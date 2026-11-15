import { describe, expect, it } from 'vitest';

import {
  VatPackageMetadataSchema,
  VatSkillMetadataSchema,
} from '../src/package-metadata.js';

// Test constants to avoid string duplication
const TEST_SKILL_NAME = 'my-skill';
const TEST_NAMESPACED_SKILL = 'vibe-agent-toolkit:vat-audit';
const VAT_VERSION = '1.0';

describe('VatSkillMetadataSchema', () => {
  it('should validate valid skill name string', () => {
    const result = VatSkillMetadataSchema.safeParse(TEST_SKILL_NAME);
    expect(result.success).toBe(true);
  });

  it('should validate namespaced skill name', () => {
    const result = VatSkillMetadataSchema.safeParse(TEST_NAMESPACED_SKILL);
    expect(result.success).toBe(true);
  });

  it('should reject non-string input', () => {
    const result = VatSkillMetadataSchema.safeParse({ name: TEST_SKILL_NAME });
    expect(result.success).toBe(false);
  });

  it('should reject empty skill name', () => {
    const result = VatSkillMetadataSchema.safeParse('');
    expect(result.success).toBe(false);
  });

  it('should reject skill name with invalid characters', () => {
    const result = VatSkillMetadataSchema.safeParse('My Skill');
    expect(result.success).toBe(false);
  });

  it('should reject skill name exceeding max length', () => {
    const longName = 'a-' + 'b'.repeat(63);
    const result = VatSkillMetadataSchema.safeParse(longName);
    expect(result.success).toBe(false);
  });
});

describe('VatPackageMetadataSchema', () => {
  it('should validate skills-only metadata', () => {
    const result = VatPackageMetadataSchema.safeParse({
      version: VAT_VERSION,
      skills: [TEST_SKILL_NAME, TEST_NAMESPACED_SKILL],
    });
    expect(result.success).toBe(true);
  });

  it('should tolerate the deprecated type field', () => {
    const result = VatPackageMetadataSchema.safeParse({
      version: VAT_VERSION,
      type: 'skill' as const,
      skills: [TEST_SKILL_NAME],
    });
    expect(result.success).toBe(true);
  });

  it('should pass through keys it does not declare instead of refusing them', () => {
    // An adopter's existing package.json `vat` block may still carry keys the schema
    // no longer models (`agents`, `pureFunctions`, `runtimes`); they must not refuse.
    const legacy = {
      version: VAT_VERSION,
      skills: [TEST_SKILL_NAME],
      agents: [{ name: 'legacy', path: './agents/legacy' }],
      pureFunctions: [],
      runtimes: ['some-runtime'],
    };

    const result = VatPackageMetadataSchema.safeParse(legacy);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({ agents: legacy.agents, runtimes: legacy.runtimes });
    }
  });

  it('should validate replaces', () => {
    const result = VatPackageMetadataSchema.safeParse({
      version: VAT_VERSION,
      replaces: { plugins: ['old-plugin'], flatSkills: ['old-skill'] },
    });
    expect(result.success).toBe(true);
  });

  it('should reject an unknown key inside replaces', () => {
    const result = VatPackageMetadataSchema.safeParse({
      version: VAT_VERSION,
      replaces: { agents: ['x'] },
    });
    expect(result.success).toBe(false);
  });

  it('should reject metadata with invalid version format', () => {
    const result = VatPackageMetadataSchema.safeParse({ version: '1.0.0' });
    expect(result.success).toBe(false);
  });

  it('should reject metadata with invalid type', () => {
    const result = VatPackageMetadataSchema.safeParse({ version: VAT_VERSION, type: 'invalid-type' });
    expect(result.success).toBe(false);
  });

  it('should reject metadata missing version', () => {
    const result = VatPackageMetadataSchema.safeParse({ skills: [] });
    expect(result.success).toBe(false);
  });

  it('should reject an invalid skill name in skills', () => {
    const result = VatPackageMetadataSchema.safeParse({ version: VAT_VERSION, skills: ['My Skill'] });
    expect(result.success).toBe(false);
  });
});
