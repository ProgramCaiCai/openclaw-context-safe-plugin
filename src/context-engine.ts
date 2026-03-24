import fs from "node:fs/promises";
import {
  createCanonicalSessionState,
  loadCanonicalSessionState,
  saveCanonicalSessionState,
  type CanonicalSessionPruneMetadata,
  type CanonicalSessionRuntimeChurnMetadata,
  type CanonicalSessionState,
} from "./canonical-session-state.js";
import {
  normalizeContextSafeEngineConfig,
  samePruneConfig,
  type ContextSafePruneConfig,
  type ContextSafeRuntimeChurnConfig,
} from "./config.js";
import {
  normalizeRuntimeChurnMessages,
  type RuntimeChurnKind,
} from "./runtime-churn-policy.js";
import {
  applyCanonicalPrune,
  applyContextToolResultPolicy,
  type ContextSafeMessage,
} from "./tool-result-policy.js";

type ContextSafeLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

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

      const result = applyContextToolResultPolicy({
        messages: canonicalState.messages,
        contextWindowTokens: Math.max(1, Math.floor(params.tokenBudget ?? 0)),
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

      const pruned = applyCanonicalPrune({
        messages: canonicalState.messages,
        thresholdChars: params.force ? 1 : config.prune.thresholdChars,
        keepRecentToolResults: config.prune.keepRecentToolResults,
        placeholder: config.prune.placeholder,
      });

      if (!pruned.pruned) {
        if (changed) {
          await persistCanonicalState(canonicalState, logger);
        }
        return {
          ok: true,
          compacted: false,
          reason: "context-safe canonical transcript already minimal",
        };
      }

      logPruneTriggered({
        logger,
        source: "compact",
        sessionId: canonicalState.sessionId,
        pruneGain: pruned.pruneGain,
        thresholdChars: params.force ? 1 : config.prune.thresholdChars,
      });
      canonicalState = createCanonicalSessionState({
        sessionId: canonicalState.sessionId,
        sourceMessageCount: canonicalState.sourceMessageCount,
        configSnapshot: config.prune,
        messages: pruned.messages,
        pruneMetadata: createPruneMetadata({
          source: "compact",
          pruneGain: pruned.pruneGain,
          thresholdChars: params.force ? 1 : config.prune.thresholdChars,
        }),
        runtimeChurnMetadata: readRuntimeChurnMetadata(canonicalState),
      });
      changed = true;

      if (changed) {
        await persistCanonicalState(canonicalState, logger);
      }

      const tokensAfter = estimateAssembledTokens(canonicalState.messages, params.tokenBudget);
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

  if (loaded.needsRebuild || !loaded.state || loaded.state.sourceMessageCount > rawMessages.length) {
    const normalized = normalizeRuntimeChurnMessages(rawMessages, params.runtimeChurnConfig);
    logRuntimeChurnNormalization({
      logger: params.logger,
      sessionId: params.sessionId,
      normalizedCount: normalized.normalizedCount,
      kinds: normalized.kinds,
    });
    return {
      state: createCanonicalSessionState({
        sessionId: params.sessionId,
        sourceMessageCount: rawMessages.length,
        configSnapshot: params.pruneConfig,
        messages: normalized.messages,
        runtimeChurnMetadata: mergeRuntimeChurnMetadata(undefined, normalized),
      }),
      changed: true,
    };
  }

  let changed = false;
  let messages = loaded.state.messages;
  let runtimeChurnMetadata = readRuntimeChurnMetadata(loaded.state);

  if (loaded.state.sourceMessageCount < rawMessages.length) {
    const appended = normalizeRuntimeChurnMessages(
      rawMessages.slice(loaded.state.sourceMessageCount),
      params.runtimeChurnConfig,
    );
    messages = [...messages, ...appended.messages];
    runtimeChurnMetadata = mergeRuntimeChurnMetadata(runtimeChurnMetadata, appended);
    logRuntimeChurnNormalization({
      logger: params.logger,
      sessionId: params.sessionId,
      normalizedCount: appended.normalizedCount,
      kinds: appended.kinds,
    });
    changed = true;
  }

  if (!samePruneConfig(loaded.state.configSnapshot, params.pruneConfig)) {
    changed = true;
  }

  return {
    state: createCanonicalSessionState({
      sessionId: loaded.state.sessionId,
      sourceMessageCount: rawMessages.length,
      configSnapshot: params.pruneConfig,
      messages,
      pruneMetadata: readPruneMetadata(loaded.state),
      runtimeChurnMetadata,
    }),
    changed,
  };
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
  return {
    state: createCanonicalSessionState({
      sessionId: params.state.sessionId,
      sourceMessageCount: params.state.sourceMessageCount,
      configSnapshot: params.pruneConfig,
      messages: pruned.messages,
      pruneMetadata: createPruneMetadata({
        source: params.source,
        pruneGain: pruned.pruneGain,
        thresholdChars: params.pruneConfig.thresholdChars,
      }),
      runtimeChurnMetadata: readRuntimeChurnMetadata(params.state),
    }),
    changed: true,
  };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
