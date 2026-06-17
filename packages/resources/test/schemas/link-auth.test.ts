import { describe, expect, it } from 'vitest';

import {
  LinkAuthConfigSchema,
  ProviderEntrySchema,
  RewriteRuleSchema,
  TokenSourceSchema,
} from '../../src/schemas/link-auth.js';
import { ResourcesConfigSchema } from '../../src/schemas/project-config.js';

const BEARER_TOKEN_TEMPLATE = 'Bearer ${token}';
const GITHUB_ACCEPT = 'application/vnd.github+json';

// Full inline github provider — mirrors the macros.yaml shipped in utils.
const GITHUB_INLINE_PROVIDER = {
  match: { host: 'github.com' },
  rewrite: [
    {
      when: String.raw`^https://github\.com/(?<owner>[^/]+)/(?<repo>[^/]+)/(?:blob|tree)/(?<ref>[^/]+)/(?<path>.+)$`,
      to: 'https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${ref}',
    },
  ],
  auth: { headers: { Authorization: BEARER_TOKEN_TEMPLATE, Accept: GITHUB_ACCEPT } },
  token: [{ command: 'gh auth token' }, { env: 'GITHUB_TOKEN' }],
  check: { method: 'GET', aliveStatus: [200], notFoundMeaning: 'ambiguous' },
};

describe('TokenSourceSchema', () => {
  it('accepts an env source', () => {
    expect(TokenSourceSchema.safeParse({ env: 'GITHUB_TOKEN' }).success).toBe(true);
  });

  it('accepts an argv-array command source', () => {
    expect(TokenSourceSchema.safeParse({ command: ['gh', 'auth', 'token'] }).success).toBe(true);
  });

  it('accepts a convenience string command source', () => {
    expect(TokenSourceSchema.safeParse({ command: 'gh auth token' }).success).toBe(true);
  });

  it('rejects an env source with an empty name', () => {
    expect(TokenSourceSchema.safeParse({ env: '' }).success).toBe(false);
  });

  it('rejects a command source with an empty string', () => {
    expect(TokenSourceSchema.safeParse({ command: '' }).success).toBe(false);
  });

  it('rejects a command source with an empty array', () => {
    expect(TokenSourceSchema.safeParse({ command: [] }).success).toBe(false);
  });

  it('rejects an object with both env and command (strict union)', () => {
    expect(TokenSourceSchema.safeParse({ env: 'X', command: 'y' }).success).toBe(false);
  });
});

describe('RewriteRuleSchema', () => {
  it('accepts the minimal { when, to } shape', () => {
    expect(
      RewriteRuleSchema.safeParse({ when: '^https://.+$', to: 'rewritten' }).success,
    ).toBe(true);
  });

  it('accepts an optional vars map', () => {
    expect(
      RewriteRuleSchema.safeParse({
        when: '^(?<u>.+)$',
        vars: { shareId: 'u!${base64url(u)}' },
        to: '${shareId}',
      }).success,
    ).toBe(true);
  });

  it('rejects an unknown sibling key (typo defense)', () => {
    const result = RewriteRuleSchema.safeParse({ when: '^.+$', to: 'x', tos: 'typo' });
    expect(result.success).toBe(false);
  });

  it('rejects missing required fields', () => {
    expect(RewriteRuleSchema.safeParse({ when: '^.+$' }).success).toBe(false);
    expect(RewriteRuleSchema.safeParse({ to: 'x' }).success).toBe(false);
  });
});

