import type { Middleware } from '../types';
import type { AgentContext } from '../types';
import type { SessionStore } from './store';

/**
 * Create an afterAgentRun hook that auto-saves the current session
 * after every completed agent run.
 */
export function createAutoSaveHook(sessionStore: SessionStore): Middleware {
  return async (context: AgentContext, next: () => Promise<AgentContext>) => {
    // Just call next - we run after the agent completes
    const result = await next();

    // Auto-save if we have a current session
    const sessionId = sessionStore.getCurrentSessionId();
    if (sessionId) {
      try {
        await sessionStore.saveSession(sessionId, result.messages);
      } catch (error) {
        console.error('Failed to auto-save session:', error);
      }
    }

    return result;
  };
}
