# OpenClaw Context Safe Plugin

## 中文版

`context-safe` 是一个面向 OpenClaw 的独立插件，用来把你原来落在本地网关里的 tool-result 裁剪策略插件化。

当前版本做三件事：

- 作为 `contextEngine`，在 `assemble()` 阶段对过大的 tool result 做上下文裁剪
- 在 `before_tool_call` 阶段给高噪声工具补默认安全参数
- 在 `tool_result_persist` 阶段移除超大 `details`，避免 transcript 持久化继续膨胀

它适合的场景：

- 本地网关长期运行，tool 输出很多，容易把上下文打爆
- 你想保留官方正式版 OpenClaw，不再维护核心代码 fork
- 你希望把“工具输出裁剪”和“上下文安全默认值”收敛到一个可安装插件里

当前策略摘要：

- `read`：默认补 `offset=1`、`limit=200`
- `exec` / `bash`：默认补 `excludeFromContext=true`
- `web_fetch`：默认补 `excludeFromContext=true`、`maxChars=12000`
- 超大 tool result：优先截断文本；如果整体上下文仍超预算，再替换成紧凑 notice
- 超大 `tool_result.details`：持久化前移除

已知边界：

- 这是一个 `assemble-only` 的 context engine，`compact()` 不接管官方 compaction 流程
- 当前裁剪策略偏文本优先，对复杂多模态 tool result 只做保守处理
- 目标是最小侵入接入官方版本，不是重新实现 OpenClaw 全套上下文引擎

## 安装

前提：

- OpenClaw `>= 2026.3.8`
- 本机能直接运行 `openclaw`

推荐安装方式：

```bash
git clone https://github.com/ProgramCaiCai/openclaw-context-safe-plugin.git
cd openclaw-context-safe-plugin
python3 scripts/install.py
```

一键安装：

```bash
python3 scripts/install.py
```

只看安装动作，不真正执行：

```bash
python3 scripts/install.py --dry-run
```

只安装插件，不改 slot / config：

```bash
python3 scripts/install.py --no-config
```

指定 OpenClaw 可执行文件：

```bash
python3 scripts/install.py --openclaw-bin /path/to/openclaw
```

手动安装：

```bash
openclaw plugins install .
openclaw config set plugins.entries.context-safe.enabled true
openclaw config set plugins.slots.contextEngine context-safe
```

安装脚本会：

- 准备一个可安装的 staging copy
- 调用 `openclaw plugins install`
- 默认启用 `plugins.entries.context-safe.enabled=true`
- 默认设置 `plugins.slots.contextEngine=context-safe`

## 为什么这个插件能省 Token

核心原因不是“模型更便宜”，而是“少把无价值工具输出塞进上下文”。

它主要从四个地方省 token：

- `exec` / `bash` / `web_fetch` 默认打 `excludeFromContext=true`
  大段 shell 输出、网页原文不会默认进入后续对话上下文
- `contextEngine.assemble()` 会先裁掉超大的 tool result
  单条工具结果不会无限吞掉窗口，超额部分会变成短 notice
- `tool_result_persist` 会删掉超大的 `details`
  避免 transcript 持久化后下轮又把大对象重新带回上下文
- 给后续真实对话保留 headroom
  上下文里留下的是“工具干了什么、怎么追查”，不是整段原始噪声

实际效果通常表现为：

- 输入 token 更低
- 上下文更稳定，不容易因为一两次大工具输出触发 compaction
- 模型更容易保留真正重要的用户意图和最近推理链

它最适合省 token 的场景：

- `exec` 输出很长
- `read` / `web_fetch` 经常读大文件、大网页
- 会话里连续有多轮工具调用
- 你希望官方 OpenClaw 保持原版，只把裁剪策略外挂出去

## 验证

```bash
openclaw plugins info context-safe
openclaw channels status --probe
```

如果你已经把它装进本地正式版网关，还可以看：

```bash
jq '.plugins.slots.contextEngine' ~/.openclaw/openclaw.json
```

## 开发

```bash
pnpm install
pnpm test
pnpm typecheck
python3 -m py_compile scripts/install.py
```

