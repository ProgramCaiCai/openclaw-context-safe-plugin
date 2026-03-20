export const DEFAULT_PRUNE_THRESHOLD_CHARS = 50_000;
export const DEFAULT_KEEP_RECENT_TOOL_RESULTS = 2;
export const DEFAULT_PRUNE_PLACEHOLDER = "[pruned]";

export type ContextSafePruneConfig = {
  thresholdChars: number;
  keepRecentToolResults: number;
  placeholder: string;
};

export type ContextSafeEngineConfig = {
  prune: ContextSafePruneConfig;
};

export function normalizeContextSafeEngineConfig(input?: unknown): ContextSafeEngineConfig {
  const root = asRecord(input);
  const prune = asRecord(root?.prune);
  return {
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
  };
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
