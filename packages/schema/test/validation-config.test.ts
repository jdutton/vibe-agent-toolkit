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

  it('rejects an unknown severity code key', () => {
    const r = ValidationConfigSchema.safeParse({ severity: { LNIK_OUTSIDE_PROJECT: 'ignore' } });
    expect(r.success).toBe(false);
  });
  it("accepts 'info' as an override value", () => {
    const r = ValidationConfigSchema.safeParse({ severity: { SKILL_TIME_SENSITIVE_CONTENT: 'info' } });
    expect(r.success).toBe(true);
  });
});

describe('ValidationConfigSchema — thresholds', () => {
  it('parses a thresholds block with alwaysLoadedContextTokens', () => {
    const result = ValidationConfigSchema.safeParse({
      thresholds: { alwaysLoadedContextTokens: 12_000 },
    });
    expect(result.success).toBe(true);
  });

  it('parses a config with no thresholds key at all', () => {
    const result = ValidationConfigSchema.safeParse({ severity: {} });
    expect(result.success).toBe(true);
  });

  it('parses an empty thresholds block', () => {
    const result = ValidationConfigSchema.safeParse({ thresholds: {} });
    expect(result.success).toBe(true);
  });

  it.each([
    ['a non-integer', 12_000.5],
    ['zero', 0],
    ['a negative number', -1],
    ['a string', '12000'],
  ])('rejects %s alwaysLoadedContextTokens', (_label, value) => {
    const result = ValidationConfigSchema.safeParse({
      thresholds: { alwaysLoadedContextTokens: value },
    });
    expect(result.success).toBe(false);
  });

  it('is strict inside thresholds — rejects an unknown threshold key', () => {
    const result = ValidationConfigSchema.safeParse({
      thresholds: { alwaysLoadedContextTokens: 12_000, alwaysLoadedContextTokenz: 9 },
    });
    expect(result.success).toBe(false);
  });
});

// Proves the new code actually reached IssueCodeSchema: `severity` and `allow`
// are keyed by the registry enum, so a config naming a code the registry does not
// hold is rejected. If ALWAYS_LOADED_CONTEXT_BUDGET were missing from
// CODE_REGISTRY these two would fail exactly like the LNIK_ typo test above.
describe('ValidationConfigSchema — ALWAYS_LOADED_CONTEXT_BUDGET is an overridable code', () => {
  it('accepts a severity override for ALWAYS_LOADED_CONTEXT_BUDGET', () => {
    const result = ValidationConfigSchema.safeParse({
      severity: { ALWAYS_LOADED_CONTEXT_BUDGET: 'ignore' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts an allow entry keyed by ALWAYS_LOADED_CONTEXT_BUDGET', () => {
    const result = ValidationConfigSchema.safeParse({
      allow: {
        ALWAYS_LOADED_CONTEXT_BUDGET: [
          { paths: ['docs/**'], reason: 'docs tree is read by humans, not loaded as context' },
        ],
      },
    });
    expect(result.success).toBe(true);
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
