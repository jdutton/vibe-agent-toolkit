import { describe, expect, it } from 'vitest';

import type { AgentRegistration, ConnectionId, GatewayConfig } from '../src/types.js';

describe('Type Definitions', () => {
  const TEST_AGENT_NAME = 'test-agent';

  it('should allow valid AgentRegistration', () => {
    const mockAgent = {
      name: TEST_AGENT_NAME,
      manifest: {
        name: TEST_AGENT_NAME,
        version: '1.0.0',
        description: 'Test',
        archetype: 'pure-function' as const,
      },
      execute: async () => ({ result: { status: 'success' as const, data: {} } }),
    };

    const registration: AgentRegistration = {
      name: TEST_AGENT_NAME,
      agent: mockAgent,
    };

    expect(registration.name).toBe(TEST_AGENT_NAME);
  });

  it('should brand ConnectionId as distinct type', () => {
    const id = 'stdio-12345' as ConnectionId;
    expect(typeof id).toBe('string');
  });

  it('should allow valid GatewayConfig', () => {
    const config: GatewayConfig = {
      agents: [],
      transport: 'stdio',
    };

    expect(config.transport).toBe('stdio');
  });
});
