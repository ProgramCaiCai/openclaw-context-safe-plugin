import { describe, expect, it } from "vitest";
import { createContextSafeContextEngine } from "./context-engine.js";
import {
  CONTEXT_LIMIT_TRUNCATION_NOTICE,
  PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER,
} from "./tool-result-policy.js";

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

  it("reports compaction as a no-op so core fallback remains available", async () => {
    const engine = createContextSafeContextEngine();

    await expect(
      engine.compact({
        sessionId: "session-3",
        sessionFile: "/tmp/session.jsonl",
        tokenBudget: 100,
      }),
    ).resolves.toEqual({
      ok: true,
      compacted: false,
      reason: "context-safe assemble-only engine",
    });
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
