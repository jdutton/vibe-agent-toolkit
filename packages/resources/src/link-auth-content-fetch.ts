/**
 * Public content-fetch primitive for the linkAuth feature (design issue #113 §6.2).
 *
 * Ships as a standalone primitive — no consumer wiring (asset-references,
 * bundling) lands in this slice. The shape and security disciplines are
 * designed so future callers can adopt it without reworking the contract.
 *
 * Responsibility split:
 *   - `resolveAuthenticatedUrl` (engine): pick provider, rewrite URL, resolve
 *     token, expand auth.headers AND fetch.headers against the same context.
 *   - `ContentCache`: persist `(bytes, metadata)` keyed by rewritten URL with
 *     30-min default TTL; whitelists fields so tokens cannot be persisted.
 *   - `authTransport`: cross-origin auth strip, 429/Retry-After handling.
 *   - **This primitive**: wire them together, decide cache vs fetch, build
 *     metadata, return a typed result.
 *
 * Behavior matrix:
 *   - Engine returns `unsupported` → return as-is, no fetch, no cache touch.
 *   - Engine returns `unverified` → return as-is, no fetch, **no cache touch**
 *     even if a cache was supplied (§6.3: result flips when a token appears,
 *     so caching the no-token answer would poison future runs).
 *   - Engine returns success + cache present + not forceRefresh + cache hit →
 *     return `{ bytes, metadata, cached: true }`, no fetch.
 *   - Engine returns success otherwise → fetch via `authTransport` (using
 *     `fetch.headers` merged over `auth.headers` when present), write to
 *     cache if supplied, return `{ bytes, metadata, cached: false }`.
 *
 * **Throws** on network-level failures from the transport: DNS resolution
 * failure, TLS handshake failure, connection refused, `AbortError` from the
 * caller's `signal`, or any underlying `fetchImpl` rejection. The cache is
 * only touched after the response body is fully read, so a transport failure
 * cannot land a partial entry on disk. Consumers that need degradation
 * semantics (validators, batch tools) should wrap calls in a try/catch.
 *
 * **Token never persisted.** Tokens are interpolated into headers in-memory;
 * the metadata interface excludes header fields. The cache additionally
 * whitelists the metadata fields it accepts. See cycle-6 token-persistence
 * test for the on-disk assertion.
 *
 * **High-volume callers**: token resolution can be expensive (`gh auth token`
 * spawns a subprocess). Callers iterating many URLs should wrap their `deps`
 * once with `wrapLinkAuthDepsWithMemo` from `./link-auth-deps-memo.js` and
 * pass the wrapped object to every invocation, so the same argv resolves at
 * most once across the iteration.
 */

import { resolveAuthenticatedUrl, type LinkAuthConfig } from '@vibe-agent-toolkit/utils';

import { type ContentCache } from './content-cache.js';
import { type LinkAuthDeps } from './link-auth-deps-memo.js';
import { authTransport, type AuthTransportOptions } from './link-auth-transport.js';
import { type ContentMetadata } from './schemas/content-cache.js';

export interface FetchAuthenticatedOptions {
  /** Content cache to read from and write to. Omit to skip caching entirely. */
  readonly cache?: ContentCache;
  /** Bypass cache reads (still writes through on success). Default: false. */
  readonly forceRefresh?: boolean;
  /** Test/DI hook. Default: `globalThis.fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Token-resolution dependencies (env map, runCommand). Default: engine defaults. */
  readonly deps?: LinkAuthDeps;
  /** Propagated to the transport — caller's per-request timeout budget. */
  readonly signal?: AbortSignal;
  /** Per-call overrides for the transport's redirect / retry caps. */
  readonly transportOptions?: AuthTransportOptions;
}

export type ContentFetchResult =
  | {
      readonly bytes: Uint8Array;
      readonly metadata: ContentMetadata;
      readonly cached: boolean;
    }
  | { readonly outcome: 'unsupported' }
  | { readonly outcome: 'unverified'; readonly reason: string };

export async function fetchAuthenticated(
  url: string,
  config: LinkAuthConfig,
  options: FetchAuthenticatedOptions = {},
): Promise<ContentFetchResult> {
  const plan = resolveAuthenticatedUrl(url, config, options.deps);
  // Discriminate via Object.hasOwn (not `'fetchUrl' in plan`) so a prototype-
  // injected `fetchUrl` field cannot reroute a non-success outcome onto the
  // cache/fetch path. The engine controls plan shape — defending in depth.
  if (!Object.hasOwn(plan, 'fetchUrl')) {
    // unsupported / unverified — both short-circuit without fetch or cache.
    const failure = plan as Exclude<typeof plan, { fetchUrl: string }>;
    return failure.outcome === 'unverified'
      ? { outcome: 'unverified', reason: failure.reason }
      : { outcome: 'unsupported' };
  }
  const success = plan as Extract<typeof plan, { fetchUrl: string }>;

  const cache = options.cache;
  if (cache !== undefined && options.forceRefresh !== true) {
    const hit = await cache.get(success.fetchUrl);
    if (hit !== null) {
      return { bytes: hit.bytes, metadata: hit.metadata, cached: true };
    }
  }

  // Merge headers: start from auth (covers Authorization + check-mode Accept),
  // layer fetch.headers on top (overrides on conflict — e.g. swap the GitHub
  // Accept from +json to .raw). Both header objects come from the engine, so
  // both have the resolved token baked in (§6.2 dual-expand).
  const requestHeaders: Record<string, string> = {
    ...success.headers,
    ...(success.fetchHeaders ?? {}),
  };

  const transportOptions: AuthTransportOptions = {
    ...(options.transportOptions ?? {}),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };

  const response = await authTransport(
    success.fetchUrl,
    requestHeaders,
    options.fetchImpl ?? globalThis.fetch,
    transportOptions,
  );

  // Read full body as bytes. We use arrayBuffer (binary-clean) and wrap into a
  // fresh Uint8Array so the caller doesn't hold a view onto fetch's internal
  // buffer.
  const arrayBuffer = await response.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);

  const metadata: ContentMetadata = {
    status: response.status,
    contentType: response.headers.get('content-type'),
    etag: response.headers.get('etag'),
    lastModified: response.headers.get('last-modified'),
    fetchedAt: Date.now(),
    rewrittenUrl: success.fetchUrl,
  };

  // Write-through. The ContentCache whitelists fields and fails soft on IO,
  // so a write failure does not propagate.
  if (cache !== undefined) {
    await cache.set(success.fetchUrl, bytes, metadata);
  }

  return { bytes, metadata, cached: false };
}
