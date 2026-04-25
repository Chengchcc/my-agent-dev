#!/usr/bin/env bun
/**
 * PreToolUse hook — 在 Edit/Write 发生之前做轻量告警。
 * 非阻塞：只打印提醒，让 Claude 看到并自觉遵守。
 */
import { readFileSync } from 'fs';

const input = JSON.parse(readFileSync(0, 'utf8'));
const path: string = input?.tool_input?.file_path ?? input?.tool_input?.path ?? '';

const reminders: Record<string, string> = {
  'src/agent/Agent.ts': '⚠️  修改 Agent.ts 前请通读全文件；当前处于拆分期，避免增加 runAgentLoop 内的 phase。',
  'src/agent/tool-dispatch/dispatcher.ts': '⚠️  dispatcher 方法集冻结；不要新增 dispatch 分支。',
  'src/runtime.ts': '⚠️  runtime 是唯一装配点；不要把装配逻辑拆散到 bin/。',
};

for (const [key, msg] of Object.entries(reminders)) {
  if (path.endsWith(key)) {
    console.error(msg);
    break;
  }
}

// 非零 exit 会阻塞；这里永远 0，仅提醒
process.exit(0);
