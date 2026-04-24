#!/usr/bin/env bun
import 'dotenv/config';
import { getSettings, settings } from '../src/config';

// Parse command line arguments
const args = process.argv.slice(2);
const debugEnabled = args.includes('--debug') || args.includes('-d');
import { setDebugMode, debugLog } from '../src/utils/debug';
setDebugMode(debugEnabled);

// Load settings first before importing anything that might access settings
await getSettings();

// Choose provider based on configured settings
const { ClaudeProvider } = await import('../src/providers');
const { OpenAIProvider } = await import('../src/providers/openai');
let provider;
if (settings.llm.provider === 'claude') {
  if (!settings.llm.apiKey) {
    // For Volces Ark, ANTHROPIC_AUTH_TOKEN is used, fall back to ANTHROPIC_API_KEY
    if (process.env.ANTHROPIC_AUTH_TOKEN) {
      settings.llm.apiKey = process.env.ANTHROPIC_AUTH_TOKEN;
    } else if (process.env.ANTHROPIC_API_KEY) {
      settings.llm.apiKey = process.env.ANTHROPIC_API_KEY;
    }
  }
  debugLog('Creating ClaudeProvider with:');
  debugLog('  apiKey length:', settings.llm.apiKey?.length);
  debugLog('  baseURL:', settings.llm.baseURL);
  debugLog('  model:', settings.llm.model);
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
  debugLog('Creating OpenAIProvider with:');
  debugLog('  apiKey length:', settings.llm.apiKey?.length);
  debugLog('  baseURL:', settings.llm.baseURL);
  debugLog('  model:', settings.llm.model);
  provider = new OpenAIProvider({
    apiKey: settings.llm.apiKey!,
    baseURL: settings.llm.baseURL ?? undefined,
    model: settings.llm.model,
  });
} else {
  console.error('Error: Invalid provider configured');
  process.exit(1);
}

const { ContextManager } = await import('../src/agent/context');
const contextManager = new ContextManager({
  tokenLimit: settings.context.tokenLimit,
});
const config: import('../src/types').AgentConfig = {
  tokenLimit: settings.context.tokenLimit,
};

// Create tool registry and register built-in tools
const { Agent, ToolRegistry } = await import('../src/agent');
const { BashTool, TextEditorTool, AskUserQuestionTool, ReadTool, GrepTool, GlobTool, LsTool, globalAskUserQuestionManager } = await import('../src/tools');
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
const { createTodoMiddleware } = await import('../src/todos');
const { tool: todoTool, hooks: todoHooks } = createTodoMiddleware();
toolRegistry.register(todoTool);

// SubAgentTool - delegate tasks to independent sub agents
const { SubAgentTool } = await import('../src/agent');
toolRegistry.register(new SubAgentTool({
  mainProvider: provider,
  mainToolRegistry: toolRegistry,
  mainAgentConfig: config,
}));

// Memory System - persistent cross-conversation memory
const {
  JsonlMemoryStore,
  KeywordRetriever,
  LlmExtractor,
  MemoryMiddleware,
  MemoryTool,
} = await import('./../src/memory');

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
const { createSkillMiddleware } = await import('../src/skills/middleware');
const skillMiddleware = createSkillMiddleware({ autoInject: true, injectOnMention: true });

// Initialize session store and create new session
const { SessionStore } = await import('../src/session/store');
const { createAutoSaveHook } = await import('../src/session/hook');
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
    // Ensure session directory is created
    await sessionStore.ensureSessionDir();
    // Create new session for this TUI run
    sessionStore.createNewSession();

    // Preload all skills for skill injection
    await skillMiddleware.preloadAll();

    const { SkillLoader } = await import('../src/skills/loader');
    const { toSkillCommand } = await import('../src/cli/tui/command-registry');
    const skillLoader = new SkillLoader();
    const skills = await skillLoader.loadAllSkills();
    const skillCommands = skills.map(toSkillCommand);

    // Wait for pending memory extractions to complete before exit
    process.on('beforeExit', async () => {
      await memoryMiddleware.awaitPendingExtractions();
      process.exit(0);
    });

    const { runTUIClient } = await import('../src/cli/index');
    runTUIClient(agent, skillCommands, sessionStore);
  } catch (error) {
    console.error('Failed to initialize TUI:', error);
    process.exit(1);
  }
})();
