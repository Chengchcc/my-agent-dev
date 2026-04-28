import { debugLog } from '../utils/debug';
import type { LLMSettings } from '../config/types';
import type { Provider } from '../types';
import type { ThinkingDecoder } from './thinking/types';
import { ClaudeProvider } from './claude';
import { OpenAIProvider } from './openai';
import { AnthropicNativeDecoder } from './thinking/anthropic-native';
import { ReasoningContentDecoder } from './thinking/reasoning-content';

export { ClaudeProvider, OpenAIProvider };

function createThinkingDecoder(settings: LLMSettings): ThinkingDecoder | undefined {
  if (!settings.thinking?.enabled) return undefined;
  const decoderType = settings.thinking.decoder ?? 'anthropic';
  switch (decoderType) {
    case 'reasoning-content':
      return new ReasoningContentDecoder();
    case 'anthropic':
    default:
      return new AnthropicNativeDecoder();
  }
}

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
    const thinkingDecoder = createThinkingDecoder(settings);
    if (thinkingDecoder) {
      debugLog('  thinking: enabled, decoder:', settings.thinking?.decoder ?? 'anthropic');
    }
    const budgetTokens = settings.thinking?.budgetTokens ?? 8000;
    return new ClaudeProvider({
      apiKey: settings.apiKey!,
      model: settings.model,
      maxTokens: settings.maxTokens,
      temperature: settings.temperature,
      ...(settings.baseURL ? { baseURL: settings.baseURL } : {}),
      ...(thinkingDecoder ? { thinkingDecoder, thinkingBudgetTokens: budgetTokens } : {}),
    });
  } else if (settings.provider === 'openai') {
    if (!settings.apiKey && process.env.OPENAI_API_KEY) {
      settings.apiKey = process.env.OPENAI_API_KEY;
    }
    debugLog('Creating OpenAIProvider with:');
    debugLog('  apiKey length:', settings.apiKey?.length);
    debugLog('  baseURL:', settings.baseURL);
    debugLog('  model:', settings.model);
    const openaiConfig: {
      apiKey: string;
      model: string;
      maxTokens: number;
      temperature: number;
      baseURL?: string;
    } = {
      apiKey: settings.apiKey!,
      model: settings.model,
      maxTokens: settings.maxTokens,
      temperature: settings.temperature,
    };
    if (settings.baseURL) openaiConfig.baseURL = settings.baseURL;
    return new OpenAIProvider(openaiConfig);
  }
  throw new Error(`Invalid provider: ${settings.provider}`);
}