目录结构：

- `index.ts`: 插件入口
- `src/context-engine.ts`: 上下文裁剪入口
- `src/tool-result-policy.ts`: tool result 裁剪策略
- `src/hooks.ts`: `before_tool_call` / `tool_result_persist` hooks
- `scripts/install.py`: 一键安装脚本

---

## English Version

`context-safe` is a standalone OpenClaw plugin that turns a local gateway tool-result trimming strategy into an installable extension.

Current scope:

- register a `contextEngine` that trims oversized tool results during `assemble()`
- add safer defaults in `before_tool_call`
- strip oversized `details` in `tool_result_persist`

Use it when:

- your local gateway accumulates large tool outputs
- you want to stay on official OpenClaw releases instead of maintaining a core fork
- you want one installable plugin for tool-result shaping and context-safety defaults

Current policy summary:

- `read`: default `offset=1`, `limit=200`
- `exec` / `bash`: default `excludeFromContext=true`
- `web_fetch`: default `excludeFromContext=true`, `maxChars=12000`
- large tool results: truncate text first, then replace with a compact notice if the full context is still over budget
- oversized `tool_result.details`: removed before persistence

Known limits:

- this is an assemble-only context engine; it does not take over OpenClaw's official compaction path
- current trimming is text-first and conservative for complex multimodal tool results
- the goal is minimal-intrusion integration with official OpenClaw, not a full replacement of the upstream context engine

## Install

Requirements:

- OpenClaw `>= 2026.3.8`
- a working `openclaw` binary on the host

Recommended flow:

```bash
git clone https://github.com/ProgramCaiCai/openclaw-context-safe-plugin.git
cd openclaw-context-safe-plugin
python3 scripts/install.py
```

Install and enable:

```bash
python3 scripts/install.py
```

Dry run:

```bash
python3 scripts/install.py --dry-run
```

Install without changing config:

```bash
python3 scripts/install.py --no-config
```

Use a custom OpenClaw binary:

```bash
python3 scripts/install.py --openclaw-bin /path/to/openclaw
```

Manual install:

```bash
openclaw plugins install .
openclaw config set plugins.entries.context-safe.enabled true
openclaw config set plugins.slots.contextEngine context-safe
```

The installer:

- materializes an installable staging copy
- runs `openclaw plugins install`
- enables `plugins.entries.context-safe.enabled=true`
- selects `plugins.slots.contextEngine=context-safe`

## Why It Saves Tokens

This plugin does not save tokens by changing model pricing. It saves tokens by keeping low-value tool output out of the next prompt.

Main savings points:

- `exec` / `bash` / `web_fetch` default to `excludeFromContext=true`
  Long shell output and full web payloads stop flowing into later context by default
- `contextEngine.assemble()` trims oversized tool results before final prompt assembly
  A single noisy tool result cannot consume an arbitrary share of the context window
- `tool_result_persist` removes oversized `details`
  Large serialized payloads do not keep re-entering future turns through persisted transcripts
- more headroom stays available for actual conversation and reasoning
  The context keeps the outcome and recovery hints instead of raw noise

In practice, that usually means:

- lower input-token usage
- less compaction pressure
- more stable long-running sessions
- better retention of user intent and recent reasoning context

It is most useful when:

- `exec` outputs are large
- `read` / `web_fetch` often pull large files or pages
- sessions have many consecutive tool calls
- you want to stay on upstream OpenClaw and move trimming policy into an extension

## Verify

```bash
openclaw plugins info context-safe
openclaw channels status --probe
```

You can also confirm the selected slot with:

```bash
jq '.plugins.slots.contextEngine' ~/.openclaw/openclaw.json
```

## Development

```bash
pnpm install
pnpm test
pnpm typecheck
python3 -m py_compile scripts/install.py
```

Layout:

- `index.ts`: plugin entry
- `src/context-engine.ts`: context trimming entry point
- `src/tool-result-policy.ts`: tool-result trimming policy
- `src/hooks.ts`: `before_tool_call` / `tool_result_persist` hooks
- `scripts/install.py`: one-command installer
