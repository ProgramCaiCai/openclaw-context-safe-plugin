import fs from "node:fs/promises";
import {
  createCanonicalSessionState,
  loadCanonicalSessionState,
  saveCanonicalSessionState,
  type CanonicalSessionCompactMetadata,
  type CanonicalSessionPruneMetadata,
  type CanonicalSessionRuntimeChurnMetadata,
  type CanonicalSessionState,
  type CanonicalSessionSummaryBoundary,
} from "./canonical-session-state.js";
import {
  normalizeContextSafeEngineConfig,
  samePruneConfig,
  type ContextSafePruneConfig,
  type ContextSafeRuntimeChurnConfig,
  type ContextSafeSessionMode,
} from "./config.js";
import {
  normalizeRuntimeChurnMessages,
  type RuntimeChurnKind,
} from "./runtime-churn-policy.js";
import { normalizeReportAwareMessages } from "./report-aware-policy.js";
import {
  buildContextSafeSessionIndex,
  buildContextSafeSessionIndexMessage,
} from "./session-index.js";
import { summarizeContextSafeSessionStats } from "./session-observability.js";
import {
  applyCanonicalPrune,
  applyContextToolResultPolicy,
  type ContextSafeMessage,
  resolveContextBudgetChars,
} from "./tool-result-policy.js";

type ContextSafeLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

const MAX_CONSECUTIVE_COMPACT_NOOPS = 3;
const MIN_MEANINGFUL_COMPACT_TOKEN_DELTA = 16;

