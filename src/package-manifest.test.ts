import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.join(import.meta.dirname, "..");

function readPackageJson() {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
    files?: string[];
  };
}

describe("package manifest", () => {
  it("publishes the install helper script referenced by README", () => {
    const packageJson = readPackageJson();

    expect(packageJson.files).toContain("scripts/install.py");
    expect(packageJson.files).toContain("src/api-invariants.ts");
  });

  it("publishes all src/context-engine.ts runtime-imported source files", () => {
    const contextEngineSource = fs.readFileSync(path.join(repoRoot, "src", "context-engine.ts"), "utf8");
    const packageJson = readPackageJson();
    const expectedRuntimeImports = [
      "./canonical-session-state.js",
      "./config.js",
      "./runtime-churn-policy.js",
      "./report-aware-policy.js",
      "./session-index.js",
      "./session-observability.js",
      "./tool-result-policy.js",
    ];
    const actualRuntimeImports = Array.from(
      contextEngineSource.matchAll(/from "(\.\/[^"]+\.js)";/g),
      ([, specifier]) => specifier,
    );
    const expectedPublishedFiles = expectedRuntimeImports.map((specifier) =>
      path.posix.join("src", specifier.replace(/^\.\//, "").replace(/\.js$/, ".ts")),
    );

    expect(actualRuntimeImports).toEqual(expectedRuntimeImports);
    expect(packageJson.files).toEqual(expect.arrayContaining(expectedPublishedFiles));
  });

  it("declares the prune and runtime-churn config schema in openclaw.plugin.json", () => {
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
          runtimeChurn?: {
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
        keepTailMinChars: {
          type: "integer",
          minimum: 1,
          default: 6000,
        },
        keepTailMinUserAssistantMessages: {
          type: "integer",
          minimum: 1,
          default: 2,
        },
        keepTailMaxChars: {
          type: "integer",
          minimum: 1,
          default: 24000,
        },
        keepTailRespectSummaryBoundary: {
          type: "boolean",
          default: true,
        },
        placeholder: {
          type: "string",
          minLength: 1,
          default: "[pruned]",
        },
      },
      type: "object",
    });
    expect(manifest.configSchema?.properties?.runtimeChurn).toEqual({
      additionalProperties: false,
      properties: {
        enabled: {
          type: "boolean",
          default: true,
        },
        collapseCompactionSummaries: {
          type: "boolean",
          default: true,
        },
        collapseChildCompletionInjections: {
          type: "boolean",
          default: true,
        },
        collapseDirectChatMetadata: {
          type: "boolean",
          default: true,
        },
      },
      type: "object",
    });
  });
});
