import { describe, expect, it } from 'vitest';

import { AllowEntrySchema, ValidationConfigSchema } from '../src/validation-config.js';

describe('ValidationConfigSchema', () => {
  it('parses a minimal severity-only config', () => {
    const result = ValidationConfigSchema.safeParse({ severity: { LINK_DROPPED_BY_DEPTH: 'error' } });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown severity value', () => {
    const result = ValidationConfigSchema.safeParse({ severity: { LINK_DROPPED_BY_DEPTH: 'fatal' } });
    expect(result.success).toBe(false);
  });

  it('requires reason on allow entries', () => {
    const result = ValidationConfigSchema.safeParse({
      allow: { LINK_DROPPED_BY_DEPTH: [{ paths: ['docs/**'] }] },
    });
    expect(result.success).toBe(false);
  });

  it('allows an entry with reason and optional expires', () => {
    const result = ValidationConfigSchema.safeParse({
      allow: {
        LINK_DROPPED_BY_DEPTH: [{ paths: ['docs/**'], reason: 'ok', expires: '2026-09-30' }],
      },
    });
    expect(result.success).toBe(true);
  });

  it('is strict — rejects unknown top-level fields', () => {
    const result = ValidationConfigSchema.safeParse({
      severity: {},
      extra: 'not allowed',
    });
    expect(result.success).toBe(false);
  });
});

describe('AllowEntrySchema', () => {
  it('defaults paths to ["**/*"] when omitted', () => {
    const result = AllowEntrySchema.safeParse({ reason: 'whole-skill concern' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.paths).toEqual(['**/*']);
    }
  });

  it('preserves explicit paths when provided', () => {
    const result = AllowEntrySchema.safeParse({ paths: ['docs/**'], reason: 'explicit scope' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.paths).toEqual(['docs/**']);
    }
  });
});
