import {
  DEFAULT_RETENTION_TIER_COMPRESSIBLE,
  DEFAULT_RETENTION_TIER_CRITICAL,
  DEFAULT_RETENTION_TIER_FOLD_FIRST,
} from "./config.js";
import { resolveToolResultRecoveryHint } from "./tool-result-notices.js";

export const CONTEXT_LIMIT_TRUNCATION_NOTICE = "[truncated: output exceeded context limit]";
export const PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER =
  "[compacted: tool output removed to free context]";

const CONTEXT_INPUT_HEADROOM_RATIO = 0.75;
const SINGLE_TOOL_RESULT_CONTEXT_SHARE = 0.5;
const CHARS_PER_TOKEN_ESTIMATE = 4;
const TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE = 2;
const MIN_CONTEXT_BUDGET_CHARS = 280;
const MIN_SINGLE_TOOL_RESULT_CHARS = 160;
const CONTEXT_NOTICE_PREFIX = "[context:";
const PROTECTED_READ_BASENAMES = new Set([
  "agents.md",
  "heartbeat.md",
  "identity.md",
  "memory.md",
  "now.md",
  "session-state.md",
  "skill.md",
  "soul.md",
  "today.md",
  "tools.md",
  "user.md",
]);

export type ContextSafeMessage = {
  role?: string;
  type?: string;
  content?: unknown;
  details?: unknown;
  toolName?: string;
  tool_name?: string;
  toolCallId?: string;
  tool_call_id?: string;
  [key: string]: unknown;
};

export function classifyCanonicalRetentionTier(params: {
  message: ContextSafeMessage;
  messageIndex: number;
  totalMessages: number;
}): "critical" | "compressible" | "foldFirst" {
  const text = collectMessageText(params.message).toLowerCase();
  const tailDistance = Math.max(0, params.totalMessages - params.messageIndex - 1);

  if (
    params.message.role === "user" &&
    tailDistance <= 3 &&
    !containsAny(text, DEFAULT_RETENTION_TIER_FOLD_FIRST) &&
    containsAny(text, DEFAULT_RETENTION_TIER_CRITICAL)
  ) {
    return "critical";
  }

  if (
    /(?:^|\s)reports\/\S+/i.test(text) &&
    /\b(?:verdict|outcome)\s*:/i.test(text)
  ) {
    return "critical";
  }

  if (containsAny(text, DEFAULT_RETENTION_TIER_FOLD_FIRST) && tailDistance > 3) {
    return "foldFirst";
  }

  if (isToolResultMessage(params.message) && isCompressibleToolResultText(text)) {
    return "compressible";
  }

  return "compressible";
}

export function estimatePruneGain(params: {
  messages: ContextSafeMessage[];
  thresholdChars: number;
  keepRecentToolResults: number;
  placeholder: string;
}): number {
  const protectedIndexes = findProtectedMessageIndexes(params.messages, params.keepRecentToolResults);
  let gain = 0;

  for (let i = 0; i < params.messages.length; i++) {
    const message = params.messages[i];

    if (message.role === "assistant" && !protectedIndexes.has(i)) {
      gain += estimateThinkingChars(message);
      continue;
    }

    if (!isToolResultMessage(message) || protectedIndexes.has(i)) {
      continue;
    }

    const pruned = pruneToolResultMessage(message, params.placeholder);
    gain += Math.max(0, estimateMessageChars(message) - estimateMessageChars(pruned));
  }

  return gain;
}

export function applyCanonicalPrune(params: {
  messages: ContextSafeMessage[];
  thresholdChars: number;
  keepRecentToolResults: number;
  placeholder: string;
}): {
  messages: ContextSafeMessage[];
  pruneGain: number;
  pruned: boolean;
} {
  const pruneGain = estimatePruneGain(params);
  if (pruneGain < params.thresholdChars) {
    return {
      messages: params.messages,
      pruneGain,
      pruned: false,
    };
  }

  const protectedIndexes = findProtectedMessageIndexes(params.messages, params.keepRecentToolResults);
  const messages = params.messages.map((message, index) => {
    if (protectedIndexes.has(index)) {
      return message;
    }
    if (message.role === "assistant") {
      return pruneAssistantThinking(message);
    }
    if (!isToolResultMessage(message)) {
      return message;
    }
    return pruneToolResultMessage(message, params.placeholder);
  });

  return {
    messages,
    pruneGain,
    pruned: true,
  };
}

