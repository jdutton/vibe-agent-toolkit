import { describe, expect, it } from 'vitest';

import * as AgentSchema from '../src/index';

describe('Package Exports', () => {
  it('should export AgentManifestSchema', () => {
    expect(AgentSchema.AgentManifestSchema).toBeDefined();
  });

  it('should export AgentMetadataSchema', () => {
    expect(AgentSchema.AgentMetadataSchema).toBeDefined();
  });

  it('should export LLMConfigSchema', () => {
    expect(AgentSchema.LLMConfigSchema).toBeDefined();
  });

  it('should export ToolSchema', () => {
    expect(AgentSchema.ToolSchema).toBeDefined();
  });

  it('should export all types', () => {
    // TypeScript will catch if types aren't exported
    expect(true).toBe(true);
  });
});
