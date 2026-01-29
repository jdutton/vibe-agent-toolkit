/**
 * Integration Test: End-to-End MCP Gateway
 *
 * Tests the complete flow from gateway creation through tool execution
 * using a real agent (haiku-validator) without starting the actual MCP server.
 */


import { createSuccess, RESULT_SUCCESS } from '@vibe-agent-toolkit/agent-schema';
import type { Agent, OneShotAgentOutput } from '@vibe-agent-toolkit/agent-schema';
import { haikuValidatorAgent } from '@vibe-agent-toolkit/vat-example-cat-agents';
import { describe, expect, it } from 'vitest';

import { NoOpObservabilityProvider } from '../../src/observability/no-op-provider.js';
import { MCPGateway } from '../../src/server/mcp-gateway.js';

const HAIKU_VALIDATOR_NAME = 'haiku-validator';
const TEST_AGENT_NAME = 'test-agent';

/**
 * Wraps a PureFunctionAgent to return OneShotAgentOutput envelope
 */
function wrapPureFunctionForGateway<TInput, TOutput>(
  pureFunctionAgent: typeof haikuValidatorAgent
): Agent<TInput, OneShotAgentOutput<TOutput, string>> {
  return {
    name: pureFunctionAgent.name,
    manifest: pureFunctionAgent.manifest,
    execute: async (input: TInput) => {
      const data = pureFunctionAgent.execute(input as Parameters<typeof pureFunctionAgent.execute>[0]);
      return {
        result: createSuccess(data as TOutput),
      };
    },
  };
}

describe('End-to-End Integration', () => {
  it('should create gateway with real agent', () => {
    const gateway = new MCPGateway({
      agents: [
        {
          name: HAIKU_VALIDATOR_NAME,
          agent: wrapPureFunctionForGateway(haikuValidatorAgent),
        },
      ],
      transport: 'stdio',
      observability: new NoOpObservabilityProvider(),
    });

    expect(gateway).toBeDefined();
  });

  it('should generate tool definitions from agent', () => {
    const gateway = new MCPGateway({
      agents: [
        {
          name: HAIKU_VALIDATOR_NAME,
          agent: wrapPureFunctionForGateway(haikuValidatorAgent),
        },
      ],
      transport: 'stdio',
      observability: new NoOpObservabilityProvider(),
    });

    const tools = gateway.getToolDefinitions();

    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      name: HAIKU_VALIDATOR_NAME,
      description: expect.stringContaining('haiku'),
      inputSchema: expect.objectContaining({
        type: 'object',
        properties: expect.any(Object),
      }),
    });
  });

  it('should execute agent directly (without MCP server)', async () => {
    // Create gateway with real agent
    const gateway = new MCPGateway({
      agents: [
        {
          name: HAIKU_VALIDATOR_NAME,
          agent: wrapPureFunctionForGateway(haikuValidatorAgent),
        },
      ],
      transport: 'stdio',
      observability: new NoOpObservabilityProvider(),
    });

    // Verify agent is registered
    const tools = gateway.getToolDefinitions();
    expect(tools).toHaveLength(1);

    // Execute agent directly (not through MCP protocol)
    const wrappedAgent = wrapPureFunctionForGateway(haikuValidatorAgent);
    const result = await wrappedAgent.execute({
      line1: 'An old silent pond',
      line2: 'A frog jumps into the pond',
      line3: 'Splash! Silence again',
    });

    // Verify agent execution result
    expect(result.result.status).toBe(RESULT_SUCCESS);
    expect(result.result.data).toMatchObject({
      valid: true,
      syllables: {
        line1: 5,
        line2: 7, // Actually 7 syllables (A-frog-jumps-in-to-the-pond)
        line3: 5,
      },
    });
  });

  it('should validate agent input schemas via tool definitions', () => {
    const gateway = new MCPGateway({
      agents: [
        {
          name: HAIKU_VALIDATOR_NAME,
          agent: wrapPureFunctionForGateway(haikuValidatorAgent),
        },
      ],
      transport: 'stdio',
      observability: new NoOpObservabilityProvider(),
    });

    // Get tool definition
    const tools = gateway.getToolDefinitions();
    const haikuTool = tools.find((t) => t.name === HAIKU_VALIDATOR_NAME);

    expect(haikuTool).toBeDefined();
    expect(haikuTool?.inputSchema).toMatchObject({
      type: 'object',
      // Properties field may be empty or populated based on schema generation
      // The key is that the tool has a valid JSON Schema structure
    });
    expect(haikuTool?.inputSchema.type).toBe('object');
  });

  it('should support multiple agents in single gateway', () => {
    // Create a second mock agent
    const mockAgent: Agent<{ value: string }, OneShotAgentOutput<{ result: boolean }, string>> = {
      name: TEST_AGENT_NAME,
      manifest: {
        name: TEST_AGENT_NAME,
        version: '1.0.0',
        description: 'Test agent',
        archetype: 'pure-function',
      },
      execute: async () => ({
        result: { status: RESULT_SUCCESS, data: { result: true } },
      }),
    };

    const gateway = new MCPGateway({
      agents: [
        {
          name: HAIKU_VALIDATOR_NAME,
          agent: wrapPureFunctionForGateway(haikuValidatorAgent),
        },
        {
          name: TEST_AGENT_NAME,
          agent: mockAgent,
        },
      ],
      transport: 'stdio',
      observability: new NoOpObservabilityProvider(),
    });

    // Verify both agents are registered
    const tools = gateway.getToolDefinitions();
    expect(tools).toHaveLength(2);

    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain(HAIKU_VALIDATOR_NAME);
    expect(toolNames).toContain(TEST_AGENT_NAME);

    // Verify each tool has proper definition structure
    for (const tool of tools) {
      expect(tool).toMatchObject({
        name: expect.any(String),
        description: expect.any(String),
        inputSchema: expect.objectContaining({
          type: 'object',
        }),
      });
    }
  });
});
