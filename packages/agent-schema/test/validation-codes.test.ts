import { describe, expect, it } from 'vitest';

import { CODE_REGISTRY, IssueCodeSchema, type IssueCode } from '../src/validation-codes.js';

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
      'ALLOW_EXPIRED',
      'ALLOW_UNUSED',
    ];
    for (const code of expected) {
      expect(CODE_REGISTRY[code], `registry missing ${code}`).toBeDefined();
      expect(CODE_REGISTRY[code].defaultSeverity).toMatch(/^(error|warning|info)$/);
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

  it('registers DUPLICATE_RESOURCE_ID as an error-severity overridable code', () => {
    expect(CODE_REGISTRY.DUPLICATE_RESOURCE_ID).toBeDefined();
    expect(CODE_REGISTRY.DUPLICATE_RESOURCE_ID.defaultSeverity).toBe('error');
    expect(CODE_REGISTRY.DUPLICATE_RESOURCE_ID.description.length).toBeGreaterThan(10);
    expect(CODE_REGISTRY.DUPLICATE_RESOURCE_ID.fix.length).toBeGreaterThan(10);
    expect(CODE_REGISTRY.DUPLICATE_RESOURCE_ID.reference).toBe('#duplicate_resource_id');
  });

  it('enforces warning defaults for best-practice and meta-codes', () => {
    for (const code of [
      'SKILL_LENGTH_EXCEEDS_RECOMMENDED',
      'SKILL_TOTAL_SIZE_LARGE',
      'SKILL_TOO_MANY_FILES',
      'REFERENCE_TOO_DEEP',
      'DESCRIPTION_TOO_VAGUE',
      'NO_PROGRESSIVE_DISCLOSURE',
      'ALLOW_EXPIRED',
      'ALLOW_UNUSED',
    ] as const) {
      expect(CODE_REGISTRY[code].defaultSeverity).toBe('warning');
    }
  });
});

describe('CODE_REGISTRY — capability and compat codes', () => {
  it('registers capability codes as info severity', () => {
    const codes = ['CAPABILITY_BROWSER_AUTH', 'CAPABILITY_LOCAL_SHELL', 'CAPABILITY_EXTERNAL_CLI'] as const;
    for (const code of codes) {
      expect(CODE_REGISTRY[code], `registry missing ${code}`).toBeDefined();
      expect(CODE_REGISTRY[code].defaultSeverity).toBe('info');
      expect(CODE_REGISTRY[code].description.length).toBeGreaterThan(10);
      expect(CODE_REGISTRY[code].fix.length).toBeGreaterThan(10);
      expect(CODE_REGISTRY[code].reference).toMatch(/^#capability_/);
    }
  });

  it('registers compat verdict codes with appropriate defaults', () => {
    expect(CODE_REGISTRY.COMPAT_TARGET_INCOMPATIBLE.defaultSeverity).toBe('warning');
    expect(CODE_REGISTRY.COMPAT_TARGET_NEEDS_REVIEW.defaultSeverity).toBe('warning');
    expect(CODE_REGISTRY.COMPAT_TARGET_UNDECLARED.defaultSeverity).toBe('info');
    for (const code of ['COMPAT_TARGET_INCOMPATIBLE', 'COMPAT_TARGET_NEEDS_REVIEW', 'COMPAT_TARGET_UNDECLARED'] as const) {
      expect(CODE_REGISTRY[code].reference).toMatch(/^#compat_target_/);
    }
  });
});

describe('CODE_REGISTRY — link-auth codes (#113 slice 2)', () => {
  it('registers all five LINK_AUTH_* codes', () => {
    const codes: IssueCode[] = [
      'LINK_AUTH_DEAD',
      'LINK_AUTH_DEAD_OR_UNAUTHORIZED',
      'LINK_AUTH_FORBIDDEN',
      'LINK_AUTH_UNAUTHORIZED',
      'LINK_AUTH_UNVERIFIED',
    ];
    for (const code of codes) {
      expect(CODE_REGISTRY[code], `registry missing ${code}`).toBeDefined();
      expect(CODE_REGISTRY[code].description.length).toBeGreaterThan(10);
      expect(CODE_REGISTRY[code].fix.length).toBeGreaterThan(10);
      expect(CODE_REGISTRY[code].reference).toMatch(/^#link_auth_/);
    }
  });

  it('enforces expected default severities per #113 §7', () => {
    // Only LINK_AUTH_DEAD is an error (honest-404 host like SharePoint —
    // 404 with valid auth is link rot). The four others default to warning;
    // strict CI lanes can promote LINK_AUTH_UNAUTHORIZED to error.
    expect(CODE_REGISTRY.LINK_AUTH_DEAD.defaultSeverity).toBe('error');
    expect(CODE_REGISTRY.LINK_AUTH_DEAD_OR_UNAUTHORIZED.defaultSeverity).toBe('warning');
    expect(CODE_REGISTRY.LINK_AUTH_FORBIDDEN.defaultSeverity).toBe('warning');
    expect(CODE_REGISTRY.LINK_AUTH_UNAUTHORIZED.defaultSeverity).toBe('warning');
    expect(CODE_REGISTRY.LINK_AUTH_UNVERIFIED.defaultSeverity).toBe('warning');
  });
});

describe('IssueCodeSchema', () => {
  it('IssueCodeSchema enumerates exactly the registry keys', () => {
    expect(new Set(IssueCodeSchema.options)).toEqual(new Set(Object.keys(CODE_REGISTRY)));
  });
});
