import { describe, expect, it } from 'vitest';

import {
  EdgeDestinationKindSchema,
  EdgeKindSchema,
  EdgeOriginSchema,
  EdgeResolutionRowSchema,
  EdgeRowSchema,
} from '../src/schemas/projection-edges.js';

/** An implicit-edge kind `LinkType` cannot express — used by three assertions. */
const ANCESTOR_CONTEXT = 'ancestor-context';

/** An opaque resource id, as `identity.ts` mints them. Used as both `dstResource` and `dstKey`. */
const CONFIGURATION_ID = 'res-0123456789abcdef0123456789abcdef';

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

describe('EdgeDestinationKindSchema', () => {
  it('accepts the three destination classes', () => {
    for (const kind of ['resource', 'external', 'out-of-corpus']) {
      expect(EdgeDestinationKindSchema.safeParse(kind).success).toBe(true);
    }
  });

  it('is a closed vocabulary — unlike EdgeKindSchema, a fourth class is a design change', () => {
    expect(EdgeDestinationKindSchema.safeParse('package').success).toBe(false);
    expect(EdgeDestinationKindSchema.safeParse('dead').success).toBe(false);
  });
});

describe('EdgeRowSchema', () => {
  const authored = {
    src: 'r-guide',
    refOrdinal: 0,
    contextId: 'claude-context:primary',
    kind: 'local_file',
    origin: 'authored',
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

  it('rejects a resolution column — a tier grades a candidate, not an edge', () => {
    expect(EdgeRowSchema.safeParse({ ...authored, resolution: 'resolved' }).success).toBe(false);
  });

  it('rejects a derived verdict column — the verdict is a GROUP BY over the candidates', () => {
    expect(EdgeRowSchema.safeParse({ ...authored, verdict: 'ambiguous' }).success).toBe(false);
  });
});

describe('EdgeResolutionRowSchema', () => {
  const candidate = {
    src: 'r-guide',
    refOrdinal: 0,
    contextId: 'wiki:primary',
    candidateOrdinal: 0,
    dstKind: 'resource',
    dstKey: CONFIGURATION_ID,
    dstResource: CONFIGURATION_ID,
    dstAnchor: null,
    tier: 'same-plugin',
    score: 0.95,
  };

  it('accepts a scored candidate', () => {
    expect(EdgeResolutionRowSchema.safeParse(candidate).success).toBe(true);
  });

  it('accepts four candidates for one wiki reference, distinguished by ordinal', () => {
    const rows = [0, 1, 2, 3].map((n) => ({
      ...candidate,
      candidateOrdinal: n,
      dstKey: `${CONFIGURATION_ID}${n}`,
      dstResource: `${CONFIGURATION_ID}${n}`,
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

  it('accepts an anchor target', () => {
    expect(EdgeResolutionRowSchema.safeParse({ ...candidate, dstAnchor: 'installation' }).success).toBe(true);
  });

  it('rejects a score outside 0..1', () => {
    expect(EdgeResolutionRowSchema.safeParse({ ...candidate, score: 1.5 }).success).toBe(false);
    expect(EdgeResolutionRowSchema.safeParse({ ...candidate, score: -0.1 }).success).toBe(false);
  });

  it('accepts an ungraded candidate — a lens with no reachability model has no honest tier', () => {
    expect(EdgeResolutionRowSchema.safeParse({ ...candidate, tier: null }).success).toBe(true);
  });

  it('accepts an open tier vocabulary', () => {
    for (const tier of ['same-marketplace', 'known-other-marketplace', 'auth-required', 'nonexistent']) {
      expect(EdgeResolutionRowSchema.safeParse({ ...candidate, tier }).success).toBe(true);
    }
  });

  describe('a destination is not always a resource', () => {
    const external = {
      ...candidate,
      dstKind: 'external',
      dstKey: 'https://example.com/x',
      dstResource: null,
      tier: null,
      score: null,
    };

    it('accepts an external URL, which must never be a resource', () => {
      expect(EdgeResolutionRowSchema.safeParse(external).success).toBe(true);
    });

    it('accepts an external destination carrying a fragment nothing in the projection can resolve', () => {
      expect(EdgeResolutionRowSchema.safeParse({ ...external, dstAnchor: 'install' }).success).toBe(true);
    });

    it('accepts a target outside the corpus boundary, keyed on its normalized path', () => {
      const row = { ...external, dstKind: 'out-of-corpus', dstKey: '../memory/MEMORY.md' };
      expect(EdgeResolutionRowSchema.safeParse(row).success).toBe(true);
    });

    it('rejects a non-resource candidate that claims a dstResource foreign key', () => {
      const row = { ...external, dstResource: CONFIGURATION_ID };
      expect(EdgeResolutionRowSchema.safeParse(row).success).toBe(false);
    });

    it('rejects a resource candidate with no dstResource — dstResource is null exactly when the target is not in the corpus', () => {
      expect(EdgeResolutionRowSchema.safeParse({ ...candidate, dstResource: null }).success).toBe(false);
    });

    it('rejects a resource candidate whose dstKey is not its resource id', () => {
      const row = { ...candidate, dstKey: 'docs/configuration.md' };
      expect(EdgeResolutionRowSchema.safeParse(row).success).toBe(false);
    });

    it('requires a dstKey — every candidate is groupable, whatever class it belongs to', () => {
      const withoutKey: Record<string, unknown> = { ...external };
      delete withoutKey['dstKey'];
      expect(EdgeResolutionRowSchema.safeParse(withoutKey).success).toBe(false);
      expect(EdgeResolutionRowSchema.safeParse({ ...external, dstKey: '' }).success).toBe(false);
    });
  });
});
