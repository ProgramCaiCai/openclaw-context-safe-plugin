import { resolveToolResultRecoveryHint } from "./tool-result-notices.js";
import { type ContextSafeMessage } from "./tool-result-policy.js";

const MAX_INDEX_GOALS = 3;
const MAX_INDEX_CONCLUSIONS = 3;
const MAX_INDEX_OPEN_THREADS = 3;
const MAX_INDEX_ARTIFACTS = 4;
const MAX_INDEX_RECOVERY_HINTS = 3;
const MAX_INDEX_TEXT_CHARS = 160;
const MAX_INDEX_POINTER_CHARS = 220;

export type ContextSafeSessionIndexArtifact = {
  toolName: string;
  resultMode: "artifact" | "inline-fallback";
  pointer: string;
  preview: string;
};

export type ContextSafeSessionIndex = {
  goals: string[];
  recentConclusions: string[];
  openThreads: string[];
  keyArtifacts: ContextSafeSessionIndexArtifact[];
  recoveryHints: string[];
};

export function buildContextSafeSessionIndex(params: {
  messages: ContextSafeMessage[];
}): ContextSafeSessionIndex {
  const goals = collectRecentStrings(params.messages, MAX_INDEX_GOALS, (message) => {
    if (message.role !== "user") {
      return undefined;
    }
    return compactIndexText(collectMessageText(message));
  });

  const recentConclusions = collectRecentStrings(
    params.messages,
    MAX_INDEX_CONCLUSIONS,
    (message) => {
      const text = compactIndexText(collectMessageText(message));
      if (!text || !isConclusionLike(text)) {
        return undefined;
      }
      return text;
    },
  );

  const openThreads = collectRecentStrings(params.messages, MAX_INDEX_OPEN_THREADS, (message) => {
    const text = compactIndexText(collectMessageText(message));
    if (!text || !isOpenThreadLike(text)) {
      return undefined;
    }
    return text;
  });

  const keyArtifacts = collectRecentArtifacts(params.messages);
  const recoveryHints = dedupeRecent(
    keyArtifacts.map((artifact) => compactIndexText(resolveToolResultRecoveryHint(artifact.toolName))),
    MAX_INDEX_RECOVERY_HINTS,
  );

  return {
    goals,
    recentConclusions,
    openThreads,
    keyArtifacts,
    recoveryHints,
  };
}

export function buildContextSafeSessionIndexMessage(params: {
  index: ContextSafeSessionIndex;
  maxChars: number;
}): ContextSafeMessage | undefined {
  const budget = Math.max(60, Math.floor(params.maxChars));
  const candidates = [
    renderFullIndexText(params.index),
    renderCompactIndexText(params.index),
    renderMinimalIndexText(params.index),
  ];

  for (const text of candidates) {
    if (text.length <= budget) {
      return {
        role: "assistant",
        content: [{ type: "text", text }],
        contextSafeSynthetic: "sessionIndex",
      };
    }
  }

  return undefined;
}

function collectRecentStrings(
  messages: ContextSafeMessage[],
  limit: number,
  select: (message: ContextSafeMessage) => string | undefined,
): string[] {
  const values: string[] = [];
  const seen = new Set<string>();
  for (let i = messages.length - 1; i >= 0 && values.length < limit; i--) {
    const selected = select(messages[i]);
    if (!selected || seen.has(selected)) {
      continue;
    }
    seen.add(selected);
    values.push(selected);
  }
  return values;
}

function collectRecentArtifacts(messages: ContextSafeMessage[]): ContextSafeSessionIndexArtifact[] {
  const artifacts: ContextSafeSessionIndexArtifact[] = [];
  const seen = new Set<string>();

  for (let i = messages.length - 1; i >= 0 && artifacts.length < MAX_INDEX_ARTIFACTS; i--) {
    const message = messages[i];
    if (!isToolResultMessage(message)) {
      continue;
    }
    const meta = readContextSafeMeta(message);
    const resultMode = readResultMode(meta);
    const toolName = normalizeToolName(message.toolName) ?? normalizeToolName(message.tool_name);
    if (!resultMode || !toolName) {
      continue;
    }
    const outputFile = normalizeString(meta?.outputFile);
    const pointer = outputFile ?? `inline-fallback:${toolName}`;
    if (seen.has(pointer)) {
      continue;
    }
    seen.add(pointer);
    artifacts.push({
      toolName,
      resultMode,
      pointer: trimToChars(pointer, MAX_INDEX_POINTER_CHARS),
      preview: compactIndexText(collectMessageText(message)),
    });
  }

  return artifacts;
}

