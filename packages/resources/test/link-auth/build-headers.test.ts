import { describe, expect, it } from 'vitest';

import {
  buildHeaders,
  REDACTED_VALUE,
  redactSecretsInText,
  sensitiveHeaderValues,
} from '../../src/link-auth/build-headers.js';
import { TemplateMissingVarError } from '../../src/link-auth/template.js';
import { UnknownTransformError } from '../../src/link-auth/transforms.js';

const BEARER_TOKEN_TEMPLATE = 'Bearer ${token}';
const GITHUB_ACCEPT = 'application/vnd.github+json';
// Not a real credential: a fixed, obviously-synthetic string so a leak is
// visible as an exact substring in whatever the code under test emits.
const LEAK_CANARY = 'ghp_leakcanary_0123456789abcdef';

describe('buildHeaders', () => {
  it('renders a single ${token} header (the GitHub/SharePoint macro shape)', () => {
    const result = buildHeaders({ Authorization: BEARER_TOKEN_TEMPLATE }, { token: 'abc' });
    expect(result).toEqual({ Authorization: 'Bearer abc' });
  });

  it('renders multiple headers from one context', () => {
    const result = buildHeaders(
      {
        Authorization: BEARER_TOKEN_TEMPLATE,
        Accept: GITHUB_ACCEPT,
      },
      { token: 'abc' },
    );
    expect(result).toEqual({
      Authorization: 'Bearer abc',
      Accept: GITHUB_ACCEPT,
    });
  });

  it('renders a header template that references a regex capture', () => {
    const result = buildHeaders({ 'X-Owner': '${owner}' }, { owner: 'acme', token: 'unused' });
    expect(result).toEqual({ 'X-Owner': 'acme' });
  });

  it('returns an empty object for an empty templates map', () => {
    expect(buildHeaders({}, { token: 'abc' })).toEqual({});
  });

  it('propagates TemplateMissingVarError when a template references a missing context key', () => {
    expect(() => buildHeaders({ Authorization: BEARER_TOKEN_TEMPLATE }, {})).toThrow(
      TemplateMissingVarError,
    );
  });

  it('propagates UnknownTransformError from a header template', () => {
    expect(() => buildHeaders({ X: '${eval(x)}' }, { x: 'y' })).toThrow(UnknownTransformError);
  });

  it('renders literal-only header values unchanged (no ${...} substitution needed)', () => {
    const result = buildHeaders({ Accept: 'application/json' }, {});
    expect(result).toEqual({ Accept: 'application/json' });
  });
});

describe('sensitiveHeaderValues', () => {
  it('returns the value of a sensitive header', () => {
    expect(sensitiveHeaderValues({ Authorization: `Bearer ${LEAK_CANARY}` })).toContain(
      `Bearer ${LEAK_CANARY}`,
    );
  });

  it('also returns the credential half of a `<scheme> <credential>` value', () => {
    // A serializer may print the credential without the scheme. Redacting only
    // the full header value would then miss it.
    expect(sensitiveHeaderValues({ Authorization: `Bearer ${LEAK_CANARY}` })).toContain(
      LEAK_CANARY,
    );
  });

  it.each([
    ['PRIVATE-TOKEN', 'the GitLab shape'],
    ['X-API-Key', 'the API-key shape'],
    ['X-Authorization-Foo', 'a custom bearer-style header'],
  ])('treats a %s value as a secret (%s) — the name is not the rule', (name) => {
    // The header set is an open record the adopter writes; every value is a
    // rendered secret-bearing template. Keying on the NAME is the instance
    // shape: whichever name is left off the list leaks verbatim.
    expect(sensitiveHeaderValues({ [name]: LEAK_CANARY })).toContain(LEAK_CANARY);
  });

  it('collects the values of every header, not one privileged name', () => {
    const values = sensitiveHeaderValues({
      Authorization: `Bearer ${LEAK_CANARY}`,
      Accept: GITHUB_ACCEPT,
    });
    expect(values).toContain(`Bearer ${LEAK_CANARY}`);
    expect(values).toContain(LEAK_CANARY);
    expect(values).toContain(GITHUB_ACCEPT);
  });

  it('skips a blank value — redacting on it would erase the whole message', () => {
    expect(sensitiveHeaderValues({ Authorization: '   ' })).toEqual([]);
  });
});

