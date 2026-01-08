import { describe, expect, it } from 'vitest';


import { ResourceRegistrySchema } from '../src/resource-registry';

describe('ResourceRegistrySchema', () => {
  it('should validate named resources', () => {
    const data = {
      prompts: {
        system: {
          path: './prompts/system.md',
          type: 'prompt',
        },
      },
      schemas: {
        input: {
          path: './schemas/input.schema.json',
          type: 'schema',
        },
      },
    };

    const result = ResourceRegistrySchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('should validate path-based resources', () => {
    const data = {
      docs: {
        path: './docs/**/*.md',
        type: 'documentation',
        fragment: true,
      },
    };

    const result = ResourceRegistrySchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('should allow empty registry', () => {
    const data = {};

    const result = ResourceRegistrySchema.safeParse(data);
    expect(result.success).toBe(true);
  });
});
