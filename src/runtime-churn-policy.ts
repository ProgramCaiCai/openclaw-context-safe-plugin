import { type ContextSafeRuntimeChurnConfig } from "./config.js";
import { type ContextSafeMessage } from "./tool-result-policy.js";

export type RuntimeChurnKind =
  | "compactionSummary"
  | "childCompletionInjection"
  | "telegramDirectChatMetadata";

export type RuntimeChurnNormalizationResult = {
  message: ContextSafeMessage;
  normalized: boolean;
  kinds: RuntimeChurnKind[];
};

export type RuntimeChurnNormalizationBatch = {
  messages: ContextSafeMessage[];
  normalizedCount: number;
  kinds: RuntimeChurnKind[];
};

export function normalizeRuntimeChurnMessages(
  messages: ContextSafeMessage[],
  options: ContextSafeRuntimeChurnConfig,
): RuntimeChurnNormalizationBatch {
  const kinds = new Set<RuntimeChurnKind>();
  let normalizedCount = 0;
  const normalizedMessages = messages.map((message) => {
    const normalized = normalizeRuntimeChurnMessage(message, options);
    if (normalized.normalized) {
      normalizedCount += 1;
      for (const kind of normalized.kinds) {
        kinds.add(kind);
      }
    }
    return normalized.message;
  });

  return {
    messages: normalizedMessages,
    normalizedCount,
    kinds: [...kinds],
  };
}

export function normalizeRuntimeChurnMessage(
  message: ContextSafeMessage,
  options: ContextSafeRuntimeChurnConfig,
): RuntimeChurnNormalizationResult {
  if (!options.enabled || hasRuntimeChurnAnnotation(message)) {
    return unchanged(message);
  }

  const text = messageText(message);
  if (!text) {
    return unchanged(message);
  }

  if (options.collapseCompactionSummaries) {
    const summary = maybeCollapseCompactionSummary(text);
    if (summary) {
      return normalizedMessage(message, summary, ["compactionSummary"]);
    }
  }

  if (options.collapseChildCompletionInjections) {
    const summary = maybeCollapseChildCompletionInjection(text);
    if (summary) {
      return normalizedMessage(message, summary, ["childCompletionInjection"]);
    }
  }

  if (options.collapseDirectChatMetadata) {
    const summary = maybeCollapseTelegramDirectChatMetadata(text);
    if (summary) {
      return normalizedMessage(message, summary, ["telegramDirectChatMetadata"]);
    }
  }

  return unchanged(message);
}

function maybeCollapseCompactionSummary(text: string): string | undefined {
  const hasCompactionSignal =
    /Exact identifiers:/i.test(text) || /Recent turns preserved verbatim:/i.test(text);
  if (!hasCompactionSignal) {
    return undefined;
  }

  const lead = firstMeaningfulLine(text) ?? "Compaction summary retained as semantic anchors only.";
  const anchors = extractAnchorPaths(text, 3);
  const parts = [
    "[runtime-churn normalized] Compaction summary collapsed.",
    compactWhitespace(lead),
  ];
  if (anchors.length > 0) {
    parts.push(`Anchors: ${anchors.join(", ")}.`);
  }
  return parts.join(" ").trim();
}

function maybeCollapseChildCompletionInjection(text: string): string | undefined {
  if (
    !text.includes("[Internal task completion event]") ||
    !text.includes("<<<BEGIN_UNTRUSTED_CHILD_RESULT>>>") ||
    !text.includes("<<<END_UNTRUSTED_CHILD_RESULT>>>")
  ) {
    return undefined;
  }

  const payload = between(text, "<<<BEGIN_UNTRUSTED_CHILD_RESULT>>>", "<<<END_UNTRUSTED_CHILD_RESULT>>>");
  const label =
    captureLineValue(text, /^Task label:\s*(.+)$/im) ??
    captureLineValue(text, /^Label:\s*(.+)$/im) ??
    captureLineValue(payload, /^Task label:\s*(.+)$/im) ??
    captureLineValue(payload, /^Label:\s*(.+)$/im);
  const status = /^\s*FAILED\b/im.test(payload) ? "failure" : "success";
  const report = extractAnchorPaths(payload, 3).find((candidate) => candidate.startsWith("reports/"));
  const bullets = extractKeyBullets(payload, report).slice(0, 3);
  const parts = [`[runtime-churn normalized] Child task completion (${status})`];
  if (label) {
    parts[0] += `: ${compactWhitespace(label)}`;
  }
  parts[0] += ".";
  if (report) {
    parts.push(`Report: ${report}.`);
  }
  if (bullets.length > 0) {
    parts.push(`Key points: ${bullets.join("; ")}.`);
  }
  return parts.join(" ").trim();
}

