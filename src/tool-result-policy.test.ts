import { describe, expect, it } from "vitest";
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
    expect(content).toContain("Use read with offset/limit for specific ranges.");
    expect(content).toContain("tool=read");
    expect((result.messages[0] as { details?: unknown }).details).toBeUndefined();
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