function readResultMode(
  meta?: Record<string, unknown>,
): ContextSafeSessionIndexArtifact["resultMode"] | undefined {
  return meta?.resultMode === "artifact" || meta?.resultMode === "inline-fallback"
    ? meta.resultMode
    : undefined;
}

function readContextSafeMeta(message: ContextSafeMessage): Record<string, unknown> | undefined {
  if (!isRecord(message.details)) {
    return undefined;
  }
  return isRecord(message.details.contextSafe) ? message.details.contextSafe : undefined;
}

function dedupeRecent(values: Array<string | undefined>, limit: number): string[] {
  const next: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    next.push(value);
    if (next.length >= limit) {
      break;
    }
  }
  return next;
}

function compactIndexText(text: string): string {
  const normalized = text
    .replace(/\s+/g, " ")
    .trim();
  return trimToChars(normalized, MAX_INDEX_TEXT_CHARS);
}

function renderFullIndexText(index: ContextSafeSessionIndex): string {
  const sections = ["[context-safe session index]"];
  pushSection(sections, "Goals", index.goals);
  pushSection(sections, "Recent conclusions", index.recentConclusions);
  pushSection(sections, "Open threads", index.openThreads);
  pushSection(
    sections,
    "Key artifacts",
    index.keyArtifacts.map(
      (artifact) => `${artifact.toolName} ${artifact.resultMode} -> ${artifact.pointer} (${artifact.preview})`,
    ),
  );
  pushSection(sections, "Recovery hints", index.recoveryHints);
  return sections.join("\n");
}

function renderCompactIndexText(index: ContextSafeSessionIndex): string {
  const sections = ["[context-safe session index]"];
  pushSection(sections, "Goals", index.goals.slice(0, 2));
  pushSection(sections, "Open threads", index.openThreads.slice(0, 2));
  pushSection(
    sections,
    "Key artifacts",
    index.keyArtifacts.slice(0, 2).map((artifact) => `${artifact.toolName} -> ${artifact.pointer}`),
  );
  return sections.join("\n");
}

function renderMinimalIndexText(index: ContextSafeSessionIndex): string {
  const lines = ["[context-safe session index]"];
  const firstGoal = index.goals[0];
  const firstThread = index.openThreads[0];
  const firstArtifact = index.keyArtifacts[0];
  if (firstGoal) {
    lines.push(`Goal: ${firstGoal}`);
  }
  if (firstThread) {
    lines.push(`Next: ${firstThread}`);
  }
  if (firstArtifact) {
    lines.push(`Artifact: ${firstArtifact.pointer}`);
  }
  return lines.join("\n");
}

function pushSection(target: string[], label: string, values: string[]): void {
  if (values.length === 0) {
    return;
  }
  target.push(`${label}:`);
  for (const value of values) {
    target.push(`- ${value}`);
  }
}

function trimToChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  if (maxChars <= 1) {
    return text.slice(0, maxChars);
  }
  return `${text.slice(0, maxChars - 1)}…`;
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

function isConclusionLike(text: string): boolean {
  return /^(?:conclusion|verdict|outcome|summary)\s*:/i.test(text);
}

function isOpenThreadLike(text: string): boolean {
  return /^(?:next|remaining|follow[- ]up|todo|pending)\s*:/i.test(text);
}

function isToolResultMessage(message: ContextSafeMessage): boolean {
  return message.role === "toolResult" || message.role === "tool" || message.type === "toolResult";
}

function normalizeToolName(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
