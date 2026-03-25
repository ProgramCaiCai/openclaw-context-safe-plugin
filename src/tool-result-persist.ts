import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveContextSafeArtifactBaseDir } from "./artifact-dir.js";
import { resolveToolResultRecoveryHint } from "./tool-result-notices.js";

const MAX_PERSISTED_DETAILS_CHARS = 4_096;
const MAX_DETAIL_STRING_CHARS = 1_024;
const MAX_DETAIL_ARRAY_ITEMS = 12;
const MAX_DETAIL_OBJECT_KEYS = 20;
const MAX_INLINE_PREVIEW_CHARS = 4_000;
const PREVIEW_OMISSION_MARKER = "\n\n[context-safe preview truncated]\n\n";

const AGGRESSIVE_EXTERNALIZATION_TOOLS = new Set(["exec", "bash", "web_fetch"]);
const OMIT = Symbol("omit");

type ToolResultMessage = Record<string, unknown>;
type PersistedResultMode = "artifact" | "inline" | "inline-fallback";
type ContextSafeMetadata = {
  resultMode?: PersistedResultMode;
  detailsCompacted?: boolean;
  detailsCollapsed?: boolean;
  excludedFromContext?: boolean;
  originalChars?: number;
  originalTextChars?: number;
  originalDetailsChars?: number;
  outputFile?: string;
  previewChars?: number;
  artifactWriteFailed?: boolean;
  artifactFailureReason?: "artifact-write-failed";
  collapseReason?: "post-compaction-hard-cap";
};

export function applyPersistedToolResultPolicy(params: {
  message: ToolResultMessage;
  toolName?: string;
  toolCallId?: string;
}): { message: ToolResultMessage } {
  if (!isToolResultMessage(params.message)) {
    return { message: params.message };
  }

  const toolName = resolveToolName(params.message, params.toolName);
  const toolCallId = resolveToolCallId(params.message, params.toolCallId);
  const toolText = getToolResultText(params.message);
  const textChars = toolText.length;
  const detailsCompaction = compactDetails((params.message as { details?: unknown }).details);

  if (
    shouldExternalizePersistedResult({
      toolName,
      textChars,
      detailsChars: detailsCompaction.originalChars,
    })
  ) {
    const artifactPayload = stringifyArtifactPayload(params.message);
    const artifactWrite = writeArtifactSync({
      toolName,
      toolCallId,
      payload: artifactPayload,
    });
    const previewSource = toolText || artifactPayload;
    const preview = buildPreviewText(previewSource, MAX_INLINE_PREVIEW_CHARS);
    const notice = buildExternalizedNotice({
      toolName,
      outputFile: artifactWrite.outputFile,
    });
    const details = applyDetailsMetadata(detailsCompaction.value, {
      resultMode: artifactWrite.outputFile ? "artifact" : "inline-fallback",
      excludedFromContext: true,
      originalTextChars: textChars,
      originalDetailsChars: detailsCompaction.originalChars,
      outputFile: artifactWrite.outputFile,
      previewChars: MAX_INLINE_PREVIEW_CHARS,
      artifactWriteFailed: artifactWrite.outputFile ? undefined : true,
      artifactFailureReason: artifactWrite.outputFile ? undefined : artifactWrite.failureReason,
    }, {
      enforceHardCap: detailsCompaction.compacted,
    });
    return {
      message: replaceToolResultContent(params.message, `${notice}\n\n${preview}`, details),
    };
  }

  if (detailsCompaction.compacted) {
    return {
      message: replaceToolResultDetails(
        params.message,
        applyDetailsMetadata(detailsCompaction.value, {
          resultMode: "inline",
        }, {
          enforceHardCap: true,
        }),
      ),
    };
  }

  const inlineDetails = applyInlineResultMode((params.message as { details?: unknown }).details);
  if (inlineDetails !== (params.message as { details?: unknown }).details) {
    return {
      message: replaceToolResultDetails(params.message, inlineDetails),
    };
  }

  return { message: params.message };
}

function isToolResultMessage(message: ToolResultMessage): boolean {
  return message.role === "toolResult" || message.role === "tool" || message.type === "toolResult";
}

