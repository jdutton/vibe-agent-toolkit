import { describe, expect, it } from 'vitest';

import { AgentManifestSchema } from '../src/agent-manifest';

const ANTHROPIC_PROVIDER = 'anthropic';
const API_VERSION = 'vat.dev/v1';
const AGENT_KIND = 'Agent';
const CLAUDE_MODEL = 'claude-sonnet-4.5';

function createMinimalManifest(overrides?: Partial<{
  apiVersion: string;
  kind: string;
  metadata: { name: string };
  spec: { llm: { provider: string; model: string } };
}>): unknown {
  return {
    apiVersion: API_VERSION,
    kind: AGENT_KIND,
    metadata: { name: 'test' },
    spec: {
      llm: {
        provider: ANTHROPIC_PROVIDER,
        model: CLAUDE_MODEL,
      },
    },
    ...overrides,
  };
}

describe('AgentManifestSchema', () => {
  it('should validate minimal agent manifest', () => {
    const data = {
      apiVersion: API_VERSION,
      kind: AGENT_KIND,
      metadata: {
        name: 'test-agent',
      },
      spec: {
        llm: {
          provider: ANTHROPIC_PROVIDER,
          model: CLAUDE_MODEL,
        },
      },
    };

    const result = AgentManifestSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('should validate complete agent manifest', () => {
    const data = {
      apiVersion: API_VERSION,
      kind: AGENT_KIND,
      metadata: {
        name: 'test-agent',
        version: '1.0.0',
        description: 'A test agent',
      },
      spec: {
        interface: {
          input: { $ref: './schemas/input.schema.json' },
          output: { $ref: './schemas/output.schema.json' },
        },
        llm: {
          provider: ANTHROPIC_PROVIDER,
          model: CLAUDE_MODEL,
        },
        tools: [
          {
            name: 'web_search',
            type: 'mcp',
            server: 'brave-search',
          },
        ],
        resources: {
          docs: {
            path: './docs/**/*.md',
            type: 'documentation',
          },
        },
      },
    };

    const result = AgentManifestSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('should reject wrong apiVersion', () => {
    const data = createMinimalManifest({ apiVersion: 'vat.dev/v2' });

    const result = AgentManifestSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('should reject wrong kind', () => {
    const data = createMinimalManifest({ kind: 'Workflow' });

    const result = AgentManifestSchema.safeParse(data);
    expect(result.success).toBe(false);
  });
});
