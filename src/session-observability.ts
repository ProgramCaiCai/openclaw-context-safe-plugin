import { type ContextSafeMessage } from "./tool-result-policy.js";

const MAX_TOP_TOOL_OFFENDERS = 5;

export type ContextSafePruneReasonCounts = {
  assemble: number;
  afterTurn: number;
  compact: number;
};

export type ContextSafeToolOffender = {
  toolName: string;
  messageCount: number;
  approxChars: number;
  artifactizedCount: number;
  artifactFallbackCount: number;
  detailsCompactedCount: number;
};

export type ContextSafeSessionStats = {
  artifactizedCount: number;
  artifactFallbackCount: number;
  detailsCompactedCount: number;
  detailsCollapsedCount: number;
  compactedDetailsCharsRemoved: number;
  prunedChars: number;
  pruneReasons: ContextSafePruneReasonCounts;
  topToolOffenders: ContextSafeToolOffender[];
  consecutiveCompactNoops?: number;
  lastCompactReason?: string;
  lastCompactFailedAt?: string;
  compactCircuitBreakerTripped?: boolean;
};

export function summarizeContextSafeSessionStats(params: {
  messages: ContextSafeMessage[];
  previous?: ContextSafeSessionStats;
  pruneEvent?: {
    source: keyof ContextSafePruneReasonCounts;
    pruneGain: number;
  };
  compactState?: {
    consecutiveCompactNoops?: number;
    lastCompactReason?: string;
    lastCompactFailedAt?: string;
    compactCircuitBreakerTripped?: boolean;
  };
}): ContextSafeSessionStats {
  let artifactizedCount = 0;
  let artifactFallbackCount = 0;
  let detailsCompactedCount = 0;
  let detailsCollapsedCount = 0;
  let compactedDetailsCharsRemoved = 0;
  const offenders = new Map<string, ContextSafeToolOffender>();

  for (const message of params.messages) {
    if (!isToolResultMessage(message)) {
      continue;
    }

    const meta = readContextSafeMeta(message);
    const toolName = normalizeToolName(message.toolName) ?? normalizeToolName(message.tool_name) ?? "tool";
    const approxChars = estimateObservedImpactChars(message, meta);
    const offender = offenders.get(toolName) ?? {
      toolName,
      messageCount: 0,
      approxChars: 0,
      artifactizedCount: 0,
      artifactFallbackCount: 0,
      detailsCompactedCount: 0,
    };

    offender.messageCount += 1;
    offender.approxChars += approxChars;

    if (meta?.resultMode === "artifact") {
      artifactizedCount += 1;
      offender.artifactizedCount += 1;
    }
    if (meta?.resultMode === "inline-fallback" || meta?.artifactWriteFailed === true) {
      artifactFallbackCount += 1;
      offender.artifactFallbackCount += 1;
    }
    if (meta?.detailsCompacted === true) {
      detailsCompactedCount += 1;
      offender.detailsCompactedCount += 1;
      compactedDetailsCharsRemoved += Math.max(
        0,
        readNonNegativeInteger(meta.originalChars) - estimateUnknownChars(message.details),
      );
    }
    if (meta?.detailsCollapsed === true) {
      detailsCollapsedCount += 1;
    }

    offenders.set(toolName, offender);
  }

  const previousPruneReasons = params.previous?.pruneReasons ?? {
    assemble: 0,
    afterTurn: 0,
    compact: 0,
  };
  const pruneReasons: ContextSafePruneReasonCounts = {
    ...previousPruneReasons,
  };
  if (params.pruneEvent) {
    pruneReasons[params.pruneEvent.source] += 1;
  }
  const compactState = params.compactState ?? {
    consecutiveCompactNoops: params.previous?.consecutiveCompactNoops,
    lastCompactReason: params.previous?.lastCompactReason,
    lastCompactFailedAt: params.previous?.lastCompactFailedAt,
    compactCircuitBreakerTripped: params.previous?.compactCircuitBreakerTripped,
  };

  return {
    artifactizedCount,
    artifactFallbackCount,
    detailsCompactedCount,
    detailsCollapsedCount,
    compactedDetailsCharsRemoved,
    prunedChars:
      (params.previous?.prunedChars ?? 0) + Math.max(0, params.pruneEvent?.pruneGain ?? 0),
    pruneReasons,
    topToolOffenders: [...offenders.values()]
      .sort((left, right) => {
        if (right.approxChars !== left.approxChars) {
          return right.approxChars - left.approxChars;
        }
        if (right.messageCount !== left.messageCount) {
          return right.messageCount - left.messageCount;
        }
        return left.toolName.localeCompare(right.toolName);
      })
      .slice(0, MAX_TOP_TOOL_OFFENDERS),
    ...(compactState.consecutiveCompactNoops !== undefined
      ? { consecutiveCompactNoops: compactState.consecutiveCompactNoops }
      : {}),
    ...(compactState.lastCompactReason ? { lastCompactReason: compactState.lastCompactReason } : {}),
    ...(compactState.lastCompactFailedAt
      ? { lastCompactFailedAt: compactState.lastCompactFailedAt }
      : {}),
    ...(compactState.compactCircuitBreakerTripped !== undefined
      ? { compactCircuitBreakerTripped: compactState.compactCircuitBreakerTripped }
      : {}),
  };
}

function isToolResultMessage(message: ContextSafeMessage): boolean {
  return message.role === "toolResult" || message.role === "tool" || message.type === "toolResult";
}

function readContextSafeMeta(message: ContextSafeMessage): Record<string, unknown> | undefined {
  if (!isRecord(message.details)) {
    return undefined;
  }
  return isRecord(message.details.contextSafe) ? message.details.contextSafe : undefined;
}

function estimateObservedImpactChars(
  message: ContextSafeMessage,
  meta?: Record<string, unknown>,
): number {
  const originalTextChars = readNonNegativeInteger(meta?.originalTextChars);
  const originalDetailsChars = readNonNegativeInteger(meta?.originalDetailsChars);
  const originalChars = readNonNegativeInteger(meta?.originalChars);
  const currentChars = estimateCurrentMessageChars(message);
  return Math.max(currentChars, originalTextChars + originalDetailsChars, originalChars);
}

function estimateCurrentMessageChars(message: ContextSafeMessage): number {
  return collectMessageText(message).length + estimateUnknownChars(message.details);
}

function collectMessageText(message: ContextSafeMessage): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  if (!Array.isArray(message.content)) {
    return "";
  }
  return message.content
    .filter(
      (block) =>
        !!block && typeof block === "object" && (block as { type?: unknown }).type === "text",
    )
    .map((block) => String((block as { text?: unknown }).text ?? ""))
    .join("\n");
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

function normalizeToolName(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readNonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
