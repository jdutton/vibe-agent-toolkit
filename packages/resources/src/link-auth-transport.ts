/**
 * Auth-safe HTTP transport for the linkAuth feature (design issue #113 §5.2, §8).
 *
 * Lower-level than the public `fetchAuthenticated` primitive — this transport
 * does not know about providers, token resolution, or caching. It takes a URL
 * + already-built headers and adds two behaviors required by the design:
 *
 *   §8 (cross-origin token leak defense) — `redirect: 'manual'`, then a
 *   bounded loop that follows Location headers. On any redirect to a
 *   different origin the `Authorization` header is stripped and stays
 *   stripped for subsequent hops (defeats token-laundering via a cross-origin
 *   bounce back to the original host).
 *
 *   §5.2 (rate-limit handling) — on HTTP 429, parse `Retry-After` (seconds or
 *   HTTP-date), wait, retry. Bounded by `maxRetries` so a stuck host cannot
 *   hang validation; bounded by `maxRetryAfterMs` so a hostile or buggy host
 *   cannot pin a validation run for an hour with `Retry-After: 86400`.
 *
 * Pure-ish: `fetchImpl` and `sleep` are dependency-injected so tests do not
 * touch the network or wall-clock. Production callers pass `globalThis.fetch`.
 */

export interface AuthTransportOptions {
  /** Maximum redirect hops to follow before returning the last 3xx response (default: 5). */
  readonly maxRedirects?: number;
  /** Maximum 429 retries before returning the final 429 response (default: 2). */
  readonly maxRetries?: number;
  /** Cap on Retry-After in ms; defends against hostile/buggy long values (default: 60_000). */
  readonly maxRetryAfterMs?: number;
  /** Abort signal propagated to every fetchImpl call (validator's per-request timeout budget). */
  readonly signal?: AbortSignal;
  /** Test-only sleep injection. Production callers omit. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_MAX_RETRY_AFTER_MS = 60_000;
/**
 * Minimum delay between 429 retries. A hostile host can send `Retry-After: 0`
 * (or an HTTP-date in the past, parsing to 0); without a floor, we'd retry
 * immediately, which is worse-than-useless for the host's rate-limiting and
 * makes us a poor neighbor. Bounded by `maxRetries` regardless, but the floor
 * gives the host's window a chance to slide.
 */
const MIN_RETRY_AFTER_MS = 250;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Parse a `Retry-After` header value into milliseconds-to-wait.
 *
 * Returns `null` when the value is missing, empty, negative, or unparseable —
 * callers treat `null` as "don't retry" (we can't pick a delay without a hint).
 * HTTP-date values in the past return `0` (the server's hint is "you can retry
 * now"). RFC 7231 §7.1.3.
 */
export function parseRetryAfter(value: string | null): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;

  // delta-seconds form: positive integer count of seconds.
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }

  // HTTP-date form per RFC 7231 §7.1.1.1 — always contains weekday and month
  // names. Guard with /[A-Za-z]/ because Date.parse() is permissive: '-5'
  // parses as year-5 BC, '0' as 1 BC, etc. Requiring at least one letter
  // restricts us to real HTTP-date strings.
  if (!/[A-Za-z]/.test(trimmed)) return null;
  const parsedMs = Date.parse(trimmed);
  if (!Number.isFinite(parsedMs)) return null;
  return Math.max(0, parsedMs - Date.now());
}

export async function authTransport(
  url: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
  options: AuthTransportOptions = {},
): Promise<Response> {
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const maxRetryAfterMs = options.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS;
  const sleep = options.sleep ?? defaultSleep;

  let currentUrl = url;
  let currentHeaders: Record<string, string> = { ...headers };
  let redirects = 0;
  let retries = 0;

  // Bounded loop: every iteration either returns or strictly advances one of
  // (retries, redirects), both capped, so termination is guaranteed within
  // `maxRetries + maxRedirects + 1` fetchImpl calls.
  while (redirects + retries < maxRedirects + maxRetries + 1) {
    const init: RequestInit = {
      headers: currentHeaders,
      redirect: 'manual',
    };
    if (options.signal !== undefined) init.signal = options.signal;

    const response = await fetchImpl(currentUrl, init);

    const retryDelay =
      retries < maxRetries ? computeRetryDelay(response, maxRetryAfterMs) : null;
    if (retryDelay !== null) {
      await sleep(retryDelay);
      retries++;
      continue;
    }

    if (redirects < maxRedirects) {
      const next = computeRedirect(response, currentUrl, currentHeaders);
      if (next !== null) {
        currentUrl = next.url;
        currentHeaders = next.headers;
        redirects++;
        continue;
      }
    }

    return response;
  }
  // Unreachable: the loop returns or continues on every iteration, and the
  // loop condition strictly bounds total iterations.
  throw new Error('authTransport: unreachable iteration cap exceeded');
}

/**
 * Decide the wait-time for a 429 response, or `null` if the response is not
 * a 429 OR has no parseable Retry-After hint (no hint → caller returns the 429
 * rather than retrying blindly).
 */
function computeRetryDelay(response: Response, maxRetryAfterMs: number): number | null {
  if (response.status !== 429) return null;
  const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
  if (retryAfter === null) return null;
  // Two-sided clamp: never longer than the DoS cap, never shorter than the
  // good-neighbor floor (defends against `Retry-After: 0` busy-loops).
  return Math.min(Math.max(retryAfter, MIN_RETRY_AFTER_MS), maxRetryAfterMs);
}

/**
 * Decide the next hop for a 3xx redirect, or `null` if the response is not a
 * redirect / has no Location. Strips Authorization on cross-origin per §8.
 */
function computeRedirect(
  response: Response,
  currentUrl: string,
  currentHeaders: Record<string, string>,
): { url: string; headers: Record<string, string> } | null {
  if (response.status < 300 || response.status >= 400) return null;
  const location = response.headers.get('location');
  if (location === null) return null;
  const nextUrl = new URL(location, currentUrl).toString();
  const sameOrigin = new URL(nextUrl).origin === new URL(currentUrl).origin;
  return {
    url: nextUrl,
    headers: sameOrigin ? currentHeaders : stripAuthorization(currentHeaders),
  };
}

/**
 * Remove any header whose name is `Authorization` (case-insensitive). Returns
 * a new object — does not mutate the input.
 */
function stripAuthorization(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === 'authorization') continue;
    result[name] = value;
  }
  return result;
}
