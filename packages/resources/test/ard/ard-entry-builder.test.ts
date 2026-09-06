/**
 * Derivation rules for an emitted ARD entry.
 *
 * The subject here is *what VAT is willing to derive*, which is a narrower set
 * than what the ARD envelope can express. Two of the four surfaces derive NO
 * media type at all, and that refusal is the behaviour under test — a suite
 * that only checked the happy skill path would pass while VAT silently coined
 * a type the specification never mentions.
 */

import { describe, expect, it } from 'vitest';

import {
  ARD_SKILL_MEDIA_TYPE,
  ArdDerivationError,
  buildArdEntries,
  buildArdEntry,
  deriveArdMediaType,
  type ArdSurface,
} from '../../src/ard/index.js';

import { MINIMAL_ARD_CONFIG, MINIMAL_SKILL_SURFACE, URL_ARD_CONFIG } from './ard-test-helpers.js';

describe('deriveArdMediaType', () => {
  it('derives the coined skill media type for a skill surface', () => {
    expect(deriveArdMediaType('skill')).toBe(ARD_SKILL_MEDIA_TYPE);
    expect(ARD_SKILL_MEDIA_TYPE).toBe('application/ai-skill+md');
  });

  it.each(['marketplace', 'okf-bundle', 'mcp-server'] as const)(
    'derives NO media type for %s — the spec names none',
    (kind) => {
      expect(deriveArdMediaType(kind)).toBeUndefined();
    }
  );
});

describe('buildArdEntry — identifier', () => {
  it('builds a domain-anchored URN from publisher, namespace and name', () => {
    const entry = buildArdEntry(MINIMAL_SKILL_SURFACE, MINIMAL_ARD_CONFIG);
    expect(entry.identifier).toBe('urn:air:example.com:skills:vat-skill-authoring');
  });

  it('uses the configured namespace when one is supplied', () => {
    const entry = buildArdEntry(MINIMAL_SKILL_SURFACE, {
      ...MINIMAL_ARD_CONFIG,
      namespace: 'agent-skills',
    });
    expect(entry.identifier).toBe('urn:air:example.com:agent-skills:vat-skill-authoring');
  });

  it('defaults an OKF bundle to the "bundles" namespace', () => {
    const entry = buildArdEntry(
      { kind: 'okf-bundle', name: 'handbook', displayName: 'Handbook', data: {} },
      { ...MINIMAL_ARD_CONFIG, entries: { handbook: { type: 'application/x-vendor-bundle' } } }
    );
    expect(entry.identifier).toBe('urn:air:example.com:bundles:handbook');
  });

  it('refuses a surface name that cannot be a URN segment', () => {
    const surface: ArdSurface = { ...MINIMAL_SKILL_SURFACE, name: 'has/slash' };
    expect(() => buildArdEntry(surface, MINIMAL_ARD_CONFIG)).toThrow(ArdDerivationError);
  });
});

describe('buildArdEntry — type derivation and overrides', () => {
  it('refuses a marketplace surface with no explicit type override', () => {
    const surface: ArdSurface = {
      kind: 'marketplace',
      name: 'vat-marketplace',
      displayName: 'VAT Marketplace',
      data: {},
    };
    expect(() => buildArdEntry(surface, MINIMAL_ARD_CONFIG)).toThrow(ArdDerivationError);
    expect(() => buildArdEntry(surface, MINIMAL_ARD_CONFIG)).toThrow(/explicit .*type/i);
  });

  it('emits a marketplace surface when the author supplies a type', () => {
    const surface: ArdSurface = {
      kind: 'marketplace',
      name: 'vat-marketplace',
      displayName: 'VAT Marketplace',
      data: {},
    };
    const entry = buildArdEntry(surface, {
      ...MINIMAL_ARD_CONFIG,
      entries: { 'vat-marketplace': { type: 'application/x-vendor-catalog+json' } },
    });
    expect(entry.type).toBe('application/x-vendor-catalog+json');
  });

  it('lets an author override the derived skill type', () => {
    const entry = buildArdEntry(MINIMAL_SKILL_SURFACE, {
      ...MINIMAL_ARD_CONFIG,
      entries: { 'vat-skill-authoring': { type: 'text/markdown' } },
    });
    expect(entry.type).toBe('text/markdown');
  });
});

