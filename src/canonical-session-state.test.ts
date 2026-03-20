import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildCanonicalSessionStatePath,
  loadCanonicalSessionState,
  saveCanonicalSessionState,
  type CanonicalSessionState,
} from "./canonical-session-state.js";

let artifactDir = "";

beforeEach(() => {
  artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "context-safe-state-"));
  process.env.OPENCLAW_CONTEXT_SAFE_ARTIFACT_DIR = artifactDir;
});

afterEach(() => {
  delete process.env.OPENCLAW_CONTEXT_SAFE_ARTIFACT_DIR;
  if (artifactDir) {
    fs.rmSync(artifactDir, { recursive: true, force: true });
    artifactDir = "";
  }
});

describe("canonical session state", () => {
  it("builds per-session state paths under the plugin artifact directory", () => {
    expect(buildCanonicalSessionStatePath("session-123")).toBe(
      path.join(artifactDir, "session-state", "session-123.json"),
    );
  });

  it("reports missing state as rebuild-needed", async () => {
    await expect(loadCanonicalSessionState("missing-session")).resolves.toEqual({
      path: path.join(artifactDir, "session-state", "missing-session.json"),
      needsRebuild: true,
    });
  });

  it("round-trips a saved canonical state through atomic persistence", async () => {
    const state: CanonicalSessionState = {
      version: 1,
      sessionId: "session-roundtrip",
      sourceMessageCount: 3,
      configSnapshot: {
        thresholdChars: 50_000,
        keepRecentToolResults: 2,
        placeholder: "[pruned]",
      },
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: [{ type: "text", text: "world" }] },
      ],
      updatedAt: "2026-03-20T12:00:00.000Z",
      messageCount: 2,
      toolResultCount: 0,
      thresholdChars: 50_000,
      keepRecentToolResults: 2,
      placeholder: "[pruned]",
      lastPrunedAt: "2026-03-20T12:01:00.000Z",
      lastPruneSource: "assemble",
      lastPruneGain: 12_345,
      lastThresholdChars: 50_000,
    };

    await saveCanonicalSessionState(state);

    await expect(loadCanonicalSessionState("session-roundtrip")).resolves.toEqual({
      path: path.join(artifactDir, "session-state", "session-roundtrip.json"),
      needsRebuild: false,
      state,
    });
  });

  it("loads older state files that do not have observability summary fields yet", async () => {
    const statePath = buildCanonicalSessionStatePath("session-legacy");
    const legacyState = {
      version: 1,
      sessionId: "session-legacy",
      sourceMessageCount: 2,
      configSnapshot: {
        thresholdChars: 50_000,
        keepRecentToolResults: 2,
        placeholder: "[pruned]",
      },
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: [{ type: "text", text: "world" }] },
      ],
    };
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(legacyState, null, 2), "utf8");

    await expect(loadCanonicalSessionState("session-legacy")).resolves.toEqual({
      path: statePath,
      needsRebuild: false,
      state: legacyState as CanonicalSessionState,
    });
  });

  it("falls back to rebuild when the state file contains invalid json", async () => {
    const statePath = buildCanonicalSessionStatePath("session-invalid");
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, "{not-valid-json", "utf8");

    await expect(loadCanonicalSessionState("session-invalid")).resolves.toEqual({
      path: statePath,
      needsRebuild: true,
    });
  });
});
