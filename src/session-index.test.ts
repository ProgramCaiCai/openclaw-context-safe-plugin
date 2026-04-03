import { describe, expect, it } from "vitest";
import {
  buildContextSafeSessionIndex,
  buildContextSafeSessionIndexMessage,
} from "./session-index.js";

describe("buildContextSafeSessionIndex", () => {
  it("builds a bounded two-layer session index from canonical messages and context-safe metadata", () => {
    const index = buildContextSafeSessionIndex({
      messages: [
        {
          role: "user",
          content:
            "Goal: finish the managed context-safe upgrade and keep state stable. Plan: docs/plans/context-safe/plan.md",
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "Conclusion: persistence fallback is now recovery-safe." }],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "Next: wire observability into canonical state." }],
        },
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Recovery note: reread SOUL.md and AGENTS.md, then verify reports/context-safe/run-1/evidence.md.",
            },
          ],
        },
        {
          role: "toolResult",
          toolName: "exec",
          content: [{ type: "text", text: "artifact preview for build logs" }],
          details: {
            contextSafe: {
              resultMode: "artifact",
              outputFile: "/tmp/build-log.json",
            },
          },
        },
      ],
      summaryBoundary: {
        preservedTailHeadId: "msg-8",
      },
      lastCompactReason: "compact prune gain 120000",
    });

    expect(index.goals).toEqual([
      "Goal: finish the managed context-safe upgrade and keep state stable. Plan: docs/plans/context-safe/plan.md",
    ]);
    expect(index.recentConclusions).toEqual([
      "Conclusion: persistence fallback is now recovery-safe.",
    ]);
    expect(index.openThreads).toEqual([
      "Next: wire observability into canonical state.",
    ]);
    expect(index.keyArtifacts).toEqual([
      {
        toolName: "exec",
        resultMode: "artifact",
        pointer: "/tmp/build-log.json",
        preview: "artifact preview for build logs",
      },
    ]);
    expect(index.activePlans).toEqual(["docs/plans/context-safe/plan.md"]);
    expect(index.protectedReads).toEqual(["SOUL.md", "AGENTS.md"]);
    expect(index.recentReports).toEqual(["reports/context-safe/run-1/evidence.md"]);
    expect(index.summaryBoundary).toEqual({
      preservedTailHeadId: "msg-8",
    });
    expect(index.lastCompactReason).toBe("compact prune gain 120000");
    expect(index.recoveryHints).toHaveLength(1);
    expect(index.recoveryHints[0]).toContain("rerun a narrower command");
  });

  it("evicts stale entries beyond the bounded caps", () => {
    const index = buildContextSafeSessionIndex({
      messages: [
        { role: "user", content: "Goal: first" },
        { role: "user", content: "Goal: second" },
        { role: "user", content: "Goal: third" },
        { role: "user", content: "Goal: fourth" },
        { role: "assistant", content: [{ type: "text", text: "Conclusion: one" }] },
        { role: "assistant", content: [{ type: "text", text: "Conclusion: two" }] },
        { role: "assistant", content: [{ type: "text", text: "Conclusion: three" }] },
        { role: "assistant", content: [{ type: "text", text: "Conclusion: four" }] },
        { role: "assistant", content: [{ type: "text", text: "Next: one" }] },
        { role: "assistant", content: [{ type: "text", text: "Next: two" }] },
        { role: "assistant", content: [{ type: "text", text: "Next: three" }] },
        { role: "assistant", content: [{ type: "text", text: "Next: four" }] },
        toolArtifact("read", "/tmp/artifact-1.json"),
        toolArtifact("read", "/tmp/artifact-2.json"),
        toolArtifact("read", "/tmp/artifact-3.json"),
        toolArtifact("read", "/tmp/artifact-4.json"),
        toolArtifact("read", "/tmp/artifact-5.json"),
      ],
    });

    expect(index.goals).toEqual(["Goal: fourth", "Goal: third", "Goal: second"]);
    expect(index.recentConclusions).toEqual([
      "Conclusion: four",
      "Conclusion: three",
      "Conclusion: two",
    ]);
    expect(index.openThreads).toEqual(["Next: four", "Next: three", "Next: two"]);
    expect(index.keyArtifacts).toHaveLength(4);
    expect(index.keyArtifacts[0]?.pointer).toBe("/tmp/artifact-5.json");
    expect(index.keyArtifacts.at(-1)?.pointer).toBe("/tmp/artifact-2.json");
  });

  it("renders a bounded synthetic assemble message and minimizes it when the budget is tight", () => {
    const index = buildContextSafeSessionIndex({
      messages: [
        { role: "user", content: "Goal: fourth Plan: docs/plans/run-4.md" },
        { role: "assistant", content: [{ type: "text", text: "Conclusion: four" }] },
        { role: "assistant", content: [{ type: "text", text: "Next: four" }] },
        {
          role: "assistant",
          content: [{ type: "text", text: "Recovery note: inspect SOUL.md before reviewing reports/context-safe/run-4.md" }],
        },
        toolArtifact("exec", "/tmp/artifact-5.json"),
      ],
      summaryBoundary: {
        preservedTailHeadId: "msg-8",
      },
      lastCompactReason: "compact prune gain 120000",
    });

    const fullMessage = buildContextSafeSessionIndexMessage({
      index,
      maxChars: 600,
    });
    const minimalMessage = buildContextSafeSessionIndexMessage({
      index,
      maxChars: 180,
    });

    expect(textOf(fullMessage)).toContain("[context-safe session index]");
    expect(textOf(fullMessage)).toContain("Goal: fourth");
    expect(textOf(fullMessage)).toContain("/tmp/artifact-5.json");
    expect(textOf(fullMessage)).toContain("Active plans:");
    expect(textOf(fullMessage)).toContain("Protected reads:");
    expect(textOf(fullMessage)).toContain("Recent reports:");
    expect(textOf(fullMessage).length).toBeLessThanOrEqual(600);
    expect(textOf(minimalMessage)).toContain("[context-safe session index]");
    expect(textOf(minimalMessage)).not.toContain("Recovery hints:");
    expect(textOf(minimalMessage)).not.toContain("Protected reads:");
    expect(textOf(minimalMessage).length).toBeLessThanOrEqual(180);
  });
});

function toolArtifact(toolName: string, outputFile: string) {
  return {
    role: "toolResult",
    toolName,
    content: [{ type: "text", text: `${toolName} preview` }],
    details: {
      contextSafe: {
        resultMode: "artifact",
        outputFile,
      },
    },
  };
}

function textOf(message: { content?: unknown } | undefined): string {
  const content = message?.content;
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
