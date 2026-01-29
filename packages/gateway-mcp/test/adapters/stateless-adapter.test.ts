
import type { Agent, OneShotAgentOutput } from '@vibe-agent-toolkit/agent-schema';
import { RESULT_SUCCESS } from '@vibe-agent-toolkit/agent-schema';
import { describe, expect, it } from 'vitest';

import { StatelessAdapter } from '../../src/adapters/stateless-adapter.js';
import { createConnectionId } from '../../src/types.js';

describe('StatelessAdapter', () => {
  const adapter = new StatelessAdapter();

  // Test constants
  const TEST_VALIDATOR_NAME = 'test-validator';
  const TEST_VERSION = '1.0.0';
  const TEST_VALIDATOR_DESC = 'Validates test input';
  const PURE_FUNCTION_ARCHETYPE = 'pure-function' as const;

  it('should create tool definition from agent manifest', () => {
    const mockAgent: Agent<{ text: string }, OneShotAgentOutput<{ valid: boolean }, string>> = {
      name: TEST_VALIDATOR_NAME,
      manifest: {
        name: TEST_VALIDATOR_NAME,
        version: TEST_VERSION,
        description: TEST_VALIDATOR_DESC,
        archetype: PURE_FUNCTION_ARCHETYPE,
      },
      execute: async () => ({ result: { status: RESULT_SUCCESS, data: { valid: true } } }),
    };

    const toolDef = adapter.createToolDefinition(mockAgent);

    expect(toolDef.name).toBe(TEST_VALIDATOR_NAME);
    expect(toolDef.description).toBe(TEST_VALIDATOR_DESC);
    expect(toolDef.inputSchema).toBeDefined();
  });

  it('should execute agent and return MCP result', async () => {
    const mockAgent: Agent<{ value: number }, OneShotAgentOutput<{ doubled: number }, string>> = {
      name: 'doubler',
      manifest: {
        name: 'doubler',
        version: TEST_VERSION,
        description: 'Doubles a number',
        archetype: PURE_FUNCTION_ARCHETYPE,
      },
      execute: async (input) => ({
        result: {
          status: RESULT_SUCCESS,
          data: { doubled: input.value * 2 },
        },
      }),
    };

    const connectionId = createConnectionId('test-conn-1');
    const result = await adapter.execute(mockAgent, { value: 5 }, connectionId);

    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toContain('10');
  });

  it('should handle agent errors', async () => {
    const mockAgent: Agent<{ value: string }, OneShotAgentOutput<never, 'invalid-input'>> = {
      name: 'validator',
      manifest: {
        name: 'validator',
        version: TEST_VERSION,
        description: 'Validates input',
        archetype: PURE_FUNCTION_ARCHETYPE,
      },
      execute: async () => ({
        result: {
          status: 'error' as const,
          error: 'invalid-input' as const,
        },
      }),
    };

    const connectionId = createConnectionId('test-conn-2');
    const result = await adapter.execute(mockAgent, { value: 'bad' }, connectionId);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('invalid-input');
  });
});
