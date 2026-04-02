import fs from "node:fs/promises";
import path from "node:path";
import { resolveContextSafeArtifactBaseDir } from "./artifact-dir.js";
import { type ContextSafePruneConfig, type ContextSafeSessionMode } from "./config.js";
import { type ContextSafeSessionIndex } from "./session-index.js";
import { type RuntimeChurnKind } from "./runtime-churn-policy.js";
import { type ContextSafeSessionStats } from "./session-observability.js";
import { type ContextSafeMessage } from "./tool-result-policy.js";

const CANONICAL_SESSION_STATE_VERSION = 1;

type CanonicalSessionPruneSource = "afterTurn" | "assemble" | "compact";

type CanonicalSessionSummarySource = "assemble" | "compact" | "manual";

export type CanonicalSessionPruneMetadata = {
  lastPrunedAt: string;
  lastPruneSource: CanonicalSessionPruneSource;
  lastPruneGain: number;
  lastThresholdChars: number;
};

export type CanonicalSessionRuntimeChurnMetadata = {
  normalizedRuntimeChurnCount: number;
  lastRuntimeChurnKinds: RuntimeChurnKind[];
};

export type CanonicalSessionSummaryBoundary = {
  lastSummarizedMessageId?: string;
  lastSummarizedAt?: string;
  lastSummarySource?: CanonicalSessionSummarySource;
  preservedTailHeadId?: string;
};

export type CanonicalSessionState = {
  version: 1;
  sessionId: string;
  sourceMessageCount: number;
  sessionMode?: ContextSafeSessionMode;
  configSnapshot: ContextSafePruneConfig;
  messages: ContextSafeMessage[];
  updatedAt: string;
  messageCount: number;
  toolResultCount: number;
  thresholdChars: number;
  keepRecentToolResults: number;
  placeholder: string;
  summaryBoundary?: CanonicalSessionSummaryBoundary;
  contextSafeSessionIndex?: ContextSafeSessionIndex;
  contextSafeStats?: ContextSafeSessionStats;
} & Partial<CanonicalSessionPruneMetadata> &
  Partial<CanonicalSessionRuntimeChurnMetadata>;

export async function loadCanonicalSessionState(
  sessionId: string,
): Promise<{
  path: string;
  needsRebuild: boolean;
  state?: CanonicalSessionState;
}> {
  const statePath = buildCanonicalSessionStatePath(sessionId);
  try {
    const raw = await fs.readFile(statePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isCanonicalSessionState(parsed) || parsed.sessionId !== sessionId) {
      return { path: statePath, needsRebuild: true };
    }
    return {
      path: statePath,
      needsRebuild: false,
      state: parsed,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { path: statePath, needsRebuild: true };
    }
    return { path: statePath, needsRebuild: true };
  }
}

export async function saveCanonicalSessionState(state: CanonicalSessionState): Promise<{ path: string }> {
  const statePath = buildCanonicalSessionStatePath(state.sessionId);
  const directory = path.dirname(statePath);
  const tempPath = path.join(
    directory,
    `${path.basename(statePath, ".json")}.${process.pid}.${Date.now()}.tmp`,
  );
  const normalizedState: CanonicalSessionState = {
    ...state,
    summaryBoundary: normalizeSummaryBoundary(state.summaryBoundary),
  };

  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(tempPath, JSON.stringify(normalizedState, null, 2), "utf8");
  await fs.rename(tempPath, statePath);

  return { path: statePath };
}

export function buildCanonicalSessionStatePath(sessionId: string): string {
  return path.join(
    resolveContextSafeArtifactBaseDir(),
    "session-state",
    `${sanitizeSessionId(sessionId)}.json`,
  );
}

