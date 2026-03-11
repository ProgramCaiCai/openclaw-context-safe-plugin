# OpenClaw Context Safe Plugin

## 中文说明

`context-safe` 是一个面向官方 OpenClaw 的独立插件，目标是在不修改 OpenClaw 核心代码的前提下，把 fork 里的 context-safe 行为迁移成可安装、可卸载、可独立维护的插件。

这个插件兼容官方 `OpenClaw >= 2026.3.8`，并且只使用官方已经提供的扩展点：

- `before_tool_call`
- `tool_result_persist`
- `plugins.slots.contextEngine`

重点说明：官方 `v2026.3.8` 没有你 fork 里那种给 `exec` / `web_fetch` 增加的 `excludeFromContext` 参数。这个插件不是假装官方已经有这个参数，而是在官方插件能力范围内，把“效果”复现出来。

### 这个插件能做什么

- 给 `read` 自动补默认安全参数：`offset=1`、`limit=200`
- 给 `web_fetch` 自动补默认安全参数：`maxChars=12000`
- 在 `tool_result_persist` 阶段把超大的 `exec` / `bash` / `web_fetch` / `read` 结果改写成“小预览 + artifact 路径”
- 把过大的 `details` 压缩成有界元数据，避免 transcript 被大对象撑爆
- 在 `contextEngine.assemble()` 阶段再次做 tool result 截断和上下文压缩，防止单条工具结果吞掉整个 context window

### 它为什么能省 Token

核心原因不是换了更便宜的模型，而是减少了被重复塞进上下文的无价值工具输出。

这个插件从四个层面省 token：

- 大工具输出不会完整留在 transcript 里
  超长结果会被写入 artifact 文件，transcript 里只保留短预览和恢复提示。
- `details` 不再无限膨胀
  原始大对象会被压缩成小型元数据，避免下一轮又把大 JSON 带回上下文。
- 官方上下文组装前会再做一次预算控制
  `contextEngine` 会对大 tool result 做第二次裁剪和必要的 compact。
- 未来轮次看到的是“怎么继续追查”，不是整段原始噪声
  对模型更有价值，也更稳定。

实际效果通常是：

- 输入 token 更低
- 工具噪声更不容易把真正的用户意图挤出窗口
- 长会话更稳定，不容易因为几次大输出就触发严重 compaction

### 官方命令安装

推荐直接使用官方命令：

```bash
openclaw plugins install --link /path/to/openclaw-context-safe-plugin
openclaw config set plugins.entries.context-safe.enabled true
openclaw config set plugins.slots.contextEngine context-safe
```

如果你不想使用 `--link`，也可以直接 copy-install：

```bash
openclaw plugins install /path/to/openclaw-context-safe-plugin
openclaw config set plugins.entries.context-safe.enabled true
openclaw config set plugins.slots.contextEngine context-safe
```

安装完成后可以验证：

```bash
openclaw plugins info context-safe
openclaw config get plugins.slots.contextEngine
```

### 官方命令卸载

如果当前 `plugins.slots.contextEngine` 还指向 `context-safe`，先切回官方默认引擎，再卸载插件：

```bash
openclaw config set plugins.slots.contextEngine legacy
openclaw plugins uninstall context-safe --force
```

### Python 一键脚本

仓库里附带了 `scripts/install.py`，但它只是把上面的官方命令串起来执行，不重新发明安装协议。

安装：

```bash
python3 scripts/install.py
```

卸载：

```bash
python3 scripts/install.py --uninstall
```

只打印将要执行的官方命令：

```bash
python3 scripts/install.py --dry-run
```

### Artifact 行为

当插件判断某个 tool result 过大时，它会把完整结果写入 artifact 文件，并把 transcript 改写成短预览。

默认 artifact 目录：

```text
~/.openclaw/artifacts/context-safe/<tool>/
```

如果你想在本地开发或测试时改路径，可以设置：

```bash
export OPENCLAW_CONTEXT_SAFE_ARTIFACT_DIR=/custom/path
```

### 开发与验证

```bash
pnpm exec vitest run --config vitest.config.ts
pnpm exec tsc -p tsconfig.json --noEmit
python3 -m py_compile scripts/install.py
```

项目结构：

