import { describe, expect, it } from "vitest";
import {
  DEFAULT_COLLAPSE_CHILD_COMPLETION_INJECTIONS,
  DEFAULT_COLLAPSE_COMPACTION_SUMMARIES,
  DEFAULT_COLLAPSE_DIRECT_CHAT_METADATA,
  DEFAULT_KEEP_RECENT_TOOL_RESULTS,
  DEFAULT_KEEP_TAIL_MAX_CHARS,
  DEFAULT_KEEP_TAIL_MIN_CHARS,
  DEFAULT_KEEP_TAIL_MIN_USER_ASSISTANT_MESSAGES,
  DEFAULT_KEEP_TAIL_RESPECT_SUMMARY_BOUNDARY,
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
        keepTailMinChars: DEFAULT_KEEP_TAIL_MIN_CHARS,
        keepTailMinUserAssistantMessages: DEFAULT_KEEP_TAIL_MIN_USER_ASSISTANT_MESSAGES,
        keepTailMaxChars: DEFAULT_KEEP_TAIL_MAX_CHARS,
        keepTailRespectSummaryBoundary: DEFAULT_KEEP_TAIL_RESPECT_SUMMARY_BOUNDARY,
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

  it("normalizes semantic preserved-tail settings when provided", () => {
    expect(
      normalizeContextSafeEngineConfig({
        prune: {
          keepTailMinChars: 6_000,
          keepTailMinUserAssistantMessages: 4,
          keepTailMaxChars: 24_000,
        },
      }),
    ).toMatchObject({
      prune: {
        keepTailMinChars: 6_000,
        keepTailMinUserAssistantMessages: 4,
        keepTailMaxChars: 24_000,
        keepTailRespectSummaryBoundary: true,
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
        keepTailMinChars: DEFAULT_KEEP_TAIL_MIN_CHARS,
        keepTailMinUserAssistantMessages: DEFAULT_KEEP_TAIL_MIN_USER_ASSISTANT_MESSAGES,
        keepTailMaxChars: DEFAULT_KEEP_TAIL_MAX_CHARS,
        keepTailRespectSummaryBoundary: DEFAULT_KEEP_TAIL_RESPECT_SUMMARY_BOUNDARY,
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
        keepTailMinChars: DEFAULT_KEEP_TAIL_MIN_CHARS,
        keepTailMinUserAssistantMessages: DEFAULT_KEEP_TAIL_MIN_USER_ASSISTANT_MESSAGES,
        keepTailMaxChars: DEFAULT_KEEP_TAIL_MAX_CHARS,
        keepTailRespectSummaryBoundary: DEFAULT_KEEP_TAIL_RESPECT_SUMMARY_BOUNDARY,
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

  it("ships bilingual retention-tier defaults for report summaries and progress chatter", () => {
    expect(DEFAULT_RETENTION_TIER_CRITICAL).toEqual(
      expect.arrayContaining(["please", "report:", "请", "结论：", "报告：", "任务：", "状态："]),
    );
    expect(DEFAULT_RETENTION_TIER_COMPRESSIBLE).toEqual(
      expect.arrayContaining(["running verification", "debug progress", "处理中", "正在验证", "调试进展"]),
    );
    expect(DEFAULT_RETENTION_TIER_FOLD_FIRST).toEqual(
      expect.arrayContaining([
        "conversation info (untrusted metadata)",
        "telegram direct chat metadata",
        "feishu direct chat metadata",
        "会话信息（不可信元数据）",
        "发送者（不可信元数据）",
      ]),
    );
  });
});
