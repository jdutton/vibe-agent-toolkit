/**
 * Test-only mocks for `fetch`-shaped functions, used by the linkAuth tests
 * in this package and intended for reuse by slice 3+ content-fetch tests.
 *
 * Three patterns:
 *   - `sequenceFetch(responses)` — script an ordered sequence of responses
 *     with per-call URL/header assertions. Used by `link-auth-fetch.test.ts`
 *     to test redirect + 429 chains.
 *   - `countingFetch()` — observe whether `fetch` was called and how many
 *     times. Used to assert "unverified short-circuit doesn't call fetch."
 *   - `capturingFetch(extract)` — capture one piece of request data (URL or
 *     headers) for later assertion. Returns a 200 response so the caller
 *     can run an end-to-end flow.
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
