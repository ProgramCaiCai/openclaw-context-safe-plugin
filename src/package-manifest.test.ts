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
});
