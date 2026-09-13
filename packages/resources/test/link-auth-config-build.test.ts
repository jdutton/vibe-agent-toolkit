import { describe, expect, it } from 'vitest';

import { LinkAuthConfigError } from '../src/link-auth/compile-check.js';
import { resolveAuthenticatedUrl } from '../src/link-auth/resolve.js';
import { buildLinkAuthEngineConfig } from '../src/link-auth-config-build.js';
import type { LinkAuthProjectConfig } from '../src/schemas/link-auth.js';

const INLINE_HOST = 'example.com';
const BEARER_TOKEN_TEMPLATE = 'Bearer ${token}';
const INLINE_PROVIDER = {
  match: { host: INLINE_HOST },
  rewrite: [{ when: '.*', to: 'https://api.example.com' }],
  auth: { headers: { Authorization: BEARER_TOKEN_TEMPLATE } },
  token: [{ env: 'TOK' }],
  check: { method: 'GET' as const, aliveStatus: [200], notFoundMeaning: 'dead' as const },
};

describe('buildLinkAuthEngineConfig — empty + inline pass-through', () => {
  it('empty providers array yields an engine config with empty providers', () => {
    const engine = buildLinkAuthEngineConfig({ providers: [] });
    expect(engine.providers).toEqual([]);
  });

  it('inline providers pass through unchanged (no macro expansion)', () => {
    const engine = buildLinkAuthEngineConfig({ providers: [INLINE_PROVIDER] });
    expect(engine.providers).toHaveLength(1);
    expect(engine.providers[0]).toMatchObject({
      match: { host: INLINE_HOST },
      check: { notFoundMeaning: 'dead' },
    });
  });

  it('order of providers is preserved (first-claiming-wins is determined by position)', () => {
    const a = { ...INLINE_PROVIDER, match: { host: 'a.com' } };
    const b = { ...INLINE_PROVIDER, match: { host: 'b.com' } };
    const engine = buildLinkAuthEngineConfig({ providers: [a, b] });
    expect(engine.providers[0]?.match.host).toBe('a.com');
    expect(engine.providers[1]?.match.host).toBe('b.com');
  });
});

describe('buildLinkAuthEngineConfig — macro expansion', () => {
  it('{ use: "github" } expands to the github macro shape', () => {
    const engine = buildLinkAuthEngineConfig({ providers: [{ use: 'github' }] });
    expect(engine.providers).toHaveLength(1);
    const [p] = engine.providers;
    expect(p?.match.host).toBe('github.com');
    expect(p?.check.notFoundMeaning).toBe('ambiguous');
    expect(p?.auth.headers['Authorization']).toBe(BEARER_TOKEN_TEMPLATE);
  });

  it('{ use: "sharepoint" } expands to the sharepoint macro shape', () => {
    const engine = buildLinkAuthEngineConfig({ providers: [{ use: 'sharepoint' }] });
    expect(engine.providers[0]?.match.host).toBe('*.sharepoint.com');
    expect(engine.providers[0]?.check.notFoundMeaning).toBe('dead');
  });

  it('overrides deep-merge on top of macro defaults', () => {
    const engine = buildLinkAuthEngineConfig({
      providers: [
        {
          use: 'github',
          match: { host: 'github.example.internal' },
          token: [{ env: 'INTERNAL_GH_TOKEN' }],
        },
      ],
    });
    const [p] = engine.providers;
    expect(p?.match.host).toBe('github.example.internal');
    // Token list replaced wholesale (arrays don't element-merge).
    expect(p?.token).toEqual([{ env: 'INTERNAL_GH_TOKEN' }]);
    // Other fields preserved from the macro.
    expect(p?.check.notFoundMeaning).toBe('ambiguous');
  });

  it('throws UnknownMacroError for an unknown macro name', () => {
    expect(() => buildLinkAuthEngineConfig({ providers: [{ use: 'not-a-real-macro' }] })).toThrow(
      /not-a-real-macro/,
    );
  });

  it('post-expansion validation: a macro override that produces an invalid provider throws', () => {
    // Override `check.notFoundMeaning` to an invalid enum value. The macro
    // schema layer can't catch this (overrides pass through unchecked), so
    // post-expansion validation must.
    expect(() =>
      buildLinkAuthEngineConfig({
        providers: [{ use: 'github', check: { notFoundMeaning: 'totally-invalid' } }] as LinkAuthProjectConfig['providers'],
      }),
    ).toThrow(/providers\[0\]/);
  });
});