export function createContextSafeContextEngine(input?: {
  prune?: Partial<ContextSafePruneConfig>;
  runtimeChurn?: Partial<ContextSafeRuntimeChurnConfig>;
  logger?: ContextSafeLogger;
}) {
  const config = normalizeContextSafeEngineConfig(input);
  const logger = input?.logger;

  return {
    info: {
      id: "context-safe",
      name: "Context Safe",
      ownsCompaction: false,
    },
    async ingest() {
      return { ingested: false };
    },
    async afterTurn(params: {
      sessionId: string;
      sessionFile?: string;
      messages: ContextSafeMessage[];
      prePromptMessageCount?: number;
    }) {
      const synced = await synchronizeCanonicalState({
        sessionId: params.sessionId,
        rawMessages: params.messages,
        pruneConfig: config.prune,
        runtimeChurnConfig: config.runtimeChurn,
        logger,
      });
      const canonical = maybePruneCanonicalState({
        state: synced.state,
        source: "afterTurn",
        pruneConfig: config.prune,
        logger,
      });

      if (synced.changed || canonical.changed) {
        await persistCanonicalState(canonical.state, logger);
      }
    },
    async assemble(params: {
      sessionId: string;
      messages: ContextSafeMessage[];
      tokenBudget?: number;
    }) {
      const synced = await synchronizeCanonicalState({
        sessionId: params.sessionId,
        rawMessages: params.messages,
        pruneConfig: config.prune,
        runtimeChurnConfig: config.runtimeChurn,
        logger,
      });
      const canonical = maybePruneCanonicalState({
        state: synced.state,
        source: "assemble",
        pruneConfig: config.prune,
        logger,
      });
      const canonicalState = canonical.state;

      if (synced.changed || canonical.changed) {
        await persistCanonicalState(canonicalState, logger);
      }

      const contextWindowTokens = Math.max(1, Math.floor(params.tokenBudget ?? 0));
      const baseResult = applyContextToolResultPolicy({
        messages: canonicalState.messages,
        contextWindowTokens,
      });
      const result = injectSessionIndexMessage({
        baseResult,
        sessionIndex: canonicalState.contextSafeSessionIndex,
        contextWindowTokens,
      });
      return {
        messages: result.messages,
        estimatedTokens: Math.max(1, Math.ceil(result.estimatedChars / 4)),
      };
    },
    async compact(params: {
      sessionId: string;
      sessionFile: string;
      tokenBudget?: number;
      force?: boolean;
    }) {
      const rawMessages = await readMessagesFromSessionFile(params.sessionFile);
      if (rawMessages.length === 0) {
        return {
          ok: true,
          compacted: false,
          reason: "context-safe canonical transcript already minimal",
        };
      }

      const synced = await synchronizeCanonicalState({
        sessionId: params.sessionId,
        rawMessages,
        pruneConfig: config.prune,
        runtimeChurnConfig: config.runtimeChurn,
        logger,
      });
      const tokensBefore = estimateAssembledTokens(synced.state.messages, params.tokenBudget);
      let canonicalState = synced.state;
      let changed = synced.changed;
      const compactMetadata = readCompactMetadata(canonicalState);

      if (
        compactMetadata.consecutiveCompactNoops !== undefined &&
        compactMetadata.consecutiveCompactNoops >= MAX_CONSECUTIVE_COMPACT_NOOPS
      ) {
        if (changed) {
          await persistCanonicalState(canonicalState, logger);
        }
        return {
          ok: true,
          compacted: false,
          reason: "context-safe compact circuit breaker tripped after repeated no-ops",
        };
      }

      const pruned = applyCanonicalPrune({
        messages: canonicalState.messages,
        thresholdChars: params.force ? 1 : config.prune.thresholdChars,
        keepRecentToolResults: config.prune.keepRecentToolResults,
        keepTailMinChars: config.prune.keepTailMinChars,
        keepTailMinUserAssistantMessages: config.prune.keepTailMinUserAssistantMessages,
        keepTailMaxChars: config.prune.keepTailMaxChars,
        keepTailRespectSummaryBoundary: config.prune.keepTailRespectSummaryBoundary,
        placeholder: config.prune.placeholder,
        summaryBoundary: readSummaryBoundary(canonicalState),
      });

      if (!pruned.pruned) {
        canonicalState = applyCompactNoopMetadata({
          state: canonicalState,
          reason: "context-safe canonical transcript already minimal",
          logger,
        });
        changed = true;
        await persistCanonicalState(canonicalState, logger);
        return {
          ok: true,
          compacted: false,
          reason:
            readCompactMetadata(canonicalState).consecutiveCompactNoops &&
            readCompactMetadata(canonicalState).consecutiveCompactNoops! >=
              MAX_CONSECUTIVE_COMPACT_NOOPS
              ? "context-safe compact circuit breaker tripped after repeated no-ops"
              : "context-safe canonical transcript already minimal",
        };
      }

      logPruneTriggered({
        logger,
        source: "compact",
        sessionId: canonicalState.sessionId,
        pruneGain: pruned.pruneGain,
        thresholdChars: params.force ? 1 : config.prune.thresholdChars,
      });
      const summaryBoundary = buildSummaryBoundary({
        existing: readSummaryBoundary(canonicalState),
        messages: pruned.messages,
        keepRecentToolResults: config.prune.keepRecentToolResults,
        source: "compact",
        preservedTailStart: pruned.preservedTailStart,
      });
      canonicalState = createCanonicalSessionState({
        sessionId: canonicalState.sessionId,
        sourceMessageCount: canonicalState.sourceMessageCount,
        sessionMode: canonicalState.sessionMode,
        configSnapshot: config.prune,
        messages: pruned.messages,
        pruneMetadata: createPruneMetadata({
          source: "compact",
          pruneGain: pruned.pruneGain,
          thresholdChars: params.force ? 1 : config.prune.thresholdChars,
        }),
        runtimeChurnMetadata: readRuntimeChurnMetadata(canonicalState),
        compactMetadata: createCompactMetadata({
          consecutiveCompactNoops: 0,
          lastCompactReason: formatLastCompactReason({
            source: "compact",
            pruneGain: pruned.pruneGain,
          }),
        }),
        summaryBoundary,
        contextSafeSessionIndex: buildSessionIndex({
          messages: pruned.messages,
          state: canonicalState,
          summaryBoundaryOverride: summaryBoundary,
          lastCompactReasonOverride: formatLastCompactReason({
            source: "compact",
            pruneGain: pruned.pruneGain,
          }),
        }),
        contextSafeStats: summarizeContextSafeSessionStats({
          messages: pruned.messages,
          previous: canonicalState.contextSafeStats,
          pruneEvent: {
            source: "compact",
            pruneGain: pruned.pruneGain,
          },
          compactState: {
            consecutiveCompactNoops: 0,
            lastCompactReason: formatLastCompactReason({
              source: "compact",
              pruneGain: pruned.pruneGain,
            }),
            compactCircuitBreakerTripped: false,
          },
        }),
      });
      changed = true;

      if (changed) {
        await persistCanonicalState(canonicalState, logger);
      }

      const tokensAfter = estimateAssembledTokens(canonicalState.messages, params.tokenBudget);
      if (!params.force && tokensBefore - tokensAfter < MIN_MEANINGFUL_COMPACT_TOKEN_DELTA) {
        canonicalState = applyCompactNoopMetadata({
          state: canonicalState,
          reason: "context-safe compact made no meaningful token reduction",
          logger,
        });
        await persistCanonicalState(canonicalState, logger);
        return {
          ok: true,
          compacted: false,
          reason:
            readCompactMetadata(canonicalState).consecutiveCompactNoops &&
            readCompactMetadata(canonicalState).consecutiveCompactNoops! >=
              MAX_CONSECUTIVE_COMPACT_NOOPS
              ? "context-safe compact circuit breaker tripped after repeated no-ops"
              : "context-safe compact made no meaningful token reduction",
        };
      }
      return {
        ok: true,
        compacted: true,
        reason: "context-safe canonical transcript pruned",
        result: {
          summary: "Canonical transcript pruned",
          tokensBefore,
          tokensAfter,
        },
      };
    },
  };
}

