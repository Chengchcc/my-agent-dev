import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import yaml from 'js-yaml';
import { settingsSchema } from './schema';
import { defaultSettings } from './defaults';
import type { Settings } from './types';

/**
 * Expand ~ to user home directory in paths
 */
export function expandTilde(filePath: string): string {
  if (filePath.startsWith('~')) {
    return path.join(os.homedir(), filePath.slice(1));
  }
  return filePath;
}

/**
 * Deep merge two configuration objects: user config overrides defaults
 */
export function mergeConfigs(defaults: Settings, user: Partial<Settings>): Settings {
  const result: Settings = { ...defaults };

  if (user.llm) {
    result.llm = { ...defaults.llm, ...user.llm };
  }
  if (user.context) {
    result.context = { ...defaults.context, ...user.context };
  }
  if (user.memory) {
    result.memory = { ...defaults.memory, ...user.memory };
  }
  if (user.skills) {
    result.skills = { ...defaults.skills, ...user.skills };
  }
  if (user.tui) {
    result.tui = {
      history: { ...defaults.tui.history, ...user.tui.history },
      sessions: { ...defaults.tui.sessions, ...user.tui.sessions },
    };
  }
  if (user.subAgent) {
    result.subAgent = { ...defaults.subAgent, ...user.subAgent };
  }
  if (user.security) {
    result.security = {
      allowedRoots: user.security.allowedRoots ?? defaults.security.allowedRoots,
    };
  }
  if (user.debug) {
    result.debug = { ...defaults.debug, ...user.debug };
  }

  return result;
}

/**
 * Load and parse a single YAML config file
 */
async function loadConfigFile(filePath: string): Promise<Partial<Settings> | null> {
  try {
    await fs.access(filePath);
    const content = await fs.readFile(filePath, 'utf8');
    const parsed = yaml.load(content) as Partial<Settings>;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Find config files in order of priority:
 * 1. ./settings.yml (project-level)
 * 2. ~/.my-agent/settings.yml (user-level)
 */
function getConfigPaths(): string[] {
  const projectConfig = path.join(process.cwd(), 'settings.yml');
  const userConfig = path.join(os.homedir(), '.my-agent', 'settings.yml');
  return [projectConfig, userConfig];
}

/**
 * Expand all tilde paths in the final config
 */
function expandAllPaths(settings: Settings): Settings {
  settings.memory.globalBaseDir = expandTilde(settings.memory.globalBaseDir);
  settings.tui.history.filePath = expandTilde(settings.tui.history.filePath);
  settings.tui.sessions.dir = expandTilde(settings.tui.sessions.dir);
  settings.subAgent.worktreeRootDir = expandTilde(settings.subAgent.worktreeRootDir);
  settings.security.allowedRoots = settings.security.allowedRoots.map(
    root => expandTilde(root)
  );
  // Resolve allowed roots to absolute paths
  settings.security.allowedRoots = settings.security.allowedRoots.map(
    root => path.resolve(root)
  );
  return settings;
}

/**
 * Apply environment variable overrides
 */
function applyEnvOverrides(settings: Settings): Settings {
  // MODEL env var overrides model
  if (process.env.MODEL) {
    settings.llm.model = process.env.MODEL;
  }

  // API keys from environment
  if (settings.llm.provider === 'claude' && process.env.ANTHROPIC_API_KEY) {
    settings.llm.apiKey = process.env.ANTHROPIC_API_KEY;
  }
  if (settings.llm.provider === 'openai' && process.env.OPENAI_API_KEY) {
    settings.llm.apiKey = process.env.OPENAI_API_KEY;
  }

  // Base URLs from environment
  if (process.env.ANTHROPIC_BASE_URL) {
    settings.llm.baseURL = process.env.ANTHROPIC_BASE_URL;
  }
  if (process.env.OPENAI_BASE_URL) {
    settings.llm.baseURL = process.env.OPENAI_BASE_URL;
  }

  // Debug from command line (--debug) is handled earlier, but env can also set it
  if (process.env.DEBUG === 'true' || process.env.DEBUG === '1') {
    settings.debug.enabled = true;
  }

  return settings;
}

/**
 * Load the complete configuration with all layers and validation
 */
export async function loadSettings(): Promise<Settings> {
  let current: Partial<Settings> = {};
  const configPaths = getConfigPaths();

  // Load and merge from highest priority (project) to lowest (user)
  for (const configPath of configPaths) {
    const loaded = await loadConfigFile(configPath);
    if (loaded) {
      current = mergeConfigs(current, loaded);
    }
  }

  // Merge with defaults
  let settings = mergeConfigs(defaultSettings, current);

  // Expand ~ in paths
  settings = expandAllPaths(settings);

  // Apply environment variable overrides (highest priority)
  settings = applyEnvOverrides(settings);

  // Validate with Zod
  const result = settingsSchema.safeParse(settings);
  if (!result.success) {
    throw new Error(`Configuration validation failed: ${result.error.message}`);
  }

  return result.data;
}
