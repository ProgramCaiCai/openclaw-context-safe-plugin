import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

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

  it("wires the registered engine and hook handlers to the plugin policy", async () => {
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
      toolName: "read",
      params: { path: "README.md" },
    });
    const persistedResult = toolResultPersist?.({
      message: {
        role: "toolResult",
        toolName: "read",
        content: [{ type: "text", text: "preview" }],
        details: { blob: "z".repeat(5000) },
      },
    });

    expect(String(JSON.stringify(assembled.messages[1]))).toContain("truncated");
    expect(beforeToolCallResult).toEqual({
      params: {
        path: "README.md",
        limit: 200,
        offset: 1,
      },
    });
    expect(persistedResult).toEqual({
      message: {
        role: "toolResult",
        toolName: "read",
        content: [{ type: "text", text: "preview" }],
      },
    });
  });
});
