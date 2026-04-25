#!/usr/bin/env bun

import 'dotenv/config';
import { parseArgs } from 'util';
import { setDebugMode } from '../src/utils/debug';

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
