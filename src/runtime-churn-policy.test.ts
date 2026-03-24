import { describe, expect, it } from "vitest";
import { normalizeContextSafeEngineConfig } from "./config.js";
import { normalizeRuntimeChurnMessage } from "./runtime-churn-policy.js";

const defaultRuntimeChurn = normalizeContextSafeEngineConfig().runtimeChurn;

describe("runtime churn policy", () => {
  it("collapses compaction summary bloat into a short semantic summary with anchors", () => {
    const result = normalizeRuntimeChurnMessage(
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: [
              "Compaction summary for the last background round.",
              "Exact identifiers:",
              "- reports/context-safe-runtime-churn-slimming-2026-03-24/index.md",
              "- docs/plans/2026-03-24-context-safe-runtime-churn-slimming.md",
              "Done:",
              "- updated config surface",
              "- updated manifest",
              "- updated tests",
              "Recent turns preserved verbatim:",
              "1. very long preserved turn",
              "2. another long preserved turn",
            ].join("\n"),
          },
        ],
      },
      defaultRuntimeChurn,
    );

    expect(result.normalized).toBe(true);
    expect(result.kinds).toEqual(["compactionSummary"]);
    expect(textOf(result.message)).toContain("Compaction summary collapsed");
    expect(textOf(result.message)).toContain(
      "reports/context-safe-runtime-churn-slimming-2026-03-24/index.md",
    );
    expect(textOf(result.message)).toContain(
      "docs/plans/2026-03-24-context-safe-runtime-churn-slimming.md",
    );
    expect(textOf(result.message)).not.toContain("Recent turns preserved verbatim");
  });

  it("collapses internal child-result injections into task status, report, and key bullets", () => {
    const result = normalizeRuntimeChurnMessage(
      {
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
      },
      defaultRuntimeChurn,
    );

    expect(result.normalized).toBe(true);
    expect(result.kinds).toEqual(["childCompletionInjection"]);
    expect(textOf(result.message)).toContain("Child task completion (success): runtime-churn-slimming");
    expect(textOf(result.message)).toContain(
      "reports/context-safe-runtime-churn-slimming-2026-03-24/index.md",
    );
    expect(textOf(result.message)).toContain("updated src/config.ts");
    expect(textOf(result.message)).not.toContain("BEGIN_UNTRUSTED_CHILD_RESULT");
  });

  it("collapses repeated Telegram direct-chat metadata wrappers into one line", () => {
    const result = normalizeRuntimeChurnMessage(
      {
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
      },
      defaultRuntimeChurn,
    );

    expect(result.normalized).toBe(true);
    expect(result.kinds).toEqual(["telegramDirectChatMetadata"]);
    expect(textOf(result.message)).toContain("Telegram direct chat metadata");
    expect(textOf(result.message)).toContain("channel=telegram");
    expect(textOf(result.message)).toContain("sender=编程菜菜");
    expect(textOf(result.message)).toContain("Please continue from the last result.");
    expect(textOf(result.message)).not.toContain("Conversation info (untrusted metadata)");
  });

  it("leaves ordinary user prompts and tool results untouched", () => {
    const prompt = {
      role: "user",
      content: [{ type: "text", text: "Help me summarize the error log." }],
    };
    const toolResult = {
      role: "toolResult",
      toolName: "read",
      content: [{ type: "text", text: "short output" }],
    };

    expect(normalizeRuntimeChurnMessage(prompt, defaultRuntimeChurn)).toEqual({
      message: prompt,
      normalized: false,
      kinds: [],
    });
    expect(normalizeRuntimeChurnMessage(toolResult, defaultRuntimeChurn)).toEqual({
      message: toolResult,
      normalized: false,
      kinds: [],
    });
  });

  it("respects per-transform disable flags", () => {
    const result = normalizeRuntimeChurnMessage(
      {
        role: "user",
        content: [
          {
            type: "text",
            text: [
              "Conversation info (untrusted metadata)",
              '{"channel":"telegram","chat_type":"direct","chat_id":"440811495"}',
              "Sender (untrusted metadata)",
              '{"id":"440811495","display_name":"编程菜菜"}',
            ].join("\n"),
          },
        ],
      },
      {
        ...defaultRuntimeChurn,
        collapseDirectChatMetadata: false,
      },
    );

    expect(result.normalized).toBe(false);
    expect(result.kinds).toEqual([]);
  });
});

function textOf(message: { content?: unknown }): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  if (!Array.isArray(message.content)) {
    return "";
  }
  return message.content
    .filter(
      (block) =>
        !!block && typeof block === "object" && (block as { type?: unknown }).type === "text",
    )
    .map((block) => String((block as { text?: unknown }).text ?? ""))
    .join("\n");
}
