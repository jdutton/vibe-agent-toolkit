import { describe, expect, it, vi } from 'vitest';

import { authTransport, parseRetryAfter } from '../src/link-auth-transport.js';

import {
  LEAK_CANARY,
  NUL,
  sequenceFetch,
  undiciHeaderValidatingFetch,
} from './auth-fetch-mocks.js';

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

describe('authTransport — happy path (no redirect, no retry)', () => {
  it('passes URL and headers through to fetchImpl, returns response', async () => {
    const impl = sequenceFetch([
      {
        status: 200,
        assertUrl: (url) => expect(url).toBe('https://api.github.com/repos/o/r/contents/f'),
        assertHeaders: (h) => expect(h['Authorization']).toBe(TEST_TOKEN),
      },
    ]);
    const response = await authTransport(
      'https://api.github.com/repos/o/r/contents/f',
      AUTH_HEADERS,
      impl,
    );
    expect(response.status).toBe(200);
  });
});

describe('authTransport — cross-origin header stripping (§8)', () => {
  it('same-origin redirect preserves Authorization header', async () => {
    const impl = sequenceFetch([
      { status: 302, headers: { location: 'https://api.github.com/redirected' } },
      {
        status: 200,
        assertHeaders: (h) => expect(h['Authorization']).toBe(TEST_TOKEN),
      },
    ]);
    const response = await authTransport(
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
    const response = await authTransport(
      ORIGIN_URL,
      AUTH_HEADERS,
      impl,
    );
    expect(response.status).toBe(200);
  });

  it('cross-origin redirect strips a lower-cased authorization key too', async () => {
    // A buggy/exotic caller might pass header key as 'authorization' instead.
    // Nothing is keyed on the name any more, so spelling cannot matter.
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
    await authTransport(
      'https://api.github.com/o',
      { authorization: 'Bearer t', Accept: 'application/json' },
      impl,
    );
  });

  it('cross-origin redirect strips a credential in a header NOT named Authorization', async () => {
    // `auth.headers` is an open adopter-authored record whose every value is
    // secret-bearing by contract (GitLab: `PRIVATE-TOKEN`; API-key hosts:
    // `X-API-Key`). A strip keyed on the NAME `authorization` is the instance
    // shape — whichever name it omits rides the bounce to the other origin.
    const impl = sequenceFetch([
      { status: 302, headers: { location: ATTACKER_URL } },
      {
        status: 200,
        assertHeaders: (h) => expect(h).toEqual({}),
      },
    ]);
    const response = await authTransport(
      ORIGIN_URL,
      { 'PRIVATE-TOKEN': TEST_TOKEN, 'X-API-Key': TEST_TOKEN, Accept: 'application/json' },
      impl,
    );
    expect(response.status).toBe(200);
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
    await authTransport(ORIGIN_URL, AUTH_HEADERS, impl);
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
    await authTransport('https://api.github.com/start', AUTH_HEADERS, impl);
  });

  it('exceeding maxRedirects returns the last 3xx response (does not throw)', async () => {
    const impl = sequenceFetch([
      { status: 302, headers: { location: 'https://api.github.com/2' } },
      { status: 302, headers: { location: 'https://api.github.com/3' } },
      { status: 302, headers: { location: 'https://api.github.com/4' } },
    ]);
    const response = await authTransport(
      'https://api.github.com/1',
      AUTH_HEADERS,
      impl,
      { maxRedirects: 2 },
    );
    expect(response.status).toBe(302);
  });

  it('redirect with no Location header returns the 3xx response', async () => {
    const impl = sequenceFetch([{ status: 301 }]);
    const response = await authTransport(ORIGIN_URL, AUTH_HEADERS, impl);
    expect(response.status).toBe(301);
  });
});

/**
 * Helper: invoke authTransport with the standard test args (ORIGIN_URL +
 * AUTH_HEADERS) and a caller-supplied impl/sleep. Eliminates the repeated
 * 4-arg call boilerplate across the retry tests.
 */
function callWithRetry(
  impl: typeof fetch,
  sleep: ReturnType<typeof vi.fn>,
  overrides: { maxRetries?: number; maxRetryAfterMs?: number } = {},
): Promise<Response> {
  return authTransport(ORIGIN_URL, AUTH_HEADERS, impl, {
    maxRetries: 2,
    sleep,
    ...overrides,
  });
}

describe('authTransport — 429 + Retry-After (§5.2)', () => {
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

describe('authTransport — interaction', () => {
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

describe('authTransport — signal pass-through', () => {
  it('AbortSignal in options is forwarded to every fetchImpl call', async () => {
    let capturedSignal: AbortSignal | null | undefined;
    const impl = (async (_u: string | URL, init?: RequestInit) => {
      capturedSignal = init?.signal as AbortSignal | undefined;
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    const signal = AbortSignal.timeout(30_000);
    await authTransport(ORIGIN_URL, AUTH_HEADERS, impl, { signal });
    expect(capturedSignal).toBe(signal);
  });
});

/** What `authTransport` throws for these headers against the undici-faithful fetch. */
async function thrownFor(headers: Record<string, string>): Promise<Error> {
  const error: unknown = await authTransport(ORIGIN_URL, headers, undiciHeaderValidatingFetch).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(Error);
  return error as Error;
}

describe('authTransport — a throwing fetch never carries the token out', () => {
  // MEASURED on Node 24.13: undici embeds the header VALUE verbatim in the
  // TypeError it throws for an invalid header —
  //   Headers.append: "Bearer <tok>\0" is an invalid header value.
  // `ExternalLinkValidator` serializes that `.message` straight into the
  // result's `error` field, which `vat resources validate` prints. A
  // credential helper that emits a NUL or a multi-line payload (`git
  // credential fill` prints `password=…` on its own line) reaches it.
  // `LEAK_CANARY`, `NUL` and `undiciHeaderValidatingFetch` are shared with the
  // validator suite from `auth-fetch-mocks.ts` — see there for why one canary.

  it('the real undici TypeError leaks the token — proving the case is live', () => {
    // Guard against the fix being tested against a mock that no longer
    // reproduces the hazard: if undici stops embedding the value, this test
    // fails and the redaction below can be re-argued from evidence.
    // `toThrow(string)` is a SUBSTRING check, which is the assertion meant —
    // and stricter than the `new RegExp(LEAK_CANARY)` this replaced, since the
    // canary is now an import and every one of its characters is matched
    // literally rather than as pattern syntax.
    expect(() => new Headers({ Authorization: `Bearer ${LEAK_CANARY}${NUL}` })).toThrow(
      LEAK_CANARY,
    );
  });

  it('rethrows a redacted error instead of the raw one', async () => {
    const seen = await thrownFor({ Authorization: `Bearer ${LEAK_CANARY}${NUL}`, Accept: 'application/json' });
    expect(seen.message).not.toContain(LEAK_CANARY);
    expect(String(seen.stack)).not.toContain(LEAK_CANARY);
    // The `cause` chain must not smuggle it either — util.inspect prints it.
    expect(JSON.stringify(seen, Object.getOwnPropertyNames(seen))).not.toContain(LEAK_CANARY);
  });

  it('keeps the diagnosis — the operator can still tell what went wrong', async () => {
    const error = await thrownFor({ Authorization: `Bearer ${LEAK_CANARY}${NUL}` });
    expect(error.message).toContain('invalid header value');
    // The original error's class is named in the text, so the swap does not
    // cost the operator the "what kind of failure was this" signal.
    expect(error.message).toContain('TypeError');
  });

  it('redacts a token carried in a header that is NOT named Authorization', async () => {
    // `auth.headers` is an open adopter-authored record — GitLab's documented
    // header is `PRIVATE-TOKEN`, API-key hosts use `X-API-Key`. The value is
    // the secret whatever the name says, so redaction must key on the VALUE.
    // A name allowlist would leave this exact throw on stdout verbatim.
    const error = await thrownFor({ 'PRIVATE-TOKEN': `${LEAK_CANARY}${NUL}` });
    expect(error.message).not.toContain(LEAK_CANARY);
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(LEAK_CANARY);
  });

  it('passes an ordinary network failure through untouched', async () => {
    // Nothing to hide → the operator keeps the original object: exact message,
    // real stack, real class. Rewrapping every failure to guard the rare one
    // would trade every diagnosis for one.
    const original = new Error('connect ECONNREFUSED 127.0.0.1:443');
    const impl = (() => Promise.reject(original)) as typeof fetch;
    const error = await authTransport(ORIGIN_URL, AUTH_HEADERS, impl).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBe(original);
  });

  it('redacts a token hiding one level down in the `cause` chain', async () => {
    // undici's own "fetch failed" nests the real error as `cause`, and
    // util.inspect prints it — a probe that read only `.message` would pass
    // this leak straight through.
    const impl = (() => {
      const inner = new Error(`upstream rejected Bearer ${LEAK_CANARY}`);
      return Promise.reject(new TypeError('fetch failed', { cause: inner }));
    }) as typeof fetch;
    const error = (await authTransport(
      ORIGIN_URL,
      { Authorization: `Bearer ${LEAK_CANARY}` },
      impl,
    ).then(
      () => undefined,
      (e: unknown) => e,
    )) as Error;
    expect(error.message).not.toContain(LEAK_CANARY);
    expect(error.message).toContain('fetch failed');
    expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
  });

  it('redacts a throw on a LATER hop, not only the first', async () => {
    // The loop rebuilds `currentHeaders` on every redirect. Redaction must
    // cover the token for the whole run, not just the first fetch call.
    let hop = 0;
    const headers = { Authorization: `Bearer ${LEAK_CANARY}${NUL}` };
    const impl = ((_url: string | URL, init?: RequestInit) => {
      hop++;
      if (hop === 1) {
        // First hop skips header validation entirely, so nothing throws yet.
        return Promise.resolve(
          new Response(null, { status: 302, headers: { location: `${ORIGIN_URL}/next` } }),
        );
      }
      // Same-origin redirect, so Authorization is still attached — undici's
      // validation is what fails here, on hop 2.
      const validated = new Headers(init?.headers);
      return Promise.resolve(
        new Response(null, {
          status: 200,
          headers: { 'x-auth-sent': String(validated.has('authorization')) },
        }),
      );
    }) as typeof fetch;

    const error = (await authTransport(ORIGIN_URL, headers, impl).then(
      () => undefined,
      (e: unknown) => e,
    )) as Error;
    expect(hop).toBe(2);
    expect(error.message).not.toContain(LEAK_CANARY);
  });
});

describe('authTransport — defaultSleep (no sleep injection)', () => {
  it('uses real setTimeout when sleep option is omitted', async () => {
    vi.useFakeTimers();
    try {
      const impl = sequenceFetch([
        { status: 429, headers: { 'retry-after': '1' } },
        { status: 200 },
      ]);
      // No sleep option → defaultSleep runs (covers the setTimeout body).
      const promise = authTransport(ORIGIN_URL, AUTH_HEADERS, impl, { maxRetries: 1 });
      // Advance fake time past the 1000ms Retry-After delay.
      await vi.advanceTimersByTimeAsync(1000);
      const response = await promise;
      expect(response.status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });
});
