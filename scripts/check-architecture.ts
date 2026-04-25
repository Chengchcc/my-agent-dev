#!/usr/bin/env bun
/**
 * 架构约束检查。在 Stop hook 和 CI 中运行。
 * 违反任何一条即 exit(1)。
 */
import { Project, SyntaxKind } from 'ts-morph';
import { readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';

const violations: string[] = [];
const v = (msg: string) => violations.push(msg);

const project = new Project({ tsConfigFilePath: 'tsconfig.json', skipAddingFilesFromTsConfig: false });

// ────────────────────────────────────────────
// Rule A1: bin/*.ts 禁止直接 new Agent / ToolRegistry / ContextManager / *Provider
// ────────────────────────────────────────────
const forbiddenCtors = ['Agent', 'ToolRegistry', 'ContextManager', 'ClaudeProvider', 'OpenAIProvider'];
for (const f of project.getSourceFiles('bin/**/*.ts')) {
  f.getDescendantsOfKind(SyntaxKind.NewExpression).forEach(ne => {
    const name = ne.getExpression().getText();
    if (forbiddenCtors.includes(name)) {
      v(`[A1] ${f.getBaseName()}:${ne.getStartLineNumber()} — bin/ 禁止直接 new ${name}，请走 createAgentRuntime()`);
    }
  });
}

// ────────────────────────────────────────────
// Rule B1: 禁止新增 `as any` / `: any`
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
  v(`[B1] any 使用数量 ${anyCount} 超过 baseline ${anyBaseline.total}（新增了 ${anyCount - anyBaseline.total} 个）`);
}

// ────────────────────────────────────────────
// Rule C1: syncTodoFromContext 调用点不得增加
// ────────────────────────────────────────────
const syncTodoBaseline = 6;
let syncTodoCount = 0;
for (const f of project.getSourceFiles('src/**/*.ts')) {
  if (f.getBaseName().includes('context')) continue; // 定义文件不算
  const matches = f.getFullText().match(/syncTodoFromContext/g);
  if (matches) syncTodoCount += matches.length;
}
if (syncTodoCount > syncTodoBaseline) {
  v(`[E1] syncTodoFromContext 调用点 ${syncTodoCount} 超过 baseline ${syncTodoBaseline}`);
}

// ────────────────────────────────────────────
// Rule D1: ToolDispatcher 方法集冻结
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
        v(`[D1] ToolDispatcher 新增方法 ${m.getName()}，冻结期禁止新增（见 CLAUDE.md § D）`);
      }
    }
  }
}

// ────────────────────────────────────────────
// Rule C2: Agent 构造函数 middleware 字段不得被使用
// ────────────────────────────────────────────
for (const f of project.getSourceFiles('src/**/*.ts')) {
  if (f.getBaseName() === 'Agent.ts') continue;
  f.getDescendantsOfKind(SyntaxKind.PropertyAssignment).forEach(pa => {
    if (pa.getName() === 'middleware' && pa.getParent()?.getParent()?.getText().includes('new Agent')) {
      v(`[C2] ${f.getBaseName()}:${pa.getStartLineNumber()} — 禁止使用 Agent 的 deprecated middleware 字段`);
    }
  });
}

// ────────────────────────────────────────────
// Rule F1: 禁止 console.log（warn/error 允许）
// ────────────────────────────────────────────
for (const f of project.getSourceFiles('src/**/*.{ts,tsx}')) {
  f.getDescendantsOfKind(SyntaxKind.CallExpression).forEach(ce => {
    if (ce.getExpression().getText() === 'console.log') {
      v(`[F1] ${f.getFilePath()}:${ce.getStartLineNumber()} — 禁用 console.log，请用 debugLog`);
    }
  });
}

// ────────────────────────────────────────────
// Rule G1: 文件体积 & 函数体积（软规则，eslint 已硬管）
// ────────────────────────────────────────────
for (const f of project.getSourceFiles('src/**/*.{ts,tsx}')) {
  const lines = f.getEndLineNumber();
  if (lines > 400) {
    v(`[G1] ${f.getFilePath()} 共 ${lines} 行 > 400，建议拆分`);
  }
}

// ────────────────────────────────────────────
// Rule A2: defaultSystemPrompt 字符串不得出现在多处
// ────────────────────────────────────────────
const promptSig = 'You are Claude Code, an interactive AI coding assistant';
const hits: string[] = [];
for (const f of project.getSourceFiles(['src/**/*.ts', 'bin/**/*.ts'])) {
  if (f.getFullText().includes(promptSig)) hits.push(f.getFilePath());
}
if (hits.length > 1) {
  v(`[A2] defaultSystemPrompt 在多处重复定义，请集中到 src/config/default-prompts.ts：\n  ${hits.join('\n  ')}`);
}

// ────────────────────────────────────────────
// 输出
// ────────────────────────────────────────────
if (violations.length) {
  console.error('\n❌ 架构约束违反:\n');
  violations.forEach(x => console.error('  ' + x));
  console.error(`\n共 ${violations.length} 处违反。详见 CLAUDE.md 架构宪法。\n`);
  process.exit(1);
}
console.log('✅ 架构约束全部通过');
