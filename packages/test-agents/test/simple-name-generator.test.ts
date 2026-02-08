import { describe, expect, it } from 'vitest';

import { simpleNameGeneratorAgent } from '../src/llm-analyzer-agent.js';

describe('simpleNameGeneratorAgent', () => {
  it('should have correct manifest metadata', () => {
    expect(simpleNameGeneratorAgent.manifest.name).toBe('simple-name-generator');
    expect(simpleNameGeneratorAgent.manifest.description).toContain('name');
    expect(simpleNameGeneratorAgent.manifest.archetype).toBe('llm-analyzer');
  });

  it('should have execute function', () => {
    expect(typeof simpleNameGeneratorAgent.execute).toBe('function');
  });

  it('should have correct input/output schemas', () => {
    expect(simpleNameGeneratorAgent.manifest.inputSchema).toBeDefined();
    expect(simpleNameGeneratorAgent.manifest.outputSchema).toBeDefined();
  });
});
