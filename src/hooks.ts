const DEFAULT_READ_LIMIT = 200;
const DEFAULT_READ_OFFSET = 1;
const DEFAULT_WEB_FETCH_MAX_CHARS = 12_000;
const MAX_PERSISTED_DETAILS_CHARS = 4_096;

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

  if (toolName === "exec" || toolName === "bash") {
    if (next.excludeFromContext !== true) {
      next.excludeFromContext = true;
    }
    return next;
  }

  if (toolName === "web_fetch") {
    if (next.excludeFromContext !== true) {
      next.excludeFromContext = true;
    }
    if (!isPositiveNumber(next.maxChars)) {
      next.maxChars = DEFAULT_WEB_FETCH_MAX_CHARS;
    }
    return next;
  }

  return next;
}

export function applyToolResultPersistSafety(params: { message: Record<string, unknown> }): {
  message: Record<string, unknown>;
} {
  if (!isToolResultMessage(params.message)) {
    return { message: params.message };
  }

  const details = params.message.details;
  if (estimateChars(details) <= MAX_PERSISTED_DETAILS_CHARS) {
    return { message: params.message };
  }

  const { details: _details, ...rest } = params.message;
  return { message: rest };
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function estimateChars(value: unknown): number {
  if (typeof value === "string") {
    return value.length;
  }
  if (value === undefined) {
    return 0;
  }
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return MAX_PERSISTED_DETAILS_CHARS + 1;
  }
}

function isToolResultMessage(message: Record<string, unknown>): boolean {
  return message.role === "toolResult" || message.role === "tool" || message.type === "toolResult";
}
