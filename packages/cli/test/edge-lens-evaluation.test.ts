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
import { safePath } from '@vibe-agent-toolkit/utils';
import { normalizedTmpdir } from '@vibe-agent-toolkit/utils/fs';
import { describe, expect, it } from 'vitest';

import { authoredLensId, evaluateAuthoredLenses } from '../src/utils/edge-lens-evaluation.js';

/** A corpus root that need not exist on disk — resolution reads columns, not files. */
const ROOT = safePath.join(normalizedTmpdir(), 'edge-lens-eval-corpus');

/**
 * One realization per extent, so each lens has something to read.
 *
 * @param contextId - The extent whose member this is
 * @returns A realization row carrying bytes
 */
function realization(contextId: string): Record<string, unknown> {
  return {
    resourceId: `id:${contextId}`,
    extentId: contextId,
    path: `${contextId}.md`,
    pathLower: `${contextId}.md`.toLowerCase(),
    basenameLower: `${contextId}.md`.toLowerCase(),
    dir: '',
    depth: 0,
    ext: '.md',
    contentKey: `key:${contextId}`,
    contentState: 'keyed',
    mtime: null,
    exists: true,
    isDirectory: false,
    gitignored: false,
    isSymlink: false,
    symlinkResolves: null,
  };
}

/**
 * A projection with the contexts a case needs, and one member to read.
 *
 * 🚨 **`roots` MUST be non-empty.** `resolveEdges` returns `{edges: [], …}` on
 * its first two lines for a rootless projection, so an earlier version of this
 * fixture — `roots: []` — made EVERY test in this file vacuous: not one of them
 * executed a single line of edge code, while the file's own header claimed to
 * guard that a lens's rows carry its own id. Deleting the `resolveEdges` call
 * from the module under test left all six green.
 */
function projectionWith(contexts: Projection['resolutionContexts']): Projection {
  return {
    roots: [{ id: 'root-x', path: ROOT, label: null }],
    resources: [],
    resourceRealizations: contexts.map((context) => ({
      ...realization(context.contextId),
    })),
    resourceExtents: contexts.map((context) => ({
      resourceId: `id:${context.contextId}`,
      extentId: context.contextId,
    })),
    resourceTags: [],
    realizationConditions: [],
    resolutionContexts: contexts,
    zoneProvenance: [],
    blobs: [],
    blobReferences: contexts.map((context) => ({
      blob: `key:${context.contextId}`,
      ordinal: 0,
      rawRef: 'https://example.com/x',
      text: null,
      line: 1,
      column: 1,
      startOffset: 0,
      endOffset: 1,
      syntacticForm: 'markdown-link',
      hasExtension: false,
      leadingAt: false,
      slashCount: 2,
      variableExpansion: null,
      inCodeSpan: false,
      inFence: false,
    })),
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

  it('actually PRODUCES edge rows, each carrying its own lens id', () => {
    // 🚨 The property the file's header always claimed and never tested. Without
    // a non-empty `roots`, `resolveEdges` short-circuits and this file asserts
    // nothing about edges at all — which is what it did.
    const { edges, edgeResolutions } = evaluateAuthoredLenses(
      projectionWith([extent('ctx-a'), extent('ctx-b', 'agentic-convention')]),
    );

    expect(edges).toHaveLength(2);
    // One edge per lens, each keyed on THAT lens — without which a GROUP BY over
    // two extents silently sums two different populations.
    expect(edges.map((edge) => edge['contextId']))
      .toEqual([authoredLensId('ctx-a'), authoredLensId('ctx-b')]);
    expect(edgeResolutions).toHaveLength(2);
  });
});
