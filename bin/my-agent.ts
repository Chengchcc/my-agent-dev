#!/usr/bin/env bun

import 'dotenv/config';
import { parseArgs } from 'util';
import type { RuntimeConfig } from '../src/runtime';
import { setDebugMode } from '../src/utils/debug';

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    prompt:       { type: 'string',  short: 'p' },
    model:        { type: 'string',  short: 'm' },
    provider:     { type: 'string' },
    'max-turns':  { type: 'string',  default: '25' },
    'output-format': { type: 'string', short: 'o', default: 'text' },
    'system-prompt': { type: 'string', short: 's' },
    'no-memory':  { type: 'boolean', default: false },
    'no-skills':  { type: 'boolean', default: false },
    'no-todo':    { type: 'boolean', default: false },
    debug:        { type: 'boolean', short: 'd', default: false },
    help:         { type: 'boolean', short: 'h', default: false },
    version:      { type: 'boolean', short: 'v', default: false },
  },
  allowPositionals: true,
  strict: false,
});

if (values.help) {
  console.log(`
Usage: my-agent [options] [prompt]

Options:
  -p, --prompt <text>         Prompt to send (alternative: positional arg or stdin)
  -m, --model <name>          Model override
      --provider <name>       Provider: claude (default) or openai
  -s, --system-prompt <text>  System prompt override
  -o, --output-format <fmt>   Output format: text (default), json, stream-json
      --max-turns <n>         Maximum agent turns (default: 25)
      --no-memory             Disable memory system
      --no-skills             Disable skill injection
      --no-todo               Disable todo system
  -d, --debug                 Enable debug output
  -h, --help                  Show this help
  -v, --version               Show version

Examples:
  my-agent -p "fix all lint errors in src/"
  my-agent -p "review this file" -o json
  cat error.log | my-agent -p "analyze these errors"
  echo "explain package.json" | my-agent
  my-agent "summarize the project"
`);
  process.exit(0);
}

if (values.version) {
  const pkg = require('../package.json');
  console.log(pkg.version ?? '0.0.0');
  process.exit(0);
}

setDebugMode(!!values.debug);

import { createAgentRuntime } from '../src/runtime';
import type { AgentEvent, AgentDoneEvent } from '../src/agent/loop-types';

type OutputFormat = 'text' | 'json' | 'stream-json';

function writeTextEvent(event: AgentEvent) {
  switch (event.type) {
    case 'text_delta':
      process.stdout.write(event.delta);
      break;
    case 'tool_call_start':
      if (values.debug) {
        process.stderr.write(`\n[tool:${event.toolCall.name}] starting...\n`);
      }
      break;
    case 'tool_call_result':
      if (values.debug) {
        const status = event.isError ? 'ERROR' : 'OK';
        process.stderr.write(`[tool:${event.toolCall.name}] ${status} (${event.durationMs}ms)\n`);
      }
      break;
    case 'agent_error':
      process.stderr.write(`Error: ${event.error.message}\n`);
      break;
    case 'agent_done':
      process.stdout.write('\n');
      break;
    case 'thinking_delta':
    case 'thinking_done':
    case 'turn_complete':
    case 'sub_agent_start':
    case 'sub_agent_event':
    case 'sub_agent_done':
    case 'budget_delegation':
    case 'budget_compact':
    case 'context_compacted':
      break;
  }
}

