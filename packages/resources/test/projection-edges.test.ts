import { describe, expect, it } from 'vitest';

import {
  EdgeKindSchema,
  EdgeOriginSchema,
  EdgeResolutionRowSchema,
  EdgeRowSchema,
} from '../src/schemas/projection-edges.js';

/** An implicit-edge kind `LinkType` cannot express — used by three assertions. */
const ANCESTOR_CONTEXT = 'ancestor-context';

describe('EdgeOriginSchema', () => {
  it('accepts the three origins', () => {
    for (const origin of ['authored', 'implicit', 'inferred']) {
      expect(EdgeOriginSchema.safeParse(origin).success).toBe(true);
    }
  });

  it('rejects anything else', () => {
    expect(EdgeOriginSchema.safeParse('derived').success).toBe(false);
  });
});

describe('EdgeKindSchema', () => {
  it('accepts a LinkType member', () => {
    expect(EdgeKindSchema.safeParse('local_file').success).toBe(true);
  });

  it('accepts a kind LinkType cannot express', () => {
    expect(EdgeKindSchema.safeParse(ANCESTOR_CONTEXT).success).toBe(true);
    expect(EdgeKindSchema.safeParse('rules-glob-match').success).toBe(true);
  });
});

describe('EdgeRowSchema', () => {
  const authored = {
    src: 'r-guide',
    refOrdinal: 0,
    contextId: 'claude-context:primary',
    kind: 'local_file',
    origin: 'authored',
    resolution: 'resolved',
  };

  it('accepts an authored edge anchored to a blob reference', () => {
    expect(EdgeRowSchema.safeParse(authored).success).toBe(true);
  });

  it('accepts an implicit edge with no reference ordinal', () => {
    const row = { ...authored, refOrdinal: null, kind: ANCESTOR_CONTEXT, origin: 'implicit' };
    expect(EdgeRowSchema.safeParse(row).success).toBe(true);
  });

  it('rejects an authored edge with no reference ordinal', () => {
    expect(EdgeRowSchema.safeParse({ ...authored, refOrdinal: null }).success).toBe(false);
  });

  it('rejects an implicit edge that claims a reference ordinal', () => {
    const row = { ...authored, origin: 'implicit', kind: ANCESTOR_CONTEXT };
    expect(EdgeRowSchema.safeParse(row).success).toBe(false);
  });

  it('rejects a dstResource column — targets live in edge_resolutions', () => {
    expect(EdgeRowSchema.safeParse({ ...authored, dstResource: 'r-other' }).success).toBe(false);
  });

  it('accepts an open resolution tier', () => {
    const row = { ...authored, resolution: 'known-other-marketplace' };
    expect(EdgeRowSchema.safeParse(row).success).toBe(true);
  });
});

describe('EdgeResolutionRowSchema', () => {
  const candidate = {
    src: 'r-guide',
    refOrdinal: 0,
    contextId: 'wiki:primary',
    candidateOrdinal: 0,
    dstResource: 'r-configuration-md',
    dstAnchor: null,
    score: 0.95,
  };

  it('accepts a scored candidate', () => {
    expect(EdgeResolutionRowSchema.safeParse(candidate).success).toBe(true);
  });

  it('accepts four candidates for one wiki reference, distinguished by ordinal', () => {
    const rows = [0, 1, 2, 3].map((n) => ({
      ...candidate,
      candidateOrdinal: n,
      dstResource: `r-configuration-${n}`,
      score: 1 - n * 0.1,
    }));
    for (const row of rows) {
      expect(EdgeResolutionRowSchema.safeParse(row).success).toBe(true);
    }
    expect(new Set(rows.map((r) => r.candidateOrdinal)).size).toBe(4);
  });

  it('accepts a certain single-target resolution with no score', () => {
    expect(EdgeResolutionRowSchema.safeParse({ ...candidate, score: null }).success).toBe(true);
  });

  it('accepts an unresolved candidate with a null target', () => {
    const row = { ...candidate, dstResource: null, score: null };
    expect(EdgeResolutionRowSchema.safeParse(row).success).toBe(true);
  });

  it('accepts an anchor target', () => {
    expect(EdgeResolutionRowSchema.safeParse({ ...candidate, dstAnchor: 'installation' }).success).toBe(true);
  });

  it('rejects a score outside 0..1', () => {
    expect(EdgeResolutionRowSchema.safeParse({ ...candidate, score: 1.5 }).success).toBe(false);
    expect(EdgeResolutionRowSchema.safeParse({ ...candidate, score: -0.1 }).success).toBe(false);
  });
});
