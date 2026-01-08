import { describe, expect, it } from 'vitest';


import { AgentManifestSchema } from '../src/agent-manifest';

const ANTHROPIC_PROVIDER = 'anthropic';
const CLAUDE_MODEL = 'claude-sonnet-4.5';

describe('AgentManifestSchema', () => {
  it('should validate minimal agent manifest', () => {
    const data = {
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
});