function writeStreamJsonEvent(event: AgentEvent) {
  const serializable: Record<string, unknown> = { type: event.type, turnIndex: event.turnIndex };

  switch (event.type) {
    case 'text_delta':
      serializable.delta = event.delta;
      break;
    case 'tool_call_start':
      serializable.tool = { name: event.toolCall.name, id: event.toolCall.id, arguments: event.toolCall.arguments };
      break;
    case 'tool_call_result':
      serializable.tool = { name: event.toolCall.name, id: event.toolCall.id };
      serializable.result = typeof event.result === 'string' ? event.result : JSON.stringify(event.result);
      serializable.durationMs = event.durationMs;
      serializable.isError = event.isError;
      break;
    case 'turn_complete':
      serializable.hasToolCalls = event.hasToolCalls;
      serializable.usage = event.usage;
      break;
    case 'agent_done':
      serializable.totalTurns = event.totalTurns;
      serializable.reason = event.reason;
      break;
    case 'agent_error':
      serializable.error = event.error.message;
      break;
    case 'sub_agent_start':
      serializable.agentId = event.agentId;
      serializable.task = event.task;
      break;
    case 'sub_agent_done':
      serializable.agentId = event.agentId;
      serializable.summary = event.summary;
      serializable.totalTurns = event.totalTurns;
      serializable.durationMs = event.durationMs;
      break;
    case 'thinking_delta':
    case 'thinking_done':
    case 'sub_agent_event':
    case 'budget_delegation':
    case 'budget_compact':
    case 'context_compacted':
      break;
  }

  process.stdout.write(JSON.stringify(serializable) + '\n');
}

async function getPrompt(): Promise<string> {
  let stdinContent = '';

  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    stdinContent = Buffer.concat(chunks).toString('utf8').trim();
  }

  const promptArg = (typeof values.prompt === 'string' ? values.prompt : '') || positionals.join(' ') || '';

  if (promptArg && stdinContent) {
    return `${promptArg}\n\n<context>\n${stdinContent}\n</context>`;
  }
  if (promptArg) return promptArg;
  if (stdinContent) return stdinContent;

  console.error('Error: No prompt provided. Use -p, positional argument, or pipe via stdin.');
  console.error('Run `my-agent --help` for usage.');
  process.exit(2);
}

async function main() {
  const prompt = await getPrompt();
  const outputFormat = (String(values['output-format'] ?? 'text')) as OutputFormat;
  const maxTurns = parseInt(String(values['max-turns'] ?? '25'), 10);

  const runtimeConfig: RuntimeConfig = {
    enableMemory: !values['no-memory'],
    enableSkills: !values['no-skills'],
    enableTodo: !values['no-todo'],
  };
  if (values.provider) runtimeConfig.provider = values.provider as 'claude' | 'openai';
  if (typeof values.model === 'string') runtimeConfig.model = values.model;
  if (typeof values['system-prompt'] === 'string') runtimeConfig.systemPrompt = values['system-prompt'];

  const runtime = await createAgentRuntime(runtimeConfig);

  let fullContent = '';
  let finalEvent: AgentDoneEvent | null = null;
  let exitCode = 0;

  try {
    for await (const event of runtime.agent.runAgentLoop(
      { role: 'user', content: prompt },
      { maxTurns },
    )) {
      if (outputFormat === 'text') {
        writeTextEvent(event);
      } else if (outputFormat === 'stream-json') {
        writeStreamJsonEvent(event);
      }

      if (event.type === 'text_delta') {
        fullContent += event.delta;
      }
      if (event.type === 'agent_done') {
        finalEvent = event;
        if (event.reason === 'error') exitCode = 1;
        else if (event.reason === 'max_turns_reached') exitCode = 2;
      }
      if (event.type === 'agent_error') {
        exitCode = 1;
      }
    }

    if (outputFormat === 'json') {
      const output = {
        content: fullContent,
        totalTurns: finalEvent?.totalTurns ?? 0,
        reason: finalEvent?.reason ?? 'unknown',
        messages: runtime.contextManager.getContext(runtime.agent.config).messages,
      };
      process.stdout.write(JSON.stringify(output, null, 2) + '\n');
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (outputFormat === 'json') {
      process.stdout.write(JSON.stringify({ error: msg }) + '\n');
    } else {
      process.stderr.write(`Error: ${msg}\n`);
    }
    exitCode = 1;
  } finally {
    await runtime.shutdown();
    process.exit(exitCode);
  }
}

void main();