export function applyContextToolResultPolicy(params: {
  messages: ContextSafeMessage[];
  contextWindowTokens: number;
}): { messages: ContextSafeMessage[]; estimatedChars: number } {
  const contextBudgetChars = Math.max(
    MIN_CONTEXT_BUDGET_CHARS,
    Math.floor(
      params.contextWindowTokens * CHARS_PER_TOKEN_ESTIMATE * CONTEXT_INPUT_HEADROOM_RATIO,
    ),
  );
  const maxSingleToolResultChars = Math.max(
    MIN_SINGLE_TOOL_RESULT_CHARS,
    Math.floor(
      params.contextWindowTokens *
        TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE *
        SINGLE_TOOL_RESULT_CONTEXT_SHARE,
    ),
  );

  const messages = params.messages.map((message) => ({ ...message }));

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (!isToolResultMessage(message)) {
      continue;
    }
    messages[i] = truncateToolResultToChars(message, maxSingleToolResultChars);
  }

  let estimatedChars = estimateContextChars(messages);
  if (estimatedChars <= contextBudgetChars) {
    return { messages, estimatedChars };
  }

  for (let i = 0; i < messages.length && estimatedChars > contextBudgetChars; i++) {
    const message = messages[i];
    if (!isToolResultMessage(message)) {
      continue;
    }

    const before = estimateMessageChars(message);
    const compacted = replaceToolResultText(
      message,
      buildCompactionNotice({
        msg: message,
        removedChars: before,
        maxCharsHint: before,
      }),
    );
    const after = estimateMessageChars(compacted);
    if (after >= before) {
      continue;
    }
    messages[i] = compacted;
    estimatedChars -= before - after;
  }

  return {
    messages,
    estimatedChars: estimateContextChars(messages),
  };
}

function isToolResultMessage(message: ContextSafeMessage): boolean {
  return message.role === "toolResult" || message.role === "tool" || message.type === "toolResult";
}

function findProtectedMessageIndexes(messages: ContextSafeMessage[], protectedWindowSize: number): Set<number> {
  const protectedIndexes = new Set<number>();
  const protectedToolCallIds = new Set<string>();
  const windowSize = Math.max(0, protectedWindowSize);
  const headStop = Math.min(messages.length, windowSize);
  const tailStart = Math.max(0, messages.length - windowSize);

  for (let i = 0; i < headStop; i++) {
    protectedIndexes.add(i);
    addProtectedToolCallIds(protectedToolCallIds, messages[i]);
  }
  for (let i = tailStart; i < messages.length; i++) {
    protectedIndexes.add(i);
    addProtectedToolCallIds(protectedToolCallIds, messages[i]);
  }

  for (let i = 0; i < messages.length; i++) {
    if (!isProtectedReadMessage(messages[i])) {
      continue;
    }
    protectedIndexes.add(i);
    addProtectedToolCallIds(protectedToolCallIds, messages[i]);
  }

  for (let i = 0; i < messages.length; i++) {
    const toolCallId = getMessageToolCallId(messages[i]);
    if (toolCallId && protectedToolCallIds.has(toolCallId) && isToolResultMessage(messages[i])) {
      protectedIndexes.add(i);
    }
  }

  return protectedIndexes;
}

function textBlocksOf(message: ContextSafeMessage): string[] {
  const content = message.content;
  if (typeof content === "string") {
    return [content];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  return content
    .filter(
      (block) =>
        !!block && typeof block === "object" && (block as { type?: unknown }).type === "text",
    )
    .map((block) => String((block as { text?: unknown }).text ?? ""));
}

function collectMessageText(message: ContextSafeMessage): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  return textBlocksOf(message).join("\n");
}

