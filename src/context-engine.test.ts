import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createContextSafeContextEngine } from "./context-engine.js";
import {
  CONTEXT_LIMIT_TRUNCATION_NOTICE,
  PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER,
} from "./tool-result-policy.js";

let artifactDir = "";

beforeEach(() => {
  artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "context-safe-engine-"));
  process.env.OPENCLAW_CONTEXT_SAFE_ARTIFACT_DIR = artifactDir;
});

afterEach(() => {
  delete process.env.OPENCLAW_CONTEXT_SAFE_ARTIFACT_DIR;
  if (artifactDir) {
    fs.rmSync(artifactDir, { recursive: true, force: true });
    artifactDir = "";
  }
});

describe("createContextSafeContextEngine", () => {
  it("assembles context with tool-result trimming", async () => {
    const engine = createContextSafeContextEngine();

    const result = await engine.assemble({
      sessionId: "session-1",
      messages: [
        { role: "user", content: "inspect this" },
        {
          role: "toolResult",
          toolName: "read",
          content: [{ type: "text", text: "x".repeat(220) }],
          details: { blob: "y".repeat(400) },
        },
      ],
      tokenBudget: 32,
    });

    expect(result.messages).toHaveLength(2);
    expect(textOf(result.messages[1])).toContain(CONTEXT_LIMIT_TRUNCATION_NOTICE);
    expect(result.estimatedTokens).toBeGreaterThan(0);
  });

  it("compacts old tool-result context before newer tool results", async () => {
    const engine = createContextSafeContextEngine();

    const result = await engine.assemble({
      sessionId: "session-2",
      messages: [
        { role: "user", content: "analyze" },
        { role: "toolResult", toolName: "exec", content: [{ type: "text", text: "a".repeat(90) }] },
        { role: "assistant", content: [{ type: "text", text: "working" }] },
        { role: "toolResult", toolName: "exec", content: [{ type: "text", text: "b".repeat(90) }] },
      ],
      tokenBudget: 36,
    });

    expect(textOf(result.messages[1])).toContain(PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER);
    expect(textOf(result.messages[3])).not.toContain(PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER);
  });

  it("persists observability summary fields after assemble", async () => {
    const engine = createContextSafeContextEngine();
    const sessionId = "session-assemble-summary";
    const messages = [
      { role: "user", content: "inspect this" },
      {
        role: "toolResult",
        toolName: "read",
        content: [{ type: "text", text: "important output" }],
      },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ];

    await engine.assemble({
      sessionId,
      messages,
      tokenBudget: 128,
    });

    const savedState = JSON.parse(fs.readFileSync(canonicalStatePath(sessionId), "utf8")) as {
      updatedAt?: string;
      messageCount?: number;
      toolResultCount?: number;
      thresholdChars?: number;
      keepRecentToolResults?: number;
      placeholder?: string;
      normalizedRuntimeChurnCount?: number;
      lastRuntimeChurnKinds?: string[];
      contextSafeStats?: {
        artifactizedCount?: number;
        artifactFallbackCount?: number;
        detailsCompactedCount?: number;
        detailsCollapsedCount?: number;
        compactedDetailsCharsRemoved?: number;
        prunedChars?: number;
        pruneReasons?: Record<string, number>;
        topToolOffenders?: unknown[];
      };
      messages: Array<{ role?: string }>;
    };

    expect(savedState.updatedAt).toEqual(expect.any(String));
    expect(savedState.messageCount).toBe(messages.length);
    expect(savedState.toolResultCount).toBe(1);
    expect(savedState.thresholdChars).toBe(100_000);
    expect(savedState.keepRecentToolResults).toBe(5);
    expect(savedState.placeholder).toBe("[pruned]");
    expect(savedState.normalizedRuntimeChurnCount).toBe(0);
    expect(savedState.lastRuntimeChurnKinds).toEqual([]);
    expect(savedState.contextSafeStats).toEqual({
      artifactizedCount: 0,
      artifactFallbackCount: 0,
      detailsCompactedCount: 0,
      detailsCollapsedCount: 0,
      compactedDetailsCharsRemoved: 0,
      prunedChars: 0,
      pruneReasons: {
        assemble: 0,
        afterTurn: 0,
        compact: 0,
      },
      topToolOffenders: [
        {
          toolName: "read",
          messageCount: 1,
          approxChars: expect.any(Number),
          artifactizedCount: 0,
          artifactFallbackCount: 0,
          detailsCompactedCount: 0,
        },
      ],
    });
    expect(savedState.messages).toHaveLength(messages.length);
  });

  it("persists bounded context-safe stats derived from persisted tool-result metadata", async () => {
    const engine = createContextSafeContextEngine();
    const sessionId = "session-context-safe-stats";

    await engine.assemble({
      sessionId,
      messages: [
        { role: "user", content: "inspect the artifacts" },
        {
          role: "toolResult",
          toolName: "read",
          content: [{ type: "text", text: "artifact preview" }],
          details: {
            contextSafe: {
              resultMode: "artifact",
              outputFile: "/tmp/read-artifact.json",
              originalTextChars: 6_000,
              originalDetailsChars: 1_500,
            },
          },
        },
        {
          role: "toolResult",
          toolName: "exec",
          content: [{ type: "text", text: "fallback preview" }],
          details: {
            contextSafe: {
              resultMode: "inline-fallback",
              artifactWriteFailed: true,
              detailsCompacted: true,
              detailsCollapsed: true,
              originalChars: 8_500,
            },
          },
        },
      ],
      tokenBudget: 1000,
    });

    const savedState = JSON.parse(fs.readFileSync(canonicalStatePath(sessionId), "utf8")) as {
      contextSafeStats?: {
        artifactizedCount?: number;
        artifactFallbackCount?: number;
        detailsCompactedCount?: number;
        detailsCollapsedCount?: number;
        compactedDetailsCharsRemoved?: number;
        prunedChars?: number;
        pruneReasons?: Record<string, number>;
        topToolOffenders?: Array<{
          toolName?: string;
          approxChars?: number;
          messageCount?: number;
        }>;
      };
    };

    expect(savedState.contextSafeStats?.artifactizedCount).toBe(1);
    expect(savedState.contextSafeStats?.artifactFallbackCount).toBe(1);
    expect(savedState.contextSafeStats?.detailsCompactedCount).toBe(1);
    expect(savedState.contextSafeStats?.detailsCollapsedCount).toBe(1);
    expect(savedState.contextSafeStats?.compactedDetailsCharsRemoved).toBeGreaterThan(0);
    expect(savedState.contextSafeStats?.prunedChars).toBe(0);
    expect(savedState.contextSafeStats?.pruneReasons).toEqual({
      assemble: 0,
      afterTurn: 0,
      compact: 0,
    });
    expect(savedState.contextSafeStats?.topToolOffenders).toEqual([
      expect.objectContaining({
        toolName: "exec",
        messageCount: 1,
        approxChars: expect.any(Number),
      }),
      expect.objectContaining({
        toolName: "read",
        messageCount: 1,
        approxChars: expect.any(Number),
      }),
    ]);
  });

  it("injects a bounded synthetic session index message during assemble", async () => {
    const engine = createContextSafeContextEngine();
    const sessionId = "session-index-assemble";

    const result = await engine.assemble({
      sessionId,
      messages: [
        {
          role: "user",
          content:
            "Goal: keep recovery hints easy to find. Plan: docs/plans/context-safe/assemble-plan.md",
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "Conclusion: indexing is ready for assemble." }],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "Next: inject the synthetic summary carefully." }],
        },
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Recovery note: reread SOUL.md and review reports/context-safe/assemble/evidence.md.",
            },
          ],
        },
        {
          role: "toolResult",
          toolName: "exec",
          content: [{ type: "text", text: "artifact preview" }],
          details: {
            contextSafe: {
              resultMode: "artifact",
              outputFile: "/tmp/assemble-index-artifact.json",
            },
          },
        },
      ],
      tokenBudget: 1000,
    });

    expect(textOf(result.messages[0])).toContain("[context-safe session index]");
    expect(textOf(result.messages[0])).toContain("Goal: keep recovery hints easy to find.");
    expect(textOf(result.messages[0])).toContain("/tmp/assemble-index-artifact.json");
    expect(textOf(result.messages[0])).toContain("Active plans:");
    expect(textOf(result.messages[0])).toContain("Recent reports:");
    expect(textOf(result.messages[0])).toContain("Protected reads:");
    expect(result.messages.slice(1).map((message) => textOf(message))).toContain(
      "Goal: keep recovery hints easy to find. Plan: docs/plans/context-safe/assemble-plan.md",
    );
  });

  it("falls back to a compact session index representation when the injection budget is tighter", async () => {
    const engine = createContextSafeContextEngine();

    const result = await engine.assemble({
      sessionId: "session-index-assemble-compact",
      messages: [
        {
          role: "user",
          content:
            "Goal: keep recovery hints easy to find. Plan: docs/plans/context-safe/assemble-plan.md",
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "Conclusion: indexing is ready for assemble." }],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "Next: inject the synthetic summary carefully." }],
        },
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Recovery note: reread SOUL.md and review reports/context-safe/assemble/evidence.md.",
            },
          ],
        },
        {
          role: "toolResult",
          toolName: "exec",
          content: [{ type: "text", text: "artifact preview" }],
          details: {
            contextSafe: {
              resultMode: "artifact",
              outputFile: "/tmp/assemble-index-artifact.json",
            },
          },
        },
      ],
      tokenBudget: 256,
    });

    expect(textOf(result.messages[0])).toContain("[context-safe session index]");
    expect(textOf(result.messages[0])).toContain("Goal: keep recovery hints easy to find.");
    expect(textOf(result.messages[0])).toContain("Active plans:");
    expect(textOf(result.messages[0])).not.toContain("Protected reads:");
    expect(textOf(result.messages[0])).not.toContain("Recent reports:");
  });

  it("skips the synthetic session index when it would crowd out already-fitting context", async () => {
    const engine = createContextSafeContextEngine();

    const result = await engine.assemble({
      sessionId: "session-index-tight-budget",
      messages: [
        { role: "user", content: "Goal: keep recent read output visible." },
        {
          role: "assistant",
          content: [{ type: "text", text: "Conclusion: the session index helps recovery." }],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "Next: inject it only with headroom." }],
        },
        {
          role: "toolResult",
          toolName: "read",
          content: [{ type: "text", text: "r".repeat(40) }],
          details: {
            contextSafe: {
              resultMode: "inline",
            },
          },
        },
      ],
      tokenBudget: 36,
    });

    expect(textOf(result.messages[0])).toBe("Goal: keep recent read output visible.");
    expect(result.messages.map((message) => textOf(message))).not.toContain("[context-safe session index]");
    expect(textOf(result.messages.at(-1))).toBe("r".repeat(40));
  });

  it("records runtime-churn observability counts, kinds, and logs when normalization happens", async () => {
    const info = vi.fn();
    const engine = createContextSafeContextEngine({
      logger: { info },
    });
    const sessionId = "session-runtime-churn-observability";

    await engine.assemble({
      sessionId,
      messages: [
        { role: "user", content: "inspect this" },
        childCompletionInjectionMessage(),
      ],
      tokenBudget: 256,
    });

    const savedState = JSON.parse(fs.readFileSync(canonicalStatePath(sessionId), "utf8")) as {
      normalizedRuntimeChurnCount?: number;
      lastRuntimeChurnKinds?: string[];
      messages: Array<{ content?: unknown }>;
    };

    expect(savedState.normalizedRuntimeChurnCount).toBe(1);
    expect(savedState.lastRuntimeChurnKinds).toEqual(["childCompletionInjection"]);
    expect(textOf(savedState.messages[1])).toContain("Child task completion (success)");
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining("context-safe runtime-churn normalized=1"),
    );
    expect(info).toHaveBeenCalledWith(expect.stringContaining("childCompletionInjection"));
  });

  it("compacts canonical state from the session transcript for manual compact requests", async () => {
    const info = vi.fn();
    const engine = createContextSafeContextEngine({
      prune: {
        thresholdChars: 100_000,
        keepRecentToolResults: 2,
        placeholder: "[pruned]",
      },
      logger: { info },
    });
    const sessionFile = path.join(artifactDir, "manual-compact.jsonl");
    const sessionId = "session-3";
    const messages = canonicalMessages({
      thinkingChars: 16_000,
      thinkingOnlyChars: 16_000,
      oldToolTextChars: 9_000,
      oldToolDetailsChars: 5_000,
    });
    writeTranscript(sessionFile, messages);

    const compactResult = await engine.compact({
      sessionId,
      sessionFile,
      tokenBudget: 30_000,
      force: true,
    });

    expect(compactResult.ok).toBe(true);
    expect(compactResult.compacted).toBe(true);
    expect(compactResult.result?.tokensBefore).toBeGreaterThan(compactResult.result?.tokensAfter ?? 0);

    const assembled = await engine.assemble({
      sessionId,
      messages: replaceHistoricalNoise(messages, {
        oldTool1Text: "RAW TRANSCRIPT SHOULD NOT REPLACE MANUALLY COMPACTED STATE",
        oldTool2Text: "SECOND RAW TRANSCRIPT SHOULD NOT REPLACE MANUALLY COMPACTED STATE",
      }),
      tokenBudget: 30_000,
    });

    expect(countThinkingBlocks(assembled.messages)).toBe(0);
    expect(toolResultTexts(assembled.messages)).toEqual([
      "[pruned]",
      "[pruned]",
      "recent tool result 1",
      "recent tool result 2",
    ]);
    expect(info).toHaveBeenCalledWith(expect.stringContaining("context-safe prune triggered"));
    expect(info).toHaveBeenCalledWith(expect.stringContaining("source=compact"));
  });

  it("moves the compact preserved-tail boundary backward so it does not start with an orphan tool result", async () => {
    const engine = createContextSafeContextEngine({
      prune: {
        thresholdChars: 1,
        keepRecentToolResults: 1,
        placeholder: "[pruned]",
      },
    });
    const sessionId = "session-compact-api-invariants";
    const sessionFile = path.join(artifactDir, "manual-compact-api-invariants.jsonl");
    writeTranscript(sessionFile, [
      { role: "user", content: "summarize the run" },
      {
        role: "assistant",
        id: "assistant-legacy-thinking",
        content: [{ type: "thinking", thinking: "t".repeat(30_000) }],
      },
      {
        role: "assistant",
        id: "assistant-call-1",
        content: [
          {
            type: "tool_use",
            name: "read",
            id: "call-1",
            input: { path: "/tmp/plan.md" },
          },
        ],
      },
      {
        role: "toolResult",
        id: "tool-result-call-1",
        toolName: "read",
        toolCallId: "call-1",
        content: [{ type: "text", text: "recent tool result" }],
      },
    ]);

    const compactResult = await engine.compact({
      sessionId,
      sessionFile,
      tokenBudget: 30_000,
      force: true,
    });

    expect(compactResult.ok).toBe(true);
    expect(compactResult.compacted).toBe(true);

    const savedState = JSON.parse(fs.readFileSync(canonicalStatePath(sessionId), "utf8")) as {
      summaryBoundary?: {
        preservedTailHeadId?: string;
      };
    };

    expect(savedState.summaryBoundary?.preservedTailHeadId).toBe("assistant-call-1");
  });

  it("uses semantic preserved-tail settings to anchor the summary boundary before the last fixed tool-result window", async () => {
    const engine = createContextSafeContextEngine({
      prune: {
        thresholdChars: 1,
        keepRecentToolResults: 1,
        keepTailMinChars: 120,
        keepTailMinUserAssistantMessages: 2,
        keepTailMaxChars: 8_000,
        placeholder: "[pruned]",
      },
    });
    const sessionId = "session-semantic-preserved-tail";

    await engine.assemble({
      sessionId,
      messages: [
        {
          role: "assistant",
          id: "assistant-legacy-thinking",
          content: [{ type: "thinking", thinking: "t".repeat(20_000) }],
        },
        {
          role: "user",
          id: "user-turn-1",
          content: "Need the preserved tail to keep the latest exchange stable.",
        },
        {
          role: "assistant",
          id: "assistant-turn-1",
          content: [{ type: "text", text: "Working through the final verification." }],
        },
        {
          role: "toolResult",
          toolName: "exec",
          toolCallId: "tail-burst-1",
          content: [{ type: "text", text: "x".repeat(900) }],
        },
        {
          role: "toolResult",
          toolName: "read",
          toolCallId: "tail-burst-2",
          content: [{ type: "text", text: "y".repeat(900) }],
        },
      ],
      tokenBudget: 30_000,
    });

    const savedState = JSON.parse(fs.readFileSync(canonicalStatePath(sessionId), "utf8")) as {
      summaryBoundary?: {
        preservedTailHeadId?: string;
      };
    };

    expect(savedState.summaryBoundary?.preservedTailHeadId).toBe("user-turn-1");
  });

  it("skips manual compact when the canonical transcript has nothing worth pruning", async () => {
    const engine = createContextSafeContextEngine();
    const sessionFile = path.join(artifactDir, "manual-compact-skip.jsonl");
    writeTranscript(sessionFile, [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "world" }] },
    ]);

    await expect(
      engine.compact({
        sessionId: "session-compact-skip",
        sessionFile,
        tokenBudget: 30_000,
        force: true,
      }),
    ).resolves.toEqual({
      ok: true,
      compacted: false,
      reason: "context-safe canonical transcript already minimal",
    });
  });
  it("persists a summary-boundary object when legacy canonical state did not have one", async () => {
    const engine = createContextSafeContextEngine();
    const sessionId = "session-legacy-summary-boundary";
    const rawMessages = [
      { role: "user", content: "Goal: rebuild summary-boundary metadata." },
      {
        role: "assistant",
        content: [{ type: "text", text: "Conclusion: legacy state loaded." }],
      },
    ];

    fs.mkdirSync(path.dirname(canonicalStatePath(sessionId)), { recursive: true });
    fs.writeFileSync(
      canonicalStatePath(sessionId),
      JSON.stringify(
        {
          version: 1,
          sessionId,
          sourceMessageCount: rawMessages.length,
          configSnapshot: {
            thresholdChars: 100_000,
            keepRecentToolResults: 5,
            placeholder: "[pruned]",
          },
          messages: rawMessages,
        },
        null,
        2,
      ),
      "utf8",
    );

    await engine.assemble({
      sessionId,
      messages: rawMessages,
      tokenBudget: 512,
    });

    const savedState = JSON.parse(fs.readFileSync(canonicalStatePath(sessionId), "utf8")) as {
      summaryBoundary?: Record<string, unknown>;
    };

    expect(savedState.summaryBoundary).toEqual({});
  });

  it("prunes canonical transcript during assemble when the default threshold gain exceeds 100000", async () => {
    const info = vi.fn();
    const engine = createContextSafeContextEngine({
      logger: { info },
    });

    const result = await engine.assemble({
      sessionId: "session-default-prune",
      messages: defaultWindowCanonicalMessages({
        thinkingChars: 16_000,
        thinkingOnlyChars: 20_000,
        oldToolTextChars: 15_000,
        oldToolDetailsChars: 10_000,
      }),
      tokenBudget: 30_000,
    });

    expect(countThinkingBlocks(result.messages)).toBe(1);
    expect(toolResultTexts(result.messages)).toEqual([
      "[pruned]",
      "[pruned]",
      "[pruned]",
      "[pruned]",
      "tail protected tool result 1",
      "tail protected tool result 2",
    ]);
    expect(toolResultDetails(result.messages)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(info).toHaveBeenCalledWith(expect.stringContaining("context-safe prune triggered"));
    expect(info).toHaveBeenCalledWith(expect.stringContaining("source=assemble"));
  });

  it("honors custom threshold overrides during assemble", async () => {
    const defaultEngine = createContextSafeContextEngine({
      prune: {
        thresholdChars: 100_000,
        keepRecentToolResults: 2,
        placeholder: "[pruned]",
      },
    });
    const customEngine = createContextSafeContextEngine({
      prune: {
        thresholdChars: 7_500,
        keepRecentToolResults: 2,
        placeholder: "[pruned]",
      },
    });
    const defaultMessages = canonicalMessages({
      thinkingChars: 8_000,
      thinkingOnlyChars: 8_000,
      oldToolTextChars: 5_000,
      oldToolDetailsChars: 2_000,
    });
    const customMessages = canonicalMessages({
      thinkingChars: 8_000,
      thinkingOnlyChars: 8_000,
      oldToolTextChars: 5_000,
      oldToolDetailsChars: 2_000,
    });

    const defaultResult = await defaultEngine.assemble({
      sessionId: "session-custom-threshold-default",
      messages: defaultMessages,
      tokenBudget: 30_000,
    });
    const customResult = await customEngine.assemble({
      sessionId: "session-custom-threshold-override",
      messages: customMessages,
      tokenBudget: 30_000,
    });

    expect(countThinkingBlocks(defaultResult.messages)).toBeGreaterThan(0);
    expect(toolResultTexts(defaultResult.messages)).toEqual([
      "a".repeat(5_000),
      "b".repeat(5_000),
      "recent tool result 1",
      "recent tool result 2",
    ]);

    expect(countThinkingBlocks(customResult.messages)).toBe(1);
    expect(toolResultTexts(customResult.messages)).toEqual([
      "[pruned]",
      "b".repeat(5_000),
      "recent tool result 1",
      "recent tool result 2",
    ]);
    expect(toolResultDetails(customResult.messages)).toEqual([
      undefined,
      { raw: "e".repeat(2_000) },
      undefined,
      undefined,
    ]);
  });

  it("persists canonical state on first prune and reuses it on later assemble calls for the same session", async () => {
    const engine = createContextSafeContextEngine({
      prune: {
        thresholdChars: 50_000,
        keepRecentToolResults: 2,
        placeholder: "[pruned]",
      },
    });
    const sessionId = "session-canonical-persistence";
    const firstMessages = canonicalMessages({
      thinkingChars: 16_000,
      thinkingOnlyChars: 16_000,
      oldToolTextChars: 9_000,
      oldToolDetailsChars: 5_000,
    });

    const firstResult = await engine.assemble({
      sessionId,
      messages: firstMessages,
      tokenBudget: 30_000,
    });

    expect(fs.existsSync(canonicalStatePath(sessionId))).toBe(true);
    expect(countThinkingBlocks(firstResult.messages)).toBe(0);
    expect(toolResultTexts(firstResult.messages)).toEqual([
      "[pruned]",
      "[pruned]",
      "recent tool result 1",
      "recent tool result 2",
    ]);

    const secondResult = await engine.assemble({
      sessionId,
      messages: replaceHistoricalNoise(firstMessages, {
        oldTool1Text: "UPSTREAM RAW HISTORY SHOULD NOT REPLACE CANONICAL STATE",
        oldTool2Text: "SECOND UPSTREAM RAW HISTORY SHOULD NOT REPLACE CANONICAL STATE",
      }),
      tokenBudget: 30_000,
    });

    expect(secondResult.messages).toEqual(firstResult.messages);
  });

  it("can trigger a later prune only after enough new canonical growth accumulates", async () => {
    const engine = createContextSafeContextEngine({
      prune: {
        thresholdChars: 50_000,
        keepRecentToolResults: 2,
        placeholder: "[pruned]",
      },
    });
    const sessionId = "session-canonical-retrigger";
    const baseMessages = canonicalMessages({
      thinkingChars: 16_000,
      thinkingOnlyChars: 16_000,
      oldToolTextChars: 9_000,
      oldToolDetailsChars: 5_000,
    });

    const firstResult = await engine.assemble({
      sessionId,
      messages: baseMessages,
      tokenBudget: 30_000,
    });
    expect(toolResultTexts(firstResult.messages)).toEqual([
      "[pruned]",
      "[pruned]",
      "recent tool result 1",
      "recent tool result 2",
    ]);

    const secondResult = await engine.assemble({
      sessionId,
      messages: baseMessages,
      tokenBudget: 30_000,
    });
    expect(secondResult.messages).toEqual(firstResult.messages);

    const grownMessages = appendNewCanonicalGrowth(baseMessages, {
      thinkingChars: 18_000,
      toolTextChars: 15_000,
      toolDetailsChars: 7_000,
    });
    const thirdResult = await engine.assemble({
      sessionId,
      messages: grownMessages,
      tokenBudget: 30_000,
    });

    expect(countThinkingBlocks(thirdResult.messages)).toBe(0);
    expect(toolResultTexts(thirdResult.messages)).toEqual([
      "[pruned]",
      "[pruned]",
      "[pruned]",
      "[pruned]",
      "[pruned]",
      "[pruned]",
      "latest tool result 1",
      "latest tool result 2",
    ]);
  });

  it("appends post-turn messages into canonical state during afterTurn", async () => {
    const engine = createContextSafeContextEngine();
    const sessionId = "session-after-turn-sync";
    const baseMessages = canonicalMessages({
      thinkingChars: 16_000,
      thinkingOnlyChars: 16_000,
      oldToolTextChars: 9_000,
      oldToolDetailsChars: 5_000,
    });
    const postTurnMessages = [
      ...baseMessages,
      { role: "assistant", content: [{ type: "text", text: "turn completed" }] },
      {
        role: "toolResult",
        toolName: "read",
        toolCallId: "post-turn-tool",
        content: [{ type: "text", text: "post-turn tool result" }],
      },
    ];

    await engine.assemble({
      sessionId,
      messages: baseMessages,
      tokenBudget: 30_000,
    });
    await engine.afterTurn({
      sessionId,
      sessionFile: "/tmp/session.jsonl",
      messages: postTurnMessages,
      prePromptMessageCount: baseMessages.length,
    });

    const result = await engine.assemble({
      sessionId,
      messages: postTurnMessages,
      tokenBudget: 30_000,
    });

    expect(result.messages.slice(-2)).toEqual([
      { role: "assistant", content: [{ type: "text", text: "turn completed" }] },
      {
        role: "toolResult",
        toolName: "read",
        toolCallId: "post-turn-tool",
        content: [{ type: "text", text: "post-turn tool result" }],
      },
    ]);
  });

  it("updates the bounded session index after afterTurn appends new canonical messages", async () => {
    const engine = createContextSafeContextEngine();
    const sessionId = "session-index-after-turn";
    const baseMessages = [
      { role: "user", content: "Goal: land the session index safely." },
      {
        role: "assistant",
        content: [{ type: "text", text: "Conclusion: the fallback path is stable." }],
      },
    ];
    const postTurnMessages = [
      ...baseMessages,
      {
        role: "assistant",
        content: [{ type: "text", text: "Next: thread the session index through assemble." }],
      },
      {
        role: "toolResult",
        toolName: "exec",
        content: [{ type: "text", text: "preview" }],
        details: {
          contextSafe: {
            resultMode: "artifact",
            outputFile: "/tmp/session-index-artifact.json",
          },
        },
      },
    ];

    await engine.assemble({
      sessionId,
      messages: baseMessages,
      tokenBudget: 512,
    });
    await engine.afterTurn({
      sessionId,
      sessionFile: "/tmp/session-index.jsonl",
      messages: postTurnMessages,
      prePromptMessageCount: baseMessages.length,
    });

    const savedState = JSON.parse(fs.readFileSync(canonicalStatePath(sessionId), "utf8")) as {
      contextSafeSessionIndex?: {
        goals?: string[];
        recentConclusions?: string[];
        openThreads?: string[];
        keyArtifacts?: Array<{ pointer?: string }>;
        activePlans?: string[];
        protectedReads?: string[];
        recentReports?: string[];
      };
    };

    expect(savedState.contextSafeSessionIndex).toEqual({
      goals: ["Goal: land the session index safely."],
      recentConclusions: ["Conclusion: the fallback path is stable."],
      openThreads: ["Next: thread the session index through assemble."],
      keyArtifacts: [
        {
          toolName: "exec",
          resultMode: "artifact",
          pointer: "/tmp/session-index-artifact.json",
          preview: "preview",
        },
      ],
      activePlans: [],
      protectedReads: [],
      recentReports: [],
      recoveryHints: [expect.stringContaining("rerun a narrower command")],
    });
  });

  it("prunes and persists canonical state during afterTurn for growth-heavy final turns", async () => {
    const info = vi.fn();
    const engine = createContextSafeContextEngine({
      prune: {
        thresholdChars: 50_000,
        keepRecentToolResults: 2,
        placeholder: "[pruned]",
      },
      logger: { info },
    });
    const sessionId = "session-after-turn-prune";
    const baseMessages = canonicalMessages({
      thinkingChars: 16_000,
      thinkingOnlyChars: 16_000,
      oldToolTextChars: 9_000,
      oldToolDetailsChars: 5_000,
    });
    const finalTurnMessages = appendNewCanonicalGrowth(baseMessages, {
      thinkingChars: 18_000,
      toolTextChars: 15_000,
      toolDetailsChars: 7_000,
    });

    await engine.assemble({
      sessionId,
      messages: baseMessages,
      tokenBudget: 30_000,
    });

    await engine.afterTurn({
      sessionId,
      sessionFile: "/tmp/final-turn.jsonl",
      messages: finalTurnMessages,
      prePromptMessageCount: baseMessages.length,
    });

    const savedState = JSON.parse(fs.readFileSync(canonicalStatePath(sessionId), "utf8")) as {
      lastPrunedAt?: string;
      lastPruneSource?: string;
      lastPruneGain?: number;
      lastThresholdChars?: number;
      contextSafeStats?: {
        prunedChars?: number;
        pruneReasons?: Record<string, number>;
      };
      messages: Array<{ role?: string; content?: unknown; details?: unknown }>;
    };

    expect(savedState.lastPrunedAt).toEqual(expect.any(String));
    expect(savedState.lastPruneSource).toBe("afterTurn");
    expect(savedState.lastPruneGain).toBeGreaterThan(0);
    expect(savedState.lastThresholdChars).toBe(50_000);
    expect(savedState.contextSafeStats?.prunedChars).toBeGreaterThanOrEqual(
      savedState.lastPruneGain ?? 0,
    );
    expect(savedState.contextSafeStats?.pruneReasons).toEqual({
      assemble: 1,
      afterTurn: 1,
      compact: 0,
    });
    expect(countThinkingBlocks(savedState.messages)).toBe(0);
    expect(toolResultTexts(savedState.messages)).toEqual([
      "[pruned]",
      "[pruned]",
      "[pruned]",
      "[pruned]",
      "[pruned]",
      "[pruned]",
      "latest tool result 1",
      "latest tool result 2",
    ]);
    expect(toolResultDetails(savedState.messages)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(info).toHaveBeenCalledWith(expect.stringContaining("context-safe prune triggered"));
    expect(info).toHaveBeenCalledWith(expect.stringContaining("source=afterTurn"));
  });

  it("rebuilds missing session index data from older saved state files", async () => {
    const engine = createContextSafeContextEngine();
    const sessionId = "session-index-legacy-rebuild";
    const rawMessages = [
      { role: "user", content: "Goal: rebuild the missing index." },
      {
        role: "assistant",
        content: [{ type: "text", text: "Conclusion: legacy state loaded." }],
      },
    ];

    fs.mkdirSync(path.dirname(canonicalStatePath(sessionId)), { recursive: true });
    fs.writeFileSync(
      canonicalStatePath(sessionId),
      JSON.stringify(
        {
          version: 1,
          sessionId,
          sourceMessageCount: rawMessages.length,
          configSnapshot: {
            thresholdChars: 100_000,
            keepRecentToolResults: 5,
            placeholder: "[pruned]",
          },
          messages: rawMessages,
        },
        null,
        2,
      ),
      "utf8",
    );

    await engine.assemble({
      sessionId,
      messages: rawMessages,
      tokenBudget: 512,
    });

    const savedState = JSON.parse(fs.readFileSync(canonicalStatePath(sessionId), "utf8")) as {
      contextSafeSessionIndex?: {
        goals?: string[];
        recentConclusions?: string[];
      };
    };

    expect(savedState.contextSafeSessionIndex).toEqual({
      goals: ["Goal: rebuild the missing index."],
      recentConclusions: ["Conclusion: legacy state loaded."],
      openThreads: [],
      keyArtifacts: [],
      activePlans: [],
      protectedReads: [],
      recentReports: [],
      recoveryHints: [],
    });
  });

  it("persists compact child-completion summaries instead of raw injected blobs", async () => {
    const engine = createContextSafeContextEngine();
    const sessionId = "session-runtime-churn-child";
    const rawMessages = [
      { role: "user", content: "check the child result" },
      childCompletionInjectionMessage(),
    ];

    await engine.assemble({
      sessionId,
      messages: rawMessages,
      tokenBudget: 512,
    });

    const savedState = JSON.parse(fs.readFileSync(canonicalStatePath(sessionId), "utf8")) as {
      messages: Array<{ content?: unknown }>;
    };
    expect(textOf(savedState.messages[1])).toContain(
      "Child task completion (success): runtime-churn-slimming",
    );
    expect(textOf(savedState.messages[1])).toContain(
      "reports/context-safe-runtime-churn-slimming-2026-03-24/index.md",
    );
    expect(textOf(savedState.messages[1])).not.toContain("BEGIN_UNTRUSTED_CHILD_RESULT");

    const secondResult = await engine.assemble({
      sessionId,
      messages: [
        { role: "user", content: "check the child result" },
        {
          ...childCompletionInjectionMessage(),
          content: [
            {
              type: "text",
              text: [
                "[Internal task completion event]",
                "Task label: runtime-churn-slimming",
                "<<<BEGIN_UNTRUSTED_CHILD_RESULT>>>",
                "RAW UPSTREAM HISTORY SHOULD NOT REPLACE THE CANONICAL SUMMARY",
                "<<<END_UNTRUSTED_CHILD_RESULT>>>",
              ].join("\n"),
            },
          ],
        },
      ],
      tokenBudget: 512,
    });

    const secondTexts = secondResult.messages.map((message) => textOf(message));
    expect(
      secondTexts.find((text) =>
        text.includes("Child task completion (success): runtime-churn-slimming"),
      ),
    ).toContain("Child task completion (success): runtime-churn-slimming");
    expect(secondTexts.join("\n")).not.toContain(
      "RAW UPSTREAM HISTORY SHOULD NOT REPLACE THE CANONICAL SUMMARY",
    );
  });

  it("normalizes newly appended Telegram direct-chat metadata during afterTurn sync", async () => {
    const engine = createContextSafeContextEngine();
    const sessionId = "session-runtime-churn-telegram";
    const baseMessages = [{ role: "assistant", content: [{ type: "text", text: "ready" }] }];
    const finalMessages = [...baseMessages, telegramDirectChatMetadataMessage()];

    await engine.assemble({
      sessionId,
      messages: baseMessages,
      tokenBudget: 512,
    });
    await engine.afterTurn({
      sessionId,
      sessionFile: "/tmp/runtime-churn-telegram.jsonl",
      messages: finalMessages,
      prePromptMessageCount: baseMessages.length,
    });

    const savedState = JSON.parse(fs.readFileSync(canonicalStatePath(sessionId), "utf8")) as {
      messages: Array<{ content?: unknown }>;
    };
    expect(textOf(savedState.messages[1])).toContain("Telegram direct chat metadata");
    expect(textOf(savedState.messages[1])).toContain("Please continue from the last result.");
    expect(textOf(savedState.messages[1])).not.toContain(
      "Conversation info (untrusted metadata)",
    );
  });

  it("normalizes newly appended Feishu direct-chat metadata during afterTurn sync", async () => {
    const engine = createContextSafeContextEngine();
    const sessionId = "session-runtime-churn-feishu";
    const baseMessages = [{ role: "assistant", content: [{ type: "text", text: "ready" }] }];
    const finalMessages = [...baseMessages, feishuDirectChatMetadataMessage()];

    await engine.assemble({
      sessionId,
      messages: baseMessages,
      tokenBudget: 512,
    });
    await engine.afterTurn({
      sessionId,
      sessionFile: "/tmp/runtime-churn-feishu.jsonl",
      messages: finalMessages,
      prePromptMessageCount: baseMessages.length,
    });

    const savedState = JSON.parse(fs.readFileSync(canonicalStatePath(sessionId), "utf8")) as {
      messages: Array<{ content?: unknown }>;
    };
    expect(textOf(savedState.messages[1])).toContain("Feishu direct chat metadata");
    expect(textOf(savedState.messages[1])).toContain("请基于上一轮结果继续。");
    expect(textOf(savedState.messages[1])).not.toContain("会话信息（不可信元数据）");
  });

  it("persists report-aware summaries in canonical state after sync", async () => {
    const engine = createContextSafeContextEngine();
    const sessionId = "session-report-aware-summary";

    await engine.assemble({
      sessionId,
      messages: [
        { role: "user", content: "capture the rollout result" },
        reportAwareSummaryMessage(),
      ],
      tokenBudget: 512,
    });

    const savedState = JSON.parse(fs.readFileSync(canonicalStatePath(sessionId), "utf8")) as {
      messages: Array<{ content?: unknown }>;
    };
    expect(textOf(savedState.messages[1])).toContain("context-safe canonical policy v2");
    expect(textOf(savedState.messages[1])).toContain("Verdict: pass");
    expect(textOf(savedState.messages[1])).toContain(
      "reports/context-safe-v2-canonical-policy-2026-03-24/index.md",
    );
    expect(textOf(savedState.messages[1])).toContain("updated src/report-aware-policy.ts");
    expect(textOf(savedState.messages[1])).toContain("updated src/context-engine.ts");
    expect(textOf(savedState.messages[1])).toContain("verified vitest + tsc");
    expect(textOf(savedState.messages[1])).not.toContain("extra noisy bullet should be dropped");
  });

  it("summarizes newly appended report-aware messages during afterTurn sync", async () => {
    const engine = createContextSafeContextEngine();
    const sessionId = "session-report-aware-append";
    const baseMessages = [{ role: "assistant", content: [{ type: "text", text: "ready" }] }];
    const finalMessages = [...baseMessages, reportAwareSummaryMessage()];

    await engine.assemble({
      sessionId,
      messages: baseMessages,
      tokenBudget: 512,
    });
    await engine.afterTurn({
      sessionId,
      sessionFile: "/tmp/report-aware-append.jsonl",
      messages: finalMessages,
      prePromptMessageCount: baseMessages.length,
    });

    const savedState = JSON.parse(fs.readFileSync(canonicalStatePath(sessionId), "utf8")) as {
      messages: Array<{ content?: unknown }>;
    };
    expect(textOf(savedState.messages[1])).toContain("context-safe canonical policy v2");
    expect(textOf(savedState.messages[1])).toContain("Verdict: pass");
    expect(textOf(savedState.messages[1])).toContain(
      "reports/context-safe-v2-canonical-policy-2026-03-24/index.md",
    );
    expect(textOf(savedState.messages[1])).not.toContain("extra noisy bullet should be dropped");
  });

  it("slims direct-chat wrapper history more than a modest background-subagent transcript", async () => {
    const engine = createContextSafeContextEngine();
    const directSessionId = "session-mode-direct-slim";
    const backgroundSessionId = "session-mode-background-modest";

    await engine.assemble({
      sessionId: directSessionId,
      messages: [
        telegramDirectChatMetadataMessage(),
        telegramDirectChatMetadataMessage(),
        telegramDirectChatMetadataMessage(),
      ],
      tokenBudget: 512,
    });
    await engine.assemble({
      sessionId: backgroundSessionId,
      messages: [
        backgroundProgressChatterMessage("status: still working"),
        backgroundCompletionResidueMessage(
          "background-modest",
          "reports/context-safe-background-modest-2026-03-24/index.md",
        ),
      ],
      tokenBudget: 512,
    });

    const directState = JSON.parse(fs.readFileSync(canonicalStatePath(directSessionId), "utf8")) as {
      sessionMode?: string;
      messages: Array<{ content?: unknown }>;
    };
    const backgroundState = JSON.parse(
      fs.readFileSync(canonicalStatePath(backgroundSessionId), "utf8"),
    ) as {
      sessionMode?: string;
      messages: Array<{ content?: unknown }>;
    };

    expect(directState.sessionMode).toBe("direct-chat");
    expect(backgroundState.sessionMode).toBe("background-subagent");
    expect(canonicalCharCount(directState.messages)).toBeLessThan(
      canonicalCharCount(backgroundState.messages),
    );
  });

  it("detects both Telegram and Feishu wrapper histories as direct-chat sessions", async () => {
    const engine = createContextSafeContextEngine();
    const telegramSessionId = "session-mode-direct-telegram";
    const feishuSessionId = "session-mode-direct-feishu";

    await engine.assemble({
      sessionId: telegramSessionId,
      messages: [
        telegramDirectChatMetadataMessage(),
        telegramDirectChatMetadataMessage(),
      ],
      tokenBudget: 512,
    });
    await engine.assemble({
      sessionId: feishuSessionId,
      messages: [
        feishuDirectChatMetadataMessage(),
        feishuDirectChatMetadataMessage(),
      ],
      tokenBudget: 512,
    });

    const telegramState = JSON.parse(fs.readFileSync(canonicalStatePath(telegramSessionId), "utf8")) as {
      sessionMode?: string;
      messages: Array<{ content?: unknown }>;
    };
    const feishuState = JSON.parse(fs.readFileSync(canonicalStatePath(feishuSessionId), "utf8")) as {
      sessionMode?: string;
      messages: Array<{ content?: unknown }>;
    };

    expect(telegramState.sessionMode).toBe("direct-chat");
    expect(feishuState.sessionMode).toBe("direct-chat");
    expect(telegramState.messages).toHaveLength(1);
    expect(feishuState.messages).toHaveLength(1);
    expect(textOf(telegramState.messages[0])).toContain("Telegram direct chat metadata");
    expect(textOf(feishuState.messages[0])).toContain("Feishu direct chat metadata");
  });

  it("collapses background-subagent completion residue more aggressively than direct-chat history", async () => {
    const engine = createContextSafeContextEngine();
    const directSessionId = "session-mode-direct-noisy";
    const backgroundSessionId = "session-mode-background-strong";

    await engine.assemble({
      sessionId: directSessionId,
      messages: [
        telegramDirectChatMetadataMessage(),
        { role: "user", content: "Please continue from the last result." },
      ],
      tokenBudget: 512,
    });
    await engine.assemble({
      sessionId: backgroundSessionId,
      messages: [
        backgroundProgressChatterMessage("status: still working"),
        backgroundProgressChatterMessage("debug progress"),
        backgroundProgressChatterMessage("running verification"),
        backgroundCompletionResidueMessage(
          "background-worker-1",
          "reports/context-safe-background-worker-1-2026-03-24/index.md",
        ),
        backgroundCompletionResidueMessage(
          "background-worker-2",
          "reports/context-safe-background-worker-2-2026-03-24/index.md",
        ),
        backgroundCompletionResidueMessage(
          "background-worker-final",
          "reports/context-safe-background-worker-final-2026-03-24/index.md",
        ),
      ],
      tokenBudget: 512,
    });

    const directState = JSON.parse(fs.readFileSync(canonicalStatePath(directSessionId), "utf8")) as {
      sessionMode?: string;
      messages: Array<{ content?: unknown }>;
    };
    const backgroundState = JSON.parse(
      fs.readFileSync(canonicalStatePath(backgroundSessionId), "utf8"),
    ) as {
      sessionMode?: string;
      messages: Array<{ content?: unknown }>;
    };

    expect(directState.sessionMode).toBe("direct-chat");
    expect(backgroundState.sessionMode).toBe("background-subagent");
    expect(backgroundState.messages.length).toBeLessThan(directState.messages.length);
    expect(canonicalCharCount(backgroundState.messages)).toBeLessThan(
      canonicalCharCount(directState.messages),
    );
  });

  it("collapses acp-run progress chatter while preserving the final verdict and report path", async () => {
    const engine = createContextSafeContextEngine();
    const sessionId = "session-mode-acp-run";

    await engine.assemble({
      sessionId,
      messages: [
        acpRunHeaderMessage(),
        acpRunProgressChatterMessage("status: still working"),
        acpRunProgressChatterMessage("debug progress"),
        reportAwareSummaryMessage(),
      ],
      tokenBudget: 512,
    });

    const savedState = JSON.parse(fs.readFileSync(canonicalStatePath(sessionId), "utf8")) as {
      sessionMode?: string;
      messages: Array<{ content?: unknown }>;
    };
    const transcript = savedState.messages.map((message) => textOf(message)).join("\\n");

    expect(savedState.sessionMode).toBe("acp-run");
    expect(transcript).toContain("Verdict: pass");
    expect(transcript).toContain("reports/context-safe-v2-canonical-policy-2026-03-24/index.md");
    expect(transcript).not.toContain("status: still working");
    expect(transcript).not.toContain("debug progress");
  });

  it("leaves non-matching messages unchanged when syncing canonical state", async () => {
    const engine = createContextSafeContextEngine();
    const sessionId = "session-runtime-churn-plain";
    const rawMessages = [
      { role: "user", content: "plain user prompt" },
      { role: "assistant", content: [{ type: "text", text: "plain assistant reply" }] },
    ];

    await engine.assemble({
      sessionId,
      messages: rawMessages,
      tokenBudget: 512,
    });

    const savedState = JSON.parse(fs.readFileSync(canonicalStatePath(sessionId), "utf8")) as {
      messages: Array<{ role?: string; content?: unknown }>;
    };
    expect(savedState.messages).toEqual(rawMessages);
  });
});

