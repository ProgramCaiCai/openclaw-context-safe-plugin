import fs from "node:fs/promises";
import {
  createCanonicalSessionState,
  loadCanonicalSessionState,
  saveCanonicalSessionState,
  type CanonicalSessionState,
} from "./canonical-session-state.js";
import {
  normalizeContextSafeEngineConfig,
  samePruneConfig,
  type ContextSafePruneConfig,
} from "./config.js";
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
      });

      if (synced.changed) {
        await persistCanonicalState(synced.state, logger);
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
      });
      let canonicalState = synced.state;
      let shouldSave = synced.changed;

      const pruned = applyCanonicalPrune({
        messages: canonicalState.messages,
        ...config.prune,
      });
      if (pruned.pruned) {
        logPruneTriggered({
          logger,
          source: "assemble",
          sessionId: canonicalState.sessionId,
          pruneGain: pruned.pruneGain,
          thresholdChars: config.prune.thresholdChars,
        });
        canonicalState = createCanonicalSessionState({
          sessionId: canonicalState.sessionId,
          sourceMessageCount: canonicalState.sourceMessageCount,
          configSnapshot: config.prune,
          messages: pruned.messages,
        });
        shouldSave = true;
      }

      if (shouldSave) {
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
}): Promise<{ state: CanonicalSessionState; changed: boolean }> {
  const loaded = await loadCanonicalSessionState(params.sessionId);
  const rawMessages = structuredClone(params.rawMessages);

  if (loaded.needsRebuild || !loaded.state || loaded.state.sourceMessageCount > rawMessages.length) {
    return {
      state: createCanonicalSessionState({
        sessionId: params.sessionId,
        sourceMessageCount: rawMessages.length,
        configSnapshot: params.pruneConfig,
        messages: rawMessages,
      }),
      changed: true,
    };
  }

  let changed = false;
  let messages = loaded.state.messages;

  if (loaded.state.sourceMessageCount < rawMessages.length) {
    messages = [...messages, ...rawMessages.slice(loaded.state.sourceMessageCount)];
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

function logPruneTriggered(params: {
  logger?: ContextSafeLogger;
  source: "assemble" | "compact";
  sessionId: string;
  pruneGain: number;
  thresholdChars: number;
}) {
  params.logger?.info?.(
    `context-safe prune triggered source=${params.source} sessionId=${params.sessionId} pruneGain=${params.pruneGain} thresholdChars=${params.thresholdChars}`,
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
