import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyBeforeToolCallSafety, applyToolResultPersistSafety } from "./hooks.js";

let artifactDir = "";

beforeEach(() => {
  artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "context-safe-plugin-"));
  process.env.OPENCLAW_CONTEXT_SAFE_ARTIFACT_DIR = artifactDir;
});

afterEach(() => {
  delete process.env.OPENCLAW_CONTEXT_SAFE_ARTIFACT_DIR;
  if (artifactDir) {
    fs.rmSync(artifactDir, { recursive: true, force: true });
    artifactDir = "";
  }
});

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

  it("does not inject fork-only exec params on official builds", () => {
    expect(
      applyBeforeToolCallSafety({
        toolName: "exec",
        params: { command: "git diff" },
      }),
    ).toEqual({
      command: "git diff",
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
      maxChars: 12000,
    });
  });
});

describe("applyToolResultPersistSafety", () => {
  it("uses the read-specific truncation hint when oversized read output is externalized", () => {
    const result = applyToolResultPersistSafety({
      message: {
        role: "toolResult",
        toolName: "read",
        toolCallId: "call_read_1",
        content: [{ type: "text", text: `${"row\n".repeat(4000)}{\"ok\":true}` }],
        details: {
          lineCount: 4001,
        },
      },
    });

    expect(textOf(result.message)).toContain("excluded from context");
    expect(textOf(result.message)).toContain("Rerun read with a narrower range");
    expect(textOf(result.message)).toContain("head");
    expect(textOf(result.message)).toContain("tail");
    expect(textOf(result.message)).toContain("jq");
  });

  it("uses the web_fetch-specific truncation hint when oversized fetch output is externalized", () => {
    const result = applyToolResultPersistSafety({
      message: {
        role: "toolResult",
        toolName: "web_fetch",
        toolCallId: "call_web_fetch_1",
        content: [{ type: "text", text: `${"payload ".repeat(1200)}END` }],
        details: {
          status: 200,
        },
      },
    });

    expect(textOf(result.message)).toContain("excluded from context");
    expect(textOf(result.message)).toContain("curl");
    expect(textOf(result.message)).toContain("read");
    expect(textOf(result.message)).toContain("save the response to a file");
  });

  it("externalizes oversized exec results into an artifact-backed preview", () => {
    const result = applyToolResultPersistSafety({
      message: {
        role: "toolResult",
        toolName: "exec",
        toolCallId: "call_exec_1",
        content: [{ type: "text", text: `${"log line\n".repeat(250)}error: boom` }],
        details: {
          exitCode: 1,
          raw: "x".repeat(10000),
        },
      },
    });

    const message = result.message as {
      content?: unknown;
      details?: {
        contextSafe?: {
          excludedFromContext?: boolean;
          outputFile?: string;
        };
      };
    };
    const outputFile = message.details?.contextSafe?.outputFile;

    expect(textOf(message)).toContain("excluded from context");
    expect(textOf(message)).toContain("error: boom");
    expect(textOf(message).length).toBeLessThan(4500);
    expect(message.details?.contextSafe?.excludedFromContext).toBe(true);
    expect(typeof outputFile).toBe("string");
    expect(outputFile ? fs.existsSync(outputFile) : false).toBe(true);
    expect(outputFile ? fs.readFileSync(outputFile, "utf-8") : "").toContain("error: boom");
  });

  it("compacts oversized details into a bounded metadata payload", () => {
    const result = applyToolResultPersistSafety({
      message: {
        role: "toolResult",
        toolName: "read",
        content: [{ type: "text", text: "preview" }],
        details: {
          lineCount: 12,
          raw: "x".repeat(10000),
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
          contextSafe: {
            detailsCompacted: true,
            originalChars: expect.any(Number),
          },
        },
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

  it("does not inject context-safe notices when the tool result stays inline", () => {
    const result = applyToolResultPersistSafety({
      message: {
        role: "toolResult",
        toolName: "read",
        content: [{ type: "text", text: "preview" }],
      },
    });

    expect(textOf(result.message)).toBe("preview");
    expect(textOf(result.message)).not.toContain("excluded from context");
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
