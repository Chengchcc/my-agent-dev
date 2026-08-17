# Bun Turborepo Monorepo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a clean Bun + Turborepo monorepo skeleton with TypeScript tooling, package templates, an interactive package generator, README, and GitHub CI.

**Architecture:** The root package owns workspace configuration and shared tooling. Generated packages are isolated Node/Bun TypeScript library workspaces created from `_template/package`. `scripts/create-package.ts` is the only generator entry point and copies the template after validating user input.

**Tech Stack:** Bun, Turborepo, TypeScript, Biome, ESLint, `@inquirer/prompts`, GitHub Actions.

---

## File Structure

- Create: `package.json` — root package scripts, workspace declarations, dev dependencies.
- Create: `turbo.json` — Turborepo task graph for lint, typecheck, test, and build.
- Create: `tsconfig.base.json` — shared TypeScript compiler defaults.
- Create: `biome.json` — root Biome formatter/linter config.
- Create: `eslint.config.js` — flat ESLint config for TypeScript files.
- Create: `.gitignore` — ignores dependencies, build output, caches, logs.
- Create: `apps/.gitkeep` — keeps empty apps workspace directory.
- Create: `packages/.gitkeep` — keeps empty packages workspace directory.
- Create: `_template/package/package.json` — package template metadata and scripts.
- Create: `_template/package/tsconfig.json` — package template TypeScript project config.
- Create: `_template/package/src/index.ts` — package template source entry.
- Create: `scripts/create-package.ts` — interactive generator CLI.
- Create: `README.md` — workspace usage and command documentation.
- Create: `.github/workflows/ci.yml` — CI matching local validation commands.
- Modify: `docs/superpowers/plans/2026-06-04-bun-turborepo-monorepo.md` — track execution checkboxes only.

### Task 1: Root Workspace Configuration

**Files:**
- Create: `package.json`
- Create: `turbo.json`
- Create: `tsconfig.base.json`
- Create: `.gitignore`
- Create: `apps/.gitkeep`
- Create: `packages/.gitkeep`

- [ ] **Step 1: Create root `package.json`**

Write `package.json` exactly:

```json
{
  "name": "my-agent-team",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "packageManager": "bun@1.1.0",
  "workspaces": [
    "apps/*",
    "packages/*"
  ],
  "scripts": {
    "build": "turbo run build",
    "create": "bun run scripts/create-package.ts",
    "format": "biome format --write .",
    "lint": "biome check . && eslint .",
    "test": "turbo run test",
    "typecheck": "turbo run typecheck"
  },
  "devDependencies": {
    "@biomejs/biome": "latest",
    "@eslint/js": "latest",
    "@inquirer/prompts": "latest",
    "@types/bun": "latest",
    "eslint": "latest",
    "typescript": "latest",
    "typescript-eslint": "latest",
    "turbo": "latest"
  }
}
```

- [ ] **Step 2: Create `turbo.json`**

