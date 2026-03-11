import fs from "node:fs/promises";
import path from "node:path";

type PackageManifest = {
  files?: unknown;
};

async function loadInstallSourcePaths(projectRoot: string): Promise<string[]> {
  const packageJsonPath = path.join(projectRoot, "package.json");
  const raw = JSON.parse(await fs.readFile(packageJsonPath, "utf-8")) as PackageManifest;
  const files = raw.files;
  if (!Array.isArray(files) || files.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new Error(`package.json files must be a non-empty string array: ${packageJsonPath}`);
  }
  return [...new Set(["package.json", ...files.map((entry) => entry.trim())])];
}

export async function materializeInstallLayout(params: {
  projectRoot: string;
  outDir: string;
}): Promise<{ installDir: string }> {
  await fs.mkdir(params.outDir, { recursive: true });
  const installSourcePaths = await loadInstallSourcePaths(params.projectRoot);

  for (const relativePath of installSourcePaths) {
    const sourcePath = path.join(params.projectRoot, relativePath);
    const targetPath = path.join(params.outDir, relativePath);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.copyFile(sourcePath, targetPath);
  }

  return { installDir: params.outDir };
}

export function buildInstallPlan(params: {
  openclawBin: string;
  installDir: string;
  applyConfig: boolean;
}): string[][] {
  const commands = [[params.openclawBin, "plugins", "install", params.installDir]];
  if (params.applyConfig) {
    commands.push(
      [params.openclawBin, "config", "set", "plugins.entries.context-safe.enabled", "true"],
      [params.openclawBin, "config", "set", "plugins.slots.contextEngine", "context-safe"],
    );
  }
  return commands;
}
