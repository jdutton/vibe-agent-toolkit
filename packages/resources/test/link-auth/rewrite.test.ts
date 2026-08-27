import { describe, expect, it } from 'vitest';

import {
  InvalidRewriteRuleError,
  rewriteUrl,
  type RewriteOutcome,
  type RewriteRule,
  VarCaptureCollisionError,
} from '../../src/link-auth/rewrite.js';
import { TemplateMissingVarError } from '../../src/link-auth/template.js';

function assertMatched(
  result: RewriteOutcome,
): asserts result is Extract<RewriteOutcome, { matched: true }> {
  if (!result.matched) {
    throw new Error('expected matched: true');
  }
}

const GITHUB_BLOB_URL = 'https://github.com/acme/widgets/blob/main/docs/api.md';
const GITHUB_CONTENTS_URL =
  'https://api.github.com/repos/acme/widgets/contents/docs/api.md?ref=main';
const SINGLE_CAPTURE_RULE = String.raw`^(?<x>.+)$`;

const GITHUB_RULES: readonly RewriteRule[] = [
  {
    when: String.raw`^https://github\.com/(?<owner>[^/]+)/(?<repo>[^/]+)/(?:blob|tree)/(?<ref>[^/]+)/(?<path>.+)$`,
    to: 'https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${ref}',
  },
];

const SHAREPOINT_RULES: readonly RewriteRule[] = [
  {
    when: '^(?<u>https://.+)$',
    vars: { shareId: 'u!${base64url(u)}' },
    to: 'https://graph.microsoft.com/v1.0/shares/${shareId}/driveItem',
  },
];

