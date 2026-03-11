const READ_RECOVERY_HINT =
  "Rerun read with a narrower range, or pipe to head, tail, or jq to extract only the needed lines or fields.";
const EXEC_RECOVERY_HINT =
  "For shell output, rerun a narrower command and pipe to grep, jq, awk, head, or tail to isolate the relevant section.";
const WEB_FETCH_RECOVERY_HINT =
  "Use curl to save the response to a file, then use read on that file to inspect only the needed section.";
const GENERIC_RECOVERY_HINT =
  "Rerun with narrower params or request only the specific section you need.";

export function resolveToolResultRecoveryHint(toolName?: string): string {
  switch (normalizeToolName(toolName)) {
    case "read":
      return READ_RECOVERY_HINT;
    case "exec":
    case "bash":
      return EXEC_RECOVERY_HINT;
    case "web_fetch":
      return WEB_FETCH_RECOVERY_HINT;
    default:
      return GENERIC_RECOVERY_HINT;
  }
}

function normalizeToolName(toolName?: string): string | undefined {
  const normalized = toolName?.trim().toLowerCase();
  return normalized ? normalized : undefined;
}
