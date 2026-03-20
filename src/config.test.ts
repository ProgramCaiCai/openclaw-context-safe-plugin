import { describe, expect, it } from "vitest";
import {
  DEFAULT_KEEP_RECENT_TOOL_RESULTS,
  DEFAULT_PRUNE_THRESHOLD_CHARS,
  normalizeContextSafeEngineConfig,
} from "./config.js";

describe("context-safe config", () => {
  it("uses the stronger default prune threshold and protection window", () => {
    expect(DEFAULT_PRUNE_THRESHOLD_CHARS).toBe(100_000);
    expect(DEFAULT_KEEP_RECENT_TOOL_RESULTS).toBe(5);
    expect(normalizeContextSafeEngineConfig()).toEqual({
      prune: {
        thresholdChars: 100_000,
        keepRecentToolResults: 5,
        placeholder: "[pruned]",
      },
    });
  });
});
