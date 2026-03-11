import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildInstallPlan, materializeInstallLayout } from "./install-layout.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true });
    }),
  );
  tempDirs.length = 0;
});

describe("materializeInstallLayout", () => {
  it("copies the plugin runtime files into a clean install directory", async () => {
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "context-safe-layout-"));
    tempDirs.push(outDir);

    const result = await materializeInstallLayout({
      outDir,
      projectRoot: path.resolve(import.meta.dirname, ".."),
    });

    expect(result.installDir).toBe(outDir);
    await expect(fs.stat(path.join(outDir, "index.ts"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(outDir, "openclaw.plugin.json"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(outDir, "package.json"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(outDir, "README.md"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(outDir, "src", "context-engine.ts"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(outDir, "src", "hooks.ts"))).resolves.toBeTruthy();
  });
});

describe("buildInstallPlan", () => {
  it("builds copy-install commands plus config activation commands", () => {
    expect(
      buildInstallPlan({
        openclawBin: "openclaw",
        installDir: "/tmp/context-safe-install",
        applyConfig: true,
      }),
    ).toEqual([
      ["openclaw", "plugins", "install", "/tmp/context-safe-install"],
      ["openclaw", "config", "set", "plugins.entries.context-safe.enabled", "true"],
      ["openclaw", "config", "set", "plugins.slots.contextEngine", "context-safe"],
    ]);
  });
});
