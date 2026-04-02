# OpenClaw Context Safe Plugin

## 中文说明

`context-safe` 是一个面向官方 OpenClaw 的独立实现插件，提供可安装、可卸载、可独立维护的 context-safe 能力，并且不修改 OpenClaw 核心代码。

这个插件兼容官方 `OpenClaw >= 2026.3.8`，并且只使用官方已经提供的扩展点：

- `before_tool_call`
- `tool_result_persist`
- `plugins.slots.contextEngine`

重点说明：官方 `v2026.3.8` 没有给 `exec` / `web_fetch` 暴露 `excludeFromContext` 参数。这个插件通过官方插件扩展点重写持久化的 tool result，在不修改 OpenClaw 核心代码的前提下复现同类效果。

### 这个插件能做什么

- 给 `read` 自动补默认安全参数：`offset=1`、`limit=200`
- 给 `web_fetch` 自动补默认安全参数：`maxChars=12000`
- 在 `tool_result_persist` 阶段把超大的 `exec` / `bash` / `web_fetch` / `read` 结果改写成“小预览 + artifact 路径”
- 把过大的 `details` 压缩成有界元数据，避免 transcript 被大对象撑爆
- 在 canonical transcript 同步阶段折叠高频 runtime churn，当前覆盖 compaction 摘要、内部 child-result 注入块、Telegram / Feishu 私聊元数据包装
- 在 `contextEngine.assemble()` 阶段维护插件自有的 canonical context transcript，并在达到阈值后做一次可持续的上下文裁剪

### Canonical Context Transcript

插件不会改写 OpenClaw 原始 transcript。它会为每个 `sessionId` 维护一份插件自有的 canonical context transcript，用来决定后续每轮真正送进模型的上下文。

runtime churn slimming 发生在消息已经进入 transcript 之后的 canonical-state 同步阶段。它当前只做三类窄规则折叠：compaction summary、内部 child-result completion 注入块、Telegram / Feishu 私聊元数据包装。它不会阻止 OpenClaw 核心继续生成这些事件，也不会改写完成判定真相源。

当估算出来的 `pruneGain >= thresholdChars` 时，插件会把 canonical transcript 裁剪并持久化，因此后续请求看到的就是裁剪后的基线，而不是再次从原始历史重复计算同一批噪声。

当前裁剪规则：

- `pruneGain` 只统计可被裁剪的消息，受保护内容不计入
- 不再使用固定 head/tail 窗口，改为从 transcript 尾部向前扩展一个语义化 preserved tail
- preserved tail 默认要同时满足最小字符预算和最小 user/assistant 文本轮次数，并受 `keepTailMaxChars` 上限约束
- 如果 canonical state 已经记录 `summaryBoundary.preservedTailHeadId`，tail 选择会尊重这个边界，不会把切点推进到边界之后
- tail 切点会额外执行 API invariant 修正，避免保留段从孤立的 `toolResult` 开始，也避免丢掉共享同一 `message.id` 的 assistant fragment
- 保护命中 basename 名单的 `read` 消息及其关联 `toolResult`
- 保护名单按 basename、大小写不敏感匹配：
  `AGENTS.md` `HEARTBEAT.md` `IDENTITY.md` `MEMORY.md` `NOW.md`
  `SESSION-STATE.md` `SKILL.md` `SOUL.md` `TODAY.md` `TOOLS.md` `USER.md`
- 非保护区里的 assistant `thinking` / `reasoning` block 会被删除
- 非保护区里的旧 `toolResult` 会被替换成 `[pruned]`，并移除 `details`

### Summary Boundary 与 Rehydration Bundle

canonical state 现在会额外保存一组 compact/rehydration 相关字段：

- `summaryBoundary`
  - `lastSummarizedMessageId`
  - `lastSummarizedAt`
  - `lastSummarySource`
  - `preservedTailHeadId`
- `contextSafeSessionIndex`
  - `goals`
  - `recentConclusions`
  - `openThreads`
  - `activePlans`
  - `protectedReads`
  - `recentReports`
  - `keyArtifacts`
  - `recoveryHints`
  - `summaryBoundary`
  - `lastCompactReason`

`assemble()` 注入的 synthetic session index 也不再只有轻量 goals/threads/artifacts。预算足够时，它会把 active plans、protected reads、recent reports、summary boundary 和最近 compact 原因一起带回上下文；预算变紧时，会自动退化到 compact/minimal 版本，只保留最关键的继续工作线索。

### 它为什么能省 Token

核心原因是减少了被重复塞进上下文的无价值工具输出，和模型价格无关。

这个插件从四个层面省 token：

- 大工具输出不会完整留在 transcript 里
  超长结果会被写入 artifact 文件，transcript 里只保留短预览和恢复提示。
