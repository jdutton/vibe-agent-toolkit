import { describe, expect, it } from 'vitest';

import { expandMacro, UnknownMacroError } from '../../src/link-auth/expand-macro.js';

const BEARER_TOKEN_TEMPLATE = 'Bearer ${token}';
const GITHUB_ACCEPT = 'application/vnd.github+json';

describe('expandMacro — shipped macros from macros.yaml', () => {
  describe('github', () => {
    it('expands to the design §A example shape', () => {
      const result = expandMacro('github');
      expect(result['match']).toEqual({ host: 'github.com' });
    });

    it('exposes the blob/tree → Contents API rewrite rule', () => {
      const result = expandMacro('github');
      const rewrite = result['rewrite'] as Array<{ when: string; to: string }>;
      expect(rewrite).toHaveLength(1);
      expect(rewrite[0]?.to).toBe(
        'https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${ref}',
      );
    });

    it('exposes Bearer + GitHub Accept headers', () => {
      const result = expandMacro('github');
      const auth = result['auth'] as { headers: Record<string, string> };
      expect(auth.headers).toEqual({
        Authorization: BEARER_TOKEN_TEMPLATE,
        Accept: GITHUB_ACCEPT,
      });
    });

    it('exposes both gh-command and env-fallback token sources', () => {
      const result = expandMacro('github');
      expect(result['token']).toEqual([
        { command: 'gh auth token' },
        { env: 'GITHUB_TOKEN' },
      ]);
    });

    it('uses notFoundMeaning: ambiguous (GitHub masks no-access as 404, design §7)', () => {
      const result = expandMacro('github');
      const check = result['check'] as { notFoundMeaning: string };
      expect(check.notFoundMeaning).toBe('ambiguous');
    });
  });

  describe('sharepoint', () => {
    it('matches *.sharepoint.com but excludes *-my.sharepoint.com (the OneDrive carve-out)', () => {
      const result = expandMacro('sharepoint');
      expect(result['match']).toEqual({
        host: '*.sharepoint.com',
        excludeHost: ['*-my.sharepoint.com'],
      });
    });

    it('exposes the Graph rewrite via base64url share-id', () => {
      const result = expandMacro('sharepoint');
      const rewrite = result['rewrite'] as Array<{
        when: string;
        vars: Record<string, string>;
        to: string;
      }>;
      expect(rewrite[0]?.vars).toEqual({ shareId: 'u!${base64url(u)}' });
      expect(rewrite[0]?.to).toBe(
        'https://graph.microsoft.com/v1.0/shares/${shareId}/driveItem',
      );
    });

    it('ships with an EMPTY token source list — adopter must supply (design §5.1 note)', () => {
      const result = expandMacro('sharepoint');
      expect(result['token']).toEqual([]);
    });

    it('uses notFoundMeaning: dead (Graph gives honest 404s, design §7)', () => {
      const result = expandMacro('sharepoint');
      const check = result['check'] as { notFoundMeaning: string };
      expect(check.notFoundMeaning).toBe('dead');
    });
  });

  describe('unknown macro', () => {
    it('throws UnknownMacroError naming the bad macro and listing available macros', () => {
      let err: unknown;
      try {
        expandMacro('nonexistent');
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(UnknownMacroError);
      const message = (err as Error).message;
      expect(message).toContain('nonexistent');
      expect(message).toContain('github');
      expect(message).toContain('sharepoint');
    });
  });
});

describe('expandMacro — deep-merge override behavior (adopter wins)', () => {
  it('overrides a scalar field at a top-level path', () => {
    const result = expandMacro('github', { match: { host: 'github.example.internal' } });
    expect(result['match']).toEqual({ host: 'github.example.internal' });
  });

  it('overrides a deep field while preserving sibling keys', () => {
    const result = expandMacro('github', {
      auth: { headers: { 'X-Custom': 'custom-value' } },
    });
    const auth = result['auth'] as { headers: Record<string, string> };
    expect(auth.headers).toEqual({
      Authorization: BEARER_TOKEN_TEMPLATE,
      Accept: GITHUB_ACCEPT,
      'X-Custom': 'custom-value',
    });
  });

  it('replaces arrays WHOLESALE — overrides do not merge arrays element-wise', () => {
    const result = expandMacro('github', {
      token: [{ env: 'CUSTOM_TOKEN' }],
    });
    expect(result['token']).toEqual([{ env: 'CUSTOM_TOKEN' }]);
  });

  it('preserves base fields the override does not mention', () => {
    const result = expandMacro('github', { match: { host: 'override.com' } });
    expect(result['rewrite']).toBeDefined();
    expect((result['rewrite'] as unknown[])).toHaveLength(1);
  });

  it('overriding the sharepoint token source is the canonical adopter pattern', () => {
    const result = expandMacro('sharepoint', {
      token: [{ command: 'az account get-access-token' }],
    });
    expect(result['token']).toEqual([{ command: 'az account get-access-token' }]);
    // sibling fields should remain — verify auth.headers stayed
    const auth = result['auth'] as { headers: Record<string, string> };
    expect(auth.headers['Authorization']).toBe(BEARER_TOKEN_TEMPLATE);
  });
});

describe('expandMacro — prototype-pollution defense', () => {
  it('expanded result and its nested objects have null prototype', () => {
    const result = expandMacro('github', { auth: { headers: { 'X-Custom': 'v' } } });
    expect(Object.getPrototypeOf(result)).toBeNull();
    const auth = result['auth'] as Record<string, unknown>;
    expect(Object.getPrototypeOf(auth)).toBeNull();
    expect(Object.getPrototypeOf(auth['headers'])).toBeNull();
  });

  it('rejects __proto__ in an override as an attack vector — no global pollution, no inheritance on result', () => {
    // YAML-parsed configs surface `__proto__` as a real own-property (same as
    // JSON.parse), so a hostile YAML config could try this. Use JSON.parse to
    // construct the same shape — object literal syntax treats `__proto__`
    // specially and would NOT exercise the relevant code path in deepMerge.
    const override = JSON.parse('{"__proto__":{"polluted":"yes"}}') as Record<string, unknown>;
    const result = expandMacro('github', override);

    // 1. Object.prototype is untouched — no global pollution.
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();

    // 2. The result does not inherit `polluted` via any path — it has a null
    //    prototype, so even though `__proto__` may be present as an own key,
    //    it is not consulted for inheritance.
    expect((result as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(Object.getPrototypeOf(result)).toBeNull();
  });
});
