import { describe, expect, it, vi } from 'vitest';

import { fetchAuthenticated, parseRetryAfter } from '../src/link-auth-fetch.js';

import { sequenceFetch } from './auth-fetch-mocks.js';

const TEST_TOKEN = 'Bearer test-token-12345';
const ORIGIN_URL = 'https://api.github.com/x';
const ATTACKER_URL = 'https://attacker.example.com/leak';

const AUTH_HEADERS = { Authorization: TEST_TOKEN, Accept: 'application/json' };

describe('parseRetryAfter', () => {
  it('null/empty → null', () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('')).toBeNull();
    expect(parseRetryAfter('   ')).toBeNull();
  });

  it('delta-seconds → milliseconds', () => {
    expect(parseRetryAfter('5')).toBe(5000);
    expect(parseRetryAfter('0')).toBe(0);
    expect(parseRetryAfter('  30  ')).toBe(30_000);
  });

  it('negative or non-numeric junk → null', () => {
    expect(parseRetryAfter('-5')).toBeNull();
    expect(parseRetryAfter('abc')).toBeNull();
    expect(parseRetryAfter('5.5.5')).toBeNull();
  });

  it('HTTP-date in the future → ms from now (approximate)', () => {
    const future = new Date(Date.now() + 10_000).toUTCString();
    const result = parseRetryAfter(future);
    expect(result).not.toBeNull();
    // Allow small slop for clock drift between Date.now() calls.
    expect(result).toBeGreaterThan(8_000);
    expect(result).toBeLessThan(12_000);
  });

  it('HTTP-date in the past → 0 (do not wait, but retry is still warranted)', () => {
    const past = new Date(Date.now() - 60_000).toUTCString();
    expect(parseRetryAfter(past)).toBe(0);
  });
});

describe('fetchAuthenticated — happy path (no redirect, no retry)', () => {
  it('passes URL and headers through to fetchImpl, returns response', async () => {
    const impl = sequenceFetch([
      {
        status: 200,
        assertUrl: (url) => expect(url).toBe('https://api.github.com/repos/o/r/contents/f'),
        assertHeaders: (h) => expect(h['Authorization']).toBe(TEST_TOKEN),
      },
    ]);
    const response = await fetchAuthenticated(
      'https://api.github.com/repos/o/r/contents/f',
      AUTH_HEADERS,
      impl,
    );
    expect(response.status).toBe(200);
  });
});

describe('fetchAuthenticated — cross-origin Authorization stripping (§8)', () => {
  it('same-origin redirect preserves Authorization header', async () => {
    const impl = sequenceFetch([
      { status: 302, headers: { location: 'https://api.github.com/redirected' } },
      {
        status: 200,
        assertHeaders: (h) => expect(h['Authorization']).toBe(TEST_TOKEN),
      },
    ]);
    const response = await fetchAuthenticated(
      ORIGIN_URL,
      AUTH_HEADERS,
      impl,
    );
    expect(response.status).toBe(200);
  });

  it('cross-origin redirect strips Authorization header (different host)', async () => {
    const impl = sequenceFetch([
      { status: 302, headers: { location: ATTACKER_URL } },
      {
        status: 200,
        assertHeaders: (h) => expect(h['Authorization']).toBeUndefined(),
      },
    ]);
    const response = await fetchAuthenticated(
      ORIGIN_URL,
      AUTH_HEADERS,
      impl,
    );
    expect(response.status).toBe(200);
  });

  it('cross-origin redirect strips Authorization case-insensitively', async () => {
    // A buggy/exotic caller might pass header key as 'authorization' instead.
    // The strip must match Headers semantics (case-insensitive).
    const impl = sequenceFetch([
      { status: 302, headers: { location: ATTACKER_URL } },
      {
        status: 200,
        assertHeaders: (h) => {
          for (const key of Object.keys(h)) {
            expect(key.toLowerCase()).not.toBe('authorization');
          }
        },
      },
    ]);
    await fetchAuthenticated(
      'https://api.github.com/o',
      { authorization: 'Bearer t', Accept: 'application/json' },
      impl,
    );
  });

  it('redirect with relative Location resolves against current URL (still same-origin)', async () => {
    const impl = sequenceFetch([
      { status: 302, headers: { location: '/relative/path' } },
      {
        status: 200,
        assertUrl: (url) => expect(url).toBe('https://api.github.com/relative/path'),
        assertHeaders: (h) => expect(h['Authorization']).toBe(TEST_TOKEN),
      },
    ]);
    await fetchAuthenticated(ORIGIN_URL, AUTH_HEADERS, impl);
  });

  it('chain of redirects: first cross-origin strip propagates to subsequent hops', async () => {
    // Once Authorization is stripped, it stays stripped — even if a subsequent
    // hop is back to the original origin (a known token-laundering attack vector).
    const impl = sequenceFetch([
      { status: 302, headers: { location: 'https://attacker.example.com/hop1' } },
      {
        status: 302,
        headers: { location: 'https://api.github.com/hop2' },
        assertHeaders: (h) => expect(h['Authorization']).toBeUndefined(),
      },
      {
        status: 200,
        assertHeaders: (h) => expect(h['Authorization']).toBeUndefined(),
      },
    ]);
    await fetchAuthenticated('https://api.github.com/start', AUTH_HEADERS, impl);
  });

  it('exceeding maxRedirects returns the last 3xx response (does not throw)', async () => {
    const impl = sequenceFetch([
      { status: 302, headers: { location: 'https://api.github.com/2' } },
      { status: 302, headers: { location: 'https://api.github.com/3' } },
      { status: 302, headers: { location: 'https://api.github.com/4' } },
    ]);
    const response = await fetchAuthenticated(
      'https://api.github.com/1',
      AUTH_HEADERS,
      impl,
      { maxRedirects: 2 },
    );
    expect(response.status).toBe(302);
  });

  it('redirect with no Location header returns the 3xx response', async () => {
    const impl = sequenceFetch([{ status: 301 }]);
    const response = await fetchAuthenticated(ORIGIN_URL, AUTH_HEADERS, impl);
    expect(response.status).toBe(301);
  });
});

