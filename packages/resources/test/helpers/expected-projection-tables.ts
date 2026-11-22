/**
 * The projection's tables, in {@link Projection}'s declaration order: the one
 * hand-kept pin the export and table-registry suites both assert against.
 *
 * `satisfies readonly (keyof Projection)[]` makes a renamed table a compile
 * error here; the suites' runtime assertions make an *added* or *removed* one a
 * red test, which is the half the compiler cannot cover once esbuild has
 * stripped the types.
 */

import type { Projection } from '../../src/projection/projection.js';

export const EXPECTED_TABLES = [
  'roots',
  'resources',
  'resourceRealizations',
  'resourceExtents',
  'resourceTags',
  'realizationConditions',
  'claudeRulePatterns',
  'resolutionContexts',
  'zoneProvenance',
  'blobs',
  'blobReferences',
  'blobSections',
  'blobConditions',
  'harnessBlobFacts',
  'harnessBlobImports',
  'skillTextFacts',
  'skillTextMatches',
] as const satisfies readonly (keyof Projection)[];
