/**
 * Provider selection by URL host.
 *
 * Iterates the configured providers in order; the first one whose `match.host`
 * glob matches the URL hostname (and no `match.excludeHost` glob excludes it)
 * claims the URL. Returns `undefined` if no provider claims it — the caller
 * then falls back to anonymous link-checking.
 *
 * Hostname matching is case-insensitive per RFC 3986. Pattern syntax follows
 * `picomatch` (already a utils dep): `*` matches any character, `**` matches
 * across `/`. For hostnames (no slashes) the practical effect is that `*`
 * happily matches dots — e.g. `*.sharepoint.com` claims both
 * `contoso.sharepoint.com` and `foo.bar.sharepoint.com`.
 *
 * Per design issue #113 §4 (vocabulary item 1: match.host + excludeHost).
 */

import picomatch from 'picomatch';

export interface ProviderMatch {
  readonly host: string;
  readonly excludeHost?: readonly string[];
}

/**
 * Find the first provider whose `match` claims the given URL.
 *
 * @returns the matching provider, or `undefined` if none claim the URL (no
 *   pattern matched, all candidates were excluded, or the URL is malformed).
 */
export function selectProvider<P extends { readonly match: ProviderMatch }>(
  url: string,
  providers: readonly P[],
): P | undefined {
  const host = extractHostname(url);
  if (host === undefined) return undefined;

  for (const provider of providers) {
    if (matches(host, provider.match)) {
      return provider;
    }
  }
  return undefined;
}

function extractHostname(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function matches(host: string, match: ProviderMatch): boolean {
  const lowerHost = host.toLowerCase();
  if (!picomatch.isMatch(lowerHost, match.host.toLowerCase())) return false;

  if (match.excludeHost !== undefined) {
    for (const pattern of match.excludeHost) {
      if (picomatch.isMatch(lowerHost, pattern.toLowerCase())) return false;
    }
  }
  return true;
}