function resolveToolName(message: ToolResultMessage, fallback?: string): string | undefined {
  return (
    normalizeToolName(fallback) ??
    normalizeToolName(asTrimmedString(message.toolName)) ??
    normalizeToolName(asTrimmedString(message.tool_name))
  );
}

function resolveToolCallId(message: ToolResultMessage, fallback?: string): string | undefined {
  return (
    asTrimmedString(fallback) ??
    asTrimmedString(message.toolCallId) ??
    asTrimmedString(message.tool_call_id)
  );
}

function normalizeToolName(value?: string): string | undefined {
  const trimmed = value?.trim().toLowerCase();
  return trimmed ? trimmed : undefined;
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function getToolResultText(message: ToolResultMessage): string {
  const content = message.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter(
      (block) =>
        !!block && typeof block === "object" && (block as { type?: unknown }).type === "text",
    )
    .map((block) => String((block as { text?: unknown }).text ?? ""))
    .join("\n");
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

function shouldExternalizePersistedResult(params: {
  toolName?: string;
  textChars: number;
  detailsChars: number;
}): boolean {
  const inlineLimit = resolveInlineCharLimit(params.toolName);
  if (params.textChars > inlineLimit) {
    return true;
  }
  return (
    AGGRESSIVE_EXTERNALIZATION_TOOLS.has(params.toolName ?? "") &&
    params.detailsChars > MAX_PERSISTED_DETAILS_CHARS
  );
}

function resolveInlineCharLimit(toolName?: string): number {
  if (toolName === "read") {
    return 12_000;
  }
  if (AGGRESSIVE_EXTERNALIZATION_TOOLS.has(toolName ?? "")) {
    return MAX_INLINE_PREVIEW_CHARS;
  }
  return 8_000;
}

function compactDetails(details: unknown): {
  value: unknown;
  originalChars: number;
  compacted: boolean;
} {
  const originalChars = estimateChars(details);
  if (originalChars <= MAX_PERSISTED_DETAILS_CHARS) {
    return {
      value: details,
      originalChars,
      compacted: false,
    };
  }

  const compacted = compactUnknown(details, 0);
  const normalized = compacted === OMIT ? undefined : compacted;
  return {
    value: mergeContextSafeMetadata(normalized, {
      detailsCompacted: true,
      originalChars,
    }),
    originalChars,
    compacted: true,
  };
}

function compactUnknown(value: unknown, depth: number): unknown | typeof OMIT {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    return value.length <= MAX_DETAIL_STRING_CHARS ? value : OMIT;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    if (depth >= 3) {
      return OMIT;
    }
    const next = value
      .slice(0, MAX_DETAIL_ARRAY_ITEMS)
      .map((entry) => compactUnknown(entry, depth + 1))
      .filter((entry) => entry !== OMIT);
    return next.length > 0 ? next : OMIT;
  }
  if (typeof value !== "object") {
    return String(value);
  }
  if (depth >= 3) {
    return OMIT;
  }

  const next: Record<string, unknown> = {};
  let count = 0;
  for (const [key, entry] of Object.entries(value)) {
    if (key === "contextSafe") {
      continue;
    }
    if (count >= MAX_DETAIL_OBJECT_KEYS) {
      break;
    }
    const compacted = compactUnknown(entry, depth + 1);
    if (compacted === OMIT) {
      continue;
    }
    next[key] = compacted;
    count += 1;
  }
  return Object.keys(next).length > 0 ? next : OMIT;
}

function mergeContextSafeMetadata(details: unknown, meta: ContextSafeMetadata): Record<string, unknown> {
  const nextMeta = Object.fromEntries(
    Object.entries(meta).filter(([, value]) => value !== undefined),
  );

  if (isRecord(details)) {
    const priorMeta = isRecord(details.contextSafe) ? details.contextSafe : {};
    return {
      ...details,
      contextSafe: {
        ...priorMeta,
        ...nextMeta,
      },
    };
  }

  return {
    contextSafe: nextMeta,
  };
}

function applyDetailsMetadata(
  details: unknown,
  meta: ContextSafeMetadata,
  options?: { enforceHardCap?: boolean },
): Record<string, unknown> {
  const merged = mergeContextSafeMetadata(details, meta);
  if (!options?.enforceHardCap || estimateChars(merged) <= MAX_PERSISTED_DETAILS_CHARS) {
    return merged;
  }

  const collapsedMeta = isRecord(merged.contextSafe) ? merged.contextSafe : {};
  return {
    contextSafe: {
      ...collapsedMeta,
      detailsCollapsed: true,
      collapseReason: "post-compaction-hard-cap",
    },
  };
}

function applyInlineResultMode(details: unknown): unknown {
  if (details === undefined) {
    return details;
  }
  return mergeContextSafeMetadata(details, {
    resultMode: "inline",
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function buildExternalizedNotice(params: {
  toolName?: string;
  outputFile?: string;
}): string {
  const toolLabel = params.toolName ?? "tool";
  const location = params.outputFile
    ? `saved to ${params.outputFile}`
    : "artifact save failed";
  return `[context-safe] ${toolLabel} output excluded from context; ${location}. ${resolveRecoveryHint(
    params.toolName,
  )}`;
}

function resolveRecoveryHint(toolName?: string): string {
  return resolveToolResultRecoveryHint(toolName);
}

function buildPreviewText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  const markerBudget = PREVIEW_OMISSION_MARKER.length;
  if (maxChars <= markerBudget + 2) {
    return text.slice(0, maxChars);
  }

  const headBudget = Math.max(1, Math.floor((maxChars - markerBudget) * 0.7));
  const tailBudget = Math.max(1, maxChars - markerBudget - headBudget);

  return `${trimToLineBoundary(text.slice(0, headBudget), "end")}${PREVIEW_OMISSION_MARKER}${trimToLineBoundary(text.slice(-tailBudget), "start")}`;
}

function trimToLineBoundary(text: string, edge: "start" | "end"): string {
  if (!text.includes("\n")) {
    return text;
  }
  if (edge === "end") {
    const newline = text.lastIndexOf("\n");
    if (newline > text.length * 0.7) {
      return text.slice(0, newline);
    }
    return text;
  }
  const newline = text.indexOf("\n");
  if (newline >= 0 && newline < text.length * 0.3) {
    return text.slice(newline + 1);
  }
  return text;
}

function replaceToolResultContent(
  message: ToolResultMessage,
  text: string,
  details: unknown,
): ToolResultMessage {
  const { details: _oldDetails, ...rest } = message;
  return {
    ...rest,
    content:
      typeof message.content === "string" || message.content === undefined
        ? text
        : [{ type: "text", text }],
    details,
  };
}

function replaceToolResultDetails(message: ToolResultMessage, details: unknown): ToolResultMessage {
  return {
    ...message,
    details,
  };
}

function stringifyArtifactPayload(message: ToolResultMessage): string {
  try {
    return JSON.stringify(message, null, 2);
  } catch {
    return String(message.content ?? "");
  }
}

function writeArtifactSync(params: {
  toolName?: string;
  toolCallId?: string;
  payload: string;
}): { outputFile?: string; failureReason?: "artifact-write-failed" } {
  try {
    const directory = path.join(resolveArtifactBaseDir(), sanitizePathSegment(params.toolName));
    fs.mkdirSync(directory, { recursive: true });
    const filePath = path.join(directory, buildArtifactFileName(params));
    fs.writeFileSync(filePath, params.payload, "utf8");
    return { outputFile: filePath };
  } catch {
    return { failureReason: "artifact-write-failed" };
  }
}

function resolveArtifactBaseDir(): string {
  return resolveContextSafeArtifactBaseDir();
}

function sanitizePathSegment(value?: string): string {
  const raw = value?.trim().toLowerCase() || "tool";
  return raw.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "tool";
}

function buildArtifactFileName(params: { toolName?: string; toolCallId?: string }): string {
  const toolSegment = sanitizePathSegment(params.toolName);
  const idSource = params.toolCallId?.trim() || `${toolSegment}-${Date.now()}`;
  const hash = crypto.createHash("sha256").update(idSource).digest("hex").slice(0, 12);
  return `${Date.now()}-${toolSegment}-${hash}.json`;
}
