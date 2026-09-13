/**
 * Test-only mocks for `fetch`-shaped functions, used by the linkAuth tests
 * in this package and intended for reuse by slice 3+ content-fetch tests.
 *
 * Four patterns:
 *   - `sequenceFetch(responses)` — script an ordered sequence of responses
 *     with per-call URL/header assertions. Used by `link-auth-fetch.test.ts`
 *     to test redirect + 429 chains.
 *   - `countingFetch()` — observe whether `fetch` was called and how many
 *     times. Used to assert "unverified short-circuit doesn't call fetch."
 *   - `capturingFetch(extract)` — capture one piece of request data (URL or
 *     headers) for later assertion. Returns a 200 response so the caller
 *     can run an end-to-end flow.
 *   - `undiciHeaderValidatingFetch`, with `LEAK_CANARY` / `NUL` — the §8
 *     token-leak fixture. Shared by the transport suite and the validator
 *     suite because both ends of one claim must exercise the SAME header
 *     validation against the SAME canary.
 *
 * Not test files themselves (no `.test.ts` suffix); vitest's
 * `test/...test.ts` include pattern skips this file.
 */

export type ResponseSpec = {
  readonly status: number;
  readonly headers?: Record<string, string>;
  readonly assertUrl?: (url: string) => void;
  readonly assertHeaders?: (headers: Record<string, string>) => void;
};

/**
 * Build a deterministic `fetchImpl` stub from an ordered list of responses.
 * Each call consumes one response; calling beyond the list throws.
 */
export function sequenceFetch(responses: readonly ResponseSpec[]): typeof fetch {
  let i = 0;
  return (async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const spec = responses[i];
    if (spec === undefined) {
      throw new Error(`sequenceFetch: ran out of responses after ${i} call(s)`);
    }
    i++;
    const url = typeof input === 'string' ? input : input.toString();
    const headers = headersToObject(init?.headers);
    spec.assertUrl?.(url);
    spec.assertHeaders?.(headers);
    return new Response(null, {
      status: spec.status,
      headers: spec.headers ?? {},
    });
  }) as typeof fetch;
}

/**
 * Build a `fetchImpl` that increments a counter on every call and returns an
 * empty 200 response. Useful for "fetch must NOT be called" assertions.
 */
export function countingFetch(): { fetchImpl: typeof fetch; calls: () => number } {
  let count = 0;
  const fetchImpl = (async () => {
    count++;
    return new Response();
  }) as typeof fetch;
  return { fetchImpl, calls: () => count };
}

/**
 * Build a `fetchImpl` that captures one piece of request data (URL or headers)
 * via the caller's extractor and always returns 200. Useful for end-to-end
 * "what did the validator actually send?" assertions.
 */
export function capturingFetch<T>(
  extract: (url: string | URL, init?: RequestInit) => T,
): { fetchImpl: typeof fetch; getCaptured: () => T | undefined } {
  let captured: T | undefined;
  const fetchImpl = ((url: string | URL, init?: RequestInit) => {
    captured = extract(url, init);
    return Promise.resolve(new Response(null, { status: 200 }));
  }) as typeof fetch;
  return { fetchImpl, getCaptured: () => captured };
}

/**
 * A token value distinctive enough that finding it anywhere in emitted text is
 * a leak and nothing else.
 *
 * One constant for both suites — `link-auth-transport.test.ts` (redaction at
 * the transport) and `external-link-validator-auth.test.ts` (redaction as the
 * validator emits it) are the two ends of one §8 claim, and a canary that
 * differed between them would let one end drift out from under the other.
 */
export const LEAK_CANARY = 'ghp_leakcanary_0123456789abcdef';

/**
 * The byte that makes undici reject a header value — and, MEASURED on Node
 * 24.13, embed that value verbatim in the `TypeError` it throws. A credential
 * helper emitting a NUL, or a multi-line payload whose interior newline
 * survives `resolveToken`'s end-only trim, puts one here.
 */
export const NUL = String.fromCodePoint(0);

/**
 * A `fetchImpl` that performs the real undici header validation — the same
 * `new Headers(init.headers)` that `fetch` does internally — and nothing else.
 * No socket is opened; the throw happens before any connection.
 *
 * 🔑 Deliberately NOT a stub of the error. The suites using this are proving a
 * REAL undici `TypeError` cannot carry a token out; mocking the throw would
 * test the redaction against a hazard we invented rather than the one that
 * exists.
 *
 * The `x-auth-sent` response header reports whether an Authorization header
 * survived to the request, which is what cross-origin-strip assertions read.
 */
export const undiciHeaderValidatingFetch = ((_url: string | URL, init?: RequestInit) => {
  const validated = new Headers(init?.headers);
  return Promise.resolve(
    new Response(null, { status: 200, headers: { 'x-auth-sent': String(validated.has('authorization')) } }),
  );
}) as typeof fetch;

function headersToObject(headers: unknown): Record<string, string> {
  if (headers === undefined || headers === null) return {};
  if (headers instanceof Headers) {
    const out: Record<string, string> = {};
    for (const [k, v] of headers) {
      out[k] = v;
    }
    return out;
  }
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return { ...(headers as Record<string, string>) };
}