function getToolResultText(message: ContextSafeMessage): string {
  return textBlocksOf(message).join("\n");
}

function estimateUnknownChars(value: unknown): number {
  if (typeof value === "string") {
    return value.length;
  }
  if (value === undefined) {
    return 0;
  }
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 256;
  }
}

function estimateMessageChars(message: ContextSafeMessage): number {
  if (hasRuntimeChurnAnnotation(message)) {
    return textBlocksOf(message).join("\n").length;
  }

  if (message.role === "user") {
    if (typeof message.content === "string") {
      return message.content.length;
    }
    return textBlocksOf(message).join("\n").length;
  }

  if (message.role === "assistant") {
    return textBlocksOf(message).join("\n").length;
  }

  if (isToolResultMessage(message)) {
    const toolText = textBlocksOf(message).join("\n");
    const contentChars = toolText.length;
    const detailsChars = estimateUnknownChars(message.details);
    const isGuardedPlaceholder =
      detailsChars === 0 &&
      (toolText.startsWith(PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER) ||
        toolText.includes(CONTEXT_LIMIT_TRUNCATION_NOTICE));
    if (isGuardedPlaceholder) {
      return contentChars;
    }
    const weighted = Math.ceil(
      (contentChars + detailsChars) *
        (CHARS_PER_TOKEN_ESTIMATE / TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE),
    );
    return Math.max(contentChars + detailsChars, weighted);
  }

  return estimateUnknownChars(message.content);
}

function estimateThinkingChars(message: ContextSafeMessage): number {
  if (!Array.isArray(message.content)) {
    return 0;
  }
  return message.content.reduce((sum, block) => {
    if (!isThinkingLikeBlock(block)) {
      return sum;
    }
    return sum + getThinkingLikeChars(block);
  }, 0);
}

function estimateContextChars(messages: ContextSafeMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateMessageChars(message), 0);
}

function addProtectedToolCallIds(target: Set<string>, message: ContextSafeMessage): void {
  const toolCallId = getMessageToolCallId(message);
  if (toolCallId) {
    target.add(toolCallId);
  }
  if (!Array.isArray(message.content)) {
    return;
  }
  for (const block of message.content) {
    const blockToolCallId = getToolCallIdFromValue(block);
    if (blockToolCallId) {
      target.add(blockToolCallId);
    }
  }
}

function getMessageToolCallId(message: ContextSafeMessage): string | undefined {
  return asTrimmedString(message.toolCallId) ?? asTrimmedString(message.tool_call_id);
}

function getToolCallIdFromValue(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return (
    asTrimmedString(value.toolCallId) ??
    asTrimmedString(value.tool_call_id) ??
    asTrimmedString(value.id)
  );
}

function isProtectedReadMessage(message: ContextSafeMessage): boolean {
  for (const candidate of extractReadPathCandidates(message)) {
    const basename = candidate.replaceAll("\\", "/").split("/").pop()?.trim().toLowerCase();
    if (basename && PROTECTED_READ_BASENAMES.has(basename)) {
      return true;
    }
  }
  return false;
}

function extractReadPathCandidates(message: ContextSafeMessage): string[] {
  const candidates: string[] = [];
  if (isReadToolValue(message)) {
    candidates.push(...extractPathCandidates(message.input));
    candidates.push(...extractPathCandidates(message.params));
    candidates.push(...extractPathCandidates(message.arguments));
    candidates.push(...extractPathCandidates(message.args));
  }
  if (!Array.isArray(message.content)) {
    return candidates;
  }
  for (const block of message.content) {
    if (!isReadToolValue(block)) {
      continue;
    }
    candidates.push(...extractPathCandidates(block.input));
    candidates.push(...extractPathCandidates(block.params));
    candidates.push(...extractPathCandidates(block.arguments));
    candidates.push(...extractPathCandidates(block.args));
  }
  return candidates;
}