describe('buildLinkAuthEngineConfig — interop with the engine', () => {
  it('produced config can drive resolveAuthenticatedUrl end-to-end', () => {
    const engine = buildLinkAuthEngineConfig({ providers: [{ use: 'github' }] });
    const outcome = resolveAuthenticatedUrl(
      'https://github.com/owner/repo/blob/main/file.md',
      engine,
      {
        env: { GITHUB_TOKEN: 'gh_abc' },
        // Bypass the macro's `gh auth token` command source so the test does
        // not pick up a real `gh` login from the dev machine — return an
        // empty stdout so the engine falls through to the env source.
        runCommand: () => ({ success: true, stdout: '' }),
      },
    );
    expect('fetchUrl' in outcome).toBe(true);
    if (!('fetchUrl' in outcome)) return;
    expect(outcome.fetchUrl).toContain('api.github.com');
    expect(outcome.headers['Authorization']).toBe('Bearer gh_abc');
    expect(outcome.check.notFoundMeaning).toBe('ambiguous');
  });
});

describe('buildLinkAuthEngineConfig — cache config propagation (§6.3)', () => {
  it('propagates cache.ttlMinutes onto the engine config when adopter sets it', () => {
    const engine = buildLinkAuthEngineConfig({
      providers: [INLINE_PROVIDER],
      cache: { ttlMinutes: 45 },
    });
    expect(engine.cache?.ttlMinutes).toBe(45);
  });

  it('omits cache when adopter does not set it (engine consumers fall back to default)', () => {
    const engine = buildLinkAuthEngineConfig({ providers: [INLINE_PROVIDER] });
    expect(engine.cache).toBeUndefined();
  });

  it('propagates an empty cache object as { } (no ttlMinutes set)', () => {
    // Adopters that opt into cache configuration without overriding TTL still
    // need the object to land on the engine config, even if it is empty —
    // future cache fields can be added without forcing every adopter to set
    // a value.
    const engine = buildLinkAuthEngineConfig({
      providers: [INLINE_PROVIDER],
      cache: {},
    });
    expect(engine.cache).toBeDefined();
    expect(engine.cache?.ttlMinutes).toBeUndefined();
  });
});

describe('buildLinkAuthEngineConfig — non-string use value', () => {
  it('throws TypeError when the use property is not a string', () => {
    expect(() =>
      buildLinkAuthEngineConfig({
        providers: [{ use: 42 }] as unknown as LinkAuthProjectConfig['providers'],
      }),
    ).toThrow(/must be a string/);
  });
});

describe('buildLinkAuthEngineConfig — prototype-pollution defense in macro entries', () => {
  it('uses Object.hasOwn to discriminate {use} so prototype-injected `use` cannot trigger macro expansion', () => {
    // Build an object whose prototype carries `use: github` but whose own
    // property set has only the inline provider shape. The function must
    // discriminate via Object.hasOwn (not `'use' in entry`), so this object
    // is treated as inline, not as a macro reference.
    const pollutedProto = { use: 'github' };
    const inline = Object.create(pollutedProto) as Record<string, unknown>;
    Object.assign(inline, INLINE_PROVIDER);

    const engine = buildLinkAuthEngineConfig({
      providers: [inline] as LinkAuthProjectConfig['providers'],
    });
    // If `'use' in inline` were used, it would have read 'github' from the
    // prototype and expanded the github macro — match.host would be 'github.com'.
    // With Object.hasOwn, the prototype is ignored and the inline values win.
    expect(engine.providers[0]?.match.host).toBe(INLINE_HOST);
  });
});

/**
 * A provider that cannot compile is a CONFIG error and is refused here, at
 * config time, by name — not degraded per link.
 *
 * 🪤 It used to reach `resolveAuthenticatedUrl`, whose catch turned every one of
 * these into `{ outcome: 'unverified' }`, which the validator reports as
 * `LINK_AUTH_UNVERIFIED` — a *warning* whose registry remedy says to set it to
 * `ignore` when running without a token is intentional. An adopter who took
 * that advice for a token-less CI lane then had every provider-config typo
 * swallowed: the link was neither authenticated nor checked anonymously, and
 * the run was green with `linksChecked` counting links nothing had fetched.
 * Every failure below is a fact about the config, knowable before any URL is
 * seen, so the run refuses before it starts.
 */
const VALID_WHEN = String.raw`^https://example\.com/(?<owner>[^/]+)/(?<path>.+)$`;

/** One inline provider with `overrides` applied, as a whole linkAuth config. */
function provider(overrides: Partial<typeof INLINE_PROVIDER>): LinkAuthProjectConfig {
  return { providers: [{ ...INLINE_PROVIDER, ...overrides }] };
}

