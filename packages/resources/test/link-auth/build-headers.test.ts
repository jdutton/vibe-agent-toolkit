import { describe, expect, it } from 'vitest';

import {
  buildHeaders,
  redactHeaders,
  REDACTED_VALUE,
} from '../../src/link-auth/build-headers.js';
import { TemplateMissingVarError } from '../../src/link-auth/template.js';
import { UnknownTransformError } from '../../src/link-auth/transforms.js';

const BEARER_TOKEN_TEMPLATE = 'Bearer ${token}';
const GITHUB_ACCEPT = 'application/vnd.github+json';

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

describe('redactHeaders', () => {
  it('redacts the Authorization header value', () => {
    expect(redactHeaders({ Authorization: 'Bearer secret-token-12345' })).toEqual({
      Authorization: REDACTED_VALUE,
    });
  });

  it('redacts case-insensitively (authorization, AUTHORIZATION)', () => {
    expect(redactHeaders({ authorization: 'Bearer x' })).toEqual({ authorization: REDACTED_VALUE });
    expect(redactHeaders({ AUTHORIZATION: 'Bearer x' })).toEqual({ AUTHORIZATION: REDACTED_VALUE });
  });

  it('passes non-sensitive headers through unchanged', () => {
    expect(redactHeaders({ Accept: 'application/json' })).toEqual({ Accept: 'application/json' });
  });

  it('does NOT redact headers that merely contain "Authorization" as a substring', () => {
    // X-Authorization-Foo is not the Authorization header; only exact (case-insensitive) match.
    expect(redactHeaders({ 'X-Authorization-Foo': 'value' })).toEqual({
      'X-Authorization-Foo': 'value',
    });
  });

  it('returns an empty object for empty input', () => {
    expect(redactHeaders({})).toEqual({});
  });

  it('preserves all header names, only blanking the values of sensitive ones', () => {
    const result = redactHeaders({
      Authorization: 'Bearer t',
      Accept: 'application/json',
      'X-Custom': 'value',
    });
    expect(Object.keys(result).sort((a, b) => a.localeCompare(b))).toEqual([
      'Accept',
      'Authorization',
      'X-Custom',
    ]);
  });
});

describe('buildHeaders + redactHeaders integration (security claim)', () => {
  it('a serialized redacted result never contains the raw token value', () => {
    // The whole point of redactHeaders: a JSON.stringify of the redacted
    // output must not leak the secret. Pinned against a literal token string
    // so this test would fail if redaction ever stopped or was misapplied.
    const built = buildHeaders(
      { Authorization: BEARER_TOKEN_TEMPLATE },
      { token: 'secret-token-12345' },
    );
    const serialized = JSON.stringify(redactHeaders(built));
    expect(serialized).not.toContain('secret-token-12345');
    expect(serialized).toContain(REDACTED_VALUE);
  });

  it('non-sensitive header values remain visible after redaction (round-trip integrity)', () => {
    const built = buildHeaders(
      { Authorization: BEARER_TOKEN_TEMPLATE, Accept: GITHUB_ACCEPT },
      { token: 't' },
    );
    const redacted = redactHeaders(built);
    expect(redacted['Accept']).toBe(GITHUB_ACCEPT);
  });

  it('preserves the header count — redaction never silently drops a header', () => {
    const built = buildHeaders(
      { Authorization: BEARER_TOKEN_TEMPLATE, Accept: GITHUB_ACCEPT, 'X-Custom': 'value' },
      { token: 't' },
    );
    const redacted = redactHeaders(built);
    expect(Object.keys(redacted)).toHaveLength(Object.keys(built).length);
  });

  it('returned maps have a null prototype (prototype-pollution defense)', () => {
    const built = buildHeaders({ Authorization: BEARER_TOKEN_TEMPLATE }, { token: 't' });
    const redacted = redactHeaders(built);
    expect(Object.getPrototypeOf(built)).toBeNull();
    expect(Object.getPrototypeOf(redacted)).toBeNull();
  });
});
