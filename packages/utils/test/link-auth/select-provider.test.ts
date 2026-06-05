import { describe, expect, it } from 'vitest';

import { type ProviderMatch, selectProvider } from '../../src/link-auth/select-provider.js';

interface TestProvider {
  readonly name: string;
  readonly match: ProviderMatch;
}

const GITHUB_HOST = 'github.com';
const GITHUB_URL = 'https://github.com/x';

const GITHUB_PROVIDER: TestProvider = {
  name: 'github',
  match: { host: GITHUB_HOST },
};

const SHAREPOINT_PROVIDER: TestProvider = {
  name: 'sharepoint',
  match: {
    host: '*.sharepoint.com',
    excludeHost: ['*-my.sharepoint.com'],
  },
};

describe('selectProvider', () => {
  describe('exact host match', () => {
    it('claims a URL whose host exactly matches the pattern', () => {
      const result = selectProvider('https://github.com/acme/widgets', [GITHUB_PROVIDER]);
      expect(result).toBe(GITHUB_PROVIDER);
    });

    it('does not claim a URL whose host is different', () => {
      const result = selectProvider('https://gitlab.com/acme/widgets', [GITHUB_PROVIDER]);
      expect(result).toBeUndefined();
    });

    it('ignores the URL port (URL.hostname does not include port)', () => {
      const result = selectProvider('https://github.com:8080/x', [GITHUB_PROVIDER]);
      expect(result).toBe(GITHUB_PROVIDER);
    });
  });

  describe('wildcard host match', () => {
    it('claims *.sharepoint.com for a single-segment subdomain', () => {
      const result = selectProvider(
        'https://contoso.sharepoint.com/sites/Eng/spec.docx',
        [SHAREPOINT_PROVIDER],
      );
      expect(result).toBe(SHAREPOINT_PROVIDER);
    });

    it('claims *.sharepoint.com for a multi-segment subdomain (picomatch * matches dots)', () => {
      const result = selectProvider(
        'https://foo.bar.sharepoint.com/path',
        [SHAREPOINT_PROVIDER],
      );
      expect(result).toBe(SHAREPOINT_PROVIDER);
    });

    it('does not claim the bare apex domain sharepoint.com (no subdomain)', () => {
      const result = selectProvider('https://sharepoint.com/path', [SHAREPOINT_PROVIDER]);
      expect(result).toBeUndefined();
    });
  });

  describe('excludeHost (the OneDrive carve-out)', () => {
    it('rejects a host that matches an excludeHost pattern even if it matches host', () => {
      // contoso-my.sharepoint.com matches BOTH *.sharepoint.com and *-my.sharepoint.com,
      // so the exclude wins — provider does not claim personal OneDrive URLs.
      const result = selectProvider(
        'https://contoso-my.sharepoint.com/personal/spec.docx',
        [SHAREPOINT_PROVIDER],
      );
      expect(result).toBeUndefined();
    });

    it('claims a host that matches host but not any excludeHost pattern', () => {
      const result = selectProvider(
        'https://contoso.sharepoint.com/sites/Eng/spec.docx',
        [SHAREPOINT_PROVIDER],
      );
      expect(result).toBe(SHAREPOINT_PROVIDER);
    });

    it('supports multiple excludeHost patterns (rejects if ANY matches)', () => {
      const provider: TestProvider = {
        name: 'multi-exclude',
        match: {
          host: '*.example.com',
          excludeHost: ['*-test.example.com', '*-dev.example.com'],
        },
      };
      expect(selectProvider('https://foo-test.example.com/x', [provider])).toBeUndefined();
      expect(selectProvider('https://foo-dev.example.com/x', [provider])).toBeUndefined();
      expect(selectProvider('https://foo-prod.example.com/x', [provider])).toBe(provider);
    });
  });

  describe('ordering', () => {
    it('returns the FIRST provider whose match claims the URL', () => {
      const first: TestProvider = { name: 'first', match: { host: GITHUB_HOST } };
      const second: TestProvider = { name: 'second', match: { host: GITHUB_HOST } };
      const result = selectProvider(GITHUB_URL, [first, second]);
      expect(result).toBe(first);
    });

    it('falls through to a later provider when earlier ones do not match', () => {
      const result = selectProvider(GITHUB_URL, [SHAREPOINT_PROVIDER, GITHUB_PROVIDER]);
      expect(result).toBe(GITHUB_PROVIDER);
    });
  });

  describe('case insensitivity (hostnames are case-insensitive per RFC 3986)', () => {
    it('claims a URL whose host differs only in case (URL constructor lowercases hostname)', () => {
      const result = selectProvider('https://GitHub.com/x', [GITHUB_PROVIDER]);
      expect(result).toBe(GITHUB_PROVIDER);
    });

    it('claims when the pattern itself has uppercase characters (defensive)', () => {
      const provider: TestProvider = { name: 'mixed-case-pattern', match: { host: 'GitHub.com' } };
      const result = selectProvider(GITHUB_URL, [provider]);
      expect(result).toBe(provider);
    });
  });

  describe('no match / edge cases', () => {
    it('returns undefined for an empty providers array', () => {
      expect(selectProvider(GITHUB_URL, [])).toBeUndefined();
    });

    it('returns undefined for a malformed URL (does not throw)', () => {
      expect(selectProvider('not a url', [GITHUB_PROVIDER])).toBeUndefined();
    });

    it('returns undefined when no provider host pattern matches', () => {
      const result = selectProvider('https://elsewhere.example/path', [
        GITHUB_PROVIDER,
        SHAREPOINT_PROVIDER,
      ]);
      expect(result).toBeUndefined();
    });
  });
});