- `details` 不再无限膨胀
  原始大对象会被压缩成小型元数据，避免下一轮又把大 JSON 带回上下文。
- 官方上下文组装前会再做一次预算控制
  `contextEngine` 会对大 tool result 做第二次裁剪和必要的 compact。
- canonical transcript 会在第一次触发阈值后变成新的基线
  同一批历史 `thinking` / `reasoning` 和旧 tool output 不会每轮都重新贡献一次 `pruneGain`。
- 未来轮次看到的是“怎么继续追查”，不是整段原始噪声
  对模型更有价值，也更稳定。

实际效果通常是：

- 输入 token 更低
- 工具噪声更不容易把真正的用户意图挤出窗口
- 长会话更稳定，不容易因为几次大输出就触发严重 compaction

### Python 一键脚本

推荐优先使用仓库里附带的 `scripts/install.py`。

默认安装（推荐，先 `npm pack` 再安装生成的 `.tgz`）：

```bash
cd projects/openclaw-context-safe-plugin
python3 scripts/install.py
```

本地开发时如果你明确需要可变的源码 link-install，再显式使用：

```bash
cd projects/openclaw-context-safe-plugin
python3 scripts/install.py --link
```

卸载：

```bash
cd projects/openclaw-context-safe-plugin
python3 scripts/install.py --uninstall
```

只打印将要执行的官方命令：

```bash
cd projects/openclaw-context-safe-plugin
python3 scripts/install.py --dry-run
```

### 官方命令安装

推荐的官方命令流程也是先打包，再安装生成的归档：

```bash
cd projects/openclaw-context-safe-plugin
ARTIFACT_DIR=/tmp/openclaw-context-safe-plugin-npm-artifacts
mkdir -p "$ARTIFACT_DIR"
npm pack --pack-destination "$ARTIFACT_DIR"
openclaw plugins install "$ARTIFACT_DIR"/context-safe-*.tgz
openclaw config set plugins.entries.context-safe.enabled true
openclaw config set plugins.slots.contextEngine context-safe
```

只有在本地开发、并且你明确希望工作区修改立即影响已安装插件时，才使用源码 link-install：

