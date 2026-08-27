/**
 * Classify a response from an authenticated external-link fetch into one of
 * the outcomes defined in design issue #113 §7.
 *
 * Pure function: takes the HTTP status from a completed fetch plus the
 * matched provider's `check` block, returns the outcome name and the matching
 * `LINK_AUTH_*` code from `CODE_REGISTRY`. Pre-fetch outcomes (`unsupported`,
 * `unverified`) are produced upstream by `resolveAuthenticatedUrl` and never
 * reach this classifier.
 *
 * Status codes that don't match any classified outcome return `null` — the
 * caller falls through to the existing anonymous `EXTERNAL_URL_DEAD` path
 * (per §7 "unsupported"), since the authenticated fetch produced no signal
 * the per-provider table can speak to.
 */

import type { ProviderCheck } from './link-auth/resolve.js';

export type LinkAuthOutcome =
  | { readonly outcome: 'alive'; readonly code: null }
  | { readonly outcome: 'dead'; readonly code: 'LINK_AUTH_DEAD' }
  | {
      readonly outcome: 'dead_or_unauthorized';
      readonly code: 'LINK_AUTH_DEAD_OR_UNAUTHORIZED';
    }
  | { readonly outcome: 'forbidden'; readonly code: 'LINK_AUTH_FORBIDDEN' }
  | { readonly outcome: 'unauthorized'; readonly code: 'LINK_AUTH_UNAUTHORIZED' };

export function classifyAuthenticatedResponse(
  status: number,
  check: ProviderCheck,
): LinkAuthOutcome | null {
  // aliveStatus wins first: a provider can in principle declare any code as
  // alive (e.g. a future host where 204 means alive), so the membership test
  // runs before the well-known-status branches.
  if (check.aliveStatus.includes(status)) {
    return { outcome: 'alive', code: null };
  }

  if (status === 401) {
    return { outcome: 'unauthorized', code: 'LINK_AUTH_UNAUTHORIZED' };
  }

  if (status === 403) {
    return { outcome: 'forbidden', code: 'LINK_AUTH_FORBIDDEN' };
  }

  if (status === 404 || status === 410) {
    if (check.notFoundMeaning === 'dead') {
      return { outcome: 'dead', code: 'LINK_AUTH_DEAD' };
    }
    return {
      outcome: 'dead_or_unauthorized',
      code: 'LINK_AUTH_DEAD_OR_UNAUTHORIZED',
    };
  }

  // 2xx not in aliveStatus, 3xx redirects, 429 rate-limit, 5xx server errors
  // — none of these are classified per §7. Caller decides what to do.
  return null;
}
