export const DEFAULT_PRUNE_THRESHOLD_CHARS = 100_000;
export const DEFAULT_KEEP_RECENT_TOOL_RESULTS = 5;
export const DEFAULT_KEEP_TAIL_MIN_CHARS = 6_000;
export const DEFAULT_KEEP_TAIL_MIN_USER_ASSISTANT_MESSAGES = 2;
export const DEFAULT_KEEP_TAIL_MAX_CHARS = 24_000;
export const DEFAULT_KEEP_TAIL_RESPECT_SUMMARY_BOUNDARY = true;
export const DEFAULT_PRUNE_PLACEHOLDER = "[pruned]";
export const DEFAULT_RUNTIME_CHURN_ENABLED = true;
export const DEFAULT_COLLAPSE_COMPACTION_SUMMARIES = true;
export const DEFAULT_COLLAPSE_CHILD_COMPLETION_INJECTIONS = true;
export const DEFAULT_COLLAPSE_DIRECT_CHAT_METADATA = true;
export const DEFAULT_RETENTION_TIERS_ENABLED = true;
export const DEFAULT_RETENTION_TIER_CRITICAL = [
  "please",
  "keep",
  "focus",
  "continue",
  "recommendation",
  "verdict:",
  "outcome:",
  "report:",
  "请",
  "继续",
  "建议",
  "结论：",
  "报告：",
  "任务：",
  "状态：",
] as const;
export const DEFAULT_RETENTION_TIER_COMPRESSIBLE = [
  "running verification",
  "status: still working",
  "debug progress",
  "处理中",
  "正在验证",
  "调试进展",
  "继续处理中",
] as const;
export const DEFAULT_RETENTION_TIER_FOLD_FIRST = [
  "conversation info (untrusted metadata)",
  "sender (untrusted metadata)",
  "telegram direct chat metadata",
  "feishu direct chat metadata",
  "会话信息（不可信元数据）",
  "发送者（不可信元数据）",
  "飞书私聊元数据",
] as const;

export type ContextSafePruneConfig = {
  thresholdChars: number;
  keepRecentToolResults: number;
  keepTailMinChars?: number;
  keepTailMinUserAssistantMessages?: number;
  keepTailMaxChars?: number;
  keepTailRespectSummaryBoundary?: boolean;
  placeholder: string;
};

export type ContextSafeRuntimeChurnConfig = {
  enabled: boolean;
  collapseCompactionSummaries: boolean;
  collapseChildCompletionInjections: boolean;
  collapseDirectChatMetadata: boolean;
};

export type ContextSafeRetentionTiersConfig = {
  enabled: boolean;
  critical: string[];
  compressible: string[];
  foldFirst: string[];
};

export type ContextSafeSessionMode =
  | "direct-chat"
  | "background-subagent"
  | "acp-run"
  | "default";

export type ContextSafeEngineConfig = {
  prune: ContextSafePruneConfig;
  runtimeChurn: ContextSafeRuntimeChurnConfig;
  retentionTiers?: ContextSafeRetentionTiersConfig;
};

