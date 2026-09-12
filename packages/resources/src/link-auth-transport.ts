/**
 * Auth-safe HTTP transport for the linkAuth feature (design issue #113 §5.2, §8).
 *
 * Lower-level than the public `fetchAuthenticated` primitive — this transport
 * does not know about providers, token resolution, or caching. It takes a URL
 * + already-built headers and adds two behaviors required by the design:
 *
 *   §8 (cross-origin token leak defense) — `redirect: 'manual'`, then a
 *   bounded loop that follows Location headers. On any redirect to a
 *   different origin EVERY adopter-supplied header is dropped and stays
 *   dropped for subsequent hops (defeats token-laundering via a cross-origin
 *   bounce back to the original host). See `computeRedirect` for why the
 *   whole set and not the one named `Authorization`.
 *
 *   §5.2 (rate-limit handling) — on HTTP 429, parse `Retry-After` (seconds or
 *   HTTP-date), wait, retry. Bounded by `maxRetries` so a stuck host cannot
 *   hang validation; bounded by `maxRetryAfterMs` so a hostile or buggy host
 *   cannot pin a validation run for an hour with `Retry-After: 86400`.
 *
 *   §8 (token leak via error text) — anything `fetchImpl` throws is replaced
 *   with an `AuthTransportError` when its text exposes a header value; the
 *   replacement carries the same account with every value scrubbed. A throw
 *   that exposes nothing is rethrown as-is, object identity intact. See
 *   `fetchRedacting` for the measured undici case.
 *
 * Pure-ish: `fetchImpl` and `sleep` are dependency-injected so tests do not
 * touch the network or wall-clock. Production callers pass `globalThis.fetch`.
 */

import { redactSecretsInText, sensitiveHeaderValues } from './link-auth/build-headers.js';

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

    const response = await fetchRedacting(fetchImpl, currentUrl, init, headers);

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
 * Thrown in place of whatever the fetch implementation threw, with every
 * sensitive header value scrubbed out of the text.
 *
 * A fresh error rather than a re-thrown one on purpose: the original's
 * `.message`, `.stack` and `.cause` chain are all places the value can hide,
 * and `util.inspect` prints all three. Keeping the original as `cause` would
 * re-open exactly the hole this closes, so the original object is dropped and
 * its `name` + redacted `message` are folded into the text instead.
 */
export class AuthTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthTransportError';
  }
}

/**
 * Call `fetchImpl`, and convert anything it throws that exposes a header value
 * into an {@link AuthTransportError} whose text cannot contain a token.
 *
 * 🚨 **This is the live half of the design's §8 "tokens never leak".**
 * A map masker (the deleted `redactHeaders`) could only protect a header MAP
 * that VAT itself serializes; it was powerless against a value already pasted
 * into a string by code that never saw it. MEASURED on Node 24.13: an
 * `Authorization` value carrying a NUL or an interior newline — which is
 * exactly what `command: git credential fill` yields, since `resolveToken`
 * only trims the ends — makes undici throw
 * `TypeError: Headers.append: "Bearer <tok>\0" is an invalid header value.`
 * `ExternalLinkValidator` then serializes that `.message` into the result's
 * `error` field and `vat resources validate` prints it.
 *
 * Redaction keys off the headers passed in at the top of the run rather than
 * the current hop's map, because the current map is only ever a subset (the
 * cross-origin strip removes headers, never adds a value) — so the
 * original set is the safe superset for the whole loop. Every value in that
 * set counts as a secret, whatever its header name — see
 * {@link sensitiveHeaderValues}.
 */
async function fetchRedacting(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  originalHeaders: Record<string, string>,
): Promise<Response> {
  try {
    return await fetchImpl(url, init);
  } catch (error) {
    throw redactThrownValue(error, sensitiveHeaderValues(originalHeaders));
  }
}

/**
 * Return the thrown value unchanged unless it exposes one of `secrets`, in
 * which case return an {@link AuthTransportError} carrying the same account of
 * what happened with the secret masked.
 *
 * 🔑 **Untouched when there is nothing to hide.** The overwhelmingly common
 * throw here is an ordinary network failure, and its `Error` instance — exact
 * message, stack, `cause` chain, class — is the most useful thing the operator
 * can be handed. Rewrapping every one of them to guard the rare case would
 * degrade every diagnosis to pay for one. So the swap happens only when the
 * redaction actually changed the text.
 *
 * The probe walks the `cause` chain, not just `.message`, because `util.inspect`
 * prints causes and undici nests its real error one level down.
 */
function redactThrownValue(error: unknown, secrets: readonly string[]): unknown {
  if (secrets.length === 0) return error;
  const exposed = describeThrown(error);
  const redacted = redactSecretsInText(exposed, secrets);
  return redacted === exposed ? error : new AuthTransportError(redacted);
}

/** Flatten a thrown value — and its `cause` chain — into one probe string. */
function describeThrown(error: unknown): string {
  if (!(error instanceof Error)) return safeJson(error);

  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    parts.push(`${current.name}: ${current.message}`);
    current = current.cause;
  }
  if (current !== undefined && current !== null) parts.push(safeJson(current));
  return parts.join(' | ');
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    // Circular or BigInt-bearing. String() still reveals enough to redact against.
    return String(value);
  }
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
 * redirect / has no Location.
 *
 * 🔑 **A cross-origin hop carries NO adopter-supplied header — the whole set
 * is dropped, not the one named `Authorization`.** The set is `auth.headers`
 * (or `fetch.headers`), an open record the adopter writes whose every value
 * is a rendered secret-bearing template by contract — GitLab's documented
 * header is `PRIVATE-TOKEN`, API-key hosts use `X-API-Key`. Stripping by
 * NAME is the instance shape: whichever name the list omits rides the bounce
 * to the other origin, and that origin can be anyone who controls a
 * `Location` header. It is the same premise `sensitiveHeaderValues` rests on
 * for redaction; the two must not disagree about which values are secrets.
 * The cost is that a non-secret companion (`Accept`) is dropped too, so a
 * cross-origin hop is fetched bare — an origin VAT was never configured to
 * authenticate against has no claim on those headers either.
 *
 * Once dropped, stays dropped: `currentHeaders` is never re-widened, so a
 * bounce back to the original origin arrives bare too (§8 token laundering).
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
    headers: sameOrigin ? currentHeaders : {},
  };
}
