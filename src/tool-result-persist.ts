import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveToolResultRecoveryHint } from "./tool-result-notices.js";

const MAX_PERSISTED_DETAILS_CHARS = 4_096;
const MAX_DETAIL_STRING_CHARS = 1_024;
const MAX_DETAIL_ARRAY_ITEMS = 12;
const MAX_DETAIL_OBJECT_KEYS = 20;
const MAX_INLINE_PREVIEW_CHARS = 4_000;
const PREVIEW_OMISSION_MARKER = "\n\n[context-safe preview truncated]\n\n";
const DEFAULT_ARTIFACT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_ARTIFACT_MAX_BYTES = 128 * 1024 * 1024;

const AGGRESSIVE_EXTERNALIZATION_TOOLS = new Set(["exec", "bash", "web_fetch"]);
const OMIT = Symbol("omit");

type ToolResultMessage = Record<string, unknown>;
type ContextSafeMetadata = {
  artifactWriteFailed?: boolean;
  detailsCompacted?: boolean;
  detailsHardLimited?: boolean;
  excludedFromContext?: boolean;
  originalChars?: number;
  originalTextChars?: number;
  originalDetailsChars?: number;
  outputFile?: string;
  previewChars?: number;
  retainedSummaryOnly?: boolean;
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
    const outputFile = writeArtifactSync({
      toolName,
      toolCallId,
      payload: artifactPayload,
    });
    const previewSource = toolText || artifactPayload;
    const preview = buildPreviewText(previewSource, MAX_INLINE_PREVIEW_CHARS);

    if (outputFile) {
      const notice = buildExternalizedNotice({
        toolName,
        outputFile,
      });
      const details = withHardLimitedContextSafeMetadata(
        detailsCompaction.value,
        {
          excludedFromContext: true,
          originalTextChars: textChars,
          originalDetailsChars: detailsCompaction.originalChars,
          outputFile,
          previewChars: MAX_INLINE_PREVIEW_CHARS,
        },
        detailsCompaction.originalChars,
      );
      return {
        message: replaceToolResultContent(params.message, `${notice}\n\n${preview}`, details),
      };
    }

    const fallbackNotice = buildInlineFallbackNotice({ toolName });
    const fallbackDetails = withHardLimitedContextSafeMetadata(
      detailsCompaction.value,
      {
        artifactWriteFailed: true,
        excludedFromContext: false,
        originalTextChars: textChars,
        originalDetailsChars: detailsCompaction.originalChars,
        previewChars: MAX_INLINE_PREVIEW_CHARS,
      },
      detailsCompaction.originalChars,
    );
    return {
      message: replaceToolResultContent(
        params.message,
        `${fallbackNotice}\n\n${preview}`,
        fallbackDetails,
      ),
    };
  }

  if (detailsCompaction.compacted) {
    return {
      message: replaceToolResultDetails(params.message, detailsCompaction.value),
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
    value: withHardLimitedContextSafeMetadata(
      normalized,
      {
        detailsCompacted: true,
        originalChars,
      },
      originalChars,
    ),
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

function withHardLimitedContextSafeMetadata(
  details: unknown,
  meta: ContextSafeMetadata,
  originalChars: number,
): Record<string, unknown> {
  const merged = mergeContextSafeMetadata(details, meta);
  return enforceDetailsHardLimit(merged, originalChars);
}

function enforceDetailsHardLimit(details: Record<string, unknown>, originalChars: number) {
  if (estimateChars(details) <= MAX_PERSISTED_DETAILS_CHARS) {
    return details;
  }

  const existingMeta = isRecord(details.contextSafe) ? details.contextSafe : {};
  const summaryMeta = {
    ...existingMeta,
    detailsCompacted: true,
    detailsHardLimited: true,
    originalChars,
    retainedSummaryOnly: true,
  };
  const summaryOnly = { contextSafe: summaryMeta };
  if (estimateChars(summaryOnly) <= MAX_PERSISTED_DETAILS_CHARS) {
    return summaryOnly;
  }

  return {
    contextSafe: {
      detailsCompacted: true,
      detailsHardLimited: true,
      originalChars,
      retainedSummaryOnly: true,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function buildExternalizedNotice(params: {
  toolName?: string;
  outputFile: string;
}): string {
  const toolLabel = params.toolName ?? "tool";
  return `[context-safe] ${toolLabel} output excluded from context; saved to ${params.outputFile}. ${resolveRecoveryHint(
    params.toolName,
  )}`;
}

function buildInlineFallbackNotice(params: { toolName?: string }): string {
  const toolLabel = params.toolName ?? "tool";
  return `[context-safe] ${toolLabel} output kept inline because artifact save failed. ${resolveRecoveryHint(
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
}): string | undefined {
  const baseDir = resolveArtifactBaseDir();
  try {
    const directory = path.join(baseDir, sanitizePathSegment(params.toolName));
    fs.mkdirSync(directory, { recursive: true });
    const filePath = path.join(directory, buildArtifactFileName(params));
    fs.writeFileSync(filePath, params.payload, "utf8");
    gcArtifactsSync({
      baseDir,
      protectedFilePath: filePath,
    });
    return filePath;
  } catch {
    return undefined;
  }
}

function gcArtifactsSync(params: { baseDir: string; protectedFilePath: string }) {
  const gcPolicy = resolveArtifactGcPolicy();
  if (!gcPolicy.enabled) {
    return;
  }

  const entries = listArtifactEntries(params.baseDir);
  if (entries.length === 0) {
    return;
  }

  const protectedPath = safeRealpath(params.protectedFilePath) ?? params.protectedFilePath;
  let survivors = entries.slice();

  if (gcPolicy.ttlMs > 0) {
    const now = Date.now();
    survivors = survivors.filter((entry) => {
      if (entry.path === protectedPath) {
        return true;
      }
      if (now - entry.mtimeMs <= gcPolicy.ttlMs) {
        return true;
      }
      return !deleteArtifactFile(entry.path);
    });
  }

  if (gcPolicy.maxBytes <= 0) {
    return;
  }

  let totalBytes = survivors.reduce((sum, entry) => sum + entry.size, 0);
  if (totalBytes <= gcPolicy.maxBytes) {
    return;
  }

  const sorted = [...survivors].sort((left, right) => left.mtimeMs - right.mtimeMs);
  for (const entry of sorted) {
    if (totalBytes <= gcPolicy.maxBytes) {
      break;
    }
    if (entry.path === protectedPath) {
      continue;
    }
    if (!deleteArtifactFile(entry.path)) {
      continue;
    }
    totalBytes -= entry.size;
  }
}

function deleteArtifactFile(filePath: string): boolean {
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function listArtifactEntries(baseDir: string): Array<{ path: string; size: number; mtimeMs: number }> {
  const entries: Array<{ path: string; size: number; mtimeMs: number }> = [];
  const root = safeRealpath(baseDir) ?? baseDir;

  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    let dirEntries: fs.Dirent[];
    try {
      dirEntries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of dirEntries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      try {
        const stats = fs.statSync(fullPath);
        entries.push({
          path: safeRealpath(fullPath) ?? fullPath,
          size: stats.size,
          mtimeMs: stats.mtimeMs,
        });
      } catch {
        // Ignore files that disappear during cleanup.
      }
    }
  }

  return entries;
}

function safeRealpath(targetPath: string): string | undefined {
  try {
    return fs.realpathSync(targetPath);
  } catch {
    return undefined;
  }
}

function resolveArtifactGcPolicy(): { enabled: boolean; ttlMs: number; maxBytes: number } {
  const ttlMs = parsePositiveInteger(
    process.env.OPENCLAW_CONTEXT_SAFE_ARTIFACT_TTL_MS,
    DEFAULT_ARTIFACT_TTL_MS,
  );
  const maxBytes = parsePositiveInteger(
    process.env.OPENCLAW_CONTEXT_SAFE_ARTIFACT_MAX_BYTES,
    DEFAULT_ARTIFACT_MAX_BYTES,
  );
  return {
    enabled: ttlMs > 0 || maxBytes > 0,
    ttlMs,
    maxBytes,
  };
}

function parsePositiveInteger(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function resolveArtifactBaseDir(): string {
  const override = asTrimmedString(process.env.OPENCLAW_CONTEXT_SAFE_ARTIFACT_DIR);
  if (override) {
    return override;
  }
  const homeDir = os.homedir();
  if (homeDir) {
    return path.join(homeDir, ".openclaw", "artifacts", "context-safe");
  }
  return path.join(os.tmpdir(), "openclaw", "artifacts", "context-safe");
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