function textOf(message: unknown): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter(
      (block) =>
        !!block && typeof block === "object" && (block as { type?: unknown }).type === "text",
    )
    .map((block) => String((block as { text?: unknown }).text ?? ""))
    .join("\n");
}

function canonicalMessages(input: {
  thinkingChars: number;
  thinkingOnlyChars: number;
  oldToolTextChars: number;
  oldToolDetailsChars: number;
}) {
  return [
    { role: "user", content: "summarize the run" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "working through prior context" },
        { type: "thinking", thinking: "t".repeat(input.thinkingChars) },
      ],
    },
    {
      role: "toolResult",
      toolName: "exec",
      toolCallId: "old-tool-1",
      content: [{ type: "text", text: "a".repeat(input.oldToolTextChars) }],
      details: { raw: "d".repeat(input.oldToolDetailsChars) },
    },
    {
      role: "assistant",
      content: [{ type: "thinking", thinking: "u".repeat(input.thinkingOnlyChars) }],
    },
    {
      role: "toolResult",
      toolName: "read",
      toolCallId: "old-tool-2",
      content: [{ type: "text", text: "b".repeat(input.oldToolTextChars) }],
      details: { raw: "e".repeat(input.oldToolDetailsChars) },
    },
    { role: "assistant", content: [{ type: "text", text: "continuing" }] },
    {
      role: "toolResult",
      toolName: "exec",
      toolCallId: "recent-tool-1",
      content: [{ type: "text", text: "recent tool result 1" }],
    },
    {
      role: "toolResult",
      toolName: "read",
      toolCallId: "recent-tool-2",
      content: [{ type: "text", text: "recent tool result 2" }],
    },
  ];
}