export function createCanonicalSessionState(params: {
  sessionId: string;
  sourceMessageCount: number;
  sessionMode?: ContextSafeSessionMode;
  configSnapshot: ContextSafePruneConfig;
  messages: ContextSafeMessage[];
  pruneMetadata?: CanonicalSessionPruneMetadata;
  runtimeChurnMetadata?: CanonicalSessionRuntimeChurnMetadata;
  summaryBoundary?: CanonicalSessionSummaryBoundary;
  contextSafeSessionIndex?: ContextSafeSessionIndex;
  contextSafeStats?: ContextSafeSessionStats;
}): CanonicalSessionState {
  const messages = structuredClone(params.messages);
  const runtimeChurnMetadata = params.runtimeChurnMetadata
    ? normalizeRuntimeChurnMetadata(params.runtimeChurnMetadata)
    : undefined;
  const summaryBoundary = normalizeSummaryBoundary(params.summaryBoundary);
  return {
    version: CANONICAL_SESSION_STATE_VERSION,
    sessionId: params.sessionId,
    sourceMessageCount: params.sourceMessageCount,
    ...(params.sessionMode ? { sessionMode: params.sessionMode } : {}),
    configSnapshot: params.configSnapshot,
    messages,
    updatedAt: new Date().toISOString(),
    messageCount: messages.length,
    toolResultCount: countToolResultMessages(messages),
    thresholdChars: params.configSnapshot.thresholdChars,
    keepRecentToolResults: params.configSnapshot.keepRecentToolResults,
    placeholder: params.configSnapshot.placeholder,
    summaryBoundary,
    ...(params.contextSafeSessionIndex
      ? { contextSafeSessionIndex: structuredClone(params.contextSafeSessionIndex) }
      : {}),
    ...(params.contextSafeStats ? { contextSafeStats: structuredClone(params.contextSafeStats) } : {}),
    ...(params.pruneMetadata ? structuredClone(params.pruneMetadata) : {}),
    ...(runtimeChurnMetadata ? runtimeChurnMetadata : {}),
  };
}

function sanitizeSessionId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_") || "session";
}

function isCanonicalSessionState(value: unknown): value is CanonicalSessionState {
  if (!isRecord(value)) {
    return false;
  }
  const sourceMessageCount = value.sourceMessageCount;
  return (
    value.version === CANONICAL_SESSION_STATE_VERSION &&
    typeof value.sessionId === "string" &&
    isOptionalSessionMode(value.sessionMode) &&
    typeof sourceMessageCount === "number" &&
    Number.isInteger(sourceMessageCount) &&
    sourceMessageCount >= 0 &&
    isPruneConfig(value.configSnapshot) &&
    Array.isArray(value.messages) &&
    isOptionalIsoTimestamp(value.updatedAt) &&
    isOptionalNonNegativeInteger(value.messageCount) &&
    isOptionalNonNegativeInteger(value.toolResultCount) &&
    isOptionalPositiveInteger(value.thresholdChars) &&
    isOptionalNonNegativeInteger(value.keepRecentToolResults) &&
    isOptionalNonEmptyString(value.placeholder) &&
    isOptionalSummaryBoundary(value.summaryBoundary) &&
    isOptionalContextSafeSessionIndex(value.contextSafeSessionIndex) &&
    isOptionalContextSafeSessionStats(value.contextSafeStats) &&
    isOptionalIsoTimestamp(value.lastPrunedAt) &&
    isOptionalPruneSource(value.lastPruneSource) &&
    isOptionalNonNegativeInteger(value.lastPruneGain) &&
    isOptionalPositiveInteger(value.lastThresholdChars) &&
    isOptionalNonNegativeInteger(value.normalizedRuntimeChurnCount) &&
    isOptionalRuntimeChurnKinds(value.lastRuntimeChurnKinds)
  );
}

function countToolResultMessages(messages: ContextSafeMessage[]): number {
  return messages.filter((message) => message.role === "toolResult").length;
}

function isPruneConfig(value: unknown): value is ContextSafePruneConfig {
  return (
    isRecord(value) &&
    typeof value.thresholdChars === "number" &&
    Number.isInteger(value.thresholdChars) &&
    value.thresholdChars > 0 &&
    typeof value.keepRecentToolResults === "number" &&
    Number.isInteger(value.keepRecentToolResults) &&
    value.keepRecentToolResults >= 0 &&
    typeof value.placeholder === "string" &&
    value.placeholder.length > 0
  );
}

function normalizeRuntimeChurnMetadata(
  value: CanonicalSessionRuntimeChurnMetadata,
): CanonicalSessionRuntimeChurnMetadata {
  return {
    normalizedRuntimeChurnCount: value.normalizedRuntimeChurnCount,
    lastRuntimeChurnKinds: [...value.lastRuntimeChurnKinds],
  };
}

function normalizeSummaryBoundary(
  value?: CanonicalSessionSummaryBoundary,
): CanonicalSessionSummaryBoundary {
  if (!value) {
    return {};
  }
  return {
    ...(typeof value.lastSummarizedMessageId === "string"
      ? { lastSummarizedMessageId: value.lastSummarizedMessageId }
      : {}),
    ...(typeof value.lastSummarizedAt === "string"
      ? { lastSummarizedAt: value.lastSummarizedAt }
      : {}),
    ...(value.lastSummarySource
      ? { lastSummarySource: value.lastSummarySource }
      : {}),
    ...(typeof value.preservedTailHeadId === "string"
      ? { preservedTailHeadId: value.preservedTailHeadId }
      : {}),
  };
}

