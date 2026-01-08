import { describe, it, expect } from 'vitest';


import { AgentMetadataSchema } from '../src/metadata';

const TEST_AGENT_NAME = 'test-agent';

describe('AgentMetadataSchema', () => {
  it('should validate minimal metadata', () => {
    const data = {
      name: TEST_AGENT_NAME,
    };

    const result = AgentMetadataSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('should validate full metadata', () => {
    const data = {
      name: TEST_AGENT_NAME,
      version: '1.0.0',
      description: 'A test agent',
      author: 'Test Author',
      license: 'MIT',
      tags: ['test', 'example'],
      build: {
        timestamp: '2025-12-28T12:00:00Z',
        vatVersion: '0.1.0',
        commit: 'abc123',
      },
    };

    const result = AgentMetadataSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('should reject invalid name (with spaces)', () => {
    const data = {
      name: 'invalid name',
    };

    const result = AgentMetadataSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('should reject invalid version format', () => {
    const data = {
      name: TEST_AGENT_NAME,
      version: 'not-semver',
    };

    const result = AgentMetadataSchema.safeParse(data);
    expect(result.success).toBe(false);
  });
});
