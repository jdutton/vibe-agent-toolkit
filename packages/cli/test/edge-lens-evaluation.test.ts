/**
 * Evaluating the authored-link lens over a projection's extents.
 *
 * The properties here are the ones a caller's SQL depends on and that no type
 * enforces: that every extent gets its own lens rather than one arbitrary
 * extent's answer standing in for the corpus, that the lens rows validate
 * against the same shipped schema a declared lens would, and that the rows a
 * lens produces carry that lens's own id — without which a `GROUP BY` over two
 * extents silently sums two different populations.
 */

import { ResolutionContextRowSchema, type Projection } from '@vibe-agent-toolkit/resources';
import { describe, expect, it } from 'vitest';

import { authoredLensId, evaluateAuthoredLenses } from '../src/utils/edge-lens-evaluation.js';

/** An empty projection with the contexts a case needs, and nothing else. */
function projectionWith(contexts: Projection['resolutionContexts']): Projection {
  return {
    roots: [],
    resources: [],
    resourceRealizations: [],
    resourceExtents: [],
    resourceTags: [],
    realizationConditions: [],
    resolutionContexts: contexts,
    zoneProvenance: [],
    blobs: [],
    blobReferences: [],
    blobSections: [],
    blobConditions: [],
  };
}

/** One extent context. */
function extent(contextId: string, kind = 'filesystem'): Projection['resolutionContexts'][number] {
  return { contextId, species: 'extent', kind, rootId: 'root-x', extentContextId: null, role: null };
}

describe('evaluateAuthoredLenses', () => {
  it('mints one lens per extent, each naming the extent it reads over', () => {
    const { lensContexts } = evaluateAuthoredLenses(
      projectionWith([extent('ctx-a'), extent('ctx-b', 'agentic-convention')]),
    );
    expect(lensContexts.map((row) => row.extentContextId)).toEqual(['ctx-a', 'ctx-b']);
    expect(new Set(lensContexts.map((row) => row.species))).toEqual(new Set(['lens']));
  });

  it('emits lens rows that satisfy the shipped resolution-context schema', () => {
    // The schema's `superRefine` is what enforces "a lens must name the extent
    // it reads over" and "role is only meaningful when kind is tree". Validating
    // here means an invented lens is held to exactly the contract a declared one
    // is, rather than to whatever this module happened to construct.
    const { lensContexts } = evaluateAuthoredLenses(projectionWith([extent('ctx-a')]));
    expect(lensContexts).toHaveLength(1);
    for (const row of lensContexts) {
      expect(() => ResolutionContextRowSchema.parse(row)).not.toThrow();
    }
  });

  it('derives a lens id from its extent, so the same tree answers the same way twice', () => {
    const first = evaluateAuthoredLenses(projectionWith([extent('ctx-a')]));
    const second = evaluateAuthoredLenses(projectionWith([extent('ctx-a')]));
    expect(first.lensContexts[0]?.contextId).toBe(second.lensContexts[0]?.contextId);
    expect(first.lensContexts[0]?.contextId).toBe(authoredLensId('ctx-a'));
  });

  it('gives two extents DIFFERENT lens ids, so a GROUP BY cannot merge them', () => {
    const { lensContexts } = evaluateAuthoredLenses(projectionWith([extent('ctx-a'), extent('ctx-b')]));
    expect(new Set(lensContexts.map((row) => row.contextId)).size).toBe(2);
  });

  it('reads over no LENS context, only extents', () => {
    // Nothing in the population mints a lens today. If something ever does, a
    // lens over a lens is not a thing this evaluation models, and it must be
    // skipped rather than silently treated as an extent.
    const { lensContexts } = evaluateAuthoredLenses(
      projectionWith([
        extent('ctx-a'),
        { contextId: 'ctx-lens', species: 'lens', kind: 'wiki', rootId: 'root-x', extentContextId: 'ctx-a', role: null },
      ]),
    );
    expect(lensContexts.map((row) => row.extentContextId)).toEqual(['ctx-a']);
  });

  it('produces nothing at all for a projection with no extents', () => {
    expect(evaluateAuthoredLenses(projectionWith([]))).toEqual({
      lensContexts: [],
      edges: [],
      edgeResolutions: [],
    });
  });
});