async function synchronizeCanonicalState(params: {
  sessionId: string;
  rawMessages: ContextSafeMessage[];
  pruneConfig: ContextSafePruneConfig;
  runtimeChurnConfig: ContextSafeRuntimeChurnConfig;
  logger?: ContextSafeLogger;
}): Promise<{ state: CanonicalSessionState; changed: boolean }> {
  const loaded = await loadCanonicalSessionState(params.sessionId);
  const rawMessages = structuredClone(params.rawMessages);
  const sessionMode = inferSessionMode(rawMessages);
  const needsModeRebuild =
    !!loaded.state?.sessionMode && loaded.state.sessionMode !== sessionMode;

  if (
    loaded.needsRebuild ||
    !loaded.state ||
    needsModeRebuild ||
    loaded.state.sourceMessageCount > rawMessages.length
  ) {
    const normalized = normalizeCanonicalMessages(rawMessages, params.runtimeChurnConfig, sessionMode);
    logRuntimeChurnNormalization({
      logger: params.logger,
      sessionId: params.sessionId,
      normalizedCount: normalized.runtimeChurn.normalizedCount,
      kinds: normalized.runtimeChurn.kinds,
    });
    return {
      state: createCanonicalSessionState({
        sessionId: params.sessionId,
        sourceMessageCount: rawMessages.length,
        sessionMode,
        configSnapshot: params.pruneConfig,
        messages: normalized.messages,
        runtimeChurnMetadata: mergeRuntimeChurnMetadata(undefined, normalized.runtimeChurn),
        compactMetadata: readCompactMetadata(loaded.state),
        summaryBoundary: readSummaryBoundary(loaded.state),
        contextSafeSessionIndex: buildSessionIndex({
          messages: normalized.messages,
          state: loaded.state,
        }),
        contextSafeStats: summarizeContextSafeSessionStats({
          messages: normalized.messages,
          previous: loaded.state?.contextSafeStats,
        }),
      }),
      changed: true,
    };
  }

  let changed = false;
  let messages = loaded.state.messages;
  let runtimeChurnMetadata = readRuntimeChurnMetadata(loaded.state);

  if (loaded.state.sourceMessageCount < rawMessages.length) {
    const appended = normalizeCanonicalMessages(
      rawMessages.slice(loaded.state.sourceMessageCount),
      params.runtimeChurnConfig,
      sessionMode,
    );
    messages = [...messages, ...appended.messages];
    runtimeChurnMetadata = mergeRuntimeChurnMetadata(runtimeChurnMetadata, appended.runtimeChurn);
    logRuntimeChurnNormalization({
      logger: params.logger,
      sessionId: params.sessionId,
      normalizedCount: appended.runtimeChurn.normalizedCount,
      kinds: appended.runtimeChurn.kinds,
    });
    changed = true;
  }

  if (!samePruneConfig(loaded.state.configSnapshot, params.pruneConfig)) {
    changed = true;
  }

  if (loaded.state.sessionMode !== sessionMode) {
    changed = true;
  }

  if (!loaded.state.contextSafeSessionIndex || !loaded.state.contextSafeStats) {
    changed = true;
  }

  if (!loaded.state.summaryBoundary) {
    changed = true;
  }

  return {
    state: createCanonicalSessionState({
      sessionId: loaded.state.sessionId,
      sourceMessageCount: rawMessages.length,
      sessionMode,
      configSnapshot: params.pruneConfig,
      messages,
      pruneMetadata: readPruneMetadata(loaded.state),
      runtimeChurnMetadata,
      compactMetadata: readCompactMetadata(loaded.state),
      summaryBoundary: readSummaryBoundary(loaded.state),
      contextSafeSessionIndex: buildSessionIndex({
        messages,
        state: loaded.state,
      }),
      contextSafeStats: summarizeContextSafeSessionStats({
        messages,
        previous: loaded.state.contextSafeStats,
      }),
    }),
    changed,
  };
}

