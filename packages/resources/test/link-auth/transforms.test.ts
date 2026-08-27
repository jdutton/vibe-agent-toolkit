import { describe, expect, it } from 'vitest';

import {
  ALLOWED_TRANSFORMS,
  applyTransform,
  UnknownTransformError,
} from '../../src/link-auth/transforms.js';

describe('applyTransform', () => {
  describe('base64url', () => {
    it('encodes ASCII to URL-safe base64 without padding', () => {
      expect(applyTransform('base64url', 'hello')).toBe('aGVsbG8');
    });

    it('strips trailing padding', () => {
      expect(applyTransform('base64url', 'a')).toBe('YQ');
    });

    it('produces URL-safe output (no + / =)', () => {
      const result = applyTransform('base64url', '>>><<<');
      expect(result).not.toMatch(/[+/=]/);
    });

    it('returns empty string for empty input', () => {
      expect(applyTransform('base64url', '')).toBe('');
    });

    it('round-trips a SharePoint sharing URL via standard base64url decoder', () => {
      const url = 'https://contoso.sharepoint.com/sites/Eng/Shared%20Documents/spec.docx';
      const encoded = applyTransform('base64url', url);
      expect(Buffer.from(encoded, 'base64url').toString('utf8')).toBe(url);
      expect(encoded).not.toMatch(/[+/=]/);
    });

    it('matches RFC 4648 §10 test vectors (guards against lockstep regression)', () => {
      // Externally-defined fixtures: any compliant base64url implementation
      // produces these exact outputs. Self-referential round-trip can't catch
      // a regression that breaks encode and decode together.
      expect(applyTransform('base64url', 'f')).toBe('Zg');
      expect(applyTransform('base64url', 'fo')).toBe('Zm8');
      expect(applyTransform('base64url', 'foo')).toBe('Zm9v');
      expect(applyTransform('base64url', 'foob')).toBe('Zm9vYg');
      expect(applyTransform('base64url', 'fooba')).toBe('Zm9vYmE');
      expect(applyTransform('base64url', 'foobar')).toBe('Zm9vYmFy');
    });

    it('substitutes U+FFFD for lone surrogates (pins Node lossy behavior)', () => {
      // Pinned against a literal external value, not against itself: UTF-8 of
      // U+FFFD is EF BF BD, which is base64url '77-9'. If substitution ever
      // silently stops, BOTH assertions break — not just the lockstep equality
      // a self-referential round-trip would mask.
      expect(applyTransform('base64url', '�')).toBe('77-9');
      expect(applyTransform('base64url', '\uD800')).toBe('77-9');
    });
  });

  describe('urlencode', () => {
    it('percent-encodes spaces', () => {
      expect(applyTransform('urlencode', 'a b')).toBe('a%20b');
    });

    it('percent-encodes path separators', () => {
      expect(applyTransform('urlencode', 'a/b')).toBe('a%2Fb');
    });

    it('passes RFC 3986 unreserved characters through unchanged', () => {
      expect(applyTransform('urlencode', 'abc-_.~')).toBe('abc-_.~');
    });

    it('throws URIError on lone surrogates (pins Node behavior — URL captures cannot legally contain these)', () => {
      // Deliberate: not wrapped into UnknownTransformError. The real call path
      // takes regex captures from a parsed URL string; a lone surrogate cannot
      // appear there. If a future caller widens the input contract, revisit.
      expect(() => applyTransform('urlencode', '\uD800')).toThrow(URIError);
    });
  });

  describe('lower', () => {
    it('lowercases mixed-case ASCII', () => {
      expect(applyTransform('lower', 'GitHub.COM')).toBe('github.com');
    });
  });

  describe('closed allowlist (security claim)', () => {
    it('throws UnknownTransformError for an unrecognized name', () => {
      expect(() => applyTransform('eval', 'x')).toThrow(UnknownTransformError);
    });

    it('rejects Object.prototype keys — the load-bearing reason this uses Object.hasOwn, not "in"', () => {
      // If lookup used `name in TRANSFORMS`, every one of these would resolve
      // to a prototype method and bypass the allowlist. This test is the
      // single most important assertion in this file.
      const adversarial = ['toString', '__proto__', 'constructor', 'hasOwnProperty', 'valueOf'];
      for (const name of adversarial) {
        expect(() => applyTransform(name, 'x')).toThrow(UnknownTransformError);
      }
    });

    it('error message names the bad transform and the full allowlist', () => {
      let err: unknown;
      try {
        applyTransform('shell', 'x');
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(UnknownTransformError);
      const message = (err as Error).message;
      expect(message).toContain('shell');
      for (const allowed of ALLOWED_TRANSFORMS) {
        expect(message).toContain(allowed);
      }
    });
  });

  describe('ALLOWED_TRANSFORMS', () => {
    it('exposes the closed allowlist', () => {
      expect(new Set(ALLOWED_TRANSFORMS)).toEqual(new Set(['base64url', 'lower', 'urlencode']));
      expect(ALLOWED_TRANSFORMS).toHaveLength(3);
    });
  });
});
