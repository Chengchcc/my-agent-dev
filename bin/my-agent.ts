#!/usr/bin/env bun

import 'dotenv/config';
import { parseArgs } from 'util';
import { createAgentRuntime } from '../src/runtime';
import { setDebugMode } from '../src/utils/debug';
import type { AgentEvent } from '../src/agent/loop-types';

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    prompt:       { type: 'string',  short: 'p' },
    model:        { type: 'string',  short: 'm' },
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
    case 'agent_done':
      process.stdout.write('\n');
      break;
  }
}

async function main() {
  const prompt = await getPrompt();
  const outputFormat = (values['output-format'] as OutputFormat ?? 'text');
  const maxTurns = parseInt(values['max-turns'] as string ?? '25', 10);

  const runtime = await createAgentRuntime({
    model: values.model as string | undefined,
    enableMemory: !values['no-memory'],
    enableSkills: !values['no-skills'],
    enableTodo: !values['no-todo'],
    systemPrompt: values['system-prompt'] as string | undefined,
  });

  let exitCode = 0;

  try {
    for await (const event of runtime.agent.runAgentLoop(
      { role: 'user', content: prompt },
      { maxTurns },
    )) {
      if (outputFormat === 'text') {
        writeTextEvent(event);
      }
      if (event.type === 'agent_done' && event.reason === 'error') {
        exitCode = 1;
      }
      if (event.type === 'agent_error') {
        exitCode = 1;
      }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error: ${msg}\n`);
    exitCode = 1;
  } finally {
    await runtime.shutdown();
    process.exit(exitCode);
  }
}

main();