function normalizeCanonicalMessages(
  messages: ContextSafeMessage[],
  runtimeChurnConfig: ContextSafeRuntimeChurnConfig,
  sessionMode: ContextSafeSessionMode,
): {
  messages: ContextSafeMessage[];
  runtimeChurn: {
    normalizedCount: number;
    kinds: RuntimeChurnKind[];
  };
} {
  const runtimeChurn = normalizeRuntimeChurnMessages(messages, runtimeChurnConfig);
  const reportAware = normalizeReportAwareMessages(runtimeChurn.messages);
  return {
    messages: applySessionModeAwareSlimming(reportAware.messages, sessionMode),
    runtimeChurn: {
      normalizedCount: runtimeChurn.normalizedCount,
      kinds: runtimeChurn.kinds,
    },
  };
}

function inferSessionMode(messages: ContextSafeMessage[]): ContextSafeSessionMode {
  if (messages.some(isAcpRunSignalMessage)) {
    return "acp-run";
  }
  if (messages.some(isBackgroundSubagentSignalMessage)) {
    return "background-subagent";
  }
  if (messages.some(isDirectChatSignalMessage)) {
    return "direct-chat";
  }
  return "default";
}

function applySessionModeAwareSlimming(
  messages: ContextSafeMessage[],
  sessionMode: ContextSafeSessionMode,
): ContextSafeMessage[] {
  switch (sessionMode) {
    case "direct-chat":
      return collapseDirectChatWrappers(messages);
    case "background-subagent":
      return collapseBackgroundSubagentResidue(messages);
    case "acp-run":
      return collapseAcpRunProgress(messages);
    default:
      return messages;
  }
}

function collapseDirectChatWrappers(messages: ContextSafeMessage[]): ContextSafeMessage[] {
  let keptDirectWrapper = false;
  const kept: ContextSafeMessage[] = [];
  for (const message of messages) {
    if (!isDirectChatSignalMessage(message)) {
      kept.push(message);
      continue;
    }
    if (keptDirectWrapper) {
      continue;
    }
    keptDirectWrapper = true;
    kept.push(message);
  }
  return kept;
}

function collapseBackgroundSubagentResidue(messages: ContextSafeMessage[]): ContextSafeMessage[] {
  const kept: ContextSafeMessage[] = [];
  let latestCompletion: ContextSafeMessage | undefined;
  for (const message of messages) {
    if (isBackgroundProgressChatterMessage(message)) {
      continue;
    }
    if (isBackgroundCompletionMessage(message)) {
      latestCompletion = message;
      continue;
    }
    kept.push(message);
  }
  if (latestCompletion) {
    kept.push(latestCompletion);
  }
  return kept;
}

function collapseAcpRunProgress(messages: ContextSafeMessage[]): ContextSafeMessage[] {
  return messages.filter((message) => !isBackgroundProgressChatterMessage(message));
}

function isDirectChatSignalMessage(message: ContextSafeMessage): boolean {
  const text = messageText(message);
  const normalized = text.toLowerCase();
  const hasMetadataWrapper =
    (text.includes("Conversation info (untrusted metadata)") &&
      text.includes("Sender (untrusted metadata)")) ||
    (text.includes("会话信息（不可信元数据）") && text.includes("发送者（不可信元数据）"));
  const hasDirectChatType =
    normalized.includes('"chat_type":"direct"') ||
    normalized.includes('"chat_type":"dm"') ||
    normalized.includes('"chat_type":"p2p"');
  return (
    normalized.includes("telegram direct chat metadata") ||
    normalized.includes("feishu direct chat metadata") ||
    (hasMetadataWrapper && hasDirectChatType)
  );
}

