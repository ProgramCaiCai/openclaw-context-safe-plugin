import { describe, expect, it } from "vitest";
import { normalizeReportAwareMessage } from "./report-aware-policy.js";

describe("normalizeReportAwareMessage", () => {
  it("collapses report-backed verdict summaries to stable anchors only", () => {
    const result = normalizeReportAwareMessage({
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
    });

    expect(result.summarized).toBe(true);
    expect(textOf(result.message)).toContain("context-safe canonical policy v2");
    expect(textOf(result.message)).toContain("Verdict: pass");
    expect(textOf(result.message)).toContain(
      "reports/context-safe-v2-canonical-policy-2026-03-24/index.md",
    );
    expect(textOf(result.message)).toContain("updated src/report-aware-policy.ts");
    expect(textOf(result.message)).toContain("updated src/context-engine.ts");
    expect(textOf(result.message)).toContain("verified vitest + tsc");
    expect(textOf(result.message)).not.toContain("extra noisy bullet should be dropped");
  });

  it("does not over-collapse report path mentions without a conclusion", () => {
    const message = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: [
            "Artifacts live under reports/context-safe-v2-canonical-policy-2026-03-24/index.md",
            "Still collecting evidence before writing the conclusion.",
          ].join("\n"),
        },
      ],
    };

    const result = normalizeReportAwareMessage(message);

    expect(result.summarized).toBe(false);
    expect(result.message).toEqual(message);
  });

  it("leaves messages without report paths unchanged", () => {
    const message = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: [
            "No report exists yet.",
            "Still running verification.",
          ].join("\n"),
        },
      ],
    };

    const result = normalizeReportAwareMessage(message);

    expect(result.summarized).toBe(false);
    expect(result.message).toEqual(message);
  });
});

function textOf(message: { content?: unknown }): string {
  const content = message.content;
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
