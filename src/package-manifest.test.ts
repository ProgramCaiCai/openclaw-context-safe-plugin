import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("package manifest", () => {
  it("publishes the install helper script referenced by README", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(import.meta.dirname, "..", "package.json"), "utf8"),
    ) as {
      files?: string[];
    };

    expect(packageJson.files).toContain("scripts/install.py");
  });

  it("declares the prune config schema in openclaw.plugin.json", () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(import.meta.dirname, "..", "openclaw.plugin.json"), "utf8"),
    ) as {
      configSchema?: {
        additionalProperties?: boolean;
        properties?: {
          prune?: {
            additionalProperties?: boolean;
            properties?: Record<string, unknown>;
          };
        };
      };
    };

    expect(manifest.configSchema?.additionalProperties).toBe(false);
    expect(manifest.configSchema?.properties?.prune).toEqual({
      additionalProperties: false,
      properties: {
        thresholdChars: {
          type: "integer",
          minimum: 1,
          default: 100000,
        },
        keepRecentToolResults: {
          type: "integer",
          minimum: 0,
          default: 5,
        },
        placeholder: {
          type: "string",
          minLength: 1,
          default: "[pruned]",
        },
      },
      type: "object",
    });
  });
});