export function normalizeContextSafeEngineConfig(input?: unknown): ContextSafeEngineConfig {
  const root = asRecord(input);
  const prune = asRecord(root?.prune);
  const runtimeChurn = asRecord(root?.runtimeChurn);
  const retentionTiers = asRecord(root?.retentionTiers);
  const normalized: ContextSafeEngineConfig = {
    prune: {
      thresholdChars: readPositiveInteger(
        prune?.thresholdChars,
        DEFAULT_PRUNE_THRESHOLD_CHARS,
        "prune.thresholdChars",
      ),
      keepRecentToolResults: readNonNegativeInteger(
        prune?.keepRecentToolResults,
        DEFAULT_KEEP_RECENT_TOOL_RESULTS,
        "prune.keepRecentToolResults",
      ),
      keepTailMinChars: readPositiveInteger(
        prune?.keepTailMinChars,
        DEFAULT_KEEP_TAIL_MIN_CHARS,
        "prune.keepTailMinChars",
      ),
      keepTailMinUserAssistantMessages: readPositiveInteger(
        prune?.keepTailMinUserAssistantMessages,
        DEFAULT_KEEP_TAIL_MIN_USER_ASSISTANT_MESSAGES,
        "prune.keepTailMinUserAssistantMessages",
      ),
      keepTailMaxChars: readPositiveInteger(
        prune?.keepTailMaxChars,
        DEFAULT_KEEP_TAIL_MAX_CHARS,
        "prune.keepTailMaxChars",
      ),
      keepTailRespectSummaryBoundary: readBoolean(
        prune?.keepTailRespectSummaryBoundary,
        DEFAULT_KEEP_TAIL_RESPECT_SUMMARY_BOUNDARY,
        "prune.keepTailRespectSummaryBoundary",
      ),
      placeholder: readNonEmptyString(
        prune?.placeholder,
        DEFAULT_PRUNE_PLACEHOLDER,
        "prune.placeholder",
      ),
    },
    runtimeChurn: {
      enabled: readBoolean(
        runtimeChurn?.enabled,
        DEFAULT_RUNTIME_CHURN_ENABLED,
        "runtimeChurn.enabled",
      ),
      collapseCompactionSummaries: readBoolean(
        runtimeChurn?.collapseCompactionSummaries,
        DEFAULT_COLLAPSE_COMPACTION_SUMMARIES,
        "runtimeChurn.collapseCompactionSummaries",
      ),
      collapseChildCompletionInjections: readBoolean(
        runtimeChurn?.collapseChildCompletionInjections,
        DEFAULT_COLLAPSE_CHILD_COMPLETION_INJECTIONS,
        "runtimeChurn.collapseChildCompletionInjections",
      ),
      collapseDirectChatMetadata: readBoolean(
        runtimeChurn?.collapseDirectChatMetadata,
        DEFAULT_COLLAPSE_DIRECT_CHAT_METADATA,
        "runtimeChurn.collapseDirectChatMetadata",
      ),
    },
  };

  if (root) {
    normalized.retentionTiers = {
      enabled: readBoolean(
        retentionTiers?.enabled,
        DEFAULT_RETENTION_TIERS_ENABLED,
        "retentionTiers.enabled",
      ),
      critical: readStringArray(
        retentionTiers?.critical,
        DEFAULT_RETENTION_TIER_CRITICAL,
        "retentionTiers.critical",
      ),
      compressible: readStringArray(
        retentionTiers?.compressible,
        DEFAULT_RETENTION_TIER_COMPRESSIBLE,
        "retentionTiers.compressible",
      ),
      foldFirst: readStringArray(
        retentionTiers?.foldFirst,
        DEFAULT_RETENTION_TIER_FOLD_FIRST,
        "retentionTiers.foldFirst",
      ),
    };
  }

  return normalized;
}

export function samePruneConfig(
  left: ContextSafePruneConfig,
  right: ContextSafePruneConfig,
): boolean {
  return (
    left.thresholdChars === right.thresholdChars &&
    left.keepRecentToolResults === right.keepRecentToolResults &&
    left.keepTailMinChars === right.keepTailMinChars &&
    left.keepTailMinUserAssistantMessages === right.keepTailMinUserAssistantMessages &&
    left.keepTailMaxChars === right.keepTailMaxChars &&
    left.keepTailRespectSummaryBoundary === right.keepTailRespectSummaryBoundary &&
    left.placeholder === right.placeholder
  );
}

export function sameRuntimeChurnConfig(
  left: ContextSafeRuntimeChurnConfig,
  right: ContextSafeRuntimeChurnConfig,
): boolean {
  return (
    left.enabled === right.enabled &&
    left.collapseCompactionSummaries === right.collapseCompactionSummaries &&
    left.collapseChildCompletionInjections === right.collapseChildCompletionInjections &&
    left.collapseDirectChatMetadata === right.collapseDirectChatMetadata
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readPositiveInteger(value: unknown, fallback: number, label: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return value;
}

function readNonNegativeInteger(value: unknown, fallback: number, label: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative integer`);
  }
  return value;
}

function readNonEmptyString(value: unknown, fallback: string, label: string): string {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function readBoolean(value: unknown, fallback: boolean, label: string): boolean {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new TypeError(`${label} must be a boolean`);
  }
  return value;
}

function readStringArray(value: unknown, fallback: readonly string[], label: string): string[] {
  if (value === undefined) {
    return [...fallback];
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim().length === 0)) {
    throw new TypeError(`${label} must be an array of non-empty strings`);
  }
  return value.map((entry) => entry.trim());
}
