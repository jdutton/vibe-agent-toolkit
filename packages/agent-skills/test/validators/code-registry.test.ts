import { describe, expect, it } from 'vitest';

import { CODE_REGISTRY, type IssueCode } from '../../src/validators/code-registry.js';

describe('CODE_REGISTRY', () => {
  it('contains every overridable code with a default severity', () => {
    const expected: IssueCode[] = [
      'LINK_OUTSIDE_PROJECT',
      'LINK_TARGETS_DIRECTORY',
      'LINK_TO_NAVIGATION_FILE',
      'LINK_TO_GITIGNORED_FILE',
      'LINK_MISSING_TARGET',
      'LINK_TO_SKILL_DEFINITION',
      'LINK_DROPPED_BY_DEPTH',
      'PACKAGED_UNREFERENCED_FILE',
      'PACKAGED_BROKEN_LINK',
      'SKILL_LENGTH_EXCEEDS_RECOMMENDED',
      'SKILL_TOTAL_SIZE_LARGE',
      'SKILL_TOO_MANY_FILES',
      'REFERENCE_TOO_DEEP',
      'DESCRIPTION_TOO_VAGUE',
      'NO_PROGRESSIVE_DISCLOSURE',
      'ACCEPTANCE_EXPIRED',
      'ACCEPTANCE_UNUSED',
    ];
    for (const code of expected) {
      expect(CODE_REGISTRY[code], `registry missing ${code}`).toBeDefined();
      expect(CODE_REGISTRY[code].defaultSeverity).toMatch(/^(error|warning)$/);
      expect(CODE_REGISTRY[code].description.length).toBeGreaterThan(10);
      expect(CODE_REGISTRY[code].fix.length).toBeGreaterThan(10);
      expect(CODE_REGISTRY[code].reference).toMatch(/^#/);
    }
  });

  it('enforces expected defaults for link codes', () => {
    expect(CODE_REGISTRY.LINK_OUTSIDE_PROJECT.defaultSeverity).toBe('error');
    expect(CODE_REGISTRY.LINK_TARGETS_DIRECTORY.defaultSeverity).toBe('error');
    expect(CODE_REGISTRY.LINK_TO_NAVIGATION_FILE.defaultSeverity).toBe('warning');
    expect(CODE_REGISTRY.LINK_TO_GITIGNORED_FILE.defaultSeverity).toBe('error');
    expect(CODE_REGISTRY.LINK_MISSING_TARGET.defaultSeverity).toBe('error');
    expect(CODE_REGISTRY.LINK_TO_SKILL_DEFINITION.defaultSeverity).toBe('error');
    expect(CODE_REGISTRY.LINK_DROPPED_BY_DEPTH.defaultSeverity).toBe('warning');
  });

  it('enforces expected defaults for packaging-only codes', () => {
    expect(CODE_REGISTRY.PACKAGED_UNREFERENCED_FILE.defaultSeverity).toBe('error');
    expect(CODE_REGISTRY.PACKAGED_BROKEN_LINK.defaultSeverity).toBe('error');
  });

  it('enforces warning defaults for best-practice and meta-codes', () => {
    for (const code of [
      'SKILL_LENGTH_EXCEEDS_RECOMMENDED',
      'SKILL_TOTAL_SIZE_LARGE',
      'SKILL_TOO_MANY_FILES',
      'REFERENCE_TOO_DEEP',
      'DESCRIPTION_TOO_VAGUE',
      'NO_PROGRESSIVE_DISCLOSURE',
      'ACCEPTANCE_EXPIRED',
      'ACCEPTANCE_UNUSED',
    ] as const) {
      expect(CODE_REGISTRY[code].defaultSeverity).toBe('warning');
    }
  });
});
