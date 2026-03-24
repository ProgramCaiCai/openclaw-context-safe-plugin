import {
  compactWhitespace,
  readMessageText,
} from "./runtime-churn-policy.js";
import { type ContextSafeMessage } from "./tool-result-policy.js";

const REPORT_PATH_PATTERN = /\breports\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.md\b/g;

export type ReportAwareNormalizationResult = {
  message: ContextSafeMessage;
  summarized: boolean;
};

export type ReportAwareNormalizationBatch = {
  messages: ContextSafeMessage[];
  summarizedCount: number;
};

export function normalizeReportAwareMessages(
  messages: ContextSafeMessage[],
): ReportAwareNormalizationBatch {
  let summarizedCount = 0;
  const summarizedMessages = messages.map((message) => {
    const normalized = normalizeReportAwareMessage(message);
    if (normalized.summarized) {
      summarizedCount += 1;
    }
    return normalized.message;
  });

  return {
    messages: summarizedMessages,
    summarizedCount,
  };
}

export function normalizeReportAwareMessage(
  message: ContextSafeMessage,
): ReportAwareNormalizationResult {
  const text = readMessageText(message);
  if (!text) {
    return unchanged(message);
  }

  const reportPath = extractReportPath(text);
  if (!reportPath) {
    return unchanged(message);
  }

  const childCompletion = extractChildCompletionSummary(text);
  if (childCompletion) {
    const bullets = extractReportAwareBullets(text, reportPath).slice(0, 3);
    return summarizedMessage(
      message,
      [childCompletion.summary, `Report: ${reportPath}`, ...bullets.map((bullet) => `- ${bullet}`)].join(
        "\n",
      ),
    );
  }

  const verdict = extractVerdictOrOutcome(text);
  if (!verdict) {
    return unchanged(message);
  }

  const summary = extractTaskLabel(text) ?? extractConciseSummary(text, reportPath, verdict);
  const bullets = extractReportAwareBullets(text, reportPath).slice(0, 3);
  const lines = [summary, verdict, `Report: ${reportPath}`, ...bullets.map((bullet) => `- ${bullet}`)].filter(
    (line): line is string => typeof line === "string" && line.length > 0,
  );
  return summarizedMessage(message, lines.join("\n"));
}

function summarizedMessage(message: ContextSafeMessage, text: string): ReportAwareNormalizationResult {
  return {
    message: replaceMessageText(message, text),
    summarized: true,
  };
}

function unchanged(message: ContextSafeMessage): ReportAwareNormalizationResult {
  return {
    message,
    summarized: false,
  };
}

function replaceMessageText(message: ContextSafeMessage, text: string): ContextSafeMessage {
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
  };
}

function extractReportPath(text: string): string | undefined {
  const matches = text.match(REPORT_PATH_PATTERN) ?? [];
  return matches[0];
}

function extractVerdictOrOutcome(text: string): string | undefined {
  return (
    captureLine(text, /^Verdict:\s*(.+)$/im, "Verdict") ??
    captureLine(text, /^Outcome:\s*(.+)$/im, "Outcome") ??
    captureLine(text, /^Status:\s*(.+)$/im, "Status")
  );
}

function extractChildCompletionSummary(text: string): { summary: string } | undefined {
  const match =
    /^\s*(?:\[runtime-churn normalized\]\s*)?Child task completion \((success|failure)\)(?::\s*([^.\n]+))?\.?/im.exec(
      text,
    );
  if (!match) {
    return undefined;
  }

  const status = compactWhitespace(match[1]);
  const label = compactWhitespace(match[2] ?? "");
  const summary = label
    ? `Child task completion (${status}): ${label}`
    : `Child task completion (${status})`;
  return { summary };
}

function extractTaskLabel(text: string): string | undefined {
  return (
    captureLine(text, /^Task:\s*(.+)$/im, "Task") ??
    captureLine(text, /^Task label:\s*(.+)$/im, "Task label") ??
    captureLine(text, /^Summary:\s*(.+)$/im, "Summary")
  );
}

function extractConciseSummary(text: string, reportPath: string, verdict: string): string | undefined {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (line === verdict || line === `Report: ${reportPath}` || line === reportPath) {
      continue;
    }
    if (/^[-*]\s+/.test(line) || /^\d+\.\s+/.test(line)) {
      continue;
    }
    if (/^Key points:\s*/i.test(line)) {
      continue;
    }
    if (/^(Verdict|Outcome|Status|Task|Task label|Summary|Report):/i.test(line)) {
      continue;
    }
    return compactWhitespace(line);
  }
  return undefined;
}

function extractReportAwareBullets(text: string, reportPath: string): string[] {
  const bulletLines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line) || /^\d+\.\s+/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, "").replace(/^\d+\.\s+/, "").trim())
    .map(compactWhitespace)
    .filter((line) => line.length > 0)
    .filter((line) => line !== reportPath)
    .filter((line) => !line.includes(reportPath));

  if (bulletLines.length > 0) {
    return dedupe(bulletLines);
  }

  const keyPoints = captureLine(text, /^Key points:\s*(.+)$/im);
  if (!keyPoints) {
    return [];
  }

  return dedupe(
    keyPoints
      .split(/\s*;\s*/)
      .map(compactWhitespace)
      .filter((line) => line.length > 0)
      .filter((line) => line !== reportPath)
      .filter((line) => !line.includes(reportPath)),
  );
}

function captureLine(text: string, pattern: RegExp, label?: string): string | undefined {
  const match = pattern.exec(text);
  const value = match?.[1];
  if (!value) {
    return undefined;
  }
  const normalized = compactWhitespace(value);
  if (!normalized) {
    return undefined;
  }
  return label ? `${label}: ${normalized}` : normalized;
}

function dedupe(values: string[]): string[] {
  const unique: string[] = [];
  for (const value of values) {
    if (!unique.includes(value)) {
      unique.push(value);
    }
  }
  return unique;
}
