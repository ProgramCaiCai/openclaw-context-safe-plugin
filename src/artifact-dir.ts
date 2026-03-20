import os from "node:os";
import path from "node:path";

export function resolveContextSafeArtifactBaseDir(): string {
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

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}