function defaultWindowCanonicalMessages(input: {
  thinkingChars: number;
  thinkingOnlyChars: number;
  oldToolTextChars: number;
  oldToolDetailsChars: number;
}) {
  return [
    { role: "user", content: "summarize the run" },
    {
      role: "assistant",
      content: [{ type: "thinking", thinking: "t".repeat(input.thinkingChars) }],
    },
    {
      role: "toolResult",
      toolName: "read",
      toolCallId: "head-tool-1",
      content: [{ type: "text", text: "head protected tool result 1" }],
      details: { raw: "h".repeat(input.oldToolDetailsChars) },
    },
    { role: "assistant", content: [{ type: "text", text: "head context" }] },
    {
      role: "toolResult",
      toolName: "exec",
      toolCallId: "head-tool-2",
      content: [{ type: "text", text: "head protected tool result 2" }],
      details: { raw: "i".repeat(input.oldToolDetailsChars) },
    },
    {
      role: "assistant",
      content: [{ type: "thinking", thinking: "u".repeat(input.thinkingOnlyChars) }],
    },
    {
      role: "toolResult",
      toolName: "exec",
      toolCallId: "middle-tool-1",
      content: [{ type: "text", text: "a".repeat(input.oldToolTextChars) }],
      details: { raw: "d".repeat(input.oldToolDetailsChars) },
    },
    { role: "assistant", content: [{ type: "text", text: "middle context" }] },
    {
      role: "toolResult",
      toolName: "read",
      toolCallId: "middle-tool-2",
      content: [{ type: "text", text: "b".repeat(input.oldToolTextChars) }],
      details: { raw: "e".repeat(input.oldToolDetailsChars) },
    },
    { role: "assistant", content: [{ type: "text", text: "tail warmup" }] },
    {
      role: "toolResult",
      toolName: "exec",
      toolCallId: "tail-tool-1",
      content: [{ type: "text", text: "tail protected tool result 1" }],
    },
    {
      role: "assistant",
      content: [{ type: "thinking", thinking: "v".repeat(input.thinkingChars) }],
    },
    {
      role: "toolResult",
      toolName: "read",
      toolCallId: "tail-tool-2",
      content: [{ type: "text", text: "tail protected tool result 2" }],
    },
    { role: "assistant", content: [{ type: "text", text: "tail context" }] },
  ];
}

