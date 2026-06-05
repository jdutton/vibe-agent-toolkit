/**
 * Public API for the linkAuth pure engine.
 *
 * `resolveAuthenticatedUrl(url, config)` is the single entry point per design
 * §6: select the first provider whose `match.host` claims the URL, run its
 * rewrite pipeline, resolve a token, build the auth headers, and return
 * everything the caller needs to issue an authenticated fetch.
 *
 * Three outcomes:
 *   - `{ fetchUrl, headers }`              — ready to fetch (provider claimed,
 *                                            rewrite matched, token resolved)
 *   - `{ outcome: 'unsupported' }`         — no provider claims the host, OR
 *                                            host matched but no rewrite did
 *                                            (per §4: "the provider does not
 *                                            claim the URL for rewriting")
 *   - `{ outcome: 'unverified', reason }`  — claimed and rewrote, but no token
 *                                            source resolved a non-empty value
 *
 * Per design issue #113 §6.
 */

import { buildHeaders } from './build-headers.js';
import {
  resolveToken,
  type TokenResolutionDeps,
  type TokenSource,
} from './resolve-token.js';
import { type RewriteRule, rewriteUrl } from './rewrite.js';
import { type ProviderMatch, selectProvider } from './select-provider.js';

export interface ProviderAuth {
  readonly headers: Record<string, string>;
}

export interface ProviderCheck {
  readonly method: 'GET' | 'HEAD';
  readonly aliveStatus: readonly number[];
  readonly notFoundMeaning: 'ambiguous' | 'dead';
}

export interface Provider {
  readonly match: ProviderMatch;
  readonly rewrite: readonly RewriteRule[];
  readonly auth: ProviderAuth;
  readonly token: readonly TokenSource[];
  readonly check: ProviderCheck;
}

export interface LinkAuthConfig {
  readonly providers: readonly Provider[];
  // `cache` lands in slice 3 (content-fetch primitive). Not used by the
  // pure engine.
}

export type ResolveOutcome =
  | { readonly fetchUrl: string; readonly headers: Record<string, string> }
  | { readonly outcome: 'unsupported' }
  | { readonly outcome: 'unverified'; readonly reason: string };

/**
 * Resolve an authenticated fetch plan for `url` against the configured providers.
 *
 * @param deps - Optional dependency injection for token resolution (`env` map
 *   + `runCommand`). Production callers omit this; tests supply mocks.
 */
export function resolveAuthenticatedUrl(
  url: string,
  config: LinkAuthConfig,
  deps?: Partial<TokenResolutionDeps>,
): ResolveOutcome {
  const provider = selectProvider(url, config.providers);
  if (provider === undefined) return { outcome: 'unsupported' };

  const rewrite = rewriteUrl(url, provider.rewrite);
  if (!rewrite.matched) return { outcome: 'unsupported' };

  const token = resolveToken(provider.token, deps);
  // eslint-disable-next-line security/detect-possible-timing-attacks -- compare to undefined sentinel, not secret content
  if (token === undefined) {
    return {
      outcome: 'unverified',
      reason: 'No token source resolved a non-empty value — configure `token` or log in.',
    };
  }

  // Headers see captures + vars + the resolved token. The resolved token wins
  // over any regex capture named "token" (later in Object.assign wins), so
  // URL-derived data never leaks into Authorization values.
  const headerContext = Object.create(null) as Record<string, string>;
  Object.assign(headerContext, rewrite.context);
  headerContext['token'] = token;

  const headers = buildHeaders(provider.auth.headers, headerContext);
  return { fetchUrl: rewrite.rewrittenUrl, headers };
}
