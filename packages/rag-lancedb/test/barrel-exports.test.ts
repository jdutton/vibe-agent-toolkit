/**
 * The `.` barrel's runtime export set — a ratchet, both ways. How to react when
 * this fails is written on `findBarrelDrift` in
 * `packages/dev-tools/src/pin-barrel-exports.ts`; in one line: a removal is a
 * breaking change (restore it, or record it in CHANGELOG.md), an addition is
 * deliberate and needs a consumer outside this package before it is added here.
 */

import { describe, expect, it } from 'vitest';

import { findBarrelDrift } from '../../dev-tools/src/pin-barrel-exports.js';

const BARREL_EXPORTS = [
  'ESTIMATOR_DIVERGENCE_FACTOR',
  'LANCEDB_QUERY_SUPPORT',
  'LanceDBRAGProvider',
  'SPECIAL_TOKEN_OVERHEAD',
  'buildMetadataFilter',
  'buildMetadataWhereClause',
  'buildWhereClause',
  'chunkToLanceRow',
  'lanceRowToChunk',
  'resolveChunkingConfig',
];

describe('@vibe-agent-toolkit/rag-lancedb — the `.` barrel export surface', () => {
  it('exports exactly the recorded set, sorted — nothing added, dropped, or out of order', async () => {
    expect(findBarrelDrift(await import('../src/index.js'), BARREL_EXPORTS)).toEqual({ added: [], removed: [], unsorted: [] });
  });
});
