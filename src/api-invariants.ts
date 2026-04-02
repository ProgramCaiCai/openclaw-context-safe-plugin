import { type ContextSafeMessage } from "./tool-result-policy.js";

export function preserveApiInvariants(
  messages: ContextSafeMessage[],
  startIndex: number,
): number {
  if (startIndex <= 0 || startIndex >= messages.length) {
    return startIndex;
  }

  let adjustedIndex = startIndex;
  const allToolResultIds: string[] = [];
  for (let i = startIndex; i < messages.length; i++) {
    allToolResultIds.push(...getToolResultIds(messages[i]));
  }

  if (allToolResultIds.length > 0) {
    const toolUseIdsInKeptRange = new Set<string>();
    for (let i = adjustedIndex; i < messages.length; i++) {
      for (const toolUseId of getToolUseIds(messages[i])) {
        toolUseIdsInKeptRange.add(toolUseId);
      }
    }

    const neededToolUseIds = new Set(
      allToolResultIds.filter((id) => !toolUseIdsInKeptRange.has(id)),
    );

    for (let i = adjustedIndex - 1; i >= 0 && neededToolUseIds.size > 0; i--) {
      const toolUseIds = getToolUseIds(messages[i]);
      if (toolUseIds.some((id) => neededToolUseIds.has(id))) {
        adjustedIndex = i;
        for (const toolUseId of toolUseIds) {
          neededToolUseIds.delete(toolUseId);
        }
      }
    }
  }

  const assistantMessageIds = new Set<string>();
  for (let i = adjustedIndex; i < messages.length; i++) {
    const messageId = getAssistantMessageId(messages[i]);
    if (messageId) {
      assistantMessageIds.add(messageId);
    }
  }

  for (let i = adjustedIndex - 1; i >= 0; i--) {
    const messageId = getAssistantMessageId(messages[i]);
    if (messageId && assistantMessageIds.has(messageId)) {
      adjustedIndex = i;
    }
  }

  return adjustedIndex;
}

function getToolResultIds(message: ContextSafeMessage | undefined): string[] {
  if (!message) {
    return [];
  }
  const ids = new Set<string>();
  const directToolCallId =
    asTrimmedString(message.toolCallId) ?? asTrimmedString(message.tool_call_id);
  if (isToolResultMessage(message) && directToolCallId) {
    ids.add(directToolCallId);
  }
  if (!Array.isArray(message.content)) {
    return [...ids];
  }
  for (const block of message.content) {
    if (!isRecord(block) || block.type !== "tool_result") {
      continue;
    }
    const blockId =
      asTrimmedString(block.tool_use_id) ??
      asTrimmedString(block.toolUseId) ??
      asTrimmedString(block.id);
    if (blockId) {
      ids.add(blockId);
    }
  }
  return [...ids];
}

function getToolUseIds(message: ContextSafeMessage | undefined): string[] {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) {
    return [];
  }
  const ids = new Set<string>();
  for (const block of message.content) {
    if (!isRecord(block) || block.type !== "tool_use") {
      continue;
    }
    const blockId = asTrimmedString(block.id);
    if (blockId) {
      ids.add(blockId);
    }
  }
  return [...ids];
}

function getAssistantMessageId(message: ContextSafeMessage | undefined): string | undefined {
  if (!message || message.role !== "assistant") {
    return undefined;
  }
  const directId =
    asTrimmedString(message.id) ??
    asTrimmedString(message.messageId) ??
    asTrimmedString(message.message_id);
  if (directId) {
    return directId;
  }
  return isRecord(message.message) ? asTrimmedString(message.message.id) : undefined;
}

function isToolResultMessage(message: ContextSafeMessage): boolean {
  return message.role === "toolResult" || message.role === "tool" || message.type === "toolResult";
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
