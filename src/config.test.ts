import { describe, expect, it } from "vitest";
import {
  DEFAULT_COLLAPSE_CHILD_COMPLETION_INJECTIONS,
  DEFAULT_COLLAPSE_COMPACTION_SUMMARIES,
  DEFAULT_COLLAPSE_DIRECT_CHAT_METADATA,
  DEFAULT_KEEP_RECENT_TOOL_RESULTS,
  DEFAULT_PRUNE_THRESHOLD_CHARS,
  DEFAULT_RETENTION_TIERS_ENABLED,
  DEFAULT_RETENTION_TIER_COMPRESSIBLE,
  DEFAULT_RETENTION_TIER_CRITICAL,
  DEFAULT_RETENTION_TIER_FOLD_FIRST,
  DEFAULT_RUNTIME_CHURN_ENABLED,
  normalizeContextSafeEngineConfig,
} from "./config.js";

describe("context-safe config", () => {
  it("uses the stronger default prune threshold and protection window", () => {
    expect(DEFAULT_PRUNE_THRESHOLD_CHARS).toBe(100_000);
    expect(DEFAULT_KEEP_RECENT_TOOL_RESULTS).toBe(5);
    expect(DEFAULT_RUNTIME_CHURN_ENABLED).toBe(true);
    expect(DEFAULT_COLLAPSE_COMPACTION_SUMMARIES).toBe(true);
    expect(DEFAULT_COLLAPSE_CHILD_COMPLETION_INJECTIONS).toBe(true);
    expect(DEFAULT_COLLAPSE_DIRECT_CHAT_METADATA).toBe(true);
    expect(normalizeContextSafeEngineConfig()).toEqual({
      prune: {
        thresholdChars: 100_000,
        keepRecentToolResults: 5,
        placeholder: "[pruned]",
      },
      runtimeChurn: {
        enabled: true,
        collapseCompactionSummaries: true,
        collapseChildCompletionInjections: true,
        collapseDirectChatMetadata: true,
      },
    });
  });

  it("allows disabling only selected runtime-churn transforms", () => {
    expect(
      normalizeContextSafeEngineConfig({
        runtimeChurn: {
          enabled: false,
          collapseCompactionSummaries: false,
          collapseChildCompletionInjections: true,
          collapseDirectChatMetadata: false,
        },
      }),
    ).toEqual({
      prune: {
        thresholdChars: 100_000,
        keepRecentToolResults: 5,
        placeholder: "[pruned]",
      },
      runtimeChurn: {
        enabled: false,
        collapseCompactionSummaries: false,
        collapseChildCompletionInjections: true,
        collapseDirectChatMetadata: false,
      },
      retentionTiers: {
        enabled: DEFAULT_RETENTION_TIERS_ENABLED,
        critical: [...DEFAULT_RETENTION_TIER_CRITICAL],
        compressible: [...DEFAULT_RETENTION_TIER_COMPRESSIBLE],
        foldFirst: [...DEFAULT_RETENTION_TIER_FOLD_FIRST],
      },
    });
  });

  it("normalizes retention tiers when enabled with explicit defaults", () => {
    expect(
      normalizeContextSafeEngineConfig({
        retentionTiers: {
          enabled: true,
        },
      }),
    ).toEqual({
      prune: {
        thresholdChars: 100_000,
        keepRecentToolResults: 5,
        placeholder: "[pruned]",
      },
      runtimeChurn: {
        enabled: true,
        collapseCompactionSummaries: true,
        collapseChildCompletionInjections: true,
        collapseDirectChatMetadata: true,
      },
      retentionTiers: {
        enabled: true,
        critical: [...DEFAULT_RETENTION_TIER_CRITICAL],
        compressible: [...DEFAULT_RETENTION_TIER_COMPRESSIBLE],
        foldFirst: [...DEFAULT_RETENTION_TIER_FOLD_FIRST],
      },
    });
  });
});