function isOptionalIsoTimestamp(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && value.length > 0);
}

function isOptionalNonEmptyString(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && value.length > 0);
}

function isOptionalSummaryBoundary(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  return (
    isRecord(value) &&
    isOptionalNonEmptyString(value.lastSummarizedMessageId) &&
    isOptionalIsoTimestamp(value.lastSummarizedAt) &&
    isOptionalSummarySource(value.lastSummarySource) &&
    isOptionalNonEmptyString(value.preservedTailHeadId)
  );
}

function isOptionalPositiveInteger(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isInteger(value) && value > 0);
}

function isOptionalNonNegativeInteger(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === "number" && Number.isInteger(value) && value >= 0)
  );
}

function isOptionalPruneSource(value: unknown): value is CanonicalSessionPruneSource | undefined {
  return value === undefined || value === "afterTurn" || value === "assemble" || value === "compact";
}

function isOptionalSummarySource(value: unknown): value is CanonicalSessionSummarySource | undefined {
  return value === undefined || value === "assemble" || value === "compact" || value === "manual";
}

function isOptionalRuntimeChurnKinds(value: unknown): value is RuntimeChurnKind[] | undefined {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.every(
        (entry) =>
          entry === "compactionSummary" ||
          entry === "childCompletionInjection" ||
          entry === "telegramDirectChatMetadata",
      ))
  );
}

function isOptionalContextSafeSessionStats(value: unknown): value is ContextSafeSessionStats | undefined {
  return value === undefined || isContextSafeSessionStats(value);
}

function isOptionalContextSafeSessionIndex(value: unknown): value is ContextSafeSessionIndex | undefined {
  return value === undefined || isContextSafeSessionIndex(value);
}

function isContextSafeSessionIndex(value: unknown): value is ContextSafeSessionIndex {
  return (
    isRecord(value) &&
    isStringArray(value.goals) &&
    isStringArray(value.recentConclusions) &&
    isStringArray(value.openThreads) &&
    isContextSafeSessionIndexArtifacts(value.keyArtifacts) &&
    isStringArray(value.recoveryHints)
  );
}

function isContextSafeSessionStats(value: unknown): value is ContextSafeSessionStats {
  return (
    isRecord(value) &&
    isOptionalNonNegativeInteger(value.artifactizedCount) &&
    isOptionalNonNegativeInteger(value.artifactFallbackCount) &&
    isOptionalNonNegativeInteger(value.detailsCompactedCount) &&
    isOptionalNonNegativeInteger(value.detailsCollapsedCount) &&
    isOptionalNonNegativeInteger(value.compactedDetailsCharsRemoved) &&
    isOptionalNonNegativeInteger(value.prunedChars) &&
    isPruneReasonCounts(value.pruneReasons) &&
    isToolOffenderList(value.topToolOffenders)
  );
}

function isContextSafeSessionIndexArtifacts(
  value: unknown,
): value is ContextSafeSessionIndex["keyArtifacts"] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.toolName === "string" &&
        entry.toolName.length > 0 &&
        (entry.resultMode === "artifact" || entry.resultMode === "inline-fallback") &&
        typeof entry.pointer === "string" &&
        entry.pointer.length > 0 &&
        typeof entry.preview === "string",
    )
  );
}

function isPruneReasonCounts(
  value: unknown,
): value is ContextSafeSessionStats["pruneReasons"] {
  return (
    isRecord(value) &&
    isOptionalNonNegativeInteger(value.assemble) &&
    isOptionalNonNegativeInteger(value.afterTurn) &&
    isOptionalNonNegativeInteger(value.compact)
  );
}

function isToolOffenderList(
  value: unknown,
): value is ContextSafeSessionStats["topToolOffenders"] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.toolName === "string" &&
        entry.toolName.length > 0 &&
        isOptionalNonNegativeInteger(entry.messageCount) &&
        isOptionalNonNegativeInteger(entry.approxChars) &&
        isOptionalNonNegativeInteger(entry.artifactizedCount) &&
        isOptionalNonNegativeInteger(entry.artifactFallbackCount) &&
        isOptionalNonNegativeInteger(entry.detailsCompactedCount),
    )
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isOptionalSessionMode(value: unknown): value is ContextSafeSessionMode | undefined {
  return (
    value === undefined ||
    value === "direct-chat" ||
    value === "background-subagent" ||
    value === "acp-run" ||
    value === "default"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