Write `turbo.json` exactly:

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "lint": {
      "dependsOn": ["^lint"]
    },
    "test": {
      "dependsOn": ["^test"]
    },
    "typecheck": {
      "dependsOn": ["^typecheck"]
    }
  }
}
```

- [ ] **Step 3: Create `tsconfig.base.json`**

Write `tsconfig.base.json` exactly:

```json
{
  "compilerOptions": {
    "declaration": true,
    "declarationMap": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "isolatedModules": true,
    "lib": ["ES2023"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "noEmitOnError": true,
    "noFallthroughCasesInSwitch": true,
    "noImplicitOverride": true,
    "noImplicitReturns": true,
    "noUncheckedIndexedAccess": true,
    "outDir": "dist",
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "strict": true,
    "target": "ES2023"
  }
}
```

- [ ] **Step 4: Create `.gitignore`**

Write `.gitignore` exactly:

```gitignore
node_modules/
dist/
.turbo/
.cache/
coverage/
*.log
.DS_Store
.env
.env.*
```

- [ ] **Step 5: Create workspace directories**

Create empty files:

```txt
apps/.gitkeep
packages/.gitkeep
```

- [ ] **Step 6: Install dependencies**

Run:

```bash
bun install
```

Expected: `bun.lock` is created and install exits with code 0.

- [ ] **Step 7: Verify root scripts are discoverable**

Run:

```bash
bun run build
```

Expected: Turbo runs successfully with no package tasks, or reports no tasks without a non-zero exit.

- [ ] **Step 8: Commit root workspace configuration**

```bash
git add package.json bun.lock turbo.json tsconfig.base.json .gitignore apps/.gitkeep packages/.gitkeep
git commit --author="chengchen <a1873042943@163.com>" -m "Initialize Bun Turborepo workspace"
```

### Task 2: Formatting and Linting Configuration

**Files:**
- Create: `biome.json`
- Create: `eslint.config.js`
- Modify: `package.json`

- [ ] **Step 1: Create `biome.json`**

Write `biome.json` exactly:

```json
{
  "$schema": "https://biomejs.dev/schemas/1.9.4/schema.json",
  "files": {
    "ignore": ["dist", "node_modules", ".turbo", "bun.lock"]
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100
  },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true
    }
  },
  "organizeImports": {
    "enabled": true
  }
}
```

- [ ] **Step 2: Create `eslint.config.js`**

Write `eslint.config.js` exactly:

```js
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", ".turbo/**", "bun.lock"]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          "argsIgnorePattern": "^_",
          "varsIgnorePattern": "^_"
        }
      ]
    }
  }
);
```

- [ ] **Step 3: Run formatter and lint**

Run:

```bash
bun run format
bun run lint
```

Expected: both commands exit 0. If `eslint .` reports no matching TypeScript files, continue after confirming the command exits 0.

- [ ] **Step 4: Commit tooling configuration**

```bash
git add biome.json eslint.config.js package.json bun.lock
git commit --author="chengchen <a1873042943@163.com>" -m "Configure formatting and linting"
```

### Task 3: Package Template

**Files:**
- Create: `_template/package/package.json`
- Create: `_template/package/tsconfig.json`
- Create: `_template/package/src/index.ts`

- [ ] **Step 1: Create template `package.json`**

Write `_template/package/package.json` exactly:

```json
{
  "name": "{{name}}",
  "version": "0.1.0",
  "description": "{{description}}",
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "types": "./dist/index.d.ts",
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "lint": "biome check . && eslint .",
    "test": "bun test",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "devDependencies": {}
}
```

- [ ] **Step 2: Create template `tsconfig.json`**

Write `_template/package/tsconfig.json` exactly:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Create template source entry**

Write `_template/package/src/index.ts` exactly:

```ts
export function packageName(): string {
  return "{{name}}";
}
```

- [ ] **Step 4: Confirm template is not a workspace**

Run:

```bash
bun pm pkg get workspaces
```

Expected: output includes only `apps/*` and `packages/*`; `_template/package` is not listed.

- [ ] **Step 5: Commit package template**

```bash
git add _template/package/package.json _template/package/tsconfig.json _template/package/src/index.ts
git commit --author="chengchen <a1873042943@163.com>" -m "Add TypeScript package template"
```

### Task 4: Interactive Package Generator

**Files:**
- Create: `scripts/create-package.ts`
- Modify: `package.json`

- [ ] **Step 1: Write generator source**

Write `scripts/create-package.ts` exactly:

```ts
import { input, select } from "@inquirer/prompts";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const rootDir = path.resolve(import.meta.dir, "..");
const templateDir = path.join(rootDir, "_template", "package");

function normalizeDirectoryName(value: string): string {
  return value.trim().replace(/^\/+|\/+$/g, "");
}

function assertSafeDirectoryName(value: string): void {
  if (value.length === 0) {
    throw new Error("Directory name is required.");
  }

  if (value.includes("..") || path.isAbsolute(value)) {
    throw new Error("Directory name must be relative and cannot contain '..'.");
  }
}

async function replacePlaceholders(filePath: string, replacements: Record<string, string>): Promise<void> {
  let content = await readFile(filePath, "utf8");

  for (const [key, value] of Object.entries(replacements)) {
    content = content.replaceAll(`{{${key}}}`, value);
  }

  await writeFile(filePath, content);
}

async function main(): Promise<void> {
  const area = await select({
    message: "Where should the package be created?",
    choices: [
      { name: "apps", value: "apps" },
      { name: "packages", value: "packages" }
    ]
  });

  const directoryName = normalizeDirectoryName(
    await input({
      message: "Directory name:",
      required: true
    })
  );
  assertSafeDirectoryName(directoryName);

  const defaultPackageName = `@chengchenccc/${directoryName.split("/").at(-1)}`;
  const packageName = await input({
    message: "Package name:",
    default: defaultPackageName,
    required: true
  });

  const description = await input({
    message: "Description:",
    default: `${packageName} package`
  });

  const targetDir = path.join(rootDir, area, directoryName);

  if (existsSync(targetDir)) {
    throw new Error(`Target already exists: ${path.relative(rootDir, targetDir)}`);
  }

  await mkdir(path.dirname(targetDir), { recursive: true });
  await cp(templateDir, targetDir, { recursive: true });

  await replacePlaceholders(path.join(targetDir, "package.json"), {
    name: packageName.trim(),
    description: description.trim()
  });
  await replacePlaceholders(path.join(targetDir, "src", "index.ts"), {
    name: packageName.trim(),
    description: description.trim()
  });

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
```

- [ ] **Step 2: Typecheck generator before creating packages**

Run:

```bash
bunx tsc --noEmit --allowImportingTsExtensions --module NodeNext --moduleResolution NodeNext --target ES2023 --types bun scripts/create-package.ts
```

Expected: command exits 0.

- [ ] **Step 3: Run lint**

Run:

```bash
bun run lint
```

Expected: command exits 0.

- [ ] **Step 4: Commit generator**

```bash
git add scripts/create-package.ts package.json bun.lock
git commit --author="chengchen <a1873042943@163.com>" -m "Add package creation CLI"
```

### Task 5: README and CI

**Files:**
- Create: `README.md`
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Create `README.md`**

Write `README.md` exactly:

```markdown
# my-agent-team

Bun + Turborepo monorepo for Node/Bun TypeScript packages.

## Workspace layout

```txt
apps/       Application workspaces
packages/   Shared package workspaces
_template/  Source templates used by repository scripts
scripts/    Repository automation scripts
```

`apps/**` and `packages/**` are managed by Bun workspaces. `_template/**` is not a workspace.

## Commands

```bash
bun install
bun run format
bun run lint
bun run typecheck
bun run test
bun run build
```

## Create a package

Run the interactive generator:

```bash
bun run create
```

The generator asks whether to create under `apps` or `packages`, then asks for a directory name, package name, and description.

Generated packages are TypeScript ESM libraries for Node/Bun. They build to `dist/` with declaration files.

## Package scripts

Each generated package provides:

```bash
bun run build
bun run lint
bun run test
bun run typecheck
```

The root uses Turborepo to run workspace tasks across all packages.
```

- [ ] **Step 2: Create GitHub Actions workflow**

Write `.github/workflows/ci.yml` exactly:

```yaml
name: CI

on:
  pull_request:
  push:
    branches:
      - master
      - main

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Bun
        uses: oven-sh/setup-bun@v2

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Lint
        run: bun run lint

      - name: Typecheck
        run: bun run typecheck

      - name: Test
        run: bun run test

      - name: Build
        run: bun run build
```

- [ ] **Step 3: Run lint after docs and CI are added**

Run:

```bash
bun run lint
```

Expected: command exits 0.

- [ ] **Step 4: Commit README and CI**

```bash
git add README.md .github/workflows/ci.yml
git commit --author="chengchen <a1873042943@163.com>" -m "Document monorepo workflow and CI"
```

### Task 6: End-to-End Validation

**Files:**
- Temporary create: `packages/tmp-validation/**`
- Remove before commit: `packages/tmp-validation/**`
- Modify only if tool output requires fixes: files from previous tasks

- [ ] **Step 1: Install with lockfile**

Run:

```bash
bun install --frozen-lockfile
```

Expected: exits 0.

- [ ] **Step 2: Run root lint**

Run:

```bash
bun run lint
```

Expected: exits 0.

- [ ] **Step 3: Run root typecheck before generated packages**

Run:

```bash
bun run typecheck
```

Expected: Turbo exits 0 with no package typecheck tasks, or reports no tasks without a non-zero exit.

- [ ] **Step 4: Run root build before generated packages**

Run:

```bash
bun run build
```

Expected: Turbo exits 0 with no package build tasks, or reports no tasks without a non-zero exit.

- [ ] **Step 5: Generate validation package interactively**

Run:

```bash
bun run create
```

When prompted, enter:

```txt
Where should the package be created? packages
Directory name: tmp-validation
Package name: @chengchenccc/tmp-validation
Description: Temporary validation package
```

Expected: `packages/tmp-validation` is created.

- [ ] **Step 6: Inspect generated files**

Verify `packages/tmp-validation/package.json` contains:

```json
{
  "name": "@chengchenccc/tmp-validation",
  "version": "0.1.0",
  "description": "Temporary validation package"
}
```

Verify `packages/tmp-validation/src/index.ts` contains:

```ts
export function packageName(): string {
  return "@chengchenccc/tmp-validation";
}
```

- [ ] **Step 7: Install after generating package**

Run:

```bash
bun install
```

Expected: exits 0 and workspace lockfile is updated if needed.

- [ ] **Step 8: Validate generated package through root commands**

Run:

```bash
bun run lint
bun run typecheck
bun run test
bun run build
```

Expected: all commands exit 0. `packages/tmp-validation/dist/index.js` and `packages/tmp-validation/dist/index.d.ts` are created by build.

- [ ] **Step 9: Remove temporary validation package**

Run:

```bash
rm -rf packages/tmp-validation
```

Expected: `packages/tmp-validation` no longer exists.

- [ ] **Step 10: Reinstall after removing validation package**

Run:

```bash
bun install
```

Expected: exits 0 and lockfile no longer references `packages/tmp-validation`.

- [ ] **Step 11: Final validation**

Run:

```bash
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun run test
bun run build
```

Expected: all commands exit 0.

- [ ] **Step 12: Commit final validation fixes if any were needed**

If validation required code changes, commit them:

```bash
git add package.json bun.lock turbo.json tsconfig.base.json biome.json eslint.config.js scripts/create-package.ts _template/package README.md .github/workflows/ci.yml .gitignore apps/.gitkeep packages/.gitkeep
git commit --author="chengchen <a1873042943@163.com>" -m "Fix monorepo validation issues"
```

If no files changed during validation, do not create an empty commit.

## Self-Review

- Spec coverage: Root Bun workspaces, Turborepo tasks, TypeScript, Biome, ESLint, GitHub CI, README, `_template/package`, interactive CLI prompts, Node/Bun package output, and temporary package validation are each covered by tasks.
- Placeholder scan: The only `{{name}}` and `{{description}}` strings are intentional template placeholders required by the spec.
- Type consistency: The generator uses `area`, `directoryName`, `packageName`, and `description` consistently. Template package scripts match the root Turbo task names.
