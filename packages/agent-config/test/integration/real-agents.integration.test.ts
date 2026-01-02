import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadAgentManifest, validateAgent } from '../../src/index.js';

describe('Real agents integration', () => {
  const agentGeneratorPath = path.resolve(
    __dirname,
    '../../../vat-development-agents/agents/agent-generator'
  );

  it('should load agent-generator manifest', async () => {
    const manifest = await loadAgentManifest(agentGeneratorPath);

    expect(manifest.metadata.name).toBe('agent-generator');
    expect(manifest.metadata.version).toBeDefined();
    expect(manifest.spec.llm.provider).toBe('anthropic');
  });

  it('should validate agent-generator', async () => {
    const result = await validateAgent(agentGeneratorPath);

    // May have warnings about missing resources, but schema should be valid
    expect(result.manifest.name).toBe('agent-generator');
    expect(result.manifest.version).toBeDefined();
  });
});
