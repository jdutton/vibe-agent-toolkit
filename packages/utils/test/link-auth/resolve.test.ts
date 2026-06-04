import { describe, expect, it } from 'vitest';

import {
  type LinkAuthConfig,
  type Provider,
  resolveAuthenticatedUrl,
  type ResolveOutcome,
} from '../../src/link-auth/resolve.js';

function assertHasFetch(
  outcome: ResolveOutcome,
): asserts outcome is Extract<ResolveOutcome, { fetchUrl: string }> {
  if (!('fetchUrl' in outcome)) {
    throw new Error(`expected fetch outcome, got: ${JSON.stringify(outcome)}`);
  }
}

const BEARER_TOKEN_TEMPLATE = 'Bearer ${token}';

function githubProvider(opts: Partial<Provider> = {}): Provider {
  return {
    match: { host: 'github.com' },
    rewrite: [
      {
        when: String.raw`^https://github\.com/(?<owner>[^/]+)/(?<repo>[^/]+)/(?:blob|tree)/(?<ref>[^/]+)/(?<path>.+)$`,
        to: 'https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${ref}',
      },
    ],
    auth: { headers: { Authorization: BEARER_TOKEN_TEMPLATE } },
    token: [{ env: 'GITHUB_TOKEN' }],
    check: { method: 'GET', aliveStatus: [200], notFoundMeaning: 'ambiguous' },
    ...opts,
  };
}

const GITHUB_BLOB_URL = 'https://github.com/acme/widgets/blob/main/docs/api.md';
const GITHUB_CONTENTS_URL =
  'https://api.github.com/repos/acme/widgets/contents/docs/api.md?ref=main';

