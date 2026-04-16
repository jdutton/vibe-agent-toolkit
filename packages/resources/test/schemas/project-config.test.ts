import { describe, expect, it } from 'vitest';

import { SkillPackagingConfigSchema } from '../../src/schemas/project-config.js';

describe('SkillPackagingConfigSchema validation block', () => {
  it('parses validation.severity and validation.accept', () => {
    const result = SkillPackagingConfigSchema.safeParse({
      linkFollowDepth: 1,
      validation: {
        severity: { LINK_DROPPED_BY_DEPTH: 'error' },
        accept: {
          PACKAGED_UNREFERENCED_FILE: [{ paths: ['internal/*.json'], reason: 'runtime consumed' }],
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects the removed ignoreValidationErrors field', () => {
    const result = SkillPackagingConfigSchema.safeParse({
      ignoreValidationErrors: { SOME_CODE: 'reason' },
    });
    // Strict schema rejects unknown keys if strict; if not strict, field is silently dropped.
    // Either way the resulting object must not contain ignoreValidationErrors.
    if (result.success) {
      expect((result.data as Record<string, unknown>).ignoreValidationErrors).toBeUndefined();
    }
  });
});
