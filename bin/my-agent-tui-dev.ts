#!/usr/bin/env bun
import 'dotenv/config';
import { getSettings, settings } from '../src/config';
import { setDebugMode, debugLog } from '../src/utils/debug';

// Parse command line arguments
const args = process.argv.slice(2);
const debugEnabled = args.includes('--debug') || args.includes('-d');
setDebugMode(debugEnabled);

// Load settings first before importing anything that might access settings
await getSettings();

// Create unified agent runtime (shared with headless mode)
import { createAgentRuntime } from '../src/runtime';
import { globalAskUserQuestionManager } from '../src/tools';
import { SkillLoader } from '../src/skills/loader';
import { toSkillCommand } from '../src/cli/tui/command-registry';
import { runTUIClient } from '../src/cli/index';

try {
  const runtime = await createAgentRuntime({
    settings: {
      llm: settings.llm,
      context: settings.context,
    },
    allowedRoots: settings.security.allowedRoots,
    askUserQuestionHandler: (params) => globalAskUserQuestionManager.askUserQuestion(params),
    enableCompaction: true,
    enableMemory: true,
    enableSkills: true,
    enableTodo: true,
    enableSession: true,
  });

  debugLog('Agent runtime initialized');

  // Preload skills
  await runtime.sessionStore.ensureSessionDir();
  runtime.sessionStore.createNewSession();

  // Load skills for slash command autocomplete
  const skillLoader = new SkillLoader();
  const skills = await skillLoader.loadAllSkills();
  const skillCommands = skills.map(toSkillCommand);

  // Wait for pending memory extractions before exit
  process.on('beforeExit', async () => {
    await runtime.shutdown();
    process.exit(0);
  });

  runTUIClient(runtime.agent, skillCommands, runtime.sessionStore);
} catch (error) {
  console.error('Failed to initialize TUI:', error);
  process.exit(1);
}
