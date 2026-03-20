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

  it("compacts canonical state from the session transcript for manual compact requests", async () => {
    const info = vi.fn();
    const engine = createContextSafeContextEngine({
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
  it("prunes canonical transcript during assemble when default threshold gain exceeds 50000", async () => {
    const info = vi.fn();
    const engine = createContextSafeContextEngine({
      logger: { info },
    });

    const result = await engine.assemble({
      sessionId: "session-default-prune",
      messages: canonicalMessages({
        thinkingChars: 16_000,
        thinkingOnlyChars: 16_000,
        oldToolTextChars: 9_000,
        oldToolDetailsChars: 5_000,
      }),
      tokenBudget: 30_000,
    });

    expect(countThinkingBlocks(result.messages)).toBe(0);
    expect(toolResultTexts(result.messages)).toEqual([
      "[pruned]",
      "[pruned]",
      "recent tool result 1",
      "recent tool result 2",
    ]);
    expect(toolResultDetails(result.messages)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(info).toHaveBeenCalledWith(expect.stringContaining("context-safe prune triggered"));
    expect(info).toHaveBeenCalledWith(expect.stringContaining("source=assemble"));
  });

  it("honors custom threshold overrides during assemble", async () => {
    const defaultEngine = createContextSafeContextEngine();
    const customEngine = createContextSafeContextEngine({
      prune: {
        thresholdChars: 25_000,
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

    expect(countThinkingBlocks(customResult.messages)).toBe(0);
    expect(toolResultTexts(customResult.messages)).toEqual([
      "[pruned]",
      "[pruned]",
      "recent tool result 1",
      "recent tool result 2",
    ]);
    expect(toolResultDetails(customResult.messages)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("persists canonical state on first prune and reuses it on later assemble calls for the same session", async () => {
    const engine = createContextSafeContextEngine();
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
    const engine = createContextSafeContextEngine();
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

  it("prunes and persists canonical state during afterTurn for growth-heavy final turns", async () => {
    const info = vi.fn();
    const engine = createContextSafeContextEngine({
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
      messages: Array<{ role?: string; content?: unknown; details?: unknown }>;
    };

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

function toolResultDetails(messages: Array<{ role?: string; details?: unknown }>): unknown[] {
  return messages
    .filter((message) => message.role === "toolResult")
    .map((message) => message.details);
}
