import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

let artifactDir = "";

beforeEach(() => {
  artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "context-safe-plugin-index-"));
  process.env.OPENCLAW_CONTEXT_SAFE_ARTIFACT_DIR = artifactDir;
});

afterEach(() => {
  delete process.env.OPENCLAW_CONTEXT_SAFE_ARTIFACT_DIR;
  if (artifactDir) {
    fs.rmSync(artifactDir, { recursive: true, force: true });
    artifactDir = "";
  }
});

describe("context-safe plugin registration", () => {
  it("registers one context engine and the required safety hooks", () => {
    const registerContextEngine = vi.fn();
    const on = vi.fn();

    plugin.register?.({
      id: "context-safe",
      name: "Context Safe",
      description: "Context Safe",
      source: "test",
      config: {},
      pluginConfig: {},
      runtime: {} as never,
      logger: {
        info() {},
        warn() {},
        error() {},
      },
      registerTool() {},
      registerHook() {},
      registerHttpRoute() {},
      registerChannel() {},
      registerGatewayMethod() {},
      registerCli() {},
      registerService() {},
      registerProvider() {},
      registerCommand() {},
      registerContextEngine,
      resolvePath(input: string) {
        return input;
      },
      on,
    });

    expect(registerContextEngine).toHaveBeenCalledTimes(1);
    expect(registerContextEngine).toHaveBeenCalledWith("context-safe", expect.any(Function));
    expect(on.mock.calls.map((call) => call[0])).toEqual([
      "before_tool_call",
      "tool_result_persist",
    ]);
  });

  it("wires the registered engine and hook handlers to the official-compatible policy", async () => {
    let contextEngineFactory: (() => unknown) | undefined;
    const hooks = new Map<string, (...args: unknown[]) => unknown>();

    plugin.register?.({
      id: "context-safe",
      name: "Context Safe",
      description: "Context Safe",
      source: "test",
      config: {},
      pluginConfig: {},
      runtime: {} as never,
      logger: {
        info() {},
        warn() {},
        error() {},
      },
      registerTool() {},
      registerHook() {},
      registerHttpRoute() {},
      registerChannel() {},
      registerGatewayMethod() {},
      registerCli() {},
      registerService() {},
      registerProvider() {},
      registerCommand() {},
      registerContextEngine(_id: string, factory: () => unknown) {
        contextEngineFactory = factory;
      },
      resolvePath(input: string) {
        return input;
      },
      on(hookName: string, handler: (...args: unknown[]) => unknown) {
        hooks.set(hookName, handler);
      },
    });

    const engine = contextEngineFactory?.() as {
      assemble: (params: {
        sessionId: string;
        messages: Array<Record<string, unknown>>;
        tokenBudget?: number;
      }) => Promise<{ messages: Array<Record<string, unknown>> }>;
    };
    const assembled = await engine.assemble({
      sessionId: "session-1",
      tokenBudget: 32,
      messages: [
        { role: "user", content: "inspect" },
        {
          role: "toolResult",
          toolName: "read",
          content: [{ type: "text", text: "x".repeat(220) }],
          details: { blob: "y".repeat(500) },
        },
      ],
    });
    const beforeToolCall = hooks.get("before_tool_call");
    const toolResultPersist = hooks.get("tool_result_persist");
    const beforeToolCallResult = beforeToolCall?.({
      toolName: "web_fetch",
      params: { url: "https://example.com" },
    });
    const persistedResult = toolResultPersist?.({
      message: {
        role: "toolResult",
        toolName: "exec",
        toolCallId: "call_exec_2",
        content: [{ type: "text", text: `${"log line\n".repeat(250)}error: boom` }],
        details: { raw: "z".repeat(5000) },
      },
    }) as {
      message?: {
        content?: unknown;
        details?: {
          contextSafe?: {
            excludedFromContext?: boolean;
            outputFile?: string;
          };
        };
      };
    };

    expect(String(JSON.stringify(assembled.messages[1]))).toContain("truncated");
    expect(beforeToolCallResult).toEqual({
      params: {
        url: "https://example.com",
        maxChars: 12000,
      },
    });
    expect(textOf(persistedResult.message)).toContain("excluded from context");
    expect(persistedResult.message?.details?.contextSafe?.excludedFromContext).toBe(true);
    expect(
      persistedResult.message?.details?.contextSafe?.outputFile
        ? fs.existsSync(persistedResult.message.details.contextSafe.outputFile)
        : false,
    ).toBe(true);
  });

  it("passes plugin prune config into the registered context engine factory", async () => {
    let contextEngineFactory: (() => unknown) | undefined;

    plugin.register?.({
      id: "context-safe",
      name: "Context Safe",
      description: "Context Safe",
      source: "test",
      config: {},
      pluginConfig: {
        prune: {
          thresholdChars: 25_000,
          keepRecentToolResults: 2,
          keepTailMinChars: 1,
          keepTailMinUserAssistantMessages: 1,
          keepTailMaxChars: 200,
          placeholder: "[pruned]",
        },
      },
      runtime: {} as never,
      logger: {
        info() {},
        warn() {},
        error() {},
      },
      registerTool() {},
      registerHook() {},
      registerHttpRoute() {},
      registerChannel() {},
      registerGatewayMethod() {},
      registerCli() {},
      registerService() {},
      registerProvider() {},
      registerCommand() {},
      registerContextEngine(_id: string, factory: () => unknown) {
        contextEngineFactory = factory;
      },
      resolvePath(input: string) {
        return input;
      },
      on() {},
    });

    const engine = contextEngineFactory?.() as {
      assemble: (params: {
        sessionId: string;
        messages: Array<Record<string, unknown>>;
        tokenBudget?: number;
      }) => Promise<{ messages: Array<Record<string, unknown>> }>;
    };
    const assembled = await engine.assemble({
      sessionId: "session-configured-threshold",
      tokenBudget: 30_000,
      messages: [
        { role: "user", content: "summarize the run" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "working through prior context" },
            { type: "thinking", thinking: "t".repeat(8_000) },
          ],
        },
        {
          role: "toolResult",
          toolName: "exec",
          toolCallId: "old-tool-1",
          content: [{ type: "text", text: "a".repeat(5_000) }],
          details: { raw: "d".repeat(2_000) },
        },
        {
          role: "assistant",
          content: [{ type: "thinking", thinking: "u".repeat(8_000) }],
        },
        {
          role: "toolResult",
          toolName: "read",
          toolCallId: "old-tool-2",
          content: [{ type: "text", text: "b".repeat(5_000) }],
          details: { raw: "e".repeat(2_000) },
        },
        { role: "assistant", content: [{ type: "text", text: "continuing" }] },
        {
          role: "toolResult",
          toolName: "exec",
          toolCallId: "recent-tool-1",
          content: [{ type: "text", text: "recent tool result 1" }],
        },
        {
          role: "toolResult",
          toolName: "read",
          toolCallId: "recent-tool-2",
          content: [{ type: "text", text: "recent tool result 2" }],
        },
      ],
    });

    expect(
      assembled.messages
        .filter((message) => message.role === "toolResult")
        .map((message) => textOf(message)),
    ).toEqual([
      "[pruned]",
      "[pruned]",
      "recent tool result 1",
      "recent tool result 2",
    ]);
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
