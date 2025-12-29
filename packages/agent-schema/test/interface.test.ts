import { describe, expect, it } from 'vitest';

import { AgentInterfaceSchema } from '../src/interface';

describe('AgentInterfaceSchema', () => {
  it('should validate interface with $ref', () => {
    const data = {
      input: {
        $ref: './schemas/input.schema.json',
      },
      output: {
        $ref: './schemas/output.schema.json',
      },
    };

    const result = AgentInterfaceSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('should allow interface with only input', () => {
    const data = {
      input: {
        $ref: './schemas/input.schema.json',
      },
    };

    const result = AgentInterfaceSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('should allow interface with only output', () => {
    const data = {
      output: {
        $ref: './schemas/output.schema.json',
      },
    };

    const result = AgentInterfaceSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('should allow empty interface (no I/O schemas)', () => {
    const data = {};

    const result = AgentInterfaceSchema.safeParse(data);
    expect(result.success).toBe(true);
  });
});