describe('buildArdEntry — url XOR data', () => {
  it('emits url and never data when a baseUrl and a urlPath are both present', () => {
    const entry = buildArdEntry(
      { ...MINIMAL_SKILL_SURFACE, urlPath: 'skills/vat-skill-authoring.md' },
      URL_ARD_CONFIG
    );
    expect(entry.url).toBe('https://example.com/catalog/skills/vat-skill-authoring.md');
    expect(entry).not.toHaveProperty('data');
  });

  it('tolerates redundant slashes between baseUrl and urlPath', () => {
    const entry = buildArdEntry(
      { ...MINIMAL_SKILL_SURFACE, urlPath: '/skills/a.md' },
      { ...URL_ARD_CONFIG, baseUrl: 'https://example.com/catalog/' }
    );
    expect(entry.url).toBe('https://example.com/catalog/skills/a.md');
  });

  it('falls back to inline data when no baseUrl is configured', () => {
    const entry = buildArdEntry(
      { ...MINIMAL_SKILL_SURFACE, urlPath: 'skills/a.md' },
      MINIMAL_ARD_CONFIG
    );
    expect(entry.data).toEqual({ note: 'inline artifact document' });
    expect(entry).not.toHaveProperty('url');
  });

  it('refuses a surface that yields neither a url nor inline data', () => {
    const surface: ArdSurface = {
      kind: 'skill',
      name: 'orphan',
      displayName: 'Orphan',
    };
    expect(() => buildArdEntry(surface, MINIMAL_ARD_CONFIG)).toThrow(ArdDerivationError);
  });
});

describe('buildArdEntry — authored fields', () => {
  it('never generates representativeQueries', () => {
    const entry = buildArdEntry(MINIMAL_SKILL_SURFACE, MINIMAL_ARD_CONFIG);
    expect(entry).not.toHaveProperty('representativeQueries');
  });

  it('carries authored representativeQueries and capabilities through verbatim', () => {
    const entry = buildArdEntry(MINIMAL_SKILL_SURFACE, {
      ...MINIMAL_ARD_CONFIG,
      entries: {
        'vat-skill-authoring': {
          representativeQueries: ['How do I write a SKILL.md?', 'What goes in frontmatter?'],
          capabilities: ['SkillAuthoring'],
        },
      },
    });
    expect(entry.representativeQueries).toEqual([
      'How do I write a SKILL.md?',
      'What goes in frontmatter?',
    ]);
    expect(entry.capabilities).toEqual(['SkillAuthoring']);
  });

  it('reads authored fields only from the entry override keyed by surface name', () => {
    const entry = buildArdEntry(MINIMAL_SKILL_SURFACE, {
      ...MINIMAL_ARD_CONFIG,
      entries: { 'some-other-skill': { capabilities: ['Wrong'] } },
    });
    expect(entry).not.toHaveProperty('capabilities');
  });

  it('carries derived description, tags, version and updatedAt', () => {
    const entry = buildArdEntry(
      {
        ...MINIMAL_SKILL_SURFACE,
        description: 'Authoring guidance',
        tags: ['skills', 'authoring'],
        version: '0.2.0',
        updatedAt: '2026-09-06T12:00:00Z',
      },
      MINIMAL_ARD_CONFIG
    );
    expect(entry.description).toBe('Authoring guidance');
    expect(entry.tags).toEqual(['skills', 'authoring']);
    expect(entry.version).toBe('0.2.0');
    expect(entry.updatedAt).toBe('2026-09-06T12:00:00Z');
  });
});

describe('buildArdEntry — trust manifest', () => {
  it('emits the member under the spec-prose spelling `trustManifest`', () => {
    const entry = buildArdEntry(MINIMAL_SKILL_SURFACE, {
      ...MINIMAL_ARD_CONFIG,
      trustManifest: { identity: 'https://example.com/workload', identityType: 'https' },
    });
    // 🚨 Upstream's JSON Schema declares this member as `TrustManifest`
    // (PascalCase) while the spec prose says `trustManifest` in all 11
    // occurrences. VAT follows the prose. See docs/external/ard/README.md.
    expect(Object.hasOwn(entry, 'trustManifest')).toBe(true);
    expect(Object.hasOwn(entry, 'TrustManifest')).toBe(false);
    expect(entry.trustManifest).toEqual({
      identity: 'https://example.com/workload',
      identityType: 'https',
    });
  });

  it('refuses an identity whose trust domain does not align with the publisher', () => {
    expect(() =>
      buildArdEntry(MINIMAL_SKILL_SURFACE, {
        ...MINIMAL_ARD_CONFIG,
        trustManifest: { identity: 'spiffe://other.example.org/workload' },
      })
    ).toThrow(ArdDerivationError);
  });

  it('accepts a hostless identity form (DID) without inventing an alignment check', () => {
    const entry = buildArdEntry(MINIMAL_SKILL_SURFACE, {
      ...MINIMAL_ARD_CONFIG,
      trustManifest: { identity: 'did:web:example.com' },
    });
    expect(entry.trustManifest?.identity).toBe('did:web:example.com');
  });
});

describe('buildArdEntries', () => {
  it('builds every surface in order', () => {
    const entries = buildArdEntries(
      [
        MINIMAL_SKILL_SURFACE,
        { ...MINIMAL_SKILL_SURFACE, name: 'vat-audit', displayName: 'VAT Audit' },
      ],
      MINIMAL_ARD_CONFIG
    );
    expect(entries.map((e) => e.identifier)).toEqual([
      'urn:air:example.com:skills:vat-skill-authoring',
      'urn:air:example.com:skills:vat-audit',
    ]);
  });
});
