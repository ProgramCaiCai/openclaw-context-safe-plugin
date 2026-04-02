import { describe, expect, it } from "vitest";
import {
  summarizeContextSafeSessionStats,
  type ContextSafeSessionStats,
} from "./session-observability.js";

describe("summarizeContextSafeSessionStats", () => {
  it("summarizes bounded context-safe tool-result stats and top offenders", () => {
    const stats = summarizeContextSafeSessionStats({
      messages: [
        toolResult("read", "artifact", {
          outputFile: "/tmp/read.json",
          originalTextChars: 6_000,
          originalDetailsChars: 2_000,
        }),
        toolResult("exec", "inline-fallback", {
          artifactWriteFailed: true,
          detailsCompacted: true,
          originalChars: 9_000,
          detailsCollapsed: true,
        }),
        toolResult("web_fetch", "inline", {
          detailsCompacted: true,
          originalChars: 7_500,
        }),
        toolResult("read", "artifact", {
          outputFile: "/tmp/read-2.json",
          originalTextChars: 4_000,
        }),
        toolResult("bash", "inline", {
          detailsCompacted: true,
          originalChars: 6_500,
        }),
        toolResult("grep", "inline", {
          detailsCompacted: true,
          originalChars: 5_500,
        }),
        toolResult("jq", "inline", {
          detailsCompacted: true,
          originalChars: 4_500,
        }),
      ],
    });

    expect(stats.artifactizedCount).toBe(2);
    expect(stats.artifactFallbackCount).toBe(1);
    expect(stats.detailsCompactedCount).toBe(5);
    expect(stats.detailsCollapsedCount).toBe(1);
    expect(stats.compactedDetailsCharsRemoved).toBeGreaterThan(0);
    expect(stats.topToolOffenders).toHaveLength(5);
    expect(stats.topToolOffenders[0]).toMatchObject({
      toolName: "read",
      messageCount: 2,
    });
    expect(stats.topToolOffenders.some((entry) => entry.toolName === "jq")).toBe(false);
  });

  it("accumulates prune counts and reasons on top of prior bounded stats", () => {
    const previous: ContextSafeSessionStats = {
      artifactizedCount: 0,
      artifactFallbackCount: 0,
      detailsCompactedCount: 0,
      detailsCollapsedCount: 0,
      compactedDetailsCharsRemoved: 0,
      prunedChars: 120,
      pruneReasons: {
        assemble: 1,
        afterTurn: 0,
        compact: 0,
      },
      topToolOffenders: [],
    };

    const stats = summarizeContextSafeSessionStats({
      messages: [],
      previous,
      pruneEvent: {
        source: "afterTurn",
        pruneGain: 80,
      },
    });

    expect(stats.prunedChars).toBe(200);
    expect(stats.pruneReasons).toEqual({
      assemble: 1,
      afterTurn: 1,
      compact: 0,
    });
  });

  it("carries compact no-op and circuit-breaker metadata into observability output", () => {
    const stats = summarizeContextSafeSessionStats({
      messages: [],
      compactState: {
        consecutiveCompactNoops: 3,
        lastCompactReason: "context-safe canonical transcript already minimal",
        lastCompactFailedAt: "2026-04-02T14:00:00.000Z",
        compactCircuitBreakerTripped: true,
      },
    });

    expect(stats.consecutiveCompactNoops).toBe(3);
    expect(stats.lastCompactReason).toBe("context-safe canonical transcript already minimal");
    expect(stats.lastCompactFailedAt).toBe("2026-04-02T14:00:00.000Z");
    expect(stats.compactCircuitBreakerTripped).toBe(true);
  });
});

function toolResult(
  toolName: string,
  resultMode: "artifact" | "inline" | "inline-fallback",
  contextSafe: Record<string, unknown>,
) {
  return {
    role: "toolResult",
    toolName,
    content: [{ type: "text", text: `${toolName} result` }],
    details: {
      payload: `${toolName}-payload`.repeat(8),
      contextSafe: {
        resultMode,
        ...contextSafe,
      },
    },
  };
}