```bash
cd projects/openclaw-context-safe-plugin
openclaw plugins install --link .
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

canonical session state 也会保存在同一 artifact 根目录下：

```text
~/.openclaw/artifacts/context-safe/session-state/<sessionId>.json
```

如果需要排查某一轮 compact / assemble 为什么这样裁剪，优先看这个 session-state 文件里的：

- `summaryBoundary`
- `contextSafeSessionIndex`
- `consecutiveCompactNoops`
- `lastCompactReason`
- `lastCompactFailedAt`
- `contextSafeStats`

### Prune 配置

默认配置：

```json
{
  "prune": {
    "thresholdChars": 100000,
    "keepRecentToolResults": 5,
    "keepTailMinChars": 6000,
    "keepTailMinUserAssistantMessages": 2,
    "keepTailMaxChars": 24000,
    "keepTailRespectSummaryBoundary": true,
    "placeholder": "[pruned]"
  },
  "runtimeChurn": {
    "enabled": true,
    "collapseCompactionSummaries": true,
    "collapseChildCompletionInjections": true,
    "collapseDirectChatMetadata": true
  },
  "retentionTiers": {
    "enabled": true,
    "critical": [
      "please",
      "keep",
      "focus",
      "continue",
      "recommendation",
      "verdict:",
      "outcome:",
      "report:"
    ],
    "compressible": [
      "running verification",
      "status: still working",
      "debug progress"
    ],
    "foldFirst": [
      "conversation info (untrusted metadata)",
      "sender (untrusted metadata)",
      "telegram direct chat metadata",
      "feishu direct chat metadata",
      "会话信息（不可信元数据）",
      "发送者（不可信元数据）",
      "飞书私聊元数据"
    ]
  }
}
```

OpenClaw 配置示例：

```bash
openclaw config set plugins.entries.context-safe.config.prune.thresholdChars 100000
openclaw config set plugins.entries.context-safe.config.prune.keepRecentToolResults 5
openclaw config set plugins.entries.context-safe.config.prune.keepTailMinChars 6000
openclaw config set plugins.entries.context-safe.config.prune.keepTailMinUserAssistantMessages 2
openclaw config set plugins.entries.context-safe.config.prune.keepTailMaxChars 24000
openclaw config set plugins.entries.context-safe.config.prune.keepTailRespectSummaryBoundary true
openclaw config set plugins.entries.context-safe.config.prune.placeholder "[pruned]"
openclaw config set plugins.entries.context-safe.config.runtimeChurn.enabled true
openclaw config set plugins.entries.context-safe.config.runtimeChurn.collapseCompactionSummaries true
openclaw config set plugins.entries.context-safe.config.runtimeChurn.collapseChildCompletionInjections true
openclaw config set plugins.entries.context-safe.config.runtimeChurn.collapseDirectChatMetadata true
openclaw config set plugins.entries.context-safe.config.retentionTiers.enabled true
```

`retentionTiers` 提供 canonical transcript 的窄规则分层提示：

- `critical`：优先保留最近尾部的非包装型用户意图，以及带 `verdict:` / `outcome:` 和 `reports/...` 路径的结论摘要
- `compressible`：压缩长且重复的 tool-result chatter
- `foldFirst`：优先折叠旧的 metadata-wrapper 文本

canonical session state 会额外记录两组轻量观测字段：

- `normalizedRuntimeChurnCount`：累计有多少条消息被 runtime churn slim 规则折叠过
- `lastRuntimeChurnKinds`：最近一次命中的 churn 类型列表
- `consecutiveCompactNoops` / `lastCompactReason` / `lastCompactFailedAt`：最近 compact 是否一直没有实质收益，和最近一次 compact/no-op 的原因

### Compact No-op Circuit Breaker

如果连续多次 `compact()` 都判断 canonical transcript 已经没有可压缩收益，插件会递增 `consecutiveCompactNoops`。达到阈值后，后续 compact 会直接返回 circuit-breaker reason，而不是继续重复做无意义 compact。

排查建议：

- 先查看 `~/.openclaw/artifacts/context-safe/session-state/<sessionId>.json`
- 关注 `consecutiveCompactNoops`、`lastCompactReason`、`lastCompactFailedAt`
- 如果原因是 `already minimal`，优先继续当前会话或等待更多新内容进入 canonical transcript，不要机械重复触发 compact
- 如果你在调配置，优先检查 `thresholdChars` 与 semantic tail 参数是不是把可裁剪区保护得过大

当某次同步真的发生折叠时，logger 会输出一条类似 `context-safe runtime-churn normalized=1 kinds=childCompletionInjection` 的信息。

### 开发与验证

```bash
pnpm exec vitest run --config vitest.config.ts
pnpm exec tsc -p tsconfig.json --noEmit
python3 -m py_compile scripts/install.py
```

当前包没有单独的 `build` script。收尾验证时用全量 `pnpm test` 和 `pnpm exec tsc -p tsconfig.json --noEmit` 作为 TypeScript 侧的最终门禁。

项目结构：

- `index.ts`：插件入口
- `src/hooks.ts`：官方 hook 入口
- `src/tool-result-persist.ts`：artifact、preview、details 压缩
- `src/context-engine.ts`：context engine
- `src/runtime-churn-policy.ts`：runtime churn 折叠规则
- `src/tool-result-policy.ts`：assemble 阶段的 tool result 裁剪策略
- `scripts/install.py`：官方命令封装脚本

## English

`context-safe` is an independently implemented plugin for official OpenClaw releases. It provides installable, removable, independently maintained context-safety behavior without patching OpenClaw core.

It is compatible with `OpenClaw >= 2026.3.8` and uses only official extension points:

- `before_tool_call`
- `tool_result_persist`
- `plugins.slots.contextEngine`

Important detail: official `v2026.3.8` does not expose an `excludeFromContext` parameter on `exec` or `web_fetch`. The plugin recreates a comparable outcome within the official plugin surface by rewriting persisted tool results, without patching OpenClaw core.

### What the Plugin Does

- adds safe defaults for `read`: `offset=1`, `limit=200`
- adds a safe default for `web_fetch`: `maxChars=12000`
- rewrites oversized `exec` / `bash` / `web_fetch` / `read` results during `tool_result_persist` into a short preview plus artifact path
- compacts oversized `details` into bounded metadata
- collapses high-churn runtime transcript noise during canonical-state sync, currently for compaction summaries, internal child-result injections, and Telegram / Feishu direct-chat metadata wrappers
- maintains a plugin-owned canonical context transcript in `contextEngine.assemble()` and applies durable prune decisions once the threshold is crossed

### Canonical Context Transcript

The plugin does not rewrite OpenClaw's raw transcript. Instead, it keeps a plugin-owned canonical context transcript per `sessionId` and uses that canonical state for future model-context assembly.

After runtime-churn normalization, the plugin also applies a narrow session-mode-aware slimming pass:

- `direct-chat`: collapses repeated Telegram / Feishu direct-chat metadata wrappers first
- `background-subagent`: drops progress chatter and keeps only the newest child-completion residue
- `acp-run`: drops progress chatter while preserving the final verdict and `reports/...` artifact path
- `default`: conservatively falls back to the existing behavior

Runtime churn slimming happens only after messages have already entered the transcript, during canonical-state sync. The current rules are intentionally narrow: compaction summaries, internal child-result completion injections, and Telegram / Feishu direct-chat metadata wrappers. This plugin does not stop OpenClaw core from emitting those events, and it does not redefine OpenClaw's completion truth source.

When the estimated `pruneGain >= thresholdChars`, the plugin prunes and persists the canonical transcript. Future requests then start from the pruned baseline instead of recalculating against the same historical noise every turn.

Current prune behavior:

- `pruneGain` counts only prune-eligible messages and ignores protected content
- protects the first 5 and last 5 messages in the session
- protects tool results linked to those head/tail windows
- protects `read` messages whose basename matches the protected list, case-insensitively
- protects tool results linked to those protected `read` messages
- prunes assistant `thinking` / `reasoning` blocks only outside the protected set
- replaces older unprotected `toolResult` payloads with `[pruned]` and drops `details`

### Why It Saves Tokens

The plugin saves tokens by preventing noisy tool output from staying inline in the transcript and getting re-sent to the model over and over.

It reduces token usage in four ways:

- large tool results are moved out of the inline transcript
  Full payloads are written to artifact files and replaced with a short preview plus recovery guidance.
- oversized `details` are compacted
  Large JSON blobs do not keep flowing back into future turns.
- the context engine enforces another budget pass before model execution
  Oversized tool results are truncated or compacted again during context assembly.
- the canonical transcript becomes the new baseline after the first thresholded prune
  The same historical `thinking` / `reasoning` and old tool output stop re-triggering the same prune work on every request.
- future turns keep the actionable trace, not the raw noise
  The model sees how to continue investigation instead of being forced to ingest the full payload again.

Typical effects:

- lower input token usage
- better long-session stability
- less context loss from one or two oversized tool calls

### Python Convenience Script

Recommended first path: use the repository's `scripts/install.py`.

Default install (recommended: pack first, then install the generated `.tgz`):

```bash
cd projects/openclaw-context-safe-plugin
python3 scripts/install.py
```

For local development only, opt into a mutable source install explicitly:

```bash
cd projects/openclaw-context-safe-plugin
python3 scripts/install.py --link
```

Uninstall:

```bash
cd projects/openclaw-context-safe-plugin
python3 scripts/install.py --uninstall
```

Dry run:

```bash
cd projects/openclaw-context-safe-plugin
python3 scripts/install.py --dry-run
```

### Official Install Commands

The recommended official CLI flow is to pack the plugin first and install the generated archive:

```bash
cd projects/openclaw-context-safe-plugin
ARTIFACT_DIR=/tmp/openclaw-context-safe-plugin-npm-artifacts
mkdir -p "$ARTIFACT_DIR"
npm pack --pack-destination "$ARTIFACT_DIR"
openclaw plugins install "$ARTIFACT_DIR"/context-safe-*.tgz
openclaw config set plugins.entries.context-safe.enabled true
openclaw config set plugins.slots.contextEngine context-safe
```

Only use a source `--link` install when you explicitly want a mutable local-development setup:

```bash
cd projects/openclaw-context-safe-plugin
openclaw plugins install --link .
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

