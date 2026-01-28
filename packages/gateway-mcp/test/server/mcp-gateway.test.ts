import { describe, expect, it } from 'vitest';

import { MCPGateway } from '../../src/server/mcp-gateway.js';
import { createMockAgent, createMockPureFunctionAgent } from '../test-helpers.js';

// Test constants
const TEST_AGENT_NAME = 'test-agent';
const TEST_VERSION = '1.0.0';

describe('MCPGateway', () => {
  it('should register agents', () => {
    const mockAgent = createMockPureFunctionAgent(TEST_AGENT_NAME, TEST_VERSION);

    const gateway = new MCPGateway({
      agents: [{ name: TEST_AGENT_NAME, agent: mockAgent }],
      transport: 'stdio',
    });

    expect(gateway).toBeDefined();
    // Internal tools map not exposed, but constructor should not throw
  });

  it('should auto-detect archetype from manifest', () => {
    const pureFunctionAgent = createMockAgent('pure-agent', TEST_VERSION, 'pure-function');
    const oneShotAgent = createMockAgent('oneshot-agent', TEST_VERSION, 'one-shot-llm-analyzer');

    const gateway = new MCPGateway({
      agents: [
        { name: 'pure-agent', agent: pureFunctionAgent },
        { name: 'oneshot-agent', agent: oneShotAgent },
      ],
      transport: 'stdio',
    });

    expect(gateway).toBeDefined();
  });

  it('should throw on unsupported archetype', () => {
    const unsupportedAgent = createMockAgent('unsupported', TEST_VERSION, 'conversational');

    expect(() =>
      new MCPGateway({
        agents: [{ name: 'unsupported', agent: unsupportedAgent }],
        transport: 'stdio',
      })
    ).toThrow('Unsupported archetype: conversational');
  });
});
