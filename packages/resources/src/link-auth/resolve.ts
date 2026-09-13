/**
 * Public API for the linkAuth pure engine.
 *
 * `resolveAuthenticatedUrl(url, config)` is the single entry point per design
 * §6: select the first provider whose `match.host` claims the URL, run its
 * rewrite pipeline, resolve a token, build the auth headers, and return
 * everything the caller needs to issue an authenticated fetch.
 *
 * Four outcomes:
 *   - `{ fetchUrl, headers }`                  — ready to fetch (provider claimed,
 *                                                rewrite matched, token resolved)
 *   - `{ outcome: 'unsupported' }`             — no provider claims the host, OR
 *                                                host matched but no rewrite did
 *                                                (per §4: "the provider does not
 *                                                claim the URL for rewriting")
 *   - `{ outcome: 'unverified', reason }`      — claimed and rewrote, but no token
 *                                                source resolved a non-empty value
 *   - `{ outcome: 'provider-error', reason }`  — the provider's own config threw
 *                                                while building the request for
 *                                                THIS url (see
 *                                                `describeProviderFailure`)
 *
 * **This function does not throw.** Everything the engine can go wrong on —
 * an uncompilable `match.host` glob, an uncompilable `when`, a malformed
 * template, an unknown transform, a capture that did not participate — comes
 * back as `provider-error`, because the only caller invokes it outside a
 * try/catch and a throw there ends the whole validation run.
 *
 * 🔑 `provider-error` is NOT `unverified`, and the split is the point.
 * `unverified` means "no token", and its registry remedy invites a token-less
 * CI lane to set the code to `ignore`; a provider that could not build a
 * request is a config defect, and reporting it under the ignorable code is how
 * a broken provider produced a green run over links nothing had fetched. The
 * statically knowable defects never reach here from `resources.linkAuth` —
 * `buildLinkAuthEngineConfig` refuses them at config time (compile-check.ts);
 * what arrives is a hand-built config, or a per-URL failure such as a declared
 * capture group that did not participate in this match.
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

/**
 * Optional content-fetch header overrides (design issue #113 §6.2).
 *
 * Health-check and content retrieval often need different `Accept` (or other)
 * headers. The canonical example: GitHub's `application/vnd.github+json`
 * returns 200 for any size but omits bytes >1 MiB, while
 * `application/vnd.github.raw` streams the bytes inline. The provider declares
 * `auth.headers` for health-check and an optional `fetch.headers` for content
 * retrieval. Both are templated against the same context (URL captures + token).
 */
export interface ProviderFetch {
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
  /**
   * Optional — present when a provider needs different headers for content
   * retrieval than for health-check. Absent for hosts where one header set
   * does both jobs.
   */
  readonly fetch?: ProviderFetch;
  readonly token: readonly TokenSource[];
  readonly check: ProviderCheck;
}

export interface LinkAuthConfig {
  readonly providers: readonly Provider[];
  /**
   * Optional content-cache config (consumed by the slice-3 content-fetch
   * primitive, not by the engine itself). The engine stays stateless; this
   * field rides along on the config object so the primitive doesn't need a
   * second source of truth.
   */
  readonly cache?: {
    readonly ttlMinutes?: number;
  };
}

export type ResolveOutcome =
  | {
      readonly fetchUrl: string;
      readonly headers: Record<string, string>;
      /**
       * Expanded fetch-mode headers, only present when the provider declared
       * a `fetch` block. Templated against the same context as `headers`
       * (URL captures + resolved token), so callers do not need to re-resolve
       * the token to send these. Per §6.2 — content-fetch consumers send
       * these instead of (or merged over) `headers` for the request body.
       */
      readonly fetchHeaders?: Record<string, string>;
      /**
       * The matched provider's `check` block, passed through so the post-fetch
       * classifier (in `packages/resources`) can route status codes to outcomes
       * without re-running `selectProvider`. Reading this from the engine —
       * rather than asking the validator to re-derive it — keeps the
       * provider-match decision in exactly one place.
       */
      readonly check: ProviderCheck;
    }
  | { readonly outcome: 'unsupported' }
  | { readonly outcome: 'unverified'; readonly reason: string }
  | { readonly outcome: 'provider-error'; readonly reason: string };

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
  // Declared outside the try: the catch names the provider in the reason.
  // `selectProvider` runs INSIDE the try — it compiles adopter-authored
  // `match.host` globs, and picomatch refuses an over-long pattern with a
  // throw, which is a provider-config error like any other and must degrade
  // one link, not end the run.
  let provider: Provider | undefined;
  try {
    provider = selectProvider(url, config.providers);
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
    // Expand fetch.headers against the same context so the resolved token wins
    // over any URL-captured "token" group here too — the precedence discipline
    // applies to both header sets, not just auth.headers.
    const fetchHeaders =
      provider.fetch === undefined
        ? undefined
        : buildHeaders(provider.fetch.headers, headerContext);
    return {
      fetchUrl: rewrite.rewrittenUrl,
      headers,
      ...(fetchHeaders === undefined ? {} : { fetchHeaders }),
      check: provider.check,
    };
  } catch (error) {
    return { outcome: 'provider-error', reason: describeProviderFailure(provider, error) };
  }
}

/**
 * Turn an engine-internal throw into the text of a `provider-error` outcome.
 *
 * 🚨 **This catch is the process boundary, not a convenience.**
 * `ExternalLinkValidator.validateLink` calls `resolveAuthenticatedUrl` outside
 * any try/catch, so anything escaping here ends `vat resources validate` and
 * `vat audit` over the entire tree — for every adopter that configured
 * `resources.linkAuth`, on account of one link. A provider that fails on one
 * URL is a finding about that link; it is not a reason to stop validating the
 * other several thousand.
 *
 * The validator surfaces the outcome as `LINK_AUTH_PROVIDER_ERROR` with this
 * reason attached, which reaches stdout. **The reason quotes the template, the
 * pattern or a name — never a substituted value.** Every error the try can
 * catch is built that way (`InvalidRewriteRuleError` carries the pattern,
 * `TemplateMissingVarError` / `TemplateSyntaxError` the template,
 * `UnknownTransformError` the name, picomatch's `SyntaxError` a length, and
 * `URIError` nothing), so the resolved token and the URL captures cannot enter
 * this text. That property is pinned by test rather than guarded by a scrub:
 * a scrub here had no input that could contain a token, and its guard test
 * passed with the call deleted. Rendered header values meet outside error
 * text in exactly one place, the transport, which owns that redaction.
 */
function describeProviderFailure(provider: Provider | undefined, error: unknown): string {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  // No provider means selection itself threw — a `match.host` glob picomatch
  // refused — so there is no host to name yet.
  const subject =
    provider === undefined
      ? 'linkAuth provider selection (a `match.host` glob) failed'
      : `linkAuth provider for host "${provider.match.host}" could not build a request`;
  return `${subject}: ${detail}`;
}