- `index.ts`：插件入口
- `src/hooks.ts`：官方 hook 入口
- `src/tool-result-persist.ts`：artifact、preview、details 压缩
- `src/context-engine.ts`：context engine
- `src/tool-result-policy.ts`：assemble 阶段的 tool result 裁剪策略
- `scripts/install.py`：官方命令封装脚本

## English

`context-safe` is a standalone plugin for official OpenClaw releases. Its purpose is to move fork-only context-safety behavior into an installable, removable, independently maintained plugin without patching OpenClaw core.

It is compatible with `OpenClaw >= 2026.3.8` and uses only official extension points:

- `before_tool_call`
- `tool_result_persist`
- `plugins.slots.contextEngine`

Important detail: official `v2026.3.8` does not expose the fork-only `excludeFromContext` parameter on `exec` or `web_fetch`. This plugin does not pretend that upstream already supports that parameter. Instead, it recreates the outcome by rewriting persisted tool results inside the official plugin surface.

### What the Plugin Does

- adds safe defaults for `read`: `offset=1`, `limit=200`
- adds a safe default for `web_fetch`: `maxChars=12000`
- rewrites oversized `exec` / `bash` / `web_fetch` / `read` results during `tool_result_persist` into a short preview plus artifact path
- compacts oversized `details` into bounded metadata
- enforces a second tool-result truncation and compaction pass in `contextEngine.assemble()`

### Why It Saves Tokens

The plugin saves tokens by preventing noisy tool output from staying inline in the transcript and getting re-sent to the model over and over.

It reduces token usage in four ways:

- large tool results are moved out of the inline transcript
  Full payloads are written to artifact files and replaced with a short preview plus recovery guidance.
- oversized `details` are compacted
  Large JSON blobs do not keep flowing back into future turns.
- the context engine enforces another budget pass before model execution
  Oversized tool results are truncated or compacted again during context assembly.
- future turns keep the actionable trace, not the raw noise
  The model sees how to continue investigation instead of being forced to ingest the full payload again.

Typical effects:

- lower input token usage
- better long-session stability
- less context loss from one or two oversized tool calls

### Official Install Commands

Preferred installation uses official OpenClaw commands directly:

```bash
openclaw plugins install --link /path/to/openclaw-context-safe-plugin
openclaw config set plugins.entries.context-safe.enabled true
openclaw config set plugins.slots.contextEngine context-safe
```

If you prefer copy-install instead of linking:

```bash
openclaw plugins install /path/to/openclaw-context-safe-plugin
openclaw config set plugins.entries.context-safe.enabled true
openclaw config set plugins.slots.contextEngine context-safe
```

Verify the install:

```bash
openclaw plugins info context-safe
openclaw config get plugins.slots.contextEngine
```

### Official Uninstall Commands

If the current context engine slot still points to `context-safe`, switch back to the built-in engine first and then uninstall:

```bash
openclaw config set plugins.slots.contextEngine legacy
openclaw plugins uninstall context-safe --force
```

### Python Convenience Script

The repository includes `scripts/install.py`, but it is only a thin wrapper around the official commands above.

Install:

```bash
python3 scripts/install.py
```

Uninstall:

```bash
python3 scripts/install.py --uninstall
```

Dry run:

```bash
python3 scripts/install.py --dry-run
```

### Artifact Behavior

When the plugin decides a persisted tool result is too large, it writes the full payload to an artifact file and rewrites the transcript entry into a short preview.

Default artifact directory:

```text
~/.openclaw/artifacts/context-safe/<tool>/
```

Override it during development or tests with:

```bash
export OPENCLAW_CONTEXT_SAFE_ARTIFACT_DIR=/custom/path
```

### Development and Verification

```bash
pnpm exec vitest run --config vitest.config.ts
pnpm exec tsc -p tsconfig.json --noEmit
python3 -m py_compile scripts/install.py
```

Project layout:

- `index.ts`: plugin entry
- `src/hooks.ts`: official hook entrypoints
- `src/tool-result-persist.ts`: artifact writing, previews, and details compaction
- `src/context-engine.ts`: context engine
- `src/tool-result-policy.ts`: assemble-time tool-result policy
- `scripts/install.py`: wrapper around official install commands
