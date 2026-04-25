#!/usr/bin/env bun
import 'dotenv/config';
import { createAgentRuntime } from '../src/runtime';
import { globalAskUserQuestionManager } from '../src/tools';
import { SkillLoader } from '../src/skills/loader';
import { toSkillCommand } from '../src/cli/tui/command-registry';
import { runTUIClient } from '../src/cli/index';
import { setDebugMode } from '../src/utils/debug';

const args = process.argv.slice(2);
setDebugMode(args.includes('--debug') || args.includes('-d'));

(async () => {
  try {
    const runtime = await createAgentRuntime({
      cwd: __dirname + '/..',
      askUserQuestionHandler: (params) =>
        globalAskUserQuestionManager.askUserQuestion(params),
    });

    const skillLoader = new SkillLoader();
    const skills = await skillLoader.loadAllSkills();
    const skillCommands = skills.map(toSkillCommand);

    process.on('beforeExit', async () => {
      await runtime.shutdown();
      process.exit(0);
    });

    runTUIClient(runtime.agent, skillCommands, runtime.sessionStore);
  } catch (error) {
    console.error('Failed to initialize TUI:', error);
    process.exit(1);
  }
})();
