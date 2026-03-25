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
          resultMode?: string;
        };
      };
    };
    const outputFile = message.details?.contextSafe?.outputFile;

    expect(textOf(message)).toContain("excluded from context");
    expect(textOf(message)).toContain("error: boom");
    expect(textOf(message).length).toBeLessThan(4500);
    expect(message.details?.contextSafe?.excludedFromContext).toBe(true);
    expect(message.details?.contextSafe?.resultMode).toBe("artifact");
    expect(typeof outputFile).toBe("string");
    expect(outputFile ? fs.existsSync(outputFile) : false).toBe(true);
    expect(outputFile ? fs.readFileSync(outputFile, "utf-8") : "").toContain("error: boom");
  });

  it("falls back to bounded inline content when artifact persistence fails", () => {
    const blockedPath = path.join(artifactDir, "blocked-artifact-root");
    fs.writeFileSync(blockedPath, "not-a-directory", "utf8");
    process.env.OPENCLAW_CONTEXT_SAFE_ARTIFACT_DIR = blockedPath;

    const result = applyToolResultPersistSafety({
      message: {
        role: "toolResult",
        toolName: "exec",
        toolCallId: "call_exec_fallback",
        content: [{ type: "text", text: `${"stderr line\n".repeat(260)}fatal: crashed` }],
        details: {
          exitCode: 1,
          raw: "z".repeat(12_000),
        },
      },
    });

    const message = result.message as {
      content?: unknown;
      details?: {
        contextSafe?: {
          excludedFromContext?: boolean;
          outputFile?: string;
          resultMode?: string;
          artifactWriteFailed?: boolean;
          artifactFailureReason?: string;
        };
      };
    };

    expect(textOf(message)).toContain("excluded from context");
    expect(textOf(message)).toContain("artifact save failed");
    expect(textOf(message)).toContain("fatal: crashed");
    expect(textOf(message)).toContain("rerun a narrower command");
    expect(textOf(message).length).toBeLessThan(4500);
    expect(message.details?.contextSafe?.excludedFromContext).toBe(true);
    expect(message.details?.contextSafe?.outputFile).toBeUndefined();
    expect(message.details?.contextSafe?.resultMode).toBe("inline-fallback");
    expect(message.details?.contextSafe?.artifactWriteFailed).toBe(true);
    expect(message.details?.contextSafe?.artifactFailureReason).toBe("artifact-write-failed");
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
            resultMode: "inline",
          },
        },
      },
    });
  });

  it("collapses post-compaction oversized object details to minimal metadata", () => {
    const result = applyToolResultPersistSafety({
      message: {
        role: "toolResult",
        toolName: "read",
        content: [{ type: "text", text: "preview" }],
        details: Object.fromEntries(
          Array.from({ length: 20 }, (_, index) => [`key${index}`, "x".repeat(1_000)]),
        ),
      },
    });

    const details = (result.message as { details?: Record<string, unknown> }).details;
    const contextSafe = details?.contextSafe as Record<string, unknown> | undefined;

    expect(details).toEqual({
      contextSafe: {
        detailsCompacted: true,
        detailsCollapsed: true,
        collapseReason: "post-compaction-hard-cap",
        originalChars: expect.any(Number),
        resultMode: "inline",
      },
    });
    expect(JSON.stringify(details).length).toBeLessThanOrEqual(4_096);
    expect(contextSafe?.originalChars).toBeGreaterThan(4_096);
  });

  it("keeps externalized results bounded when compacted details still exceed the hard cap", () => {
    const result = applyToolResultPersistSafety({
      message: {
        role: "toolResult",
        toolName: "exec",
        toolCallId: "call_exec_hard_cap",
        content: [{ type: "text", text: `${"stdout line\n".repeat(260)}done` }],
        details: {
          exitCode: 0,
          nested: Array.from({ length: 12 }, () => "y".repeat(1_000)),
        },
      },
    });

    const message = result.message as {
      content?: unknown;
      details?: {
        contextSafe?: {
          outputFile?: string;
          resultMode?: string;
          detailsCompacted?: boolean;
          detailsCollapsed?: boolean;
          collapseReason?: string;
        };
      };
    };

    expect(message.details).toEqual({
      contextSafe: {
        excludedFromContext: true,
        originalTextChars: expect.any(Number),
        originalDetailsChars: expect.any(Number),
        outputFile: expect.any(String),
        previewChars: 4_000,
        detailsCompacted: true,
        detailsCollapsed: true,
        collapseReason: "post-compaction-hard-cap",
        originalChars: expect.any(Number),
        resultMode: "artifact",
      },
    });
    expect(JSON.stringify(message.details).length).toBeLessThanOrEqual(4_096);
    expect(message.details?.contextSafe?.outputFile).toEqual(expect.any(String));
  });

  it("adds inline mode metadata to small detail payloads without changing the content", () => {
    const result = applyToolResultPersistSafety({
      message: {
        role: "toolResult",
        toolName: "read",
        content: [{ type: "text", text: "preview" }],
        details: {
          lineCount: 12,
          nested: { ok: true },
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
          nested: { ok: true },
          contextSafe: {
            resultMode: "inline",
          },
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
