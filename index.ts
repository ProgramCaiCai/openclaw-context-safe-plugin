import { normalizeContextSafeEngineConfig } from "./src/config.js";
import { createContextSafeContextEngine } from "./src/context-engine.js";
import { applyBeforeToolCallSafety, applyToolResultPersistSafety } from "./src/hooks.js";

type ContextSafePluginApi = {
  registerContextEngine: (id: string, factory: () => unknown) => void;
  on: (
    hookName: string,
    handler: (event: unknown, ctx: unknown) => unknown,
    opts?: { priority?: number },
  ) => void;
  [key: string]: unknown;
};

const plugin = {
  id: "context-safe",
  name: "Context Safe",
  description: "Tool-result context safety plugin for OpenClaw.",
  register(api: ContextSafePluginApi) {
    const config = normalizeContextSafeEngineConfig((api as { pluginConfig?: unknown }).pluginConfig);

    api.registerContextEngine("context-safe", () =>
      createContextSafeContextEngine({
        ...config,
        logger: (api as { logger?: { warn?: (message: string) => void } }).logger,
      }),
    );
    api.on("before_tool_call", (event) => ({
      params: applyBeforeToolCallSafety(
        event as { toolName: string; params: Record<string, unknown> },
      ),
    }));
    api.on("tool_result_persist", (event) =>
      applyToolResultPersistSafety(event as { message: Record<string, unknown> }),
    );
  },
};

export default plugin;
