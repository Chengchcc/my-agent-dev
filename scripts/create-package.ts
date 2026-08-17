import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { input, select } from "@inquirer/prompts";

const rootDir = path.resolve(import.meta.dir, "..");
const templateDir = path.join(rootDir, "_template", "package");

function normalizeDirectoryName(value: string): string {
  return value.trim();
}

function assertSafeDirectoryName(value: string): void {
  if (value.length === 0) {
    throw new Error("Directory name is required.");
  }

  if (path.isAbsolute(value)) {
    throw new Error("Directory name must be relative.");
  }

  if (value.includes("/") || value.includes(path.sep)) {
    throw new Error(
      "Directory name must not contain '/'; only direct children of apps/ or packages/ are workspace members.",
    );
  }

  const segments = value.split(/[\\/]/);
  if (segments.some((segment) => segment === "..")) {
    throw new Error("Directory name must not contain '..' path segments.");
  }
}

async function replacePlaceholders(
  filePath: string,
  replacements: Record<string, string>,
): Promise<void> {
  let content = await readFile(filePath, "utf8");

  for (const [key, value] of Object.entries(replacements)) {
    content = content.replaceAll(`{{${key}}}`, value);
  }

  await writeFile(filePath, content);
}

async function listFilesRecursively(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const results: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await listFilesRecursively(entryPath)));
    } else if (entry.isFile()) {
      results.push(entryPath);
    }
  }

  return results;
}

async function main(): Promise<void> {
  const area = await select({
    message: "Where should the package be created?",
    choices: [
      { name: "apps", value: "apps" },
      { name: "packages", value: "packages" },
    ],
  });

  const directoryName = normalizeDirectoryName(
    await input({
      message: "Directory name:",
      required: true,
    }),
  );
  assertSafeDirectoryName(directoryName);

  const defaultPackageName = `@chengchenccc/${directoryName}`;
  const packageName = await input({
    message: "Package name:",
    default: defaultPackageName,
    required: true,
  });

  const description = await input({
    message: "Description:",
    default: `${packageName} package`,
  });

  const areaDir = path.join(rootDir, area);
  const targetDir = path.join(areaDir, directoryName);

  const resolvedAreaDir = path.resolve(areaDir);
  const resolvedTargetDir = path.resolve(targetDir);
  const areaPrefix = resolvedAreaDir + path.sep;
  if (!resolvedTargetDir.startsWith(areaPrefix)) {
    throw new Error(
      `Resolved target ${resolvedTargetDir} is not inside workspace area ${resolvedAreaDir}.`,
    );
  }

  if (existsSync(targetDir)) {
    throw new Error(`Target already exists: ${path.relative(rootDir, targetDir)}`);
  }

  await mkdir(path.dirname(targetDir), { recursive: true });
  await cp(templateDir, targetDir, { recursive: true });

  const replacements = {
    name: packageName.trim(),
    description: description.trim(),
  };

  const copiedFiles = await listFilesRecursively(targetDir);
  for (const file of copiedFiles) {
    await replacePlaceholders(file, replacements);
  }

  const relativeTarget = path.relative(rootDir, targetDir);
  console.log(`Created ${relativeTarget}`);
  console.log("Next steps:");
  console.log("  bun install");
  console.log(`  bun run --filter ${packageName.trim()} typecheck`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
