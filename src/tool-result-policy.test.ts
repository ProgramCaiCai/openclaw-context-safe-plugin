import { describe, expect, it } from "vitest";
import * as policy from "./tool-result-policy.js";
import {
  CONTEXT_LIMIT_TRUNCATION_NOTICE,
  PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER,
  applyContextToolResultPolicy,
  classifyCanonicalRetentionTier,
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

  it("preserves read results ahead of exec results when aggregate context is tight", () => {
    const result = applyContextToolResultPolicy({
      messages: [
        userMessage("compare the file read and command output"),
        toolResult({ toolName: "read", text: "r".repeat(90) }),
        assistantMessage("working"),
        toolResult({ toolName: "exec", text: "e".repeat(90) }),
      ],
      contextWindowTokens: 36,
    });

    expect(textOf(result.messages[1])).not.toContain(PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER);
    expect(textOf(result.messages[3])).toContain(PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER);
  });

  it("compacts already externalized fallback results before inline read results", () => {
    const result = applyContextToolResultPolicy({
      messages: [
        userMessage("keep the file read visible"),
        toolResult({
          toolName: "read",
          text: "r".repeat(90),
          details: {
            contextSafe: {
              resultMode: "inline",
            },
          },
        }),
        assistantMessage("working"),
        toolResult({
          toolName: "exec",
          text: "e".repeat(90),
          details: {
            contextSafe: {
              resultMode: "inline-fallback",
            },
          },
        }),
      ],
      contextWindowTokens: 36,
    });

    expect(textOf(result.messages[1])).not.toContain(PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER);
    expect(textOf(result.messages[3])).toContain(PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER);
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

function assistantWithThinking(thinking: string) {
  return {
    role: "assistant",
    content: [{ type: "thinking", thinking }],
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

function assistantToolUse(toolName: string, toolCallId: string, input: Record<string, unknown>) {
  return {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        name: toolName,
        id: toolCallId,
        input,
      },
    ],
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

  it("fires prune when gain reaches the threshold and preserves the protected window", () => {
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

    expect(countThinkingBlocks(result.messages)).toBe(1);
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
    expect(countThinkingBlocks(customResult.messages)).toBe(1);
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

  it("counts and prunes assistant reasoning blocks the same as thinking blocks", () => {
    const messages = [
      userMessage("summarize"),
      {
        role: "assistant",
        content: [
          { type: "text", text: "working" },
          { type: "reasoning", thinking: "r".repeat(12_000) },
        ],
      },
      toolResult({
        toolName: "exec",
        toolCallId: "old-tool-1",
        text: "a".repeat(9_000),
        details: { raw: "d".repeat(5_000) },
      }),
      {
        role: "assistant",
        content: [{ type: "reasoning", thinking: "s".repeat(12_000) }],
      },
      toolResult({
        toolName: "read",
        toolCallId: "old-tool-2",
        text: "b".repeat(9_000),
        details: { raw: "e".repeat(5_000) },
      }),
      assistantMessage("middle context"),
      userMessage("follow-up"),
      assistantMessage("still going"),
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

    expect(countThinkingBlocks(result.messages)).toBe(1);
    expect(textOf(result.messages[1])).toBe("working");
    expect(textOf(result.messages[3])).toBe("");
    expect(toolResultTexts(result.messages)).toEqual([
      "[pruned]",
      "[pruned]",
      "recent tool result 1",
      "recent tool result 2",
    ]);
  });

  it("protects head and tail windows plus basename-matched read messages and linked tool results", () => {
    const messages = [
      userMessage("session start"),
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "head-thinking" }],
      },
      toolResult({
        toolName: "exec",
        toolCallId: "old-tool-1",
        text: "legacy result 1",
        details: { raw: "a".repeat(4_000) },
      }),
      assistantMessage("head context"),
      assistantToolUse("read", "head-read-call", { path: "/repo/.codex/skills/example/SKILL.md" }),
      toolResult({
        toolName: "read",
        toolCallId: "head-read-call",
        text: "head protected read result",
        details: { raw: "b".repeat(4_000) },
      }),
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "middle-thinking" }],
      },
      assistantToolUse("read", "middle-read-call", { path: "/tmp/policies/agents.MD" }),
      toolResult({
        toolName: "read",
        toolCallId: "middle-read-call",
        text: "middle protected read result",
        details: { raw: "c".repeat(4_000) },
      }),
      toolResult({
        toolName: "exec",
        toolCallId: "old-tool-2",
        text: "legacy result 2",
        details: { raw: "d".repeat(4_000) },
      }),
      toolResult({
        toolName: "read",
        toolCallId: "tail-read-call",
        text: "tail protected read result",
        details: { raw: "e".repeat(4_000) },
      }),
      assistantToolUse("read", "tail-read-call", { path: "/tmp/runtime/Today.md" }),
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "tail-thinking" }],
      },
      toolResult({
        toolName: "exec",
        toolCallId: "recent-tool-1",
        text: "recent tool result 1",
      }),
      assistantMessage("session end"),
      toolResult({
        toolName: "read",
        toolCallId: "recent-tool-2",
        text: "recent tool result 2",
      }),
    ];

    const result = policy.applyCanonicalPrune({
      messages,
      thresholdChars: 1,
      keepRecentToolResults: 5,
      placeholder: "[pruned]",
    });

    expect(result.pruned).toBe(true);
    expect(countThinkingBlocks(result.messages)).toBe(2);
    expect(textOf(result.messages[2])).toBe("legacy result 1");
    expect(textOf(result.messages[5])).toBe("head protected read result");
    expect(textOf(result.messages[8])).toBe("middle protected read result");
    expect(textOf(result.messages[9])).toBe("[pruned]");
    expect(textOf(result.messages[10])).toBe("tail protected read result");
    expect(textOf(result.messages[13])).toBe("recent tool result 1");
    expect(textOf(result.messages[15])).toBe("recent tool result 2");
    expect((result.messages[2] as { details?: unknown }).details).toEqual({
      raw: "a".repeat(4_000),
    });
    expect((result.messages[5] as { details?: unknown }).details).toEqual({
      raw: "b".repeat(4_000),
    });
    expect((result.messages[8] as { details?: unknown }).details).toEqual({
      raw: "c".repeat(4_000),
    });
    expect((result.messages[9] as { details?: unknown }).details).toBeUndefined();
    expect((result.messages[10] as { details?: unknown }).details).toEqual({
      raw: "e".repeat(4_000),
    });
  });

  it("uses the smaller normalized runtime-churn size during prune estimation", () => {
    const rawGain = policy.estimatePruneGain({
      messages: [
        assistantWithThinking("t".repeat(12_000)),
        toolResult({
          toolName: "exec",
          text: "x".repeat(12_000),
          details: { raw: "y".repeat(12_000) },
        }),
        toolResult({ toolName: "read", text: "recent" }),
      ],
      thresholdChars: 1,
      keepRecentToolResults: 1,
      placeholder: "[pruned]",
    });
    const normalizedGain = policy.estimatePruneGain({
      messages: [
        assistantWithThinking("t".repeat(12_000)),
        {
          ...toolResult({
            toolName: "exec",
            text: "[runtime-churn normalized] Compaction summary collapsed.",
            details: { raw: "y".repeat(12_000) },
          }),
          contextSafeRuntimeChurn: {
            normalized: true,
            kinds: ["compactionSummary"],
          },
        },
        toolResult({ toolName: "read", text: "recent" }),
      ],
      thresholdChars: 1,
      keepRecentToolResults: 1,
      placeholder: "[pruned]",
    });

    expect(rawGain).toBeGreaterThan(normalizedGain);
  });

  it("preserves normalized child-completion summaries inside the protected tail", () => {
    const result = policy.applyCanonicalPrune({
      messages: [
        userMessage("head"),
        toolResult({
          toolName: "exec",
          text: "legacy result",
          details: { raw: "r".repeat(18_000) },
        }),
        {
          ...toolResult({
            toolName: "exec",
            text: "[runtime-churn normalized] Child task completion (success): runtime-churn-slimming.",
          }),
          contextSafeRuntimeChurn: {
            normalized: true,
            kinds: ["childCompletionInjection"],
          },
        },
      ],
      thresholdChars: 10_000,
      keepRecentToolResults: 1,
      placeholder: "[pruned]",
    });

    expect(result.pruned).toBe(true);
    expect(textOf(result.messages[1])).toBe("[pruned]");
    expect(textOf(result.messages[2])).toContain("Child task completion (success)");
  });

  it("pulls the preserved-tail start backward to include matching tool_use blocks", () => {
    const start = policy.calculatePreservedTailStart({
      messages: [
        userMessage("head"),
        {
          id: "assistant-tool-use",
          ...assistantToolUse("read", "call-1", { path: "/tmp/notes.md" }),
        },
        {
          id: "tool-result-1",
          ...toolResult({
            toolName: "read",
            toolCallId: "call-1",
            text: "recent read result",
          }),
        },
        assistantMessage("done"),
      ],
      keepRecentToolResults: 2,
    });

    expect(start).toBe(1);
  });

  it("pulls the preserved-tail start backward to include assistant fragments sharing message.id", () => {
    const start = policy.calculatePreservedTailStart({
      messages: [
        userMessage("head"),
        {
          role: "assistant",
          id: "assistant-msg-1",
          content: [{ type: "thinking", thinking: "private scratchpad" }],
        },
        {
          role: "assistant",
          id: "assistant-msg-1",
          content: [
            {
              type: "tool_use",
              name: "read",
              id: "call-2",
              input: { path: "/tmp/plan.md" },
            },
          ],
        },
        toolResult({
          toolName: "read",
          toolCallId: "call-2",
          text: "recent read result",
        }),
      ],
      keepRecentToolResults: 2,
    });

    expect(start).toBe(1);
  });

  it("treats normalized Telegram metadata wrappers like ordinary small user text", () => {
    const plainGain = policy.estimatePruneGain({
      messages: [
        userMessage("Telegram direct chat metadata: channel=telegram; sender=编程菜菜."),
        assistantWithThinking("t".repeat(9_000)),
        toolResult({ toolName: "exec", text: "recent" }),
      ],
      thresholdChars: 1,
      keepRecentToolResults: 1,
      placeholder: "[pruned]",
    });
    const normalizedGain = policy.estimatePruneGain({
      messages: [
        {
          ...userMessage("Telegram direct chat metadata: channel=telegram; sender=编程菜菜."),
          contextSafeRuntimeChurn: {
            normalized: true,
            kinds: ["telegramDirectChatMetadata"],
          },
        },
        assistantWithThinking("t".repeat(9_000)),
        toolResult({ toolName: "exec", text: "recent" }),
      ],
      thresholdChars: 1,
      keepRecentToolResults: 1,
      placeholder: "[pruned]",
    });

    expect(normalizedGain).toBe(plainGain);
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
          !!block &&
          typeof block === "object" &&
          ["thinking", "reasoning"].includes(String((block as { type?: unknown }).type ?? "")),
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


describe("classifyCanonicalRetentionTier", () => {
  it("classifies a recent user intent message as critical", () => {
    expect(
      classifyCanonicalRetentionTier({
        message: userMessage("Please keep the final recommendation focused on the canonical transcript policy."),
        messageIndex: 9,
        totalMessages: 12,
      }),
    ).toBe("critical");
  });

  it("classifies a report-path verdict summary as critical", () => {
    expect(
      classifyCanonicalRetentionTier({
        message: assistantMessage(
          "Verdict: pass. Rollout is ready. Report: reports/context-safe-v2-canonical-policy-2026-03-24/index.md", 
        ),
        messageIndex: 6,
        totalMessages: 20,
      }),
    ).toBe("critical");
  });

  it("classifies long tool-result chatter as compressible", () => {
    expect(
      classifyCanonicalRetentionTier({
        message: toolResult({
          toolName: "exec",
          text: [
            "running verification",
            "status: still working",
            "debug progress",
            "status: still working",
            "debug progress",
            "status: still working",
          ].join("\n"),
        }),
        messageIndex: 4,
        totalMessages: 20,
      }),
    ).toBe("compressible");
  });

  it("classifies old metadata-wrapper text as foldFirst", () => {
    expect(
      classifyCanonicalRetentionTier({
        message: userMessage([
          "Conversation info (untrusted metadata)",
          '{"channel":"telegram","chat_type":"direct","chat_id":"440811495"}',
          "Sender (untrusted metadata)",
          '{"id":"440811495","display_name":"编程菜菜"}',
          "Please continue from the last result.",
        ].join("\n")),
        messageIndex: 1,
        totalMessages: 20,
      }),
    ).toBe("foldFirst");
  });
});
