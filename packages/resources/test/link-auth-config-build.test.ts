import { resolveAuthenticatedUrl } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { buildLinkAuthEngineConfig } from '../src/link-auth-config-build.js';
import type { LinkAuthProjectConfig } from '../src/schemas/link-auth.js';

const INLINE_HOST = 'example.com';
const INLINE_PROVIDER = {
  match: { host: INLINE_HOST },
  rewrite: [{ when: '.*', to: 'https://api.example.com' }],
  auth: { headers: { Authorization: 'Bearer ${token}' } },
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
    expect(p?.auth.headers['Authorization']).toBe('Bearer ${token}');
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
