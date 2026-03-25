import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.join(import.meta.dirname, "..");

function readPackageJson() {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
    name?: string;
    version?: string;
    files?: string[];
    scripts?: Record<string, string>;
  };
}

describe("package manifest", () => {
  it("publishes the install helper script referenced by README", () => {
    const packageJson = readPackageJson();

    expect(packageJson.files).toContain("scripts/install.py");
    expect(packageJson.scripts).toMatchObject({
      "install:plugin": "python3 scripts/install.py",
      "install:plugin:link": "python3 scripts/install.py --link",
    });
  });

  it("uses packed archive install by default and source link install only when requested", () => {
    const packageJson = readPackageJson();
    const expectedArchivePath = `/tmp/${packageJson.name}-npm-artifacts/${packageJson.name}-${packageJson.version}.tgz`;
    const defaultDryRun = execFileSync("python3", ["scripts/install.py", "--dry-run"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    const linkDryRun = execFileSync("python3", ["scripts/install.py", "--dry-run", "--link"], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(defaultDryRun).toContain("$ npm pack --json --pack-destination /tmp/context-safe-npm-artifacts");
    expect(defaultDryRun).toContain(`$ openclaw plugins install ${expectedArchivePath}`);
    expect(defaultDryRun).not.toContain("$ openclaw plugins install --link");
    expect(linkDryRun).toContain(`$ openclaw plugins install --link ${repoRoot}`);
    expect(linkDryRun).not.toContain("$ npm pack --json --pack-destination");
  });

  it("declares the prune and runtime-churn config schema in openclaw.plugin.json", () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "openclaw.plugin.json"), "utf8"),
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