describe('ProviderEntrySchema — inline provider', () => {
  it('accepts the full github inline provider', () => {
    expect(ProviderEntrySchema.safeParse(GITHUB_INLINE_PROVIDER).success).toBe(true);
  });

  it('rejects an inline provider missing required top-level fields', () => {
    const incomplete = { ...GITHUB_INLINE_PROVIDER };
    delete (incomplete as { check?: unknown }).check;
    expect(ProviderEntrySchema.safeParse(incomplete).success).toBe(false);
  });

  it('rejects an unknown sibling key in an inline provider (typo defense)', () => {
    const withTypo = { ...GITHUB_INLINE_PROVIDER, tokens: GITHUB_INLINE_PROVIDER.token };
    expect(ProviderEntrySchema.safeParse(withTypo).success).toBe(false);
  });

  it('rejects an empty rewrite array (at least one rule required)', () => {
    const noRewrites = { ...GITHUB_INLINE_PROVIDER, rewrite: [] };
    expect(ProviderEntrySchema.safeParse(noRewrites).success).toBe(false);
  });

  it('rejects an invalid notFoundMeaning value', () => {
    const bad = {
      ...GITHUB_INLINE_PROVIDER,
      check: { ...GITHUB_INLINE_PROVIDER.check, notFoundMeaning: 'maybe' },
    };
    expect(ProviderEntrySchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an HTTP method other than GET or HEAD', () => {
    const bad = {
      ...GITHUB_INLINE_PROVIDER,
      check: { ...GITHUB_INLINE_PROVIDER.check, method: 'DELETE' },
    };
    expect(ProviderEntrySchema.safeParse(bad).success).toBe(false);
  });
});

describe('ProviderEntrySchema — macro reference (use:)', () => {
  it('accepts a bare `use: <name>` reference', () => {
    expect(ProviderEntrySchema.safeParse({ use: 'github' }).success).toBe(true);
  });

  it('accepts `use:` with override fields (deep-merged at expansion time)', () => {
    const result = ProviderEntrySchema.safeParse({
      use: 'sharepoint',
      token: [{ command: 'az account get-access-token' }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects an empty `use:` name', () => {
    expect(ProviderEntrySchema.safeParse({ use: '' }).success).toBe(false);
  });
});

describe('LinkAuthConfigSchema — top-level', () => {
  it('accepts a minimal config with a single inline provider', () => {
    const config = { providers: [GITHUB_INLINE_PROVIDER] };
    expect(LinkAuthConfigSchema.safeParse(config).success).toBe(true);
  });

  it('accepts a config mixing inline and use-form providers', () => {
    const config = {
      providers: [{ use: 'github' }, GITHUB_INLINE_PROVIDER],
    };
    expect(LinkAuthConfigSchema.safeParse(config).success).toBe(true);
  });

  it('accepts a cache config', () => {
    const config = {
      cache: { ttlMinutes: 60 },
      providers: [{ use: 'github' }],
    };
    expect(LinkAuthConfigSchema.safeParse(config).success).toBe(true);
  });

  it('rejects unknown top-level keys', () => {
    const config = { providers: [], cachees: { ttlMinutes: 30 } };
    expect(LinkAuthConfigSchema.safeParse(config).success).toBe(false);
  });

  it('rejects a missing `providers` field', () => {
    expect(LinkAuthConfigSchema.safeParse({}).success).toBe(false);
  });

  it('rejects a negative or zero cache TTL', () => {
    expect(
      LinkAuthConfigSchema.safeParse({ cache: { ttlMinutes: 0 }, providers: [] }).success,
    ).toBe(false);
    expect(
      LinkAuthConfigSchema.safeParse({ cache: { ttlMinutes: -5 }, providers: [] }).success,
    ).toBe(false);
  });
});

describe('ResourcesConfigSchema integration', () => {
  it('accepts a resources config with an optional linkAuth block', () => {
    const result = ResourcesConfigSchema.safeParse({
      linkAuth: { providers: [{ use: 'github' }] },
    });
    expect(result.success).toBe(true);
  });

  it('still accepts a resources config WITHOUT a linkAuth block (existing fixtures must not regress)', () => {
    expect(
      ResourcesConfigSchema.safeParse({
        include: ['docs/**/*.md'],
      }).success,
    ).toBe(true);
  });

  it('a malformed linkAuth block surfaces as a Zod error (not silently accepted)', () => {
    const result = ResourcesConfigSchema.safeParse({
      linkAuth: { providers: 'not-an-array' },
    });
    expect(result.success).toBe(false);
  });
});
