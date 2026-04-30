#!/usr/bin/env bun
/**
 * Architecture constraint checks. Runs in stop hook and CI.
 * Any violation exits(1).
 */
import { Project, SyntaxKind } from 'ts-morph';
import { readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';

const violations: string[] = [];
const v = (msg: string) => violations.push(msg);

const project = new Project({ tsConfigFilePath: 'tsconfig.json', skipAddingFilesFromTsConfig: false });

// ────────────────────────────────────────────
// Rule A1: bin/*.ts must not directly new Agent / ToolRegistry / ContextManager / *Provider
// ────────────────────────────────────────────
const forbiddenCtors = ['Agent', 'ToolRegistry', 'ContextManager', 'ClaudeProvider', 'OpenAIProvider'];
for (const f of project.getSourceFiles('bin/**/*.ts')) {
  f.getDescendantsOfKind(SyntaxKind.NewExpression).forEach(ne => {
    const name = ne.getExpression().getText();
    if (forbiddenCtors.includes(name)) {
      v(`[A1] ${f.getBaseName()}:${ne.getStartLineNumber()} — bin/ must not directly new ${name}, use createAgentRuntime()`);
    }
  });
}

// ────────────────────────────────────────────
// Rule B1: No new as any / : any
// ────────────────────────────────────────────
const anyBaseline = existsSync('.any-baseline.json')
  ? JSON.parse(readFileSync('.any-baseline.json', 'utf8'))
  : { total: Infinity };

let anyCount = 0;
for (const f of project.getSourceFiles('src/**/*.{ts,tsx}')) {
  const text = f.getFullText();
  const matches = text.match(/\b(as\s+any|:\s*any\b|<any>)/g);
  if (matches) anyCount += matches.length;
}
if (anyCount > anyBaseline.total) {
  v(`[B1] any usage count ${anyCount} exceeds baseline ${anyBaseline.total} (added ${anyCount - anyBaseline.total})`);
}

// ────────────────────────────────────────────
// Rule C1: syncTodoFromContext call sites must not increase
// ────────────────────────────────────────────
const syncTodoBaseline = 6;
let syncTodoCount = 0;
for (const f of project.getSourceFiles('src/**/*.ts')) {
  if (f.getBaseName().includes('context')) continue;
  const matches = f.getFullText().match(/syncTodoFromContext/g);
  if (matches) syncTodoCount += matches.length;
}
if (syncTodoCount > syncTodoBaseline) {
  v(`[E1] syncTodoFromContext call sites ${syncTodoCount} exceeds baseline ${syncTodoBaseline}`);
}

// ────────────────────────────────────────────
// Rule D1: ToolDispatcher method set is frozen
// ────────────────────────────────────────────
const allowedDispatcherMethods = new Set([
  'dispatch', 'executeSingle', 'buildMiddlewareChain',
  'withTimeout', 'serializeAndTruncate',
  'dispatchSequential', 'dispatchParallelBatch', 'dispatchParallelStreaming',
]);
const dispatcherFile = project.getSourceFile('src/agent/tool-dispatch/dispatcher.ts');
if (dispatcherFile) {
  const cls = dispatcherFile.getClass('ToolDispatcher');
  if (cls) {
    for (const m of cls.getMethods()) {
      if (!allowedDispatcherMethods.has(m.getName())) {
        v(`[D1] ToolDispatcher new method ${m.getName()}, frozen period — no new methods (see CLAUDE.md § D)`);
      }
    }
  }
}

// ────────────────────────────────────────────
// Rule C2: Agent constructor middleware field must not be used
// ────────────────────────────────────────────
for (const f of project.getSourceFiles('src/**/*.ts')) {
  if (f.getBaseName() === 'Agent.ts') continue;
  f.getDescendantsOfKind(SyntaxKind.PropertyAssignment).forEach(pa => {
    if (pa.getName() === 'middleware' && pa.getParent()?.getParent()?.getText().includes('new Agent')) {
      v(`[C2] ${f.getBaseName()}:${pa.getStartLineNumber()} — Agent deprecated middleware field is forbidden`);
    }
  });
}

// ────────────────────────────────────────────
// Rule F1: No console.log (warn/error allowed)
// ────────────────────────────────────────────
for (const f of project.getSourceFiles('src/**/*.{ts,tsx}')) {
  f.getDescendantsOfKind(SyntaxKind.CallExpression).forEach(ce => {
    if (ce.getExpression().getText() === 'console.log') {
      v(`[F1] ${f.getFilePath()}:${ce.getStartLineNumber()} — console.log is forbidden, use debugLog`);
    }
  });
}

// ────────────────────────────────────────────
// Rule G1: File size (soft rule, eslint already enforces)
// ────────────────────────────────────────────
for (const f of project.getSourceFiles('src/**/*.{ts,tsx}')) {
  const lines = f.getEndLineNumber();
  if (lines > 400) {
    v(`[G1] ${f.getFilePath()} has ${lines} lines > 400, consider splitting`);
  }
}

// ────────────────────────────────────────────
// Rule A2: defaultSystemPrompt string must only appear in one place
// ────────────────────────────────────────────
const promptSig = 'You are Claude Code, an interactive AI coding assistant';
const hits: string[] = [];
for (const f of project.getSourceFiles(['src/**/*.ts', 'bin/**/*.ts'])) {
  if (f.getFullText().includes(promptSig)) hits.push(f.getFilePath());
}
if (hits.length > 1) {
  v(`[A2] defaultSystemPrompt defined in multiple places, consolidate to src/config/default-prompts.ts:\n  ${hits.join('\n  ')}`);
}

// ────────────────────────────────────────────
// Output
// ────────────────────────────────────────────
if (violations.length) {
  console.error('\n❌ Architecture constraint violations:\n');
  violations.forEach(x => console.error('  ' + x));
  console.error(`\n${violations.length} violation(s). See CLAUDE.md architecture constitution.\n`);
  process.exit(1);
}
console.log('✅ All architecture constraints passed');
