import { describe, test, expect, vi } from 'bun:test';
import { Agent, ContextManager, ToolRegistry } from '../../src/agent';
import type { AgentConfig } from '../../src/types';

describe('Auto-trigger behavior (regression)', () => {
  /**
   * Documents the known issue: without explicit system prompt guidance,
   * LLM rarely calls sub_agent spontaneously.
   */
  test.skip('BUG: without system prompt guidance, complex file tasks do not trigger sub_agent', async () => {
    // This test requires a real LLM provider configured. Skip in unit test runs.
    // The expectation is that without guidance, LLM does NOT call sub_agent.
    // This is the documented bug that adding system prompt fixes.
  }, 60000); // 1 minute timeout for real API

  test.todo('with explicit system prompt guidance, complex file tasks trigger sub_agent', async () => {
    // This test requires real LLM provider. Marked as todo since requires real API key.
    // If you don't have a real provider configured, this is fine - just leave it as todo.
  }, 120000); // 2 minute timeout
});

describe('Todo coexistence', () => {
  test.todo('sub-agent execution does not trigger main agent todo reminders', async () => {
    // This test verifies that todo reminders are only triggered on the main agent,
    // not on sub-agent turns. Requires the full middleware stack configured.
    // Since todo middleware integration with sub-agent is not fully set up yet,
    // leave this as test.todo for now.
  });
});