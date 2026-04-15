import { describe, expect, it } from 'vitest';

import { SkillPackagingConfigSchema, SkillsConfigSchema } from '../../src/schemas/project-config.js';

describe('SkillPackagingConfigSchema publish field', () => {
  it('should accept publish: false', () => {
    const result = SkillPackagingConfigSchema.safeParse({ publish: false });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.publish).toBe(false);
    }
  });

  it('should accept publish: true', () => {
    const result = SkillPackagingConfigSchema.safeParse({ publish: true });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.publish).toBe(true);
    }
  });

  it('should default publish to undefined (treated as true by consumers)', () => {
    const result = SkillPackagingConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.publish).toBeUndefined();
    }
  });

  it('should reject non-boolean publish values', () => {
    const result = SkillPackagingConfigSchema.safeParse({ publish: 'false' });
    expect(result.success).toBe(false);
  });

  it('should work in full skills config context', () => {
    const result = SkillsConfigSchema.safeParse({
      include: ['skills/**/SKILL.md'],
      config: {
        'my-skill': { publish: false },
        'other-skill': { publish: true },
        'default-skill': {},
      },
    });
    expect(result.success).toBe(true);
  });
});
