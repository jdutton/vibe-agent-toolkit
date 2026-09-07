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
  findShadowedArdOverrideKeys,
  type ArdSurface,
} from '../../src/ard/index.js';

import { MINIMAL_ARD_CONFIG, MINIMAL_SKILL_SURFACE, URL_ARD_CONFIG } from './ard-test-helpers.js';

/** Surface kind whose media type the spec names none for, used in several cases. */
const OKF_BUNDLE_KIND = 'okf-bundle';

/** The two author-supplied media types the override cases hand in. */
const OKF_BUNDLE_TYPE = 'application/okf-bundle';
const VENDOR_CATALOG_TYPE = 'application/x-vendor-catalog+json';

/** A name that deliberately occurs in two independent config key spaces. */
const AMBIGUOUS_NAME = 'knowledge';

/** The relative path the url-resolution cases append to a base. */
const EXPENSES_PATH = 'skills/expenses';

describe('deriveArdMediaType', () => {
  it('derives the coined skill media type for a skill surface', () => {
    expect(deriveArdMediaType('skill')).toBe(ARD_SKILL_MEDIA_TYPE);
    expect(ARD_SKILL_MEDIA_TYPE).toBe('application/ai-skill+md');
  });

  it.each(['marketplace', OKF_BUNDLE_KIND, 'mcp-server'] as const)(
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
      { kind: OKF_BUNDLE_KIND, name: 'handbook', displayName: 'Handbook', data: {} },
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
      entries: { 'vat-marketplace': { type: VENDOR_CATALOG_TYPE } },
    });
    expect(entry.type).toBe(VENDOR_CATALOG_TYPE);
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

/** The two identity forms several trust-manifest cases hand in. */
const HTTPS_IDENTITY = 'https://example.com/workload';
const DID_IDENTITY = 'did:web:example.com';

describe('buildArdEntry — trust manifest', () => {
  it('emits the member under the spec-prose spelling `trustManifest`', () => {
    const entry = buildArdEntry(MINIMAL_SKILL_SURFACE, {
      ...MINIMAL_ARD_CONFIG,
      trustManifest: { identity: HTTPS_IDENTITY, identityType: 'https' },
    });
    // 🚨 Upstream's JSON Schema declares this member as `TrustManifest`
    // (PascalCase) while the spec prose says `trustManifest` in all 11
    // occurrences. VAT follows the prose. See docs/external/ard/README.md.
    expect(Object.hasOwn(entry, 'trustManifest')).toBe(true);
    expect(Object.hasOwn(entry, 'TrustManifest')).toBe(false);
    expect(entry.trustManifest).toEqual({ identity: HTTPS_IDENTITY, identityType: 'https' });
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
      trustManifest: { identity: DID_IDENTITY },
    });
    expect(entry.trustManifest?.identity).toBe(DID_IDENTITY);
  });

  // 🚨 The DID carve-out was written as "no `://`, no authority to check", and
  // a bare domain has no `://` either. `identity: attacker.com` therefore
  // reached the manifest with the ONE binding ARD mandates never applied, at
  // exit 0 — while the config schema's own description promises "SPIFFE ID,
  // DID, or HTTPS FQDN URI", and a bare domain is none of the three.
  //
  // The property is *scheme*, not *domain*: `example.com` — the publisher's own
  // host, spelled without a scheme — is refused for exactly the same reason, so
  // nobody can satisfy this suite by string-matching a hostile-looking name.
  it.each([
    'example.com',
    'attacker.com',
    'sub.example.com',
    'example.com/workload',
    '//example.com/workload',
  ])('refuses the scheme-less identity %s, which no binding check can read', (identity) => {
    expect(() =>
      buildArdEntry(MINIMAL_SKILL_SURFACE, { ...MINIMAL_ARD_CONFIG, trustManifest: { identity } })
    ).toThrow(ArdDerivationError);
  });

  // The other side of the same rule: every form the schema's description names
  // still passes, so the refusal above cannot have been bought by refusing
  // everything.
  it.each([HTTPS_IDENTITY, 'spiffe://example.com/workload', DID_IDENTITY])(
    'still emits %s, which carries a scheme',
    (identity) => {
      const entry = buildArdEntry(MINIMAL_SKILL_SURFACE, {
        ...MINIMAL_ARD_CONFIG,
        trustManifest: { identity },
      });
      expect(entry.trustManifest?.identity).toBe(identity);
    }
  );
});