/**
 * Helper: invoke fetchAuthenticated with the standard test args (ORIGIN_URL +
 * AUTH_HEADERS) and a caller-supplied impl/sleep. Eliminates the repeated
 * 4-arg call boilerplate across the retry tests.
 */
function callWithRetry(
  impl: typeof fetch,
  sleep: ReturnType<typeof vi.fn>,
  overrides: { maxRetries?: number; maxRetryAfterMs?: number } = {},
): Promise<Response> {
  return fetchAuthenticated(ORIGIN_URL, AUTH_HEADERS, impl, {
    maxRetries: 2,
    sleep,
    ...overrides,
  });
}

describe('fetchAuthenticated — 429 + Retry-After (§5.2)', () => {
  it('429 with Retry-After=2 → sleeps 2000ms, retries, returns 200', async () => {
    const sleep = vi.fn(async () => undefined);
    const impl = sequenceFetch([
      { status: 429, headers: { 'retry-after': '2' } },
      { status: 200 },
    ]);
    const response = await callWithRetry(impl, sleep);
    expect(response.status).toBe(200);
    expect(sleep.mock.calls).toEqual([[2000]]);
  });

  it('429 without Retry-After → does not retry, returns the 429', async () => {
    const sleep = vi.fn(async () => undefined);
    const impl = sequenceFetch([{ status: 429 }]);
    const response = await callWithRetry(impl, sleep, { maxRetries: 5 });
    expect(response.status).toBe(429);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('Retry-After: 0 clamps up to the 250ms floor (good-neighbor defense)', async () => {
    const sleep = vi.fn(async () => undefined);
    const impl = sequenceFetch([
      { status: 429, headers: { 'retry-after': '0' } },
      { status: 200 },
    ]);
    await callWithRetry(impl, sleep);
    // Hostile host says "retry now"; we wait at least 250 ms anyway.
    expect(sleep.mock.calls).toEqual([[250]]);
  });

  it('Retry-After exceeding maxRetryAfterMs cap is clamped (DoS defense)', async () => {
    const sleep = vi.fn(async () => undefined);
    const impl = sequenceFetch([
      { status: 429, headers: { 'retry-after': '3600' } }, // 1 hour
      { status: 200 },
    ]);
    await callWithRetry(impl, sleep, { maxRetryAfterMs: 60_000 });
    expect(sleep.mock.calls).toEqual([[60_000]]);
  });

  it('exhausting maxRetries on repeated 429 returns the final 429', async () => {
    const sleep = vi.fn(async () => undefined);
    const impl = sequenceFetch([
      { status: 429, headers: { 'retry-after': '1' } },
      { status: 429, headers: { 'retry-after': '1' } },
      { status: 429, headers: { 'retry-after': '1' } },
    ]);
    const response = await callWithRetry(impl, sleep);
    expect(response.status).toBe(429);
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});

describe('fetchAuthenticated — interaction', () => {
  it('429 → Retry-After → redirect: each phase honored in order', async () => {
    const sleep = vi.fn(async () => undefined);
    const impl = sequenceFetch([
      { status: 429, headers: { 'retry-after': '1' } },
      { status: 302, headers: { location: 'https://api.github.com/redirected' } },
      { status: 200 },
    ]);
    const response = await callWithRetry(impl, sleep);
    expect(response.status).toBe(200);
    expect(sleep.mock.calls).toEqual([[1000]]);
  });
});
