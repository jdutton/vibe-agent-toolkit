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

import { inspect } from 'node:util';

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
 * The probe IS `util.inspect` (plus `JSON.stringify`, for the one thing
 * inspect does not print) — see {@link describeThrown} — and the redaction
 * matches every encoded form of the secret, not only the verbatim bytes (see
 * `redactSecretsInText`).
 */
function redactThrownValue(error: unknown, secrets: readonly string[]): unknown {
  if (secrets.length === 0) return error;
  const exposed = describeThrown(error);
  if (redactSecretsInText(exposed, secrets) === exposed) return error;
  // The replacement's text is the compact account, not the probe: the probe is
  // an inspect dump with a stack trace, which is the right thing to search and
  // the wrong thing to print.
  return new AuthTransportError(redactSecretsInText(summarizeThrown(error), secrets));
}

/**
 * Everything `util.inspect` prints for a thrown value, with no depth, length
 * or visibility cap: the whole `cause` chain and every `AggregateError`
 * member, own properties whether enumerable, non-enumerable or Symbol-keyed,
 * `Map`/`Set`/`Headers` contents, getter values (a throwing getter prints as
 * `[Getter: <Inspection threw …>]` instead of aborting the probe), a
 * reassigned `.stack`, and a circular reference as `[Circular]`.
 */
const INSPECT_EVERYTHING: Parameters<typeof inspect>[1] = {
  depth: Infinity,
  showHidden: true,
  getters: true,
  maxArrayLength: Infinity,
  maxStringLength: Infinity,
  breakLength: Infinity,
};

/**
 * Flatten a thrown value into one probe string covering every place a value
 * can ride on it. Searched, never printed.
 *
 * The probe is `util.inspect` itself, because "would `util.inspect` print it"
 * is the question being asked and no hand-rolled walk answers it as well.
 *
 * 🪤 The walk this replaced ({@link summarizeThrown}, kept for the message)
 * read own properties through `JSON.stringify` and recursed into `cause` and
 * `errors` by hand. `JSON.stringify` prints a `Headers` or `Map` instance as
 * `{}`, skips Symbol-keyed and non-enumerable properties, never reads
 * `.stack`, and throws — abandoning the probe for a bare `String(error)` — on
 * a getter that throws. Each of those shapes was judged "exposes nothing" and
 * the SAME object rethrown, token intact, for `util.inspect` to print.
 * (Before that it read `message` and `cause` only, which missed
 * `AggregateError.errors` and every own property.)
 *
 * `JSON.stringify` stays beside inspect for the one thing inspect does not
 * do: call `toJSON`. A logger that serializes the error as JSON prints what
 * `toJSON` returns, and inspect shows the method, not its result.
 *
 * inspect quotes string properties and escapes their control characters, so
 * the redaction must know that spelling of a secret too — `secretForms` in
 * `build-headers.ts` carries the inspect-escaped body for exactly this probe.
 */
function describeThrown(error: unknown): string {
  return `${inspect(error, INSPECT_EVERYTHING)} | ${safeJson(error)}`;
}

/**
 * The account of a thrown value handed to the operator in the replacement
 * error's message: `name: message` and the JSON of own enumerable properties
 * (`.code`, `.headers`), down the `cause` chain and through an
 * `AggregateError`'s members.
 *
 * This is composition, not detection — {@link describeThrown} decides whether
 * a swap happens, so a shape this walk cannot see costs nothing. Everything it
 * emits still goes through `redactSecretsInText` before it becomes a message.
 */
function summarizeThrown(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  const visit = (value: unknown): void => {
    if (value === undefined || value === null) return;
    if (!(value instanceof Error)) {
      parts.push(safeJson(value));
      return;
    }
    if (seen.has(value)) return;
    seen.add(value);
    parts.push(`${value.name}: ${value.message}`, safeJson(value));
    visit(value.cause);
    if (value instanceof AggregateError) for (const inner of value.errors as unknown[]) visit(inner);
  };
  visit(error);
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
 * The 3xx statuses that redirect. Not every 3xx does — 304 Not Modified is a
 * cache validation answer and RFC 9110 permits a `Location` header on it, so
 * a range test followed it as a redirect and reported hop two's status in
 * place of the 304 the origin actually gave.
 */
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/**
 * Decide the next hop for a redirect, or `null` if the response is not a
 * redirect (see {@link REDIRECT_STATUSES}) / has no Location.
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
  if (!REDIRECT_STATUSES.has(response.status)) return null;
  const location = response.headers.get('location');
  if (location === null) return null;
  const nextUrl = new URL(location, currentUrl).toString();
  const sameOrigin = new URL(nextUrl).origin === new URL(currentUrl).origin;
  return {
    url: nextUrl,
    headers: sameOrigin ? currentHeaders : {},
  };
}