function isReadToolValue(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }
  const toolName =
    asTrimmedString(value.toolName) ??
    asTrimmedString(value.tool_name) ??
    asTrimmedString(value.name);
  return toolName?.toLowerCase() === "read";
}

function extractPathCandidates(value: unknown): string[] {
  if (!isRecord(value)) {
    return [];
  }
  const candidates = [
    asTrimmedString(value.path),
    asTrimmedString(value.filePath),
    asTrimmedString(value.filepath),
    asTrimmedString(value.file_path),
  ];
  return candidates.filter((candidate): candidate is string => !!candidate);
}

function containsAny(text: string, candidates: readonly string[]): boolean {
  return candidates.some((candidate) => text.includes(candidate.toLowerCase()));
}

function isCompressibleToolResultText(text: string): boolean {
  const lines = text
    .split("\n")
    .map((line) => line.trim().toLowerCase())
    .filter((line) => line.length > 0);
  const repeatedLineCount = lines.length - new Set(lines).size;
  return (
    lines.length >= 4 &&
    repeatedLineCount >= 2 &&
    containsAny(text, DEFAULT_RETENTION_TIER_COMPRESSIBLE)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasRuntimeChurnAnnotation(message: ContextSafeMessage): boolean {
  const value = message.contextSafeRuntimeChurn;
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { normalized?: unknown }).normalized === true
  );
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function shortenContextToken(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  if (maxChars <= 3) {
    return value.slice(0, maxChars);
  }
  const head = Math.max(1, Math.floor((maxChars - 3) / 2));
  const tail = Math.max(1, maxChars - 3 - head);
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}

function getToolResultMeta(message: ContextSafeMessage): {
  toolName?: string;
  toolCallId?: string;
} {
  const toolNameRaw = asTrimmedString(message.toolName) ?? asTrimmedString(message.tool_name);
  const toolCallIdRaw =
    asTrimmedString(message.toolCallId) ?? asTrimmedString(message.tool_call_id);
  return {
    toolName: toolNameRaw ? shortenContextToken(toolNameRaw.replace(/\s+/g, " "), 32) : undefined,
    toolCallId: toolCallIdRaw
      ? shortenContextToken(toolCallIdRaw.replace(/\s+/g, " "), 24)
      : undefined,
  };
}

function resolveRecoveryHint(toolName?: string): string {
  return resolveToolResultRecoveryHint(toolName);
}

function formatContextDetailLine(params: {
  msg: ContextSafeMessage;
  detailParts: string[];
}): string {
  const meta = getToolResultMeta(params.msg);
  const parts = [...params.detailParts];
  if (meta.toolName) {
    parts.unshift(`tool=${meta.toolName}`);
  }
  if (meta.toolCallId) {
    parts.unshift(`call=${meta.toolCallId}`);
  }
  const details = parts.filter((part) => part.length > 0).join("; ");
  const hint = resolveRecoveryHint(meta.toolName);
  const body = details ? `${details}. ${hint}` : hint;
  return `${CONTEXT_NOTICE_PREFIX} ${body}]`;
}

function buildContextLimitNotice(params: {
  msg: ContextSafeMessage;
  originalChars: number;
  maxChars: number;
}): string {
  const detailLine = formatContextDetailLine({
    msg: params.msg,
    detailParts: [
      `original~${Math.max(0, Math.floor(params.originalChars))} chars`,
      `limit~${Math.max(0, Math.floor(params.maxChars))} chars`,
    ],
  });
  return `${CONTEXT_LIMIT_TRUNCATION_NOTICE}\n${detailLine}`;
}

function fitContextLimitNotice(params: {
  msg: ContextSafeMessage;
  originalChars: number;
  maxChars: number;
}): string {
  const fullNotice = buildContextLimitNotice(params);
  if (fullNotice.length <= params.maxChars) {
    return fullNotice;
  }

  const shorterNotice = `${CONTEXT_LIMIT_TRUNCATION_NOTICE}\n${resolveRecoveryHint(
    getToolResultMeta(params.msg).toolName,
  )}`;
  const compactShorterNotice = `${CONTEXT_LIMIT_TRUNCATION_NOTICE}\n${formatContextDetailLine({
    msg: params.msg,
    detailParts: [],
  })}`;
  if (compactShorterNotice.length <= params.maxChars) {
    return compactShorterNotice;
  }
  if (shorterNotice.length <= params.maxChars) {
    return shorterNotice;
  }

  const hintOnly = resolveRecoveryHint(getToolResultMeta(params.msg).toolName);
  if (hintOnly.length <= params.maxChars) {
    return hintOnly;
  }

  return CONTEXT_LIMIT_TRUNCATION_NOTICE;
}

function buildCompactionNotice(params: {
  msg: ContextSafeMessage;
  removedChars: number;
  maxCharsHint: number;
}): string {
  const detailLine = formatContextDetailLine({
    msg: params.msg,
    detailParts: [`removed~${Math.max(0, Math.floor(params.removedChars))} chars`],
  });
  const detailed = `${PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER}\n${detailLine}`;
  if (detailed.length >= params.maxCharsHint) {
    return PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER;
  }
  return detailed;
}

function truncateTextToBudget(text: string, maxChars: number, suffix: string): string {
  if (text.length <= maxChars) {
    return text;
  }
  if (maxChars <= 0) {
    return CONTEXT_LIMIT_TRUNCATION_NOTICE;
  }

  const bodyBudget = Math.max(0, maxChars - suffix.length);
  if (bodyBudget <= 0) {
    return suffix.length <= maxChars ? suffix : CONTEXT_LIMIT_TRUNCATION_NOTICE;
  }

  let cutPoint = bodyBudget;
  const newline = text.lastIndexOf("\n", bodyBudget);
  if (newline > bodyBudget * 0.7) {
    cutPoint = newline;
  }

  return text.slice(0, cutPoint) + suffix;
}

function replaceToolResultText(message: ContextSafeMessage, text: string): ContextSafeMessage {
  const { details: _details, ...rest } = message;
  const content =
    typeof message.content === "string" || message.content === undefined
      ? text
      : [{ type: "text", text }];
  return {
    ...rest,
    content,
  };
}

function pruneToolResultMessage(message: ContextSafeMessage, placeholder: string): ContextSafeMessage {
  return replaceToolResultText(message, placeholder);
}

function pruneAssistantThinking(message: ContextSafeMessage): ContextSafeMessage {
  if (!Array.isArray(message.content)) {
    return message;
  }

  const content = message.content.filter((block) => !isThinkingLikeBlock(block));
  if (content.length > 0) {
    return {
      ...message,
      content,
    };
  }

  return {
    ...message,
    content: [{ type: "text", text: "" }],
  };
}

function getThinkingLikeChars(value: { thinking?: unknown; reasoning?: unknown; text?: unknown }): number {
  return String(value.thinking ?? value.reasoning ?? value.text ?? "").length;
}

function isThinkingLikeBlock(
  value: unknown,
): value is { type: "thinking" | "reasoning"; thinking?: unknown; reasoning?: unknown; text?: unknown } {
  if (!value || typeof value !== "object") {
    return false;
  }
  const type = (value as { type?: unknown }).type;
  return type === "thinking" || type === "reasoning";
}

function truncateToolResultToChars(
  message: ContextSafeMessage,
  maxChars: number,
): ContextSafeMessage {
  const estimatedChars = estimateMessageChars(message);
  if (estimatedChars <= maxChars) {
    return message;
  }

  const fittedNotice = fitContextLimitNotice({
    msg: message,
    originalChars: estimatedChars,
    maxChars,
  });
  const rawText = getToolResultText(message);
  if (!rawText) {
    return replaceToolResultText(message, fittedNotice);
  }

  return replaceToolResultText(
    message,
    truncateTextToBudget(rawText, maxChars, `\n${fittedNotice}`),
  );
}