describe('buildLinkAuthEngineConfig — refuses a provider that cannot compile', () => {
  it.each([
    [
      'a `when` regex that does not compile',
      provider({ rewrite: [{ when: '([unclosed', to: 'https://x/' }] }),
      /rewrite\[0\]\.when/,
    ],
    [
      'a `to` template with an unterminated ${',
      provider({ rewrite: [{ when: VALID_WHEN, to: 'https://x/${path' }] }),
      /rewrite\[0\]\.to/,
    ],
    [
      'a `to` template naming a capture the rule does not declare',
      provider({ rewrite: [{ when: VALID_WHEN, to: 'https://x/${nope}' }] }),
      /rewrite\[0\]\.to.*"nope"/,
    ],
    [
      'a `vars` entry referencing ${token}, which vars never see',
      provider({ rewrite: [{ when: VALID_WHEN, vars: { t: '${token}' }, to: 'https://x/${t}' }] }),
      /rewrite\[0\]\.vars\.t.*"token"/,
    ],
    [
      'a `vars` name colliding with a capture',
      provider({ rewrite: [{ when: VALID_WHEN, vars: { path: '${owner}' }, to: 'https://x/${path}' }] }),
      /rewrite\[0\]\.vars\.path/,
    ],
    [
      'a header template calling an unknown transform',
      provider({ auth: { headers: { Authorization: 'Bearer ${rot13(token)}' } } }),
      /auth\.headers\.Authorization.*rot13/,
    ],
    [
      'a header template naming a capture no rule declares',
      provider({
        rewrite: [{ when: VALID_WHEN, to: 'https://x/${path}' }],
        auth: { headers: { Authorization: BEARER_TOKEN_TEMPLATE, 'X-Owner': '${org}' } },
      }),
      /auth\.headers\.X-Owner.*"org"/,
    ],
    [
      'a fetch header template with whitespace inside the expression',
      provider({ fetch: { headers: { Accept: '${ token }' } } }),
      /fetch\.headers\.Accept/,
    ],
    [
      'a `match.host` glob longer than picomatch accepts',
      provider({ match: { host: 'a'.repeat(70_000) } }),
      /match\.host/,
    ],
    [
      'a `match.excludeHost` glob longer than picomatch accepts',
      provider({ match: { host: 'example.com', excludeHost: ['b'.repeat(70_000)] } }),
      /match\.excludeHost\[0\]/,
    ],
  ])('refuses %s, naming providers[0] and the field', (_label, config, fieldPattern) => {
    expect(() => buildLinkAuthEngineConfig(config)).toThrow(LinkAuthConfigError);
    expect(() => buildLinkAuthEngineConfig(config)).toThrow(/resources\.linkAuth providers\[0\]/);
    expect(() => buildLinkAuthEngineConfig(config)).toThrow(fieldPattern);
  });

  it('names the provider by host, so a multi-provider config says WHICH one', () => {
    const config: LinkAuthProjectConfig = {
      providers: [
        INLINE_PROVIDER,
        { ...INLINE_PROVIDER, match: { host: 'second.example' }, rewrite: [{ when: '(', to: 'x' }] },
      ],
    };
    expect(() => buildLinkAuthEngineConfig(config)).toThrow(/providers\[1\] \(host "second\.example"\)/);
  });

  it('accepts every shipped macro (positive control: the check is not refusing everything)', () => {
    expect(() =>
      buildLinkAuthEngineConfig({ providers: [{ use: 'github' }, { use: 'sharepoint' }] }),
    ).not.toThrow();
  });

  it('accepts a header that names a capture SOME rule declares, and a `to` that reads a var', () => {
    // Headers render against whichever rule matched, so a capture declared by
    // any rule is a legitimate name — the runtime lane reports the rule that
    // matched without it. A `to` reads that rule's vars as well as its captures.
    const config = provider({
      rewrite: [
        { when: VALID_WHEN, vars: { enc: '${urlencode(path)}' }, to: 'https://x/${enc}' },
        { when: String.raw`^https://example\.com/(?<id>\d+)$`, to: 'https://x/id/${id}' },
      ],
      auth: { headers: { Authorization: BEARER_TOKEN_TEMPLATE, 'X-Owner': '${owner}', 'X-Id': '${id}' } },
    });
    expect(() => buildLinkAuthEngineConfig(config)).not.toThrow();
  });

  it('does not mistake an escaped "\\(?<" in a `when` for a capture declaration', () => {
    // `\(?<x>` is an optional literal open-paren followed by literal `<x>` —
    // no group named x exists, so a template reading it must be refused.
    const config = provider({ rewrite: [{ when: String.raw`\(?<x>y`, to: 'https://x/${x}' }] });
    expect(() => buildLinkAuthEngineConfig(config)).toThrow(/"x"/);
  });
});