describe('redactSecretsInText', () => {
  it('replaces every occurrence of a secret', () => {
    const text = `sent ${LEAK_CANARY} then retried ${LEAK_CANARY}`;
    const out = redactSecretsInText(text, [LEAK_CANARY]);
    expect(out).not.toContain(LEAK_CANARY);
    expect(out.split(REDACTED_VALUE)).toHaveLength(3);
  });

  it('leaves the surrounding text intact', () => {
    expect(redactSecretsInText(`a ${LEAK_CANARY} b`, [LEAK_CANARY])).toBe(
      `a ${REDACTED_VALUE} b`,
    );
  });

  it.each([
    ['undefined', undefined],
    ['empty string', ''],
    ['whitespace only', '  \t '],
  ])('ignores a %s secret rather than shredding the text', (_label, secret) => {
    expect(redactSecretsInText('untouched text', [secret])).toBe('untouched text');
  });

  it('redacts the longest overlapping secret first', () => {
    // `Bearer <tok>` and `<tok>` both arrive from sensitiveHeaderValues. If the
    // short one ran first, the long one would never match and the output would
    // read `Bearer <redacted>` — still safe, but it hides that the scheme was
    // part of the leaked string. Longest-first keeps one clean marker.
    const values = sensitiveHeaderValues({ Authorization: `Bearer ${LEAK_CANARY}` });
    const out = redactSecretsInText(`value "Bearer ${LEAK_CANARY}" is invalid`, values);
    expect(out).toBe(`value "${REDACTED_VALUE}" is invalid`);
  });

  it('closes the undici message shape verbatim', () => {
    // MEASURED on Node 24: `new Headers({ Authorization: 'Bearer <tok>\\0' })`
    // throws `TypeError: Headers.append: "Bearer <tok>\\0" is an invalid header
    // value.` — the value verbatim in `.message`.
    const value = `Bearer ${LEAK_CANARY}${String.fromCodePoint(0)}`;
    const undiciMessage = `Headers.append: "${value}" is an invalid header value.`;
    const out = redactSecretsInText(undiciMessage, sensitiveHeaderValues({ Authorization: value }));
    expect(out).not.toContain(LEAK_CANARY);
    expect(out).toContain('is an invalid header value');
  });

  /**
   * 🪤 A secret does not have to arrive VERBATIM to be a secret. A value that
   * carries a NUL is embedded by `JSON.stringify` as `\u0000`, so the literal
   * header value no longer occurs in the text while the token beside it does;
   * a logger may percent-encode, base64 or case-fold a value on its way out.
   * Each of those is one decode away from the credential, and a scrub that
   * matched only the exact bytes let all of them through.
   */
  describe('encoded forms of a secret', () => {
    const NUL = String.fromCodePoint(0);
    const value = `Bearer ${LEAK_CANARY}${NUL}`;
    const secrets = sensitiveHeaderValues({ Authorization: value });

    it('redacts the JSON-escaped form (the NUL is `\\u0000`, the token is verbatim beside it)', () => {
      const out = redactSecretsInText(`boom ${JSON.stringify(value)}`, secrets);
      expect(out).not.toContain(LEAK_CANARY);
      expect(out).toContain('boom');
    });

    it('redacts the percent-encoded form', () => {
      const out = redactSecretsInText(`url ?t=${encodeURIComponent(value)}`, secrets);
      expect(out).not.toContain(encodeURIComponent(LEAK_CANARY));
      expect(out).toContain('url ?t=');
    });

    it.each([
      ['base64', Buffer.from(value, 'utf8').toString('base64')],
      ['base64url', Buffer.from(value, 'utf8').toString('base64url')],
    ])('redacts the %s form', (_label, encoded) => {
      const out = redactSecretsInText(`blob ${encoded} end`, secrets);
      expect(out).not.toContain(encoded);
      expect(out).toBe(`blob ${REDACTED_VALUE} end`);
    });

    it('redacts a case-folded copy of the secret', () => {
      const out = redactSecretsInText(`saw ${LEAK_CANARY.toUpperCase()} here`, [LEAK_CANARY]);
      expect(out).toBe(`saw ${REDACTED_VALUE} here`);
    });

    it('still leaves unrelated text intact (encoded forms widen the net, not the shred)', () => {
      expect(redactSecretsInText('nothing to see', secrets)).toBe('nothing to see');
    });
  });
});