function maybeCollapseTelegramDirectChatMetadata(text: string): string | undefined {
  if (
    !text.includes("Conversation info (untrusted metadata)") ||
    !text.includes("Sender (untrusted metadata)")
  ) {
    return undefined;
  }

  const conversation = parseJsonLineAfterLabel(text, "Conversation info (untrusted metadata)");
  const sender = parseJsonLineAfterLabel(text, "Sender (untrusted metadata)");
  if (!conversation || !sender || !looksLikeDirectChat(conversation)) {
    return undefined;
  }

  const fields: string[] = [];
  const channel = readStringField(conversation, ["channel", "source"]);
  const chatId = readStringField(conversation, ["chat_id", "chatId", "conversation_id", "conversationId"]);
  const threadId = readStringField(conversation, ["thread_id", "threadId", "topic_id", "topicId"]);
  const senderName = readStringField(sender, ["display_name", "displayName", "name", "username"]);
  const senderId = readStringField(sender, ["id", "sender_id", "senderId", "user_id", "userId"]);

  if (channel) {
    fields.push(`channel=${compactWhitespace(channel)}`);
  }
  if (chatId) {
    fields.push(`chat=${compactWhitespace(chatId)}`);
  }
  if (threadId) {
    fields.push(`thread=${compactWhitespace(threadId)}`);
  }
  if (senderName) {
    fields.push(`sender=${compactWhitespace(senderName)}`);
  }
  if (senderId && senderId !== senderName) {
    fields.push(`senderId=${compactWhitespace(senderId)}`);
  }

  const residual = compactWhitespace(stripMetadataWrappers(text));
  const summary = [
    "[runtime-churn normalized] Telegram direct chat metadata:",
    fields.join("; "),
  ]
    .filter((part) => part.length > 0)
    .join(" ")
    .trim();
  if (!residual) {
    return `${summary}.`;
  }
  return `${summary}. ${residual}`;
}

function normalizedMessage(
  message: ContextSafeMessage,
  text: string,
  kinds: RuntimeChurnKind[],
): RuntimeChurnNormalizationResult {
  return {
    message: replaceMessageText(message, text, kinds),
    normalized: true,
    kinds,
  };
}

function unchanged(message: ContextSafeMessage): RuntimeChurnNormalizationResult {
  return {
    message,
    normalized: false,
    kinds: [],
  };
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

function replaceMessageText(
  message: ContextSafeMessage,
  text: string,
  kinds: RuntimeChurnKind[],
): ContextSafeMessage {
  const { details: _details, ...rest } = message;
  const normalizedBlock = { type: "text", text };
  const content =
    typeof message.content === "string" || message.content === undefined || !Array.isArray(message.content)
      ? text
      : [
          ...message.content.filter(
            (block: unknown) =>
              !!block && typeof block === "object" && (block as { type?: unknown }).type !== "text",
          ),
          normalizedBlock,
        ];
  return {
    ...rest,
    content,
    contextSafeRuntimeChurn: {
      normalized: true,
      kinds,
    },
  };
}

function messageText(message: ContextSafeMessage): string {
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

function firstMeaningfulLine(text: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (
      !trimmed ||
      trimmed === "Exact identifiers:" ||
      trimmed === "Done:" ||
      trimmed === "Recent turns preserved verbatim:"
    ) {
      continue;
    }
    if (/^[-*]\s+/.test(trimmed) || /^\d+\.\s+/.test(trimmed)) {
      continue;
    }
    return trimmed;
  }
  return undefined;
}

function between(text: string, start: string, end: string): string {
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end, startIndex + start.length);
  if (startIndex === -1 || endIndex === -1) {
    return "";
  }
  return text.slice(startIndex + start.length, endIndex).trim();
}

function captureLineValue(text: string, pattern: RegExp): string | undefined {
  const match = pattern.exec(text);
  return match?.[1]?.trim() || undefined;
}

function extractKeyBullets(text: string, report?: string): string[] {
  const bullets = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line) || /^\d+\.\s+/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, "").replace(/^\d+\.\s+/, "").trim())
    .filter((line) => line.length > 0)
    .filter((line) => line !== report);

  if (bullets.length > 0) {
    return bullets.map(compactWhitespace);
  }

  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !line.startsWith("FAILED "))
    .filter((line) => line !== report)
    .filter((line) => !line.startsWith("Task label:"))
    .slice(0, 3)
    .map(compactWhitespace);
}

function extractAnchorPaths(text: string, limit: number): string[] {
  const matches = text.match(/(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+(?:\.[A-Za-z0-9._-]+)?/g) ?? [];
  const unique: string[] = [];
  for (const match of matches) {
    const candidate = match.replace(/[),.:;]+$/g, "");
    if (!unique.includes(candidate)) {
      unique.push(candidate);
    }
    if (unique.length >= limit) {
      break;
    }
  }
  return unique;
}

function parseJsonLineAfterLabel(text: string, label: string): Record<string, unknown> | undefined {
  const lines = text.split(/\r?\n/);
  const index = lines.findIndex((line) => line.trim() === label);
  if (index === -1) {
    return undefined;
  }

  for (let i = index + 1; i < lines.length; i++) {
    const candidate = lines[i].trim();
    if (!candidate) {
      continue;
    }
    if (!candidate.startsWith("{")) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(candidate) as unknown;
      return isRecord(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  return undefined;
}

function looksLikeDirectChat(conversation: Record<string, unknown>): boolean {
  const chatType = readStringField(conversation, ["chat_type", "chatType", "type"]);
  if (!chatType) {
    return false;
  }
  const normalized = chatType.toLowerCase();
  return normalized === "direct" || normalized === "dm" || normalized === "p2p";
}

function readStringField(value: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return undefined;
}

function stripMetadataWrappers(text: string): string {
  const lines = text.split(/\r?\n/);
  const kept: string[] = [];
  let skipNextJson = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (
      trimmed === "Conversation info (untrusted metadata)" ||
      trimmed === "Sender (untrusted metadata)"
    ) {
      skipNextJson = true;
      continue;
    }
    if (skipNextJson && trimmed.startsWith("{")) {
      skipNextJson = false;
      continue;
    }
    skipNextJson = false;
    if (trimmed.length > 0) {
      kept.push(trimmed);
    }
  }

  return kept.join(" ");
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