function replaceHistoricalNoise(
  messages: ReturnType<typeof canonicalMessages>,
  input: { oldTool1Text: string; oldTool2Text: string },
) {
  return messages.map((message, index) => {
    if (index === 2) {
      return {
        ...message,
        content: [{ type: "text", text: input.oldTool1Text }],
      };
    }
    if (index === 4) {
      return {
        ...message,
        content: [{ type: "text", text: input.oldTool2Text }],
      };
    }
    return message;
  });
}

function appendNewCanonicalGrowth(
  messages: ReturnType<typeof canonicalMessages>,
  input: { thinkingChars: number; toolTextChars: number; toolDetailsChars: number },
) {
  return [
    ...messages,
    {
      role: "assistant",
      content: [
        { type: "text", text: "new turn in progress" },
        { type: "thinking", thinking: "n".repeat(input.thinkingChars) },
      ],
    },
    {
      role: "toolResult",
      toolName: "exec",
      toolCallId: "new-tool-1",
      content: [{ type: "text", text: "x".repeat(input.toolTextChars) }],
      details: { raw: "f".repeat(input.toolDetailsChars) },
    },
    { role: "assistant", content: [{ type: "text", text: "still working" }] },
    {
      role: "toolResult",
      toolName: "read",
      toolCallId: "new-tool-2",
      content: [{ type: "text", text: "y".repeat(input.toolTextChars) }],
      details: { raw: "g".repeat(input.toolDetailsChars) },
    },
    {
      role: "toolResult",
      toolName: "exec",
      toolCallId: "latest-tool-1",
      content: [{ type: "text", text: "latest tool result 1" }],
    },
    {
      role: "toolResult",
      toolName: "read",
      toolCallId: "latest-tool-2",
      content: [{ type: "text", text: "latest tool result 2" }],
    },
  ];
}

