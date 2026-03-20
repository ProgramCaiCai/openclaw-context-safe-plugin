import { describe, expect, it } from "vitest";
import * as policy from "./tool-result-policy.js";
import {
  CONTEXT_LIMIT_TRUNCATION_NOTICE,
  PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER,
  applyContextToolResultPolicy,
} from "./tool-result-policy.js";

describe("applyContextToolResultPolicy", () => {
  it("truncates an oversized read tool result and appends a recovery hint", () => {
    const result = applyContextToolResultPolicy({
      messages: [
        toolResult({
          toolName: "read",
          toolCallId: "call-1234567890",
          text: `${"header\n".repeat(6)}${"x".repeat(160)}`,
          details: { raw: "y".repeat(400) },
        }),
      ],
      contextWindowTokens: 32,
    });

    const content = textOf(result.messages[0]);
    expect(content).toContain(CONTEXT_LIMIT_TRUNCATION_NOTICE);
    expect(content).toContain("Rerun read with a narrower range");
    expect(content).toContain("head");
    expect(content).toContain("tail");
    expect(content).toContain("jq");
    expect((result.messages[0] as { details?: unknown }).details).toBeUndefined();
  });

  it("truncates an oversized web_fetch result and suggests curl plus read", () => {
    const result = applyContextToolResultPolicy({
      messages: [
        toolResult({
          toolName: "web_fetch",
          toolCallId: "call-web-fetch-1",
          text: "f".repeat(320),
          details: { raw: "d".repeat(400) },
        }),
      ],
      contextWindowTokens: 32,
    });

    const content = textOf(result.messages[0]);
    expect(content).toContain(CONTEXT_LIMIT_TRUNCATION_NOTICE);
    expect(content).toContain("curl");
    expect(content).toContain("read");
    expect(content).toContain("save the response to a file");
  });

  it("leaves in-budget tool results untouched and without truncation notices", () => {
    const original = toolResult({
      toolName: "read",
      text: "line 1\nline 2\nline 3",
      details: { lineCount: 3 },
    });

    const result = applyContextToolResultPolicy({
      messages: [original],
      contextWindowTokens: 512,
    });

    expect(result.messages).toEqual([original]);
    expect(textOf(result.messages[0])).not.toContain(CONTEXT_LIMIT_TRUNCATION_NOTICE);
  });

  it("compacts older tool results first when aggregate context exceeds the budget", () => {
    const result = applyContextToolResultPolicy({
      messages: [
        userMessage("summarize the logs"),
        toolResult({ toolName: "exec", text: "a".repeat(90) }),
        assistantMessage("looking"),
        toolResult({ toolName: "exec", text: "b".repeat(90) }),
      ],
      contextWindowTokens: 36,
    });

    expect(textOf(result.messages[1])).toContain(PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER);
    expect(textOf(result.messages[3])).not.toContain(PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER);
  });

  it("keeps non-tool messages unchanged", () => {
    const messages = [userMessage("hi"), assistantMessage("hello")];

    const result = applyContextToolResultPolicy({
      messages,
      contextWindowTokens: 128,
    });

    expect(result.messages).toEqual(messages);
  });
});

function userMessage(text: string) {
  return {
    role: "user",
    content: text,
  };
}

function assistantMessage(text: string) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
  };
}

function toolResult(input: {
  toolName?: string;
  toolCallId?: string;
  text: string;
  details?: unknown;
}) {
  return {
    role: "toolResult",
    toolName: input.toolName,
    toolCallId: input.toolCallId,
    content: [{ type: "text", text: input.text }],
    details: input.details,
  };
}

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

describe("prune threshold gating", () => {
  it("skips prune when gain stays below an explicit 50000 threshold", () => {
    const messages = canonicalMessages({
      thinkingChars: 8_000,
      thinkingOnlyChars: 8_000,
      oldToolTextChars: 5_000,
      oldToolDetailsChars: 2_000,
    });
    const gain = policy.estimatePruneGain({
      messages,
      thresholdChars: 50_000,
      keepRecentToolResults: 2,
      placeholder: "[pruned]",
    });

    expect(gain).toBeGreaterThan(25_000);
    expect(gain).toBeLessThan(50_000);

    const result = policy.applyCanonicalPrune({
      messages,
      thresholdChars: 50_000,
      keepRecentToolResults: 2,
      placeholder: "[pruned]",
    });

    expect(result.messages).toEqual(messages);
  });

  it("does not fire prune when the configured threshold stays above the estimated gain", () => {
    const messages = canonicalMessages({
      thinkingChars: 8_000,
      thinkingOnlyChars: 8_000,
      oldToolTextChars: 5_000,
      oldToolDetailsChars: 2_000,
    });
    const gain = policy.estimatePruneGain({
      messages,
      thresholdChars: 50_000,
      keepRecentToolResults: 2,
      placeholder: "[pruned]",
    });

    expect(gain).toBeLessThan(50_000);

    const result = policy.applyCanonicalPrune({
      messages,
      thresholdChars: 50_000,
      keepRecentToolResults: 2,
      placeholder: "[pruned]",
    });

    expect(result.messages).toEqual(messages);
  });

  it("fires prune when gain reaches the threshold and keeps exactly the two newest tool results inline", () => {
    const messages = canonicalMessages({
      thinkingChars: 16_000,
      thinkingOnlyChars: 16_000,
      oldToolTextChars: 9_000,
      oldToolDetailsChars: 5_000,
    });
    const gain = policy.estimatePruneGain({
      messages,
      thresholdChars: 50_000,
      keepRecentToolResults: 2,
      placeholder: "[pruned]",
    });

    expect(gain).toBeGreaterThanOrEqual(50_000);

    const result = policy.applyCanonicalPrune({
      messages,
      thresholdChars: 50_000,
      keepRecentToolResults: 2,
      placeholder: "[pruned]",
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
  });

  it("allows a custom threshold to override the default gate", () => {
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

    const defaultResult = policy.applyCanonicalPrune({
      messages: defaultMessages,
      thresholdChars: 50_000,
      keepRecentToolResults: 2,
      placeholder: "[pruned]",
    });
    const customResult = policy.applyCanonicalPrune({
      messages: customMessages,
      thresholdChars: 25_000,
      keepRecentToolResults: 2,
      placeholder: "[pruned]",
    });

    expect(defaultResult.messages).toEqual(defaultMessages);
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
});

function canonicalMessages(input: {
  thinkingChars: number;
  thinkingOnlyChars: number;
  oldToolTextChars: number;
  oldToolDetailsChars: number;
}) {
  return [
    userMessage("summarize the run"),
    {
      role: "assistant",
      content: [
        { type: "text", text: "working through prior context" },
        { type: "thinking", thinking: "t".repeat(input.thinkingChars) },
      ],
    },
    toolResult({
      toolName: "exec",
      toolCallId: "old-tool-1",
      text: "a".repeat(input.oldToolTextChars),
      details: { raw: "d".repeat(input.oldToolDetailsChars) },
    }),
    {
      role: "assistant",
      content: [{ type: "thinking", thinking: "u".repeat(input.thinkingOnlyChars) }],
    },
    toolResult({
      toolName: "read",
      toolCallId: "old-tool-2",
      text: "b".repeat(input.oldToolTextChars),
      details: { raw: "e".repeat(input.oldToolDetailsChars) },
    }),
    assistantMessage("continuing"),
    toolResult({
      toolName: "exec",
      toolCallId: "recent-tool-1",
      text: "recent tool result 1",
    }),
    toolResult({
      toolName: "read",
      toolCallId: "recent-tool-2",
      text: "recent tool result 2",
    }),
  ];
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
