/**
 * An empty `Projection` — every table empty.
 *
 * Shared by `claude/context-envelope-limits.test.ts` and
 * `claude/context-estimate-lines.test.ts`, both of which need only a
 * projection to satisfy `answerDocument`'s signature (its rows come from a
 * hand-built `LoadedContextAnswer`, never from this projection) — `account()`
 * over no rows still produces totals, and its correctness is pinned in
 * `@vibe-agent-toolkit/resources` where it lives. Populating a real tree here
 * would buy nothing and make either suite a slow test of somebody else's code.
 */

import type { Projection } from '@vibe-agent-toolkit/resources';

/**
 * @returns A projection with every table empty
 */
export function emptyClaudeContextProjection(): Projection {
  return {
    roots: [],
    resources: [],
    resourceRealizations: [],
    resourceExtents: [],
    resourceTags: [],
    realizationConditions: [],
    claudeRulePatterns: [],
    resolutionContexts: [],
    zoneProvenance: [],
    blobs: [],
    blobReferences: [],
    blobSections: [],
    blobConditions: [],
    harnessBlobFacts: [], harnessBlobImports: [],
  };
}