Canonical session state is stored under the same artifact root:

```text
~/.openclaw/artifacts/context-safe/session-state/<sessionId>.json
```

### Prune Configuration

Default configuration:

```json
{
  "prune": {
    "thresholdChars": 100000,
    "keepRecentToolResults": 5,
    "placeholder": "[pruned]"
  },
  "runtimeChurn": {
    "enabled": true,
    "collapseCompactionSummaries": true,
    "collapseChildCompletionInjections": true,
    "collapseDirectChatMetadata": true
  }
}
```

Example OpenClaw config:

```bash
openclaw config set plugins.entries.context-safe.config.prune.thresholdChars 100000
openclaw config set plugins.entries.context-safe.config.prune.keepRecentToolResults 5
openclaw config set plugins.entries.context-safe.config.prune.placeholder "[pruned]"
openclaw config set plugins.entries.context-safe.config.runtimeChurn.enabled true
openclaw config set plugins.entries.context-safe.config.runtimeChurn.collapseCompactionSummaries true
openclaw config set plugins.entries.context-safe.config.runtimeChurn.collapseChildCompletionInjections true
openclaw config set plugins.entries.context-safe.config.runtimeChurn.collapseDirectChatMetadata true
```

Canonical session state also records two lightweight observability fields:

- `normalizedRuntimeChurnCount`: cumulative number of messages collapsed by runtime-churn rules
- `lastRuntimeChurnKinds`: churn kinds matched during the latest normalization pass

When a sync pass actually normalizes something, the logger emits a line similar to `context-safe runtime-churn normalized=1 kinds=childCompletionInjection`.

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
- `src/runtime-churn-policy.ts`: runtime churn normalization rules
- `src/tool-result-policy.ts`: assemble-time tool-result policy
- `scripts/install.py`: wrapper around official install commands