function isBackgroundSubagentSignalMessage(message: ContextSafeMessage): boolean {
  const normalized = messageText(message).toLowerCase();
  return (
    normalized.includes("[internal task completion event]") ||
    normalized.includes("child task completion (")
  );
}

function isAcpRunSignalMessage(message: ContextSafeMessage): boolean {
  const normalized = messageText(message).toLowerCase();
  return (
    normalized.includes("openai codex v") ||
    (normalized.includes("workdir:") && normalized.includes("model:"))
  );
}

function isBackgroundProgressChatterMessage(message: ContextSafeMessage): boolean {
  const normalized = messageText(message).toLowerCase();
  return (
    normalized.includes("status: still working") ||
    normalized.includes("debug progress") ||
    normalized.includes("running verification")
  );
}

function isBackgroundCompletionMessage(message: ContextSafeMessage): boolean {
  return messageText(message).toLowerCase().includes("child task completion (");
}

function messageText(message: ContextSafeMessage): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  if (!Array.isArray(message.content)) {
    return "";
  }
  return message.content
    .filter(
      (block) =>
        !!block && typeof block === "object" && (block as { type?: unknown }).type === "text",
    )
    .map((block) => String((block as { text?: unknown }).text ?? ""))
    .join("\n");
}

async function persistCanonicalState(
  state: CanonicalSessionState,
  logger?: ContextSafeLogger,
): Promise<void> {
  try {
    await saveCanonicalSessionState(state);
  } catch (error) {
    logger?.warn?.(`context-safe canonical state save failed: ${String(error)}`);
  }
}

function maybePruneCanonicalState(params: {
  state: CanonicalSessionState;
  source: "afterTurn" | "assemble";
  pruneConfig: ContextSafePruneConfig;
  logger?: ContextSafeLogger;
}): { state: CanonicalSessionState; changed: boolean } {
  const pruned = applyCanonicalPrune({
    messages: params.state.messages,
    ...params.pruneConfig,
    summaryBoundary: readSummaryBoundary(params.state),
  });
  if (!pruned.pruned) {
    return { state: params.state, changed: false };
  }

  logPruneTriggered({
    logger: params.logger,
    source: params.source,
    sessionId: params.state.sessionId,
    pruneGain: pruned.pruneGain,
    thresholdChars: params.pruneConfig.thresholdChars,
  });
  const summaryBoundary = buildSummaryBoundary({
    existing: readSummaryBoundary(params.state),
    messages: pruned.messages,
    keepRecentToolResults: params.pruneConfig.keepRecentToolResults,
    source: params.source,
    preservedTailStart: pruned.preservedTailStart,
  });
  return {
    state: createCanonicalSessionState({
      sessionId: params.state.sessionId,
      sourceMessageCount: params.state.sourceMessageCount,
      sessionMode: params.state.sessionMode,
      configSnapshot: params.pruneConfig,
      messages: pruned.messages,
      pruneMetadata: createPruneMetadata({
        source: params.source,
        pruneGain: pruned.pruneGain,
        thresholdChars: params.pruneConfig.thresholdChars,
      }),
      runtimeChurnMetadata: readRuntimeChurnMetadata(params.state),
      compactMetadata: readCompactMetadata(params.state),
      summaryBoundary,
      contextSafeSessionIndex: buildSessionIndex({
        messages: pruned.messages,
        state: params.state,
        summaryBoundaryOverride: summaryBoundary,
        lastCompactReasonOverride: formatLastCompactReason({
          source: params.source,
          pruneGain: pruned.pruneGain,
        }),
      }),
      contextSafeStats: summarizeContextSafeSessionStats({
        messages: pruned.messages,
        previous: params.state.contextSafeStats,
        pruneEvent: {
          source: params.source,
          pruneGain: pruned.pruneGain,
        },
        compactState: {
          ...readCompactMetadata(params.state),
          compactCircuitBreakerTripped: false,
        },
      }),
    }),
    changed: true,
  };
}