describe('buildArdEntry — override key spaces', () => {
  // 🚨 `skills.config`, `claude.marketplaces` and `okf.bundles` are three
  // INDEPENDENT key spaces. Nothing stops the same name appearing in two of
  // them, so a bare `ard.entries.<name>` key cannot say which surface it means.
  // Driving the built CLI on a config carrying `skills.config.knowledge`,
  // `okf.bundles.knowledge` and `ard.entries.knowledge.type:
  // application/okf-bundle` emitted the SKILL typed `application/okf-bundle` —
  // it silently lost its coined `application/ai-skill+md` — at exit 0.
  const BUNDLE_SURFACE: ArdSurface = {
    kind: OKF_BUNDLE_KIND,
    name: AMBIGUOUS_NAME,
    displayName: AMBIGUOUS_NAME,
    data: {},
  };
  const SKILL_SURFACE: ArdSurface = {
    kind: 'skill',
    name: AMBIGUOUS_NAME,
    displayName: AMBIGUOUS_NAME,
    data: {},
  };

  it('reads an override qualified by kind', () => {
    const entry = buildArdEntry(BUNDLE_SURFACE, {
      ...MINIMAL_ARD_CONFIG,
      entries: { 'okf-bundle:knowledge': { type: OKF_BUNDLE_TYPE } },
    });
    expect(entry.type).toBe(OKF_BUNDLE_TYPE);
  });

  it('never lets a kind-qualified override reach a same-named surface of another kind', () => {
    const entry = buildArdEntry(SKILL_SURFACE, {
      ...MINIMAL_ARD_CONFIG,
      entries: {
        'okf-bundle:knowledge': {
          type: OKF_BUNDLE_TYPE,
          capabilities: ['BundleOnly'],
        },
      },
    });
    expect(entry.type).toBe(ARD_SKILL_MEDIA_TYPE);
    expect(entry).not.toHaveProperty('capabilities');
  });

  it('refuses a bare override key that matches surfaces of more than one kind', () => {
    const build = (): unknown =>
      buildArdEntries([SKILL_SURFACE, BUNDLE_SURFACE], {
        ...MINIMAL_ARD_CONFIG,
        entries: { knowledge: { type: OKF_BUNDLE_TYPE } },
      });
    expect(build).toThrow(ArdDerivationError);
    expect(build).toThrow(/ard\.entries\.knowledge/);
    expect(build).toThrow(/skill:knowledge/);
    expect(build).toThrow(/okf-bundle:knowledge/);
  });

  it('still honours a bare key when only one kind carries that name', () => {
    const entry = buildArdEntry(SKILL_SURFACE, {
      ...MINIMAL_ARD_CONFIG,
      entries: { knowledge: { capabilities: ['Knowledge'] } },
    });
    expect(entry.capabilities).toEqual(['Knowledge']);
  });
});

describe('buildArdEntries — identifier uniqueness', () => {
  // 🚨 `identifier` is ARD's "globally unique discovery handle", but JSON
  // Schema cannot express array-element uniqueness, so the vendored-schema
  // oracle passes a manifest carrying the same identifier twice. A skill named
  // `main` plus a marketplace named `main` under a single global
  // `ard.namespace` emitted TWO byte-identical entries at exit 0.
  it('refuses two surfaces that collapse to one identifier, naming both', () => {
    const build = (): unknown =>
      buildArdEntries(
        [
          { kind: 'skill', name: 'main', displayName: 'main', data: {} },
          { kind: 'marketplace', name: 'main', displayName: 'main', data: {} },
        ],
        {
          ...MINIMAL_ARD_CONFIG,
          namespace: 'things',
          entries: { 'marketplace:main': { type: VENDOR_CATALOG_TYPE } },
        }
      );
    expect(build).toThrow(ArdDerivationError);
    expect(build).toThrow(/urn:air:example\.com:things:main/);
    expect(build).toThrow(/skill/);
    expect(build).toThrow(/marketplace/);
  });

  it('leaves distinct identifiers alone', () => {
    const entries = buildArdEntries(
      [
        { kind: 'skill', name: 'main', displayName: 'main', data: {} },
        { kind: 'skill', name: 'other', displayName: 'other', data: {} },
      ],
      MINIMAL_ARD_CONFIG
    );
    expect(entries).toHaveLength(2);
  });
});