describe('resolveAuthenticatedUrl', () => {
  describe('happy path — provider claims, rewrite matches, token resolves', () => {
    it('returns {fetchUrl, headers} for a github URL with env-resolved token', () => {
      const config: LinkAuthConfig = { providers: [githubProvider()] };
      const result = resolveAuthenticatedUrl(GITHUB_BLOB_URL, config, {
        env: { GITHUB_TOKEN: 'ghp_abc' },
      });
      assertHasFetch(result);
      expect(result.fetchUrl).toBe(GITHUB_CONTENTS_URL);
      expect(result.headers).toEqual({ Authorization: 'Bearer ghp_abc' });
    });

    it('header templates can reference regex captures alongside ${token}', () => {
      const provider = githubProvider({
        auth: {
          headers: {
            Authorization: BEARER_TOKEN_TEMPLATE,
            'X-Owner': '${owner}',
          },
        },
      });
      const result = resolveAuthenticatedUrl(
        GITHUB_BLOB_URL,
        { providers: [provider] },
        { env: { GITHUB_TOKEN: 't' } },
      );
      assertHasFetch(result);
      expect(result.headers['X-Owner']).toBe('acme');
      expect(result.headers['Authorization']).toBe('Bearer t');
    });

    it('resolves the SharePoint-shape macro end-to-end (vars + base64url + Graph URL)', () => {
      const sharepointProvider: Provider = {
        match: { host: '*.sharepoint.com', excludeHost: ['*-my.sharepoint.com'] },
        rewrite: [
          {
            when: '^(?<u>https://.+)$',
            vars: { shareId: 'u!${base64url(u)}' },
            to: 'https://graph.microsoft.com/v1.0/shares/${shareId}/driveItem',
          },
        ],
        auth: { headers: { Authorization: BEARER_TOKEN_TEMPLATE } },
        token: [{ env: 'GRAPH_TOKEN' }],
        check: { method: 'GET', aliveStatus: [200], notFoundMeaning: 'dead' },
      };
      const result = resolveAuthenticatedUrl(
        'https://contoso.sharepoint.com/sites/Eng/spec.docx',
        { providers: [sharepointProvider] },
        { env: { GRAPH_TOKEN: 'graph-tok' } },
      );
      assertHasFetch(result);
      // Pinned externally: base64url of the SharePoint URL above.
      // Computed via Buffer.from(url, 'utf8').toString('base64url').
      expect(result.fetchUrl).toBe(
        'https://graph.microsoft.com/v1.0/shares/u!aHR0cHM6Ly9jb250b3NvLnNoYXJlcG9pbnQuY29tL3NpdGVzL0VuZy9zcGVjLmRvY3g/driveItem',
      );
      expect(result.headers['Authorization']).toBe('Bearer graph-tok');
    });
  });

  describe('outcome: unsupported', () => {
    it('returns unsupported when no provider claims the host', () => {
      const config: LinkAuthConfig = { providers: [githubProvider()] };
      const result = resolveAuthenticatedUrl('https://elsewhere.example/x', config);
      expect(result).toEqual({ outcome: 'unsupported' });
    });

    it('returns unsupported when host matches but no rewrite rule matches', () => {
      const provider = githubProvider({
        rewrite: [{ when: '^never://.+$', to: 'x' }],
      });
      const result = resolveAuthenticatedUrl(GITHUB_BLOB_URL, { providers: [provider] });
      expect(result).toEqual({ outcome: 'unsupported' });
    });

    it('returns unsupported for an empty providers array', () => {
      const result = resolveAuthenticatedUrl(GITHUB_BLOB_URL, { providers: [] });
      expect(result).toEqual({ outcome: 'unsupported' });
    });

    it('returns unsupported for a malformed URL', () => {
      const config: LinkAuthConfig = { providers: [githubProvider()] };
      const result = resolveAuthenticatedUrl('not a url', config);
      expect(result).toEqual({ outcome: 'unsupported' });
    });
  });

  describe('outcome: unverified', () => {
    it('returns unverified when host + rewrite match but no token source resolves', () => {
      const provider = githubProvider({ token: [{ env: 'GITHUB_TOKEN' }] });
      const result = resolveAuthenticatedUrl(
        GITHUB_BLOB_URL,
        { providers: [provider] },
        { env: {} },
      );
      expect(result).toMatchObject({ outcome: 'unverified' });
      if ('reason' in result) {
        expect(typeof result.reason).toBe('string');
        expect(result.reason.length).toBeGreaterThan(0);
      }
    });

    it('returns unverified when the provider ships with an empty token list (SharePoint case)', () => {
      const provider = githubProvider({ token: [] });
      const result = resolveAuthenticatedUrl(GITHUB_BLOB_URL, { providers: [provider] });
      expect(result).toMatchObject({ outcome: 'unverified' });
    });
  });

  describe('multiple providers — first claiming-by-host wins', () => {
    it('iterates providers in order; first matching host claims the URL', () => {
      const claiming = githubProvider();
      const other: Provider = {
        match: { host: 'other.com' },
        rewrite: [{ when: '^.+$', to: 'wrong' }],
        auth: { headers: {} },
        token: [],
        check: { method: 'GET', aliveStatus: [200], notFoundMeaning: 'dead' },
      };
      const result = resolveAuthenticatedUrl(
        GITHUB_BLOB_URL,
        { providers: [other, claiming] },
        { env: { GITHUB_TOKEN: 't' } },
      );
      assertHasFetch(result);
      expect(result.fetchUrl).toBe(GITHUB_CONTENTS_URL);
    });
  });

  describe('security and prototype defense', () => {
    it('the resolved token takes precedence over a regex capture named "token" in header templates', () => {
      // If a rewrite rule captures a group named "token", that capture would
      // appear in the merged header context. The RESOLVED token must win for
      // headers — otherwise URL-derived data could leak into Authorization.
      const provider: Provider = {
        match: { host: 'example.com' },
        rewrite: [
          {
            when: String.raw`^https://example\.com/(?<token>.+)$`,
            to: 'rewritten/${token}',
          },
        ],
        auth: { headers: { Authorization: BEARER_TOKEN_TEMPLATE } },
        token: [{ env: 'REAL_TOKEN' }],
        check: { method: 'GET', aliveStatus: [200], notFoundMeaning: 'dead' },
      };
      const result = resolveAuthenticatedUrl(
        'https://example.com/url-part-not-a-token',
        { providers: [provider] },
        { env: { REAL_TOKEN: 'actual-secret' } },
      );
      assertHasFetch(result);
      // The URL captures "url-part-not-a-token" and uses it for the rewrite.
      expect(result.fetchUrl).toBe('rewritten/url-part-not-a-token');
      // But the Authorization header uses the RESOLVED token, not the capture.
      expect(result.headers['Authorization']).toBe('Bearer actual-secret');
    });

    it('returned headers map has null prototype', () => {
      const result = resolveAuthenticatedUrl(
        GITHUB_BLOB_URL,
        { providers: [githubProvider()] },
        { env: { GITHUB_TOKEN: 't' } },
      );
      assertHasFetch(result);
      expect(Object.getPrototypeOf(result.headers)).toBeNull();
    });
  });
});