function childCompletionInjectionMessage() {
  return {
    role: "assistant",
    content: [
      {
        type: "text",
        text: [
          "[Internal task completion event]",
          "Task label: runtime-churn-slimming",
          "<<<BEGIN_UNTRUSTED_CHILD_RESULT>>>",
          "Implemented runtime churn slimming.",
          "- updated src/config.ts",
          "- added src/runtime-churn-policy.ts",
          "- wrote reports/context-safe-runtime-churn-slimming-2026-03-24/index.md",
          "<<<END_UNTRUSTED_CHILD_RESULT>>>",
        ].join("\n"),
      },
    ],
  };
}

function reportAwareSummaryMessage() {
  return {
    role: "assistant",
    content: [
      {
        type: "text",
        text: [
          "Task: context-safe canonical policy v2",
          "Verdict: pass",
          "Report: reports/context-safe-v2-canonical-policy-2026-03-24/index.md",
          "- updated src/report-aware-policy.ts",
          "- updated src/context-engine.ts",
          "- verified vitest + tsc",
          "- extra noisy bullet should be dropped",
        ].join("\n"),
      },
    ],
  };
}

function backgroundProgressChatterMessage(text: string) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
  };
}

function backgroundCompletionResidueMessage(label: string, reportPath: string) {
  return {
    role: "assistant",
    content: [
      {
        type: "text",
        text: [
          `[runtime-churn normalized] Child task completion (success): ${label}`,
          `Report: ${reportPath}`,
          `Key points: finalized ${label}; verified vitest; wrote ${reportPath}`,
        ].join("\\n"),
      },
    ],
  };
}