function injectSessionIndexMessage(params: {
  baseResult: { messages: ContextSafeMessage[]; estimatedChars: number };
  sessionIndex?: CanonicalSessionState["contextSafeSessionIndex"];
  contextWindowTokens: number;
}): { messages: ContextSafeMessage[]; estimatedChars: number } {
  if (
    !params.sessionIndex ||
    params.contextWindowTokens <= 24 ||
    !hasInjectableSessionIndexSignal(params.sessionIndex)
  ) {
    return params.baseResult;
  }

  const summary = buildContextSafeSessionIndexMessage({
    index: params.sessionIndex,
    maxChars: resolveSessionIndexBudgetChars(params.contextWindowTokens),
  });
  if (!summary) {
    return params.baseResult;
  }

  const summaryChars = estimateSyntheticMessageChars(summary);
  if (params.baseResult.estimatedChars + summaryChars > resolveContextBudgetChars(params.contextWindowTokens)) {
    return params.baseResult;
  }

  return applyContextToolResultPolicy({
    messages: [summary, ...params.baseResult.messages],
    contextWindowTokens: params.contextWindowTokens,
  });
}

function resolveSessionIndexBudgetChars(contextWindowTokens: number): number {
  return Math.min(900, Math.max(180, Math.floor(contextWindowTokens * 4 * 0.18)));
}

function hasInjectableSessionIndexSignal(
  index: NonNullable<CanonicalSessionState["contextSafeSessionIndex"]>,
): boolean {
  return (
    index.recentConclusions.length > 0 ||
    index.openThreads.length > 0 ||
    index.keyArtifacts.length > 0 ||
    index.activePlans.length > 0 ||
    index.protectedReads.length > 0 ||
    index.recentReports.length > 0 ||
    !!index.summaryBoundary ||
    !!index.lastCompactReason
  );
}

function buildSessionIndex(params: {
  messages: ContextSafeMessage[];
  state?: CanonicalSessionState;
  summaryBoundaryOverride?: CanonicalSessionSummaryBoundary;
  lastCompactReasonOverride?: string;
}): ReturnType<typeof buildContextSafeSessionIndex> {
  return buildContextSafeSessionIndex({
    messages: params.messages,
    summaryBoundary: params.summaryBoundaryOverride ?? readSummaryBoundary(params.state),
    lastCompactReason:
      params.lastCompactReasonOverride ?? readLastCompactReason(params.state),
  });
}

function readLastCompactReason(state?: CanonicalSessionState): string | undefined {
  if (typeof state?.lastCompactReason === "string" && state.lastCompactReason.length > 0) {
    return state.lastCompactReason;
  }
  if (
    !state ||
    (state.lastPruneSource !== "afterTurn" &&
      state.lastPruneSource !== "assemble" &&
      state.lastPruneSource !== "compact") ||
    typeof state.lastPruneGain !== "number"
  ) {
    return undefined;
  }
  return formatLastCompactReason({
    source: state.lastPruneSource,
    pruneGain: state.lastPruneGain,
  });
}

function formatLastCompactReason(params: {
  source: "afterTurn" | "assemble" | "compact";
  pruneGain: number;
}): string {
  return `${params.source} prune gain ${params.pruneGain}`;
}

function createCompactMetadata(
  params: CanonicalSessionCompactMetadata,
): CanonicalSessionCompactMetadata {
  return {
    ...(typeof params.lastCompactFailedAt === "string"
      ? { lastCompactFailedAt: params.lastCompactFailedAt }
      : {}),
    ...(typeof params.consecutiveCompactNoops === "number"
      ? { consecutiveCompactNoops: params.consecutiveCompactNoops }
      : {}),
    ...(typeof params.lastCompactReason === "string"
      ? { lastCompactReason: params.lastCompactReason }
      : {}),
  };
}

