import { inspect } from 'node:util';

import { describe, expect, it, vi } from 'vitest';

import { AuthTransportError, authTransport, parseRetryAfter } from '../src/link-auth-transport.js';

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
/** undici's message for every connect-level failure; the real error rides in `cause`. */
const FETCH_FAILED = 'fetch failed';

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
    const response = await authTransport(
      'https://api.github.com/o',
      { authorization: 'Bearer t', Accept: 'application/json' },
      impl,
    );
    expect(response.status).toBe(200); // the hop with the assertions actually ran
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

  // The two chain tests below assert the FINAL status as well as the per-hop
  // headers: every per-hop `expect` sits inside a hop that only runs if the
  // redirect was followed, so without the final-status check both passed
  // verbatim against a transport that never redirects at all (mutation-verified
  // with `REDIRECT_STATUSES` emptied).
  it('redirect with relative Location resolves against current URL (still same-origin)', async () => {
    const impl = sequenceFetch([
      { status: 302, headers: { location: '/relative/path' } },
      {
        status: 200,
        assertUrl: (url) => expect(url).toBe('https://api.github.com/relative/path'),
        assertHeaders: (h) => expect(h['Authorization']).toBe(TEST_TOKEN),
      },
    ]);
    const response = await authTransport(ORIGIN_URL, AUTH_HEADERS, impl);
    expect(response.status).toBe(200);
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
    const response = await authTransport('https://api.github.com/start', AUTH_HEADERS, impl);
    expect(response.status).toBe(200);
  });

  it('a malformed Location is refused through the redaction seam, not as a bare `Invalid URL`', async () => {
    // `new URL('http://[bad', currentUrl)` throws a TypeError whose `.input`
    // is the raw header. It used to escape from the loop body untouched —
    // outside `fetchRedacting`'s catch and outside the documented
    // "network-level failure" contract — so a server that echoed the
    // request's credential into `Location` handed it back verbatim.
    const location = `http://[bad/${LEAK_CANARY}`;
    const impl = sequenceFetch([{ status: 302, headers: { location } }]);
    const error = await thrownBy({ Authorization: `Bearer ${LEAK_CANARY}` }, impl);
    expect(error).toBeInstanceOf(AuthTransportError);
    expect(error.message).toContain('Location');
    expect(error.message).toContain('302');
    expect(inspect(error, { depth: 6, showHidden: true })).not.toContain(LEAK_CANARY);
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

  /**
   * 304 Not Modified is a 3xx that is not a redirect; an origin answering 304
   * with a `Location` (RFC 9110 allows the header on any response) was being
   * followed as one. Only the five redirect statuses move the request.
   */
  it.each([304, 305, 306])('does not follow a Location on %i — a 3xx that is not a redirect', async (status) => {
    let hops = 0;
    const impl = ((_url: string | URL) => {
      hops++;
      return Promise.resolve(
        new Response(null, { status: hops === 1 ? status : 200, headers: { location: ATTACKER_URL } }),
      );
    }) as typeof fetch;
    const response = await authTransport(ORIGIN_URL, AUTH_HEADERS, impl);
    expect(hops).toBe(1);
    expect(response.status).toBe(status);
  });

  it.each([301, 302, 303, 307, 308])('follows a Location on %i', async (status) => {
    const impl = sequenceFetch([
      { status, headers: { location: 'https://api.github.com/moved' } },
      { status: 200, assertUrl: (url) => expect(url).toBe('https://api.github.com/moved') },
    ]);
    const response = await authTransport(ORIGIN_URL, AUTH_HEADERS, impl);
    expect(response.status).toBe(200);
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
  return await thrownBy(headers, undiciHeaderValidatingFetch);
}

/** What `authTransport` throws for these headers when `fetchImpl` rejects with `rejection`. */
async function thrownByRejection(headers: Record<string, string>, rejection: unknown): Promise<Error> {
  return await thrownBy(headers, (() => Promise.reject(rejection)) as typeof fetch);
}

/** What `authTransport` throws for these headers against `impl` — asserted to be an Error. */
async function thrownBy(headers: Record<string, string>, impl: typeof fetch): Promise<Error> {
  const error: unknown = await authTransport(ORIGIN_URL, headers, impl).then(
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
    const inner = new Error(`upstream rejected Bearer ${LEAK_CANARY}`);
    const error = await thrownByRejection(
      { Authorization: `Bearer ${LEAK_CANARY}` },
      new TypeError(FETCH_FAILED, { cause: inner }),
    );
    expect(error.message).not.toContain(LEAK_CANARY);
    expect(error.message).toContain(FETCH_FAILED);
    expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
  });

  /**
   * `describeThrown` used to probe `.message` and the `cause` chain only, so a
   * value riding anywhere else on the object — `AggregateError.errors`, an own
   * enumerable property such as a `.headers` a client library attaches — was
   * judged "exposes nothing" and the SAME object was rethrown, value intact,
   * for `util.inspect` or a debug logger to print.
   */
  it('redacts a token carried in `AggregateError.errors`', async () => {
    const error = await thrownByRejection(
      { Authorization: `Bearer ${LEAK_CANARY}` },
      new AggregateError([new Error(`inner has Bearer ${LEAK_CANARY}`)], 'all addresses failed'),
    );
    expect(error.message).not.toContain(LEAK_CANARY);
    expect(error.message).toContain('all addresses failed');
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(LEAK_CANARY);
    expect((error as Error & { errors?: unknown }).errors).toBeUndefined();
  });

  it('redacts a token carried on an own enumerable property of the error', async () => {
    const error = await thrownByRejection(
      { Authorization: `Bearer ${LEAK_CANARY}` },
      Object.assign(new Error('request failed'), { headers: { Authorization: `Bearer ${LEAK_CANARY}` } }),
    );
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(LEAK_CANARY);
    expect(error.message).toContain('request failed');
    expect((error as Error & { headers?: unknown }).headers).toBeUndefined();
  });

  /**
   * The docstring's claim is "everything `util.inspect` or a debug logger would
   * print". `JSON.stringify` — the old flatten step — is blind to a `Headers`
   * or `Map` instance (`{}`), a Symbol-keyed property, a non-enumerable one, an
   * overwritten `.stack`, and gives up entirely on a throwing getter; each of
   * those shapes was judged "exposes nothing" and the ORIGINAL object rethrown
   * with the token visible under `util.inspect`. The assertion is against
   * `util.inspect` itself, the very function the claim is about.
   */
  const INSPECT_OPTIONS = { depth: 6, showHidden: true };
  const authInit = { Authorization: `Bearer ${LEAK_CANARY}` };
  it.each<[string, (error: Error) => void]>([
    ['a `Headers` instance on an own property', (e) => Object.assign(e, { request: { headers: new Headers(authInit) } })],
    ['a `Map` on an own property', (e) => Object.assign(e, { h: new Map(Object.entries(authInit)) })],
    ['a Symbol-keyed property', (e) => Object.assign(e, { [Symbol('kInit')]: { headers: authInit } })],
    ['a non-enumerable own property', (e) => Object.defineProperty(e, 'init', { value: { headers: authInit }, enumerable: false })],
    [
      'a throwing getter beside the property that carries it',
      (e) => {
        Object.defineProperty(e, 'boom', { enumerable: true, get: () => { throw new Error('x'); } });
        Object.assign(e, { init: { headers: authInit } });
      },
    ],
    ['an overwritten `.stack` with a clean message', (e) => { e.stack = `Error: clean\n    at ${LEAK_CANARY}`; }],
  ])('redacts a token that only `util.inspect` would print: %s', async (_label, decorate) => {
    const original = new Error(FETCH_FAILED);
    decorate(original);
    expect(inspect(original, INSPECT_OPTIONS)).toContain(LEAK_CANARY); // the shape is live
    const error = await thrownByRejection(authInit, original);
    expect(error).toBeInstanceOf(AuthTransportError);
    expect(inspect(error, INSPECT_OPTIONS)).not.toContain(LEAK_CANARY);
    expect(error.message).toContain(FETCH_FAILED);
  });

  it('redacts a NUL-bearing token that only `util.inspect` prints, in inspect\'s own escaping', async () => {
    // A `Map` is `{}` to JSON, so only inspect sees the value — and inspect
    // prints the NUL as `\x00`, which is neither the verbatim credential nor
    // JSON's `\u0000`. The redaction has to know inspect's spelling of the
    // secret or this shape is judged clean and rethrown intact.
    const nulHeaders = { Authorization: `Bearer ${LEAK_CANARY}${NUL}` };
    const original = Object.assign(new Error(FETCH_FAILED), { h: new Map(Object.entries(nulHeaders)) });
    expect(JSON.stringify(original)).not.toContain(LEAK_CANARY);
    const error = await thrownByRejection(nulHeaders, original);
    expect(error).toBeInstanceOf(AuthTransportError);
    expect(inspect(error, INSPECT_OPTIONS)).not.toContain(LEAK_CANARY);
  });

  it('redacts a token that only `JSON.stringify` would print — a `toJSON` own method', async () => {
    // `util.inspect` never calls `toJSON`; a logger that `JSON.stringify`s the
    // error does. This is the one shape the inspect probe cannot see, and the
    // reason the JSON probe stays beside it.
    const original = Object.assign(new Error(FETCH_FAILED), { toJSON: () => ({ headers: authInit }) });
    expect(inspect(original, INSPECT_OPTIONS)).not.toContain(LEAK_CANARY);
    expect(JSON.stringify(original)).toContain(LEAK_CANARY);
    const error = await thrownByRejection(authInit, original);
    expect(error).toBeInstanceOf(AuthTransportError);
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(LEAK_CANARY);
  });

  /**
   * `cause` and `errors` are non-enumerable on a standard Error, so a
   * top-level `JSON.stringify(error)` never descends into them and a `toJSON`
   * living there is only ever called by a consumer that serializes
   * `err.cause` / `err.errors` directly. The walk that `describeThrown`
   * replaced called `JSON.stringify` at every level; the inspect-only probe
   * printed `[Function: toJSON]` and judged each of these clean.
   */
  it.each<[string, () => unknown]>([
    [
      'a `toJSON` on the `cause` Error',
      () => new TypeError(FETCH_FAILED, { cause: Object.assign(new Error('inner'), { toJSON: () => ({ headers: authInit }) }) }),
    ],
    [
      'a `toJSON` on a plain-object `cause`',
      () => new TypeError(FETCH_FAILED, { cause: { toJSON: () => ({ headers: authInit }) } }),
    ],
    [
      'a `toJSON` on an `AggregateError` member',
      () => new AggregateError([Object.assign(new Error('inner'), { toJSON: () => ({ headers: authInit }) })], FETCH_FAILED),
    ],
  ])('redacts a token that only `JSON.stringify` of a nested member would print: %s', async (_label, build) => {
    const original = build() as Error & { cause?: unknown; errors?: unknown[] };
    expect(inspect(original, INSPECT_OPTIONS)).not.toContain(LEAK_CANARY);
    expect(JSON.stringify(original)).not.toContain(LEAK_CANARY);
    const nested = original.cause ?? original.errors?.[0];
    expect(JSON.stringify(nested)).toContain(LEAK_CANARY); // the shape is live one level down
    const error = await thrownByRejection(authInit, original);
    expect(error).toBeInstanceOf(AuthTransportError);
    expect(error.message).toContain(FETCH_FAILED);
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(LEAK_CANARY);
  });

  /**
   * A secret carried as BYTES. `util.inspect` prints a `Buffer` and an
   * `ArrayBuffer` as spaced hex and a `Uint8Array` as decimal bytes;
   * `JSON.stringify` prints a `Buffer` as `{"type":"Buffer","data":[…]}` and
   * a `Uint8Array` as an index-keyed object. None of those is the verbatim,
   * escaped, percent- or base64-encoded credential, and each is one decode
   * away from it. Every encoding the swap could print is asserted absent:
   * the credential itself, its hex, its base64, its base64url and its
   * decimal bytes, in the replacement's inspect dump and its JSON.
   */
  const secretBytes = Buffer.from(`Bearer ${LEAK_CANARY}`);
  const encodings: readonly [string, string][] = [
    ['verbatim', LEAK_CANARY],
    ['hex', Buffer.from(LEAK_CANARY).toString('hex')],
    ['spaced hex', Buffer.from(LEAK_CANARY).toString('hex').replaceAll(/(..)(?=.)/g, '$1 ')],
    ['base64', Buffer.from(LEAK_CANARY).toString('base64')],
    ['base64url', Buffer.from(LEAK_CANARY).toString('base64url')],
    ['decimal bytes', [...Buffer.from(LEAK_CANARY)].join(', ')],
    ['JSON decimal bytes', [...Buffer.from(LEAK_CANARY)].join(',')],
    ['JSON index-keyed bytes', [...Buffer.from(LEAK_CANARY)].map((byte, i) => `"${i}":${byte}`).join(',')],
  ];
  /** Every element on one line, so a decimal byte list is one contiguous string as the probe sees it. */
  const INSPECT_BYTES = { ...INSPECT_OPTIONS, maxArrayLength: Infinity, breakLength: Infinity, compact: true };
  it.each<[string, (error: Error) => void]>([
    ['a `Buffer` own property', (e) => Object.assign(e, { buf: Buffer.from(secretBytes) })],
    ['a `Uint8Array` own property', (e) => Object.assign(e, { bytes: new Uint8Array(secretBytes) })],
    [
      'an `ArrayBuffer` own property',
      (e) => Object.assign(e, { ab: secretBytes.buffer.slice(secretBytes.byteOffset, secretBytes.byteOffset + secretBytes.byteLength) }),
    ],
  ])('redacts a secret carried as bytes on %s, in every encoding', async (_label, decorate) => {
    const original = new Error(FETCH_FAILED);
    decorate(original);
    const printed = `${inspect(original, INSPECT_BYTES)} | ${JSON.stringify(original)}`;
    expect(printed).not.toContain(LEAK_CANARY); // no textual form is present…
    expect(encodings.some(([, form]) => printed.includes(form))).toBe(true); // …but a byte form is
    const error = await thrownByRejection(authInit, original);
    expect(error).toBeInstanceOf(AuthTransportError);
    const swapped = `${inspect(error, INSPECT_BYTES)} | ${JSON.stringify(error, Object.getOwnPropertyNames(error))}`;
    for (const [name, form] of encodings) {
      expect(swapped, `leaks the ${name} form`).not.toContain(form);
    }
  });

  it('redacts a byte-held secret longer than inspect\'s 50-byte Buffer cap that only inspect would print', async () => {
    // A `Buffer` inside a `Map` is `{}` to JSON, so only inspect sees it — and
    // inspect prints `INSPECT_MAX_BYTES` (50) of a Buffer, then `… N more
    // bytes`. A 93-character fine-grained token would print as a hex PREFIX
    // that no whole-secret form matches unless the probe lifts the cap.
    const longCanary = `${LEAK_CANARY}_${'x'.repeat(60)}`;
    const headers = { Authorization: `Bearer ${longCanary}` };
    const original = Object.assign(new Error(FETCH_FAILED), { m: new Map([['buf', Buffer.from(longCanary)]]) });
    expect(inspect(original, INSPECT_BYTES)).toContain('more bytes>'); // the cap is live at the default
    const error = await thrownByRejection(headers, original);
    expect(error).toBeInstanceOf(AuthTransportError);
    expect(inspect(error, INSPECT_BYTES)).not.toContain(Buffer.from(LEAK_CANARY).toString('hex').replaceAll(/(..)(?=.)/g, '$1 '));
  });

  it('redacts a `Uint8Array` that only inspect would print — its decimal bytes must be one contiguous list', async () => {
    // Inside a `Map` the array is `{}` to JSON. Under inspect's default
    // layout a long numeric array is grouped into aligned columns across
    // lines, and no literal spelling of the bytes matches a list broken by
    // variable whitespace; the probe has to print it on one line.
    const original = Object.assign(new Error(FETCH_FAILED), { m: new Map([['u', new Uint8Array(secretBytes)]]) });
    expect(JSON.stringify(original)).not.toContain('66');
    expect(inspect(original, INSPECT_OPTIONS)).toMatch(/66,\s+101,/); // the shape is live, and grouped by default
    const error = await thrownByRejection(authInit, original);
    expect(error).toBeInstanceOf(AuthTransportError);
    expect(inspect(error, INSPECT_BYTES)).not.toContain([...Buffer.from(LEAK_CANARY)].join(', '));
  });

  it('redacts a token whose surrounding value was JSON-escaped on the way into the message', async () => {
    // The header value carries a NUL; a wrapper that `JSON.stringify`s the
    // value embeds the NUL as `\u0000` and the token verbatim beside it — so
    // the exact header value is nowhere in the text and the token is.
    const value = `Bearer ${LEAK_CANARY}${NUL}`;
    const error = await thrownByRejection({ Authorization: value }, new Error(`boom ${JSON.stringify(value)}`));
    expect(error.message).not.toContain(LEAK_CANARY);
    expect(error.message).toContain('boom');
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