function acpRunHeaderMessage() {
  return {
    role: "assistant",
    content: [
      {
        type: "text",
        text: [
          "OpenAI Codex v0.116.0 (research preview)",
          "workdir: /Users/programcaicai/clawd/projects/openclaw-context-safe-plugin",
          "model: gpt-5.4",
          "approval: never",
          "sandbox: danger-full-access",
        ].join("\\n"),
      },
    ],
  };
}

function acpRunProgressChatterMessage(text: string) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
  };
}

function telegramDirectChatMetadataMessage() {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: [
          "Conversation info (untrusted metadata)",
          '{"channel":"telegram","chat_type":"direct","chat_id":"440811495","thread_id":"dm"}',
          "Sender (untrusted metadata)",
          '{"id":"440811495","display_name":"编程菜菜","username":"programcaicai"}',
          "Please continue from the last result.",
        ].join("\n"),
      },
    ],
  };
}

function feishuDirectChatMetadataMessage() {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: [
          "会话信息（不可信元数据）",
          '{"channel":"feishu","chat_type":"p2p","chat_id":"ou_123456","thread_id":"p2p"}',
          "发送者（不可信元数据）",
          '{"id":"ou_123456","display_name":"编程菜菜","user_id":"u_987654"}',
          "请基于上一轮结果继续。",
        ].join("\n"),
      },
    ],
  };
}

function canonicalStatePath(sessionId: string): string {
  return path.join(artifactDir, "session-state", `${sessionId}.json`);
}

function writeTranscript(sessionFile: string, messages: Array<Record<string, unknown>>) {
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(
    sessionFile,
    messages.map((message) => JSON.stringify({ type: "message", message })).join("\n") + "\n",
    "utf8",
  );
}

function countThinkingBlocks(messages: Array<{ content?: unknown }>): number {
  return messages.reduce((sum, message) => {
    if (!Array.isArray(message.content)) {
      return sum;
    }
    return (
      sum +
      message.content.filter(
        (block) =>
          !!block && typeof block === "object" && (block as { type?: unknown }).type === "thinking",
      ).length
    );
  }, 0);
}

function toolResultTexts(messages: Array<{ role?: string; content?: unknown }>): string[] {
  return messages.filter((message) => message.role === "toolResult").map((message) => textOf(message));
}

function canonicalCharCount(messages: Array<{ content?: unknown }>): number {
  return messages.map((message) => textOf(message)).join("\n").length;
}

function toolResultDetails(messages: Array<{ role?: string; details?: unknown }>): unknown[] {
  return messages
    .filter((message) => message.role === "toolResult")
    .map((message) => message.details);
}