function applyCompactNoopMetadata(params: {
  state: CanonicalSessionState;
  reason: string;
  logger?: ContextSafeLogger;
}): CanonicalSessionState {
  const previous = readCompactMetadata(params.state);
  const nextNoops = (previous.consecutiveCompactNoops ?? 0) + 1;
  const compactMetadata = createCompactMetadata({
    consecutiveCompactNoops: nextNoops,
    lastCompactFailedAt: new Date().toISOString(),
    lastCompactReason: params.reason,
  });
  if (nextNoops >= MAX_CONSECUTIVE_COMPACT_NOOPS) {
    params.logger?.warn?.(
      `context-safe compact circuit breaker tripped after ${nextNoops} consecutive no-ops`,
    );
  }
  return createCanonicalSessionState({
    sessionId: params.state.sessionId,
    sourceMessageCount: params.state.sourceMessageCount,
    sessionMode: params.state.sessionMode,
    configSnapshot: params.state.configSnapshot,
    messages: params.state.messages,
    pruneMetadata: readPruneMetadata(params.state),
    runtimeChurnMetadata: readRuntimeChurnMetadata(params.state),
    compactMetadata,
    summaryBoundary: readSummaryBoundary(params.state),
    contextSafeSessionIndex: buildSessionIndex({
      messages: params.state.messages,
      state: params.state,
      lastCompactReasonOverride: params.reason,
    }),
    contextSafeStats: summarizeContextSafeSessionStats({
      messages: params.state.messages,
      previous: params.state.contextSafeStats,
      compactState: {
        ...compactMetadata,
        compactCircuitBreakerTripped: nextNoops >= MAX_CONSECUTIVE_COMPACT_NOOPS,
      },
    }),
  });
}

function estimateSyntheticMessageChars(message: ContextSafeMessage): number {
  const content = message.content;
  if (typeof content === "string") {
    return content.length;
  }
  if (!Array.isArray(content)) {
    return 0;
  }
  return content
    .filter(
      (block) =>
        !!block && typeof block === "object" && (block as { type?: unknown }).type === "text",
    )
    .map((block) => String((block as { text?: unknown }).text ?? ""))
    .join("\n").length;
}

function createPruneMetadata(params: {
  source: "afterTurn" | "assemble" | "compact";
  pruneGain: number;
  thresholdChars: number;
}): CanonicalSessionPruneMetadata {
  return {
    lastPrunedAt: new Date().toISOString(),
    lastPruneSource: params.source,
    lastPruneGain: params.pruneGain,
    lastThresholdChars: params.thresholdChars,
  };
}

function buildSummaryBoundary(params: {
  existing?: CanonicalSessionSummaryBoundary;
  messages: ContextSafeMessage[];
  keepRecentToolResults: number;
  source: "afterTurn" | "assemble" | "compact";
  preservedTailStart?: number;
}): CanonicalSessionSummaryBoundary {
  const now = new Date().toISOString();
  const boundary: CanonicalSessionSummaryBoundary = {
    ...(params.existing ? structuredClone(params.existing) : {}),
    lastSummarizedAt: now,
    lastSummarySource: params.source,
  };
  const preservedTailStart =
    params.preservedTailStart ??
    resolveFixedPreservedTailStartIndex(params.messages, params.keepRecentToolResults);
  if (preservedTailStart === undefined) {
    return boundary;
  }
  const preservedTailHeadId = resolveContextSafeMessageId(params.messages[preservedTailStart]);
  const lastSummarizedMessageId =
    preservedTailStart > 0
      ? resolveContextSafeMessageId(params.messages[preservedTailStart - 1])
      : undefined;
  return {
    ...boundary,
    ...(lastSummarizedMessageId ? { lastSummarizedMessageId } : {}),
    ...(preservedTailHeadId ? { preservedTailHeadId } : {}),
  };
}

function resolveFixedPreservedTailStartIndex(
  messages: ContextSafeMessage[],
  keepRecentToolResults: number,
): number | undefined {
  if (messages.length === 0 || keepRecentToolResults <= 0) {
    return undefined;
  }
  return Math.max(0, messages.length - keepRecentToolResults);
}

function resolveContextSafeMessageId(message: ContextSafeMessage | undefined): string | undefined {
  if (!message) {
    return undefined;
  }
  const direct =
    asTrimmedString(message.id) ??
    asTrimmedString(message.messageId) ??
    asTrimmedString(message.message_id) ??
    asTrimmedString(message.toolCallId) ??
    asTrimmedString(message.tool_call_id);
  if (direct) {
    return direct;
  }
  if (isRecord(message.message)) {
    return asTrimmedString(message.message.id);
  }
  return undefined;
}

