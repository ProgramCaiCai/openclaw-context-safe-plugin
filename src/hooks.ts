import { applyPersistedToolResultPolicy } from "./tool-result-persist.js";

const DEFAULT_READ_LIMIT = 200;
const DEFAULT_READ_OFFSET = 1;
const DEFAULT_WEB_FETCH_MAX_CHARS = 12_000;

export function applyBeforeToolCallSafety(params: {
  toolName: string;
  params: Record<string, unknown>;
}): Record<string, unknown> {
  const toolName = params.toolName.trim().toLowerCase();
  const next = { ...params.params };

  if (toolName === "read") {
    if (!isPositiveNumber(next.limit)) {
      next.limit = DEFAULT_READ_LIMIT;
    }
    if (!isPositiveNumber(next.offset)) {
      next.offset = DEFAULT_READ_OFFSET;
    }
    return next;
  }

  if (toolName === "web_fetch") {
    if (!isPositiveNumber(next.maxChars)) {
      next.maxChars = DEFAULT_WEB_FETCH_MAX_CHARS;
    }
    return next;
  }

  return next;
}

export function applyToolResultPersistSafety(params: {
  message: Record<string, unknown>;
  toolName?: string;
  toolCallId?: string;
}): {
  message: Record<string, unknown>;
} {
  return applyPersistedToolResultPolicy({
    message: params.message,
    toolName: params.toolName,
    toolCallId: params.toolCallId,
  });
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
