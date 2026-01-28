import { RESULT_SUCCESS } from '@vibe-agent-toolkit/agent-schema';
import type { Agent, OneShotAgentOutput } from '@vibe-agent-toolkit/agent-schema';

/**
 * Create a mock pure-function agent for testing
 */
export function createMockPureFunctionAgent(
  name: string,
  version = '1.0.0'
): Agent<{ value: string }, OneShotAgentOutput<{ result: boolean }, string>> {
  return {
    name,
    manifest: {
      name,
      version,
      description: 'Test agent',
      archetype: 'pure-function' as const,
    },
    execute: async () => ({ result: { status: RESULT_SUCCESS, data: { result: true } } }),
  };
}

/**
 * Create a generic mock agent for testing
 */
export function createMockAgent(
  name: string,
  version = '1.0.0',
  archetype: 'pure-function' | 'one-shot-llm-analyzer' | 'conversational' = 'pure-function'
): Agent<unknown, OneShotAgentOutput<unknown, string>> {
  return {
    name,
    manifest: {
      name,
      version,
      description: 'Test',
      archetype,
    },
    execute: async () => ({ result: { status: RESULT_SUCCESS, data: {} } }),
  };
}