function readSummaryBoundary(
  state: CanonicalSessionState | undefined,
): CanonicalSessionSummaryBoundary | undefined {
  if (!state?.summaryBoundary || !isRecord(state.summaryBoundary)) {
    return state?.summaryBoundary;
  }
  return structuredClone(state.summaryBoundary);
}

function readPruneMetadata(state: CanonicalSessionState): CanonicalSessionPruneMetadata | undefined {
  if (
    typeof state.lastPrunedAt !== "string" ||
    (state.lastPruneSource !== "afterTurn" &&
      state.lastPruneSource !== "assemble" &&
      state.lastPruneSource !== "compact") ||
    typeof state.lastPruneGain !== "number" ||
    typeof state.lastThresholdChars !== "number"
  ) {
    return undefined;
  }

  return {
    lastPrunedAt: state.lastPrunedAt,
    lastPruneSource: state.lastPruneSource,
    lastPruneGain: state.lastPruneGain,
    lastThresholdChars: state.lastThresholdChars,
  };
}

function readCompactMetadata(
  state: CanonicalSessionState | undefined,
): CanonicalSessionCompactMetadata {
  return createCompactMetadata({
    lastCompactFailedAt: state?.lastCompactFailedAt,
    consecutiveCompactNoops:
      typeof state?.consecutiveCompactNoops === "number" ? state.consecutiveCompactNoops : undefined,
    lastCompactReason: state?.lastCompactReason,
  });
}

function readRuntimeChurnMetadata(
  state: CanonicalSessionState,
): CanonicalSessionRuntimeChurnMetadata | undefined {
  if (
    typeof state.normalizedRuntimeChurnCount !== "number" ||
    !Array.isArray(state.lastRuntimeChurnKinds)
  ) {
    return undefined;
  }

  return {
    normalizedRuntimeChurnCount: state.normalizedRuntimeChurnCount,
    lastRuntimeChurnKinds: [...state.lastRuntimeChurnKinds],
  };
}

function mergeRuntimeChurnMetadata(
  existing: CanonicalSessionRuntimeChurnMetadata | undefined,
  normalized: { normalizedCount: number; kinds: RuntimeChurnKind[] },
): CanonicalSessionRuntimeChurnMetadata {
  if (!existing) {
    return {
      normalizedRuntimeChurnCount: normalized.normalizedCount,
      lastRuntimeChurnKinds: [...normalized.kinds],
    };
  }

  return {
    normalizedRuntimeChurnCount:
      existing.normalizedRuntimeChurnCount + normalized.normalizedCount,
    lastRuntimeChurnKinds:
      normalized.kinds.length > 0 ? [...normalized.kinds] : [...existing.lastRuntimeChurnKinds],
  };
}

function logPruneTriggered(params: {
  logger?: ContextSafeLogger;
  source: "afterTurn" | "assemble" | "compact";
  sessionId: string;
  pruneGain: number;
  thresholdChars: number;
}) {
  params.logger?.info?.(
    `context-safe prune triggered source=${params.source} sessionId=${params.sessionId} pruneGain=${params.pruneGain} thresholdChars=${params.thresholdChars}`,
  );
}

function logRuntimeChurnNormalization(params: {
  logger?: ContextSafeLogger;
  sessionId: string;
  normalizedCount: number;
  kinds: RuntimeChurnKind[];
}) {
  if (params.normalizedCount <= 0) {
    return;
  }
  params.logger?.info?.(
    `context-safe runtime-churn normalized=${params.normalizedCount} sessionId=${params.sessionId} kinds=${params.kinds.join(",")}`,
  );
}

async function readMessagesFromSessionFile(sessionFile: string): Promise<ContextSafeMessage[]> {
  try {
    const raw = await fs.readFile(sessionFile, "utf8");
    return raw
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (parsed.type === "message" && isRecord(parsed.message)) {
          return parsed.message as ContextSafeMessage;
        }
        return isRecord(parsed) ? (parsed as ContextSafeMessage) : undefined;
      })
      .filter((message): message is ContextSafeMessage => !!message);
  } catch {
    return [];
  }
}

function estimateAssembledTokens(messages: ContextSafeMessage[], tokenBudget?: number): number {
  const result = applyContextToolResultPolicy({
    messages,
    contextWindowTokens: Math.max(1, Math.floor(tokenBudget ?? 0)),
  });
  return Math.max(1, Math.ceil(result.estimatedChars / 4));
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
