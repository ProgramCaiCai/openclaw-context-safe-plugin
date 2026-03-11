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

function estimateContextChars(messages: ContextSafeMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateMessageChars(message), 0);
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