describe('rewriteUrl', () => {
  describe('GitHub URL rewriting (design §A example)', () => {
    it('rewrites a blob URL to the Contents API', () => {
      const result = rewriteUrl(GITHUB_BLOB_URL, GITHUB_RULES);
      assertMatched(result);
      expect(result.rewrittenUrl).toBe(GITHUB_CONTENTS_URL);
    });

    it('rewrites a tree URL (the macro regex covers both blob and tree)', () => {
      const result = rewriteUrl('https://github.com/acme/widgets/tree/main/docs', GITHUB_RULES);
      assertMatched(result);
      expect(result.rewrittenUrl).toBe(
        'https://api.github.com/repos/acme/widgets/contents/docs?ref=main',
      );
    });

    it('exposes named captures in the result context', () => {
      const result = rewriteUrl(GITHUB_BLOB_URL, GITHUB_RULES);
      assertMatched(result);
      expect(result.context).toEqual({
        owner: 'acme',
        repo: 'widgets',
        ref: 'main',
        path: 'docs/api.md',
      });
    });
  });

  describe('fragment and query stripping (§5.2 hardening)', () => {
    it('strips #fragment before matching — greedy path must not swallow it', () => {
      const result = rewriteUrl(`${GITHUB_BLOB_URL}#L10-L20`, GITHUB_RULES);
      assertMatched(result);
      expect(result.rewrittenUrl).toBe(GITHUB_CONTENTS_URL);
      expect(result.rewrittenUrl).not.toContain('#');
    });

    it('strips ?query before matching', () => {
      const result = rewriteUrl(`${GITHUB_BLOB_URL}?foo=bar`, GITHUB_RULES);
      assertMatched(result);
      expect(result.rewrittenUrl).toBe(GITHUB_CONTENTS_URL);
      expect(result.rewrittenUrl).not.toContain('foo=bar');
    });

    it('strips both #fragment and ?query', () => {
      const result = rewriteUrl(`${GITHUB_BLOB_URL}?x=1#frag`, GITHUB_RULES);
      assertMatched(result);
      expect(result.rewrittenUrl).toBe(GITHUB_CONTENTS_URL);
    });

    it('strips a bare trailing ? (empty query)', () => {
      const result = rewriteUrl(`${GITHUB_BLOB_URL}?`, GITHUB_RULES);
      assertMatched(result);
      expect(result.rewrittenUrl).toBe(GITHUB_CONTENTS_URL);
    });

    it('strips a bare trailing # (empty fragment)', () => {
      const result = rewriteUrl(`${GITHUB_BLOB_URL}#`, GITHUB_RULES);
      assertMatched(result);
      expect(result.rewrittenUrl).toBe(GITHUB_CONTENTS_URL);
    });

    it('strips at the FIRST ? or # — ?foo=#bar drops everything from ? onward', () => {
      const result = rewriteUrl(`${GITHUB_BLOB_URL}?foo=#bar`, GITHUB_RULES);
      assertMatched(result);
      expect(result.rewrittenUrl).toBe(GITHUB_CONTENTS_URL);
    });
  });

  describe('documented v1 limitations (pin-tests, not aspirations)', () => {
    it('multi-segment refs match WRONG — ref=first-segment, path swallows the rest (design §5.2)', () => {
      // The GitHub regex uses (?<ref>[^/]+) which cannot distinguish single- from
      // multi-segment refs. For a multi-segment ref like `release/1.0`, the
      // regex binds ref='release' and path='1.0/docs/api.md', producing a wrong
      // API URL. The design accepts this as a v1 limitation; the proper fix
      // (resolve ref via GitHub API) is deferred. This test pins the current
      // behavior so a future regex widening that silently changes semantics is
      // caught — and so the limitation stays visible in the test surface.
      const result = rewriteUrl(
        'https://github.com/acme/widgets/blob/release/1.0/docs/api.md',
        GITHUB_RULES,
      );
      assertMatched(result);
      expect(result.context).toEqual({
        owner: 'acme',
        repo: 'widgets',
        ref: 'release',
        path: '1.0/docs/api.md',
      });
      expect(result.rewrittenUrl).toBe(
        'https://api.github.com/repos/acme/widgets/contents/1.0/docs/api.md?ref=release',
      );
    });
  });

  describe('regex without named groups', () => {
    it('matches with an empty context (match.groups is undefined → context becomes {})', () => {
      const rules: readonly RewriteRule[] = [
        { when: String.raw`^https://example\.com/.+$`, to: 'rewritten' },
      ];
      const result = rewriteUrl('https://example.com/anything', rules);
      assertMatched(result);
      expect(result.rewrittenUrl).toBe('rewritten');
      expect(result.context).toEqual({});
    });

    it('throws TemplateMissingVarError if "to" references a variable but no groups exist', () => {
      const rules: readonly RewriteRule[] = [
        { when: String.raw`^https://example\.com/.+$`, to: '${nothing}' },
      ];
      expect(() => rewriteUrl('https://example.com/anything', rules)).toThrow(
        TemplateMissingVarError,
      );
    });
  });

  describe('vars (computed from captures)', () => {
    it('renders a var that calls a transform on a capture, then substitutes into "to"', () => {
      // Externally pinned: base64url('https://x') = 'aHR0cHM6Ly94'.
      // Computed by hand from UTF-8 bytes 68 74 74 70 73 3A 2F 2F 78 → 12 base64
      // chars with no padding; no `+`/`/` so base64 == base64url.
      const result = rewriteUrl('https://x', SHAREPOINT_RULES);
      assertMatched(result);
      expect(result.rewrittenUrl).toBe(
        'https://graph.microsoft.com/v1.0/shares/u!aHR0cHM6Ly94/driveItem',
      );
      expect(result.context).toEqual({
        u: 'https://x',
        shareId: 'u!aHR0cHM6Ly94',
      });
    });

    it('renders a vars template combining literal + transform call', () => {
      // Externally pinned: base64url('bar') = 'YmFy' (Y=24, m=38, F=5, y=50).
      const rules: readonly RewriteRule[] = [
        {
          when: '^foo:(?<u>.+)$',
          vars: { x: 'prefix-${base64url(u)}' },
          to: 'result/${x}',
        },
      ];
      const result = rewriteUrl('foo:bar', rules);
      assertMatched(result);
      expect(result.rewrittenUrl).toBe('result/prefix-YmFy');
    });

    it('vars cannot reference other vars — they see captures only', () => {
      const rules: readonly RewriteRule[] = [
        {
          when: SINGLE_CAPTURE_RULE,
          vars: {
            a: '${x}',
            b: '${a}',
          },
          to: '${b}',
        },
      ];
      expect(() => rewriteUrl('any', rules)).toThrow(TemplateMissingVarError);
    });
  });

  describe('ordered first-match-wins', () => {
    it('applies the first rule whose when matches', () => {
      const rules: readonly RewriteRule[] = [
        { when: String.raw`^https://example\.com/(?<a>.+)$`, to: 'first:${a}' },
        { when: String.raw`^https://example\.com/(?<a>.+)$`, to: 'second:${a}' },
      ];
      const result = rewriteUrl('https://example.com/foo', rules);
      assertMatched(result);
      expect(result.rewrittenUrl).toBe('first:foo');
    });

    it('falls through to a later rule if earlier ones do not match', () => {
      const rules: readonly RewriteRule[] = [
        { when: '^never:.*$', to: 'first' },
        { when: '^second:(?<x>.+)$', to: 'matched:${x}' },
      ];
      const result = rewriteUrl('second:value', rules);
      assertMatched(result);
      expect(result.rewrittenUrl).toBe('matched:value');
    });
  });

  describe('no match', () => {
    it('returns matched:false when no rule claims the URL', () => {
      const result = rewriteUrl('https://elsewhere.example/path', GITHUB_RULES);
      expect(result).toEqual({ matched: false });
    });

    it('returns matched:false for an empty rules array', () => {
      const result = rewriteUrl('https://anything', []);
      expect(result).toEqual({ matched: false });
    });
  });

  describe('error propagation', () => {
    it('throws InvalidRewriteRuleError if a when regex does not compile', () => {
      const rules: readonly RewriteRule[] = [{ when: '[invalid(regex', to: 'x' }];
      expect(() => rewriteUrl('any', rules)).toThrow(InvalidRewriteRuleError);
    });

    it('throws VarCaptureCollisionError if a var name collides with a capture name', () => {
      const rules: readonly RewriteRule[] = [
        {
          when: '^(?<owner>.+)$',
          vars: { owner: 'overridden' },
          to: '${owner}',
        },
      ];
      expect(() => rewriteUrl('acme', rules)).toThrow(VarCaptureCollisionError);
    });

    it('propagates TemplateMissingVarError from a "to" template referencing a non-existent var', () => {
      const rules: readonly RewriteRule[] = [
        {
          when: SINGLE_CAPTURE_RULE,
          to: '${missing}',
        },
      ];
      expect(() => rewriteUrl('any', rules)).toThrow(TemplateMissingVarError);
    });

    it('propagates TemplateMissingVarError from a vars template referencing a missing capture', () => {
      const rules: readonly RewriteRule[] = [
        {
          when: SINGLE_CAPTURE_RULE,
          vars: { y: '${missing}' },
          to: '${y}',
        },
      ];
      expect(() => rewriteUrl('any', rules)).toThrow(TemplateMissingVarError);
    });
  });
});
