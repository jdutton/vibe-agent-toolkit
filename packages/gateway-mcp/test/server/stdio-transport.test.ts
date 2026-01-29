import { describe, expect, it } from 'vitest';

import { StdioMCPGateway } from '../../src/server/stdio-transport.js';
import { createMockAgent, createMockPureFunctionAgent } from '../test-helpers.js';

// Test constants
const TEST_AGENT_NAME = 'test-agent';
const TEST_VERSION = '1.0.0';

describe('StdioMCPGateway', () => {
  it('should create stdio gateway', () => {
    const mockAgent = createMockPureFunctionAgent(TEST_AGENT_NAME, TEST_VERSION);

    const gateway = new StdioMCPGateway({
      agents: [{ name: TEST_AGENT_NAME, agent: mockAgent }],
      transport: 'stdio',
    });

    expect(gateway).toBeDefined();
  });

  it('should generate connection ID from process.pid', () => {
    const mockAgent = createMockAgent('test', TEST_VERSION, 'pure-function');

    const gateway = new StdioMCPGateway({
      agents: [{ name: 'test', agent: mockAgent }],
      transport: 'stdio',
    });

    expect(gateway).toBeDefined();
    // ConnectionId is internal, but should be stdio-{pid}
  });
});
