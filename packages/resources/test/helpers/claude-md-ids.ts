import { CLAUDE_MD_TAG } from '../../src/projection/agentic-tags.js';
import type { Projection } from '../../src/projection/projection.js';

/**
 * The `claude-md`-tagged identities, re-derived for an oracle.
 *
 * ⛔ Deliberately NOT `claudeMdIdentities` from `claude-context-regions.ts`,
 * which is the SHIPPED derivation and is exported. Both differential oracles
 * that use this — the budget sweep's and the cost map's — exist to check a
 * collapsed computation against a naive one, and an oracle that reaches for the
 * production helper is comparing the shipped code to itself. The duplication
 * against production is the point.
 *
 * ⚠️ It is shared between the two TEST files, though, and that is a different
 * question: two copies of an oracle's apparatus is not independence, it is two
 * places for the same apparatus to be weakened separately — and jscpd fails the
 * build on it. One copy here, read by both.
 *
 * @param projection - The populated projection
 * @returns Every `resourceId` carrying {@link CLAUDE_MD_TAG}
 */
export function claudeMdIdsOf(projection: Projection): ReadonlySet<string> {
  return new Set(
    projection.resourceTags
      .filter((tag) => tag.tag === CLAUDE_MD_TAG)
      .map((tag) => tag.resourceId),
  );
}