describe('buildArdEntry — url is RESOLVED, not concatenated', () => {
  // 🚨 String concatenation put the entry path inside the base's fragment:
  // `https://example.com/base?tenant=acme#frag` + `/skills/expenses` resolves
  // to `https://example.com/base` for EVERY entry, and `format: uri` accepts
  // it. `mailto:ops@example.com` — which `z.string().url()` admits — produced
  // `mailto:ops@example.com/skills/expenses`, which addresses nothing.
  it('refuses a baseUrl carrying a query or a fragment', () => {
    for (const baseUrl of [
      'https://example.com/base?tenant=acme',
      'https://example.com/base#frag',
      'https://example.com/base?tenant=acme#frag',
    ]) {
      expect(() =>
        buildArdEntry(
          { ...MINIMAL_SKILL_SURFACE, urlPath: EXPENSES_PATH },
          { ...MINIMAL_ARD_CONFIG, baseUrl }
        )
      ).toThrow(ArdDerivationError);
    }
  });

  it('refuses a non-http(s) baseUrl', () => {
    expect(() =>
      buildArdEntry(
        { ...MINIMAL_SKILL_SURFACE, urlPath: EXPENSES_PATH },
        { ...MINIMAL_ARD_CONFIG, baseUrl: 'mailto:ops@example.com' }
      )
    ).toThrow(ArdDerivationError);
  });

  it('leaves the RULED path-doubling case exactly as it was', () => {
    // ⛔ Not a defect: `baseUrl: https://example.com/skills` plus the
    // namespace-mirroring `skills/<name>` path is a config error the project
    // has ruled it will not paper over. Pinned so a URL-resolution rewrite
    // cannot quietly turn it into a different answer.
    const entry = buildArdEntry(
      { ...MINIMAL_SKILL_SURFACE, urlPath: EXPENSES_PATH },
      { ...MINIMAL_ARD_CONFIG, baseUrl: 'https://example.com/skills' }
    );
    expect(entry.url).toBe('https://example.com/skills/skills/expenses');
  });
});

describe('buildArdEntry — a URN segment is never a DOT segment', () => {
  // 🚨 `ARD_NAME_SEGMENT_PATTERN` is a charset, and a charset admits `.` and
  // `..`. Dot-segment collapsing is `new URL`'s defining behaviour, so
  // `namespace: ".."` against `baseUrl: https://example.com/tenants/acme/catalog`
  // emitted `https://example.com/tenants/acme/alpha` at exit 0 — an address that
  // is plausibly wrong rather than legibly wrong, one segment above where the
  // identifier says the resource lives. A skill NAMED `.` resolved to the
  // namespace DIRECTORY rather than to the skill.
  //
  // The property is per-segment, not per-example: a segment that IS a dot
  // segment is refused in either position; a segment that merely CONTAINS dots
  // is untouched, since that is the ordinary shape of a versioned name.
  //
  // ⚠️ Every refusal case here builds an entry with NO baseUrl, so the only gate
  // that can fire is the identifier's. Handing these a `urlPath` instead would
  // let the path check refuse them and leave the segment rule vacuous — the two
  // guards are independent and each is pinned alone.
  const DOT_SEGMENTS = ['.', '..'] as const;

  it.each(DOT_SEGMENTS)('refuses ard.namespace "%s"', (namespace) => {
    expect(() =>
      buildArdEntry(MINIMAL_SKILL_SURFACE, { ...MINIMAL_ARD_CONFIG, namespace })
    ).toThrow(ArdDerivationError);
  });

  it.each(DOT_SEGMENTS)('refuses a surface name "%s"', (name) => {
    expect(() => buildArdEntry({ ...MINIMAL_SKILL_SURFACE, name }, MINIMAL_ARD_CONFIG)).toThrow(
      ArdDerivationError
    );
  });

  it.each(DOT_SEGMENTS)('names the segment it refused, for "%s"', (namespace) => {
    expect(() =>
      buildArdEntry(MINIMAL_SKILL_SURFACE, { ...MINIMAL_ARD_CONFIG, namespace })
    ).toThrow(/ard\.namespace/);
  });

  it.each(['v1.2', '.hidden', 'a..b', '...'])(
    'still accepts "%s", which merely contains dots',
    (name) => {
      const entry = buildArdEntry(
        { ...MINIMAL_SKILL_SURFACE, name, urlPath: `skills/${name}` },
        URL_ARD_CONFIG
      );
      expect(entry.identifier).toBe(`urn:air:example.com:skills:${name}`);
      expect(entry.url).toBe(`https://example.com/catalog/skills/${name}`);
    }
  );
});

