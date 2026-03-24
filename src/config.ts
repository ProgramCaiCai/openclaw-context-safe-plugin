export const DEFAULT_PRUNE_THRESHOLD_CHARS = 100_000;
export const DEFAULT_KEEP_RECENT_TOOL_RESULTS = 5;
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
] as const;
export const DEFAULT_RETENTION_TIER_COMPRESSIBLE = [
  "running verification",
  "status: still working",
  "debug progress",
] as const;
export const DEFAULT_RETENTION_TIER_FOLD_FIRST = [
  "conversation info (untrusted metadata)",
  "sender (untrusted metadata)",
  "telegram direct chat metadata",
] as const;

export type ContextSafePruneConfig = {
  thresholdChars: number;
  keepRecentToolResults: number;
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
