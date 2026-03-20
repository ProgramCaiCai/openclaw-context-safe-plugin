import fs from "node:fs/promises";
import path from "node:path";
import { resolveContextSafeArtifactBaseDir } from "./artifact-dir.js";
import { type ContextSafePruneConfig } from "./config.js";
import { type ContextSafeMessage } from "./tool-result-policy.js";

const CANONICAL_SESSION_STATE_VERSION = 1;

export type CanonicalSessionState = {
  version: 1;
  sessionId: string;
  sourceMessageCount: number;
  configSnapshot: ContextSafePruneConfig;
  messages: ContextSafeMessage[];
};

export async function loadCanonicalSessionState(
  sessionId: string,
): Promise<{
  path: string;
  needsRebuild: boolean;
  state?: CanonicalSessionState;
}> {
  const statePath = buildCanonicalSessionStatePath(sessionId);
  try {
    const raw = await fs.readFile(statePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isCanonicalSessionState(parsed) || parsed.sessionId !== sessionId) {
      return { path: statePath, needsRebuild: true };
    }
    return {
      path: statePath,
      needsRebuild: false,
      state: parsed,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { path: statePath, needsRebuild: true };
    }
    return { path: statePath, needsRebuild: true };
  }
}

export async function saveCanonicalSessionState(state: CanonicalSessionState): Promise<{ path: string }> {
  const statePath = buildCanonicalSessionStatePath(state.sessionId);
  const directory = path.dirname(statePath);
  const tempPath = path.join(
    directory,
    `${path.basename(statePath, ".json")}.${process.pid}.${Date.now()}.tmp`,
  );

  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(tempPath, JSON.stringify(state, null, 2), "utf8");
  await fs.rename(tempPath, statePath);

  return { path: statePath };
}

export function buildCanonicalSessionStatePath(sessionId: string): string {
  return path.join(
    resolveContextSafeArtifactBaseDir(),
    "session-state",
    `${sanitizeSessionId(sessionId)}.json`,
  );
}

export function createCanonicalSessionState(params: {
  sessionId: string;
  sourceMessageCount: number;
  configSnapshot: ContextSafePruneConfig;
  messages: ContextSafeMessage[];
}): CanonicalSessionState {
  return {
    version: CANONICAL_SESSION_STATE_VERSION,
    sessionId: params.sessionId,
    sourceMessageCount: params.sourceMessageCount,
    configSnapshot: params.configSnapshot,
    messages: structuredClone(params.messages),
  };
}

function sanitizeSessionId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_") || "session";
}

function isCanonicalSessionState(value: unknown): value is CanonicalSessionState {
  if (!isRecord(value)) {
    return false;
  }
  const sourceMessageCount = value.sourceMessageCount;
  return (
    value.version === CANONICAL_SESSION_STATE_VERSION &&
    typeof value.sessionId === "string" &&
    typeof sourceMessageCount === "number" &&
    Number.isInteger(sourceMessageCount) &&
    sourceMessageCount >= 0 &&
    isPruneConfig(value.configSnapshot) &&
    Array.isArray(value.messages)
  );
}

function isPruneConfig(value: unknown): value is ContextSafePruneConfig {
  return (
    isRecord(value) &&
    typeof value.thresholdChars === "number" &&
    Number.isInteger(value.thresholdChars) &&
    value.thresholdChars > 0 &&
    typeof value.keepRecentToolResults === "number" &&
    Number.isInteger(value.keepRecentToolResults) &&
    value.keepRecentToolResults >= 0 &&
    typeof value.placeholder === "string" &&
    value.placeholder.length > 0
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