describe('buildArdEntry — urlPath is a PATH, never a relocation', () => {
  // 🚨 `ArdSurface.urlPath` is documented as "path appended to `ard.baseUrl`",
  // and `buildArdEntry` is exported from the package. An absolute URL handed to
  // it resolved to ITSELF: the entry kept `urn:air:example.com:…` while its
  // `url` pointed at another origin, which is exactly the binding
  // `resolveTrustManifest` exists to protect. Encoded dot segments decode during
  // resolution, so `%2e%2e` walks the base's path just as `..` does.
  it.each([
    'https://evil.com/x',
    // Any scheme, not just the web ones — the check is on the SHAPE. (A plain
    // `http://` literal here trips `sonarjs/no-clear-text-protocols`, which is
    // reading a refusal fixture as a connection.)
    'x-vat://evil.com/x',
    '//evil.com/x',
    'mailto:ops@evil.com',
    'javascript:alert(1)',
    'skills/../x',
    'skills/%2e%2e/x',
    'skills/%2E%2E/x',
    '../x',
    './x',
    'skills/./x',
  ])('refuses urlPath %s', (urlPath) => {
    expect(() => buildArdEntry({ ...MINIMAL_SKILL_SURFACE, urlPath }, URL_ARD_CONFIG)).toThrow(
      ArdDerivationError
    );
  });

  it.each(['skills/a.md', '/skills/a.md', 'skills/v1.2/a.md', 'skills/a%20b.md'])(
    'accepts urlPath %s, which addresses inside the base',
    (urlPath) => {
      const entry = buildArdEntry({ ...MINIMAL_SKILL_SURFACE, urlPath }, URL_ARD_CONFIG);
      expect(entry.url?.startsWith('https://example.com/catalog/')).toBe(true);
    }
  );
});

describe('buildArdEntry — the QUALIFIED override key outranks the bare one', () => {
  // 🚨 Nothing decided this. Two mutations reversing the lookup to bare-first
  // stayed green across the whole suite, because no case ever put both keys on
  // one surface — so a refactor could publish the wrong block in silence.
  //
  // Pinned as a property over both DECLARATION ORDERS: a lookup that walked the
  // record instead of asking for the key it wants would pass one and fail the
  // other.
  const BARE = { capabilities: ['FromBareKey'], type: 'text/BARE' };
  const QUALIFIED = { capabilities: ['FromQualifiedKey'], type: 'text/QUALIFIED' };
  const NAME = MINIMAL_SKILL_SURFACE.name;
  const QUALIFIED_KEY = `skill:${NAME}`;

  it.each([
    ['bare declared first', { [NAME]: BARE, [QUALIFIED_KEY]: QUALIFIED }],
    ['qualified declared first', { [QUALIFIED_KEY]: QUALIFIED, [NAME]: BARE }],
  ])('takes the qualified block when %s', (_label, entries) => {
    const entry = buildArdEntry(MINIMAL_SKILL_SURFACE, { ...MINIMAL_ARD_CONFIG, entries });
    expect(entry.type).toBe(QUALIFIED.type);
    expect(entry.capabilities).toEqual(QUALIFIED.capabilities);
  });

  it('reports the bare block it discarded, rather than dropping it in silence', () => {
    const shadowed = findShadowedArdOverrideKeys([MINIMAL_SKILL_SURFACE], {
      ...MINIMAL_ARD_CONFIG,
      entries: { [NAME]: BARE, [QUALIFIED_KEY]: QUALIFIED },
    });
    expect(shadowed).toEqual([
      { kind: 'skill', name: NAME, shadowedKey: NAME, winningKey: QUALIFIED_KEY },
    ]);
  });

  it('reports nothing when only one of the two keys is declared', () => {
    for (const entries of [{ [NAME]: BARE }, { [QUALIFIED_KEY]: QUALIFIED }]) {
      expect(
        findShadowedArdOverrideKeys([MINIMAL_SKILL_SURFACE], { ...MINIMAL_ARD_CONFIG, entries })
      ).toEqual([]);
    }
  });
});

describe('buildArdEntries — an inherited Object.prototype key is not a config key', () => {
  // 🚨 `entries[surface.name] === undefined` reads through the prototype, and
  // `z.record` yields a plain-prototype object — so a skill and a marketplace
  // both named `toString` hit the ambiguity refusal and exited 1 naming
  // `ard.entries.toString`, a key the config does not contain.
  it.each(['toString', 'constructor', 'valueOf', 'hasOwnProperty'])(
    'emits both surfaces named %s, since no bare key was declared',
    (name) => {
      const entries = buildArdEntries(
        [
          { kind: 'skill', name, displayName: name, data: {} },
          { kind: 'marketplace', name, displayName: name, data: {} },
        ],
        {
          ...MINIMAL_ARD_CONFIG,
          entries: { [`marketplace:${name}`]: { type: VENDOR_CATALOG_TYPE } },
        }
      );
      expect(entries.map((e) => e.identifier)).toEqual([
        `urn:air:example.com:skills:${name}`,
        `urn:air:example.com:marketplaces:${name}`,
      ]);
      // The inherited value must not have been read as an override either.
      expect(entries[0]?.type).toBe(ARD_SKILL_MEDIA_TYPE);
    }
  );
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
