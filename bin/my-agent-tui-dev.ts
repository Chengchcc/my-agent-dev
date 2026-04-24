#!/usr/bin/env bun
import 'dotenv/config';
import { Agent, ToolRegistry } from './../src/agent';
import { ContextManager } from '../src/agent/context';
import { ClaudeProvider } from '../src/providers';
import { OpenAIProvider } from '../src/providers/openai';
import { SkillLoader } from '../src/skills/loader';
import { createSkillMiddleware } from '../src/skills/middleware';
import { toSkillCommand, loadAvailableCommands } from '../src/cli/tui/command-registry';
import { runTUIClient } from '../src/cli/index';
import { BashTool, TextEditorTool, AskUserQuestionTool, ReadTool, GrepTool, GlobTool, LsTool } from '../src/tools';
import { SubAgentTool } from '../src/agent';
import { globalAskUserQuestionManager } from '../src/tools';
import { SessionStore } from '../src/session/store';
import { createAutoSaveHook } from '../src/session/hook';
import { createTodoMiddleware } from '../src/todos';
import { setDebugMode } from '../src/utils/debug';
import { getSettings, settings } from '../src/config';
import type { AgentConfig } from '../src/types';
import type { SkillFrontmatter } from '../src/skills/loader';

// Parse command line arguments
const args = process.argv.slice(2);
const debugEnabled = args.includes('--debug') || args.includes('-d');
setDebugMode(debugEnabled);

// Load settings
await getSettings();

// Choose provider based on configured settings
let provider;
if (settings.llm.provider === 'claude') {
  if (!settings.llm.apiKey && process.env.ANTHROPIC_API_KEY) {
    settings.llm.apiKey = process.env.ANTHROPIC_API_KEY;
  }
  provider = new ClaudeProvider({
    apiKey: settings.llm.apiKey!,
    baseURL: settings.llm.baseURL ?? undefined,
    model: settings.llm.model,
    maxTokens: settings.llm.maxTokens,
    temperature: settings.llm.temperature,
  });
} else if (settings.llm.provider === 'openai') {
  if (!settings.llm.apiKey && process.env.OPENAI_API_KEY) {
    settings.llm.apiKey = process.env.OPENAI_API_KEY;
  }
  provider = new OpenAIProvider({
    apiKey: settings.llm.apiKey!,
    baseURL: settings.llm.baseURL ?? undefined,
    model: settings.llm.model,
  });
} else {
  console.error('Error: Invalid provider configured');
  process.exit(1);
}

const contextManager = new ContextManager({
  tokenLimit: settings.context.tokenLimit,
});
const config: AgentConfig = {
  tokenLimit: settings.context.tokenLimit,
};

// Create tool registry and register built-in tools
const toolRegistry = new ToolRegistry();
const allowedRoots = settings.security.allowedRoots;
toolRegistry.register(new BashTool({ allowedWorkingDirs: allowedRoots }));
toolRegistry.register(new TextEditorTool({ allowedRoots }));
toolRegistry.register(new AskUserQuestionTool(
  (params) => globalAskUserQuestionManager.askUserQuestion(params)
));
toolRegistry.register(new ReadTool());
toolRegistry.register(new GrepTool());
toolRegistry.register(new GlobTool());
toolRegistry.register(new LsTool());

// Register todo middleware - provides todo_write tool and periodic reminders
const { tool: todoTool, hooks: todoHooks } = createTodoMiddleware();
toolRegistry.register(todoTool);

// SubAgentTool - delegate tasks to independent sub agents
toolRegistry.register(new SubAgentTool({
  mainProvider: provider,
  mainToolRegistry: toolRegistry,
  mainAgentConfig: config,
}));

// Memory System - persistent cross-conversation memory
import {
  JsonlMemoryStore,
  KeywordRetriever,
  LlmExtractor,
  MemoryMiddleware,
  MemoryTool,
} from './../src/memory';

// Initialize memory stores
const semanticMemoryStore = new JsonlMemoryStore('semantic');
const episodicMemoryStore = new JsonlMemoryStore('episodic');
const projectMemoryStore = new JsonlMemoryStore('project', {}, process.cwd());
const keywordRetriever = new KeywordRetriever(
  semanticMemoryStore,
  episodicMemoryStore,
  projectMemoryStore,
);
const llmExtractor = new LlmExtractor(provider);
const memoryMiddleware = new MemoryMiddleware(
  {
    semantic: semanticMemoryStore,
    episodic: episodicMemoryStore,
    project: projectMemoryStore,
  },
  keywordRetriever,
  llmExtractor,
);
const memoryTool = new MemoryTool(
  {
    semantic: semanticMemoryStore,
    episodic: episodicMemoryStore,
    project: projectMemoryStore,
  },
  keywordRetriever,
  llmExtractor,
);

// Register memory tool
toolRegistry.register(memoryTool);

// Skill middleware for automatic skill injection - factory pattern
// Skill injection happens in beforeModel hook every turn, guaranteeing it's never lost
const skillMiddleware = createSkillMiddleware({ autoInject: true, injectOnMention: true });

// Initialize session store and create new session
const sessionStore = new SessionStore();

// Create agent with tool registry
const agentHooks = {
  beforeAgentRun: [skillMiddleware.beforeAgentRun],
  beforeModel: [skillMiddleware.beforeModel, todoHooks.beforeModel!],
  afterAgentRun: [createAutoSaveHook(sessionStore)],
};

// Add memory middleware hooks
if (memoryMiddleware.beforeModel) {
  agentHooks.beforeModel?.push(memoryMiddleware.beforeModel);
}
if (memoryMiddleware.afterAgentRun) {
  agentHooks.afterAgentRun?.push(memoryMiddleware.afterAgentRun);
}

const agent = new Agent({
  provider,
  contextManager,
  config,
  toolRegistry,
  hooks: agentHooks,
});

// Load skills and convert to slash commands
(async () => {
  try {
    // Load settings first
    const { getSettings } = await import('../src/config');
    await getSettings();

    // Ensure session directory is created
    await sessionStore.ensureSessionDir();
    // Create new session for this TUI run
    sessionStore.createNewSession();

    // Preload all skills for skill injection
    await skillMiddleware.preloadAll();

    const skillLoader = new SkillLoader();
    const skills = await skillLoader.loadAllSkills();
    const skillCommands = skills.map(toSkillCommand);

    // Wait for pending memory extractions to complete before exit
    process.on('beforeExit', async () => {
      await memoryMiddleware.awaitPendingExtractions();
      process.exit(0);
    });

    runTUIClient(agent, skillCommands, sessionStore);
  } catch (error) {
    console.error('Failed to initialize TUI:', error);
    process.exit(1);
  }
})();
