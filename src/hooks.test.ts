import { describe, expect, it } from "vitest";
import { applyBeforeToolCallSafety, applyToolResultPersistSafety } from "./hooks.js";

describe("applyBeforeToolCallSafety", () => {
  it("adds default read limits when they are missing", () => {
    expect(
      applyBeforeToolCallSafety({
        toolName: "read",
        params: { path: "README.md" },
      }),
    ).toEqual({
      path: "README.md",
      limit: 200,
      offset: 1,
    });
  });

  it("forces exec output out of context by default", () => {
    expect(
      applyBeforeToolCallSafety({
        toolName: "exec",
        params: { command: "git diff" },
      }),
    ).toEqual({
      command: "git diff",
      excludeFromContext: true,
    });
  });

  it("caps web_fetch when callers do not provide explicit limits", () => {
    expect(
      applyBeforeToolCallSafety({
        toolName: "web_fetch",
        params: { url: "https://example.com" },
      }),
    ).toEqual({
      url: "https://example.com",
      excludeFromContext: true,
      maxChars: 12000,
    });
  });
});

describe("applyToolResultPersistSafety", () => {
  it("strips oversized details payloads from tool results before persistence", () => {
    const result = applyToolResultPersistSafety({
      message: {
        role: "toolResult",
        toolName: "read",
        content: [{ type: "text", text: "preview" }],
        details: {
          raw: "x".repeat(10000),
        },
      },
    });

    expect(result).toEqual({
      message: {
        role: "toolResult",
        toolName: "read",
        content: [{ type: "text", text: "preview" }],
      },
    });
  });

  it("keeps small detail payloads intact", () => {
    const result = applyToolResultPersistSafety({
      message: {
        role: "toolResult",
        toolName: "read",
        content: [{ type: "text", text: "preview" }],
        details: {
          lineCount: 12,
        },
      },
    });

    expect(result).toEqual({
      message: {
        role: "toolResult",
        toolName: "read",
        content: [{ type: "text", text: "preview" }],
        details: {
          lineCount: 12,
        },
      },
    });
  });
});
