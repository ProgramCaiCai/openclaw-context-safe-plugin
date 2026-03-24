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

  it("collapses Chinese report summaries with stable report anchors", () => {
    const result = normalizeReportAwareMessage({
      role: "assistant",
      content: [
        {
          type: "text",
          text: [
            "任务：context-safe 双语飞书收敛",
            "结论：通过",
            "报告：reports/context-safe-v2-bilingual-feishu-2026-03-24/index.md",
            "- 更新 src/report-aware-policy.ts",
            "- 更新 src/runtime-churn-policy.ts",
            "- 验证 vitest 与 tsc",
            "- 多余噪声应被丢弃",
          ].join("\n"),
        },
      ],
    });

    expect(result.summarized).toBe(true);
    expect(textOf(result.message)).toContain("任务：context-safe 双语飞书收敛");
    expect(textOf(result.message)).toContain("结论：通过");
    expect(textOf(result.message)).toContain(
      "报告：reports/context-safe-v2-bilingual-feishu-2026-03-24/index.md",
    );
    expect(textOf(result.message)).toContain("更新 src/report-aware-policy.ts");
    expect(textOf(result.message)).toContain("更新 src/runtime-churn-policy.ts");
    expect(textOf(result.message)).toContain("验证 vitest 与 tsc");
    expect(textOf(result.message)).not.toContain("多余噪声应被丢弃");
  });

  it("collapses mixed Chinese and English report fields together", () => {
    const result = normalizeReportAwareMessage({
      role: "assistant",
      content: [
        {
          type: "text",
          text: [
            "Task: context-safe bilingual follow-up",
            "状态：完成",
            "Report: reports/context-safe-v2-bilingual-feishu-2026-03-24/index.md",
            "- updated src/context-engine.ts",
            "- 验证 direct-chat mode",
            "- verified vitest + tsc",
            "- noisy trailing detail should be dropped",
          ].join("\n"),
        },
      ],
    });

    expect(result.summarized).toBe(true);
    expect(textOf(result.message)).toContain("Task: context-safe bilingual follow-up");
    expect(textOf(result.message)).toContain("状态：完成");
    expect(textOf(result.message)).toContain(
      "Report: reports/context-safe-v2-bilingual-feishu-2026-03-24/index.md",
    );
    expect(textOf(result.message)).toContain("updated src/context-engine.ts");
    expect(textOf(result.message)).toContain("验证 direct-chat mode");
    expect(textOf(result.message)).toContain("verified vitest + tsc");
    expect(textOf(result.message)).not.toContain("noisy trailing detail should be dropped");
  });

  it("preserves Chinese summary and key-point labels when bullets are absent", () => {
    const result = normalizeReportAwareMessage({
      role: "assistant",
      content: [
        {
          type: "text",
          text: [
            "摘要：飞书直聊包装折叠",
            "状态：完成",
            "报告：reports/context-safe-v2-bilingual-feishu-2026-03-24/index.md",
            "关键点：保留 channel=feishu；识别 chat_type=p2p；保持 direct-chat 模式",
          ].join("\n"),
        },
      ],
    });

    expect(result.summarized).toBe(true);
    expect(textOf(result.message)).toContain("摘要：飞书直聊包装折叠");
    expect(textOf(result.message)).toContain("状态：完成");
    expect(textOf(result.message)).toContain(
      "报告：reports/context-safe-v2-bilingual-feishu-2026-03-24/index.md",
    );
    expect(textOf(result.message)).toContain("保留 channel=feishu");
    expect(textOf(result.message)).toContain("识别 chat_type=p2p");
    expect(textOf(result.message)).toContain("保持 direct-chat 模式");
  });

  it("does not over-collapse Chinese report path mentions without verdict or status", () => {
    const message = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: [
            "报告会写到 reports/context-safe-v2-bilingual-feishu-2026-03-24/index.md",
            "还在继续取证，尚未给出结论。",
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
