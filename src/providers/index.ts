import { debugLog } from '../utils/debug';
import type { LLMSettings } from '../config/types';
import type { Provider } from '../types';
import { ClaudeProvider } from './claude';
import { OpenAIProvider } from './openai';

export { ClaudeProvider, OpenAIProvider };

/**
 * Create LLM provider from settings.
 * Shared by TUI and headless modes.
 */
export function createProviderFromSettings(settings: LLMSettings): Provider {
  if (settings.provider === 'claude') {
    if (!settings.apiKey) {
      if (process.env.ANTHROPIC_AUTH_TOKEN) {
        settings.apiKey = process.env.ANTHROPIC_AUTH_TOKEN;
      } else if (process.env.ANTHROPIC_API_KEY) {
        settings.apiKey = process.env.ANTHROPIC_API_KEY;
      }
    }
    debugLog('Creating ClaudeProvider with:');
    debugLog('  apiKey length:', settings.apiKey?.length);
    debugLog('  baseURL:', settings.baseURL);
    debugLog('  model:', settings.model);
    return new ClaudeProvider({
      apiKey: settings.apiKey!,
      baseURL: settings.baseURL ?? undefined,
      model: settings.model,
      maxTokens: settings.maxTokens,
      temperature: settings.temperature,
    });
  } else if (settings.provider === 'openai') {
    if (!settings.apiKey && process.env.OPENAI_API_KEY) {
      settings.apiKey = process.env.OPENAI_API_KEY;
    }
    debugLog('Creating OpenAIProvider with:');
    debugLog('  apiKey length:', settings.apiKey?.length);
    debugLog('  baseURL:', settings.baseURL);
    debugLog('  model:', settings.model);
    return new OpenAIProvider({
      apiKey: settings.apiKey!,
      baseURL: settings.baseURL ?? undefined,
      model: settings.model,
      maxTokens: settings.maxTokens,
      temperature: settings.temperature,
    });
  }
  throw new Error(`Invalid provider: ${(settings as any).provider}`);
}
