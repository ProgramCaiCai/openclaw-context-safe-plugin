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
    const reportLine = extractReportLine(text, reportPath);
    const bullets = extractReportAwareBullets(text, reportPath).slice(0, 3);
    return summarizedMessage(
      message,
      [childCompletion.summary, reportLine, ...bullets.map((bullet) => `- ${bullet}`)].join("\n"),
    );
  }

  const verdict = extractVerdictOrOutcome(text);
  if (!verdict) {
    return unchanged(message);
  }

  const reportLine = extractReportLine(text, reportPath);
  const summary = extractTaskLabel(text) ?? extractConciseSummary(text, reportPath, verdict, reportLine);
  const keyPointsLine = extractReportAwareKeyPointsLine(text, reportPath);
  const bullets = extractReportAwareBullets(text, reportPath).slice(0, 3);
  const lines = [summary, verdict, reportLine, keyPointsLine, ...bullets.map((bullet) => `- ${bullet}`)].filter(
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
  return captureLabeledLine(text, [
    { pattern: /^Verdict:\s*(.+)$/im, label: "Verdict" },
    { pattern: /^Outcome:\s*(.+)$/im, label: "Outcome" },
    { pattern: /^Status:\s*(.+)$/im, label: "Status" },
    { pattern: /^结论[:：]\s*(.+)$/im, label: "结论", separator: "：" },
    { pattern: /^状态[:：]\s*(.+)$/im, label: "状态", separator: "：" },
  ]);
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
  return captureLabeledLine(text, [
    { pattern: /^Task:\s*(.+)$/im, label: "Task" },
    { pattern: /^Task label:\s*(.+)$/im, label: "Task label" },
    { pattern: /^Summary:\s*(.+)$/im, label: "Summary" },
    { pattern: /^任务[:：]\s*(.+)$/im, label: "任务", separator: "：" },
    { pattern: /^摘要[:：]\s*(.+)$/im, label: "摘要", separator: "：" },
  ]);
}

function extractConciseSummary(
  text: string,
  reportPath: string,
  verdict: string,
  reportLine: string,
): string | undefined {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (line === verdict || line === reportLine || line === reportPath) {
      continue;
    }
    if (/^[-*]\s+/.test(line) || /^\d+\.\s+/.test(line)) {
      continue;
    }
    if (/^(?:Key points:\s*|关键点[:：]\s*)/i.test(line)) {
      continue;
    }
    if (/^(?:Verdict|Outcome|Status|Task|Task label|Summary|Report):/i.test(line)) {
      continue;
    }
    if (/^(?:任务|摘要|结论|状态|报告)[:：]/.test(line)) {
      continue;
    }
    return compactWhitespace(line);
  }
  return undefined;
}

function extractReportAwareBullets(text: string, reportPath: string): string[] {
  return dedupe(
    text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line) || /^\d+\.\s+/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, "").replace(/^\d+\.\s+/, "").trim())
    .map(compactWhitespace)
    .filter((line) => line.length > 0)
    .filter((line) => line !== reportPath)
    .filter((line) => !line.includes(reportPath)),
  );
}

function extractReportLine(text: string, reportPath: string): string {
  return (
    captureLabeledLine(text, [
      { pattern: /^Report:\s*(.+)$/im, label: "Report" },
      { pattern: /^报告[:：]\s*(.+)$/im, label: "报告", separator: "：" },
    ]) ?? `Report: ${reportPath}`
  );
}

function extractReportAwareKeyPointsLine(text: string, reportPath: string): string | undefined {
  const keyPoints = captureListLine(text, [
    { pattern: /^Key points:\s*(.+)$/im, label: "Key points", itemSeparator: "; " },
    { pattern: /^关键点[:：]\s*(.+)$/im, label: "关键点", labelSeparator: "：", itemSeparator: "；" },
  ]);
  if (!keyPoints) {
    return undefined;
  }

  const values = dedupe(
    keyPoints.value
      .split(/\s*[;；]\s*/)
      .map(compactWhitespace)
      .filter((line) => line.length > 0)
      .filter((line) => line !== reportPath)
      .filter((line) => !line.includes(reportPath)),
  );
  if (values.length === 0) {
    return undefined;
  }
  return `${keyPoints.label}${keyPoints.labelSeparator}${values.join(keyPoints.itemSeparator)}`;
}

function captureLine(text: string, pattern: RegExp): string | undefined {
  const match = pattern.exec(text);
  const value = match?.[1];
  if (!value) {
    return undefined;
  }
  const normalized = compactWhitespace(value);
  return normalized || undefined;
}

function captureLabeledLine(
  text: string,
  patterns: Array<{ pattern: RegExp; label: string; separator?: string }>,
): string | undefined {
  for (const { pattern, label, separator = ": " } of patterns) {
    const value = captureLine(text, pattern);
    if (value) {
      return `${label}${separator}${value}`;
    }
  }
  return undefined;
}

function captureListLine(
  text: string,
  patterns: Array<{ pattern: RegExp; label: string; labelSeparator?: string; itemSeparator: string }>,
): { label: string; labelSeparator: string; itemSeparator: string; value: string } | undefined {
  for (const { pattern, label, labelSeparator = ": ", itemSeparator } of patterns) {
    const value = captureLine(text, pattern);
    if (value) {
      return { label, labelSeparator, itemSeparator, value };
    }
  }
  return undefined;
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
