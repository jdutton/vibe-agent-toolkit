import { describe, expect, it } from 'vitest';

import {
  CONDITION_WITHOUT_REFERENCE,
  RealizationConditionRowSchema,
  ResourceExtentRowSchema,
  ResourceRealizationRowSchema,
  ResourceRowSchema,
  ResourceTagRowSchema,
  RootRowSchema,
} from '../src/schemas/projection-resources.js';

const VALID_KEY = 'markdown.' + '0'.repeat(64);
const GUIDE_PATH = 'docs/guide.md';
const SOURCE_EXTENT = 'tree:source';

describe('RootRowSchema', () => {
  it('accepts a valid root', () => {
    expect(RootRowSchema.safeParse({ id: 'primary', path: '/repo' }).success).toBe(true);
  });

  it('rejects an empty id', () => {
    expect(RootRowSchema.safeParse({ id: '', path: '/repo' }).success).toBe(false);
  });
});

describe('ResourceRowSchema', () => {
  const base = {
    resourceId: 'r-8f3a',
    kind: 'file',
    origin: 'git-tracked',
    observed: true,
    fromEnumeration: true,
    vatId: 'guide',
  };

  it('accepts an observed file identity', () => {
    expect(ResourceRowSchema.safeParse(base).success).toBe(true);
  });

  it('accepts an entity with no local path at all — a marketplace-declared, uninstalled plugin', () => {
    const row = { ...base, kind: 'plugin', observed: false, fromEnumeration: false, vatId: null };
    expect(ResourceRowSchema.safeParse(row).success).toBe(true);
  });

  it('accepts a kind VAT has no enum member for', () => {
    expect(ResourceRowSchema.safeParse({ ...base, kind: 'sharepoint-document' }).success).toBe(true);
  });

  it('rejects a path column — paths belong to realizations, never to an identity', () => {
    expect(ResourceRowSchema.safeParse({ ...base, path: GUIDE_PATH }).success).toBe(false);
  });

  it('rejects a contentKey column — the packager rewrites content, so two realizations of one identity have two content keys', () => {
    const row = { ...base, contentKey: 'markdown.' + '0'.repeat(64) };
    expect(ResourceRowSchema.safeParse(row).success).toBe(false);
  });

  it('rejects an empty resourceId', () => {
    expect(ResourceRowSchema.safeParse({ ...base, resourceId: '' }).success).toBe(false);
  });
});

describe('ResourceRealizationRowSchema', () => {
  const base = {
    resourceId: 'r-8f3a',
    extentId: SOURCE_EXTENT,
    path: GUIDE_PATH,
    pathLower: GUIDE_PATH,
    basenameLower: 'guide.md',
    dir: 'docs',
    depth: 1,
    ext: '.md',
    contentKey: VALID_KEY,
    contentState: 'keyed',
    mtime: new Date('2026-01-01T00:00:00Z'),
    exists: true,
    isDirectory: false,
    gitignored: false,
    isSymlink: false,
    symlinkResolves: null,
  };

  it('accepts a source realization', () => {
    expect(ResourceRealizationRowSchema.safeParse(base).success).toBe(true);
  });

  it('accepts a dist realization of the SAME identity with a DIFFERENT content key', () => {
    const dist = {
      ...base,
      extentId: 'tree:dist',
      path: 'dist/skills/x/docs-guide.md',
      pathLower: 'dist/skills/x/docs-guide.md',
      basenameLower: 'docs-guide.md',
      dir: 'dist/skills/x',
      depth: 3,
      contentKey: 'markdown.' + '1'.repeat(64),
    };
    expect(ResourceRealizationRowSchema.safeParse(dist).success).toBe(true);
    expect(dist.contentKey).not.toBe(base.contentKey);
  });

  it('accepts a declared-but-unwritten realization with a null content key', () => {
    const row = { ...base, contentKey: null, contentState: 'none', mtime: null, exists: false };
    expect(ResourceRealizationRowSchema.safeParse(row).success).toBe(true);
  });

  it.each(['deferred', 'unreadable', 'none'])(
    'accepts a null content key explained by contentState "%s"',
    (contentState) => {
      expect(ResourceRealizationRowSchema.safeParse({ ...base, contentKey: null, contentState }).success).toBe(true);
    },
  );

  it('rejects contentState "keyed" with no key — a row claiming bytes it cannot name', () => {
    const row = { ...base, contentKey: null };
    expect(ResourceRealizationRowSchema.safeParse(row).success).toBe(false);
  });

  it.each(['deferred', 'unreadable', 'none'])(
    'rejects a non-null content key labelled "%s" — the read plainly happened',
    (contentState) => {
      expect(ResourceRealizationRowSchema.safeParse({ ...base, contentState }).success).toBe(false);
    },
  );

  it('rejects a contentState outside the closed vocabulary', () => {
    expect(ResourceRealizationRowSchema.safeParse({ ...base, contentState: 'pending' }).success).toBe(false);
  });

  it('rejects a row with no contentState — a null key that says nothing is the defect being fixed', () => {
    // eslint-disable-next-line sonarjs/no-unused-vars
    const { contentState: _contentState, ...withoutState } = base;
    expect(ResourceRealizationRowSchema.safeParse({ ...withoutState, contentKey: null }).success).toBe(false);
  });

  it('accepts a resolved symlink', () => {
    expect(ResourceRealizationRowSchema.safeParse({ ...base, isSymlink: true, symlinkResolves: true }).success).toBe(true);
  });

  it('rejects symlinkResolves set on a non-symlink', () => {
    expect(ResourceRealizationRowSchema.safeParse({ ...base, symlinkResolves: true }).success).toBe(false);
  });

  it('coerces an ISO date string for mtime (as published by the generated JSON Schema)', () => {
    const result = ResourceRealizationRowSchema.safeParse({ ...base, mtime: '2026-01-01T00:00:00.000Z' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mtime).toBeInstanceOf(Date);
      expect(result.data.mtime?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    }
  });

  it('rejects a row with no extentId — a path is meaningless without the zone it lives in', () => {
    // eslint-disable-next-line sonarjs/no-unused-vars
    const { extentId: _extentId, ...withoutExtent } = base;
    expect(ResourceRealizationRowSchema.safeParse(withoutExtent).success).toBe(false);
  });
});

describe('ResourceExtentRowSchema', () => {
  it('accepts a membership row', () => {
    expect(ResourceExtentRowSchema.safeParse({ resourceId: 'r1', extentId: 'git:primary' }).success).toBe(true);
  });

  it('rejects a zoneKind column — kind is a property of the zone entity, not of a membership', () => {
    const row = { resourceId: 'r1', extentId: SOURCE_EXTENT, zoneKind: 'tree' };
    expect(ResourceExtentRowSchema.safeParse(row).success).toBe(false);
  });

  it('rejects a role column — role moved to resolution_contexts', () => {
    const row = { resourceId: 'r1', extentId: SOURCE_EXTENT, role: 'source' };
    expect(ResourceExtentRowSchema.safeParse(row).success).toBe(false);
  });
});

describe('RealizationConditionRowSchema', () => {
  const collision = {
    extentId: 'tree:dist',
    path: 'skills/x/a-b-c-html',
    code: 'REALIZATION_PATH_COLLISION',
    severity: 'error',
    message: 'a-b/c.html and a/b-c.html both flatten to a-b-c-html',
    resourceId: 'r-second',
    ...CONDITION_WITHOUT_REFERENCE,
  };

  it('accepts a collision condition naming the identity that could not be realized', () => {
    expect(RealizationConditionRowSchema.safeParse(collision).success).toBe(true);
  });

  it('accepts a condition with no identity attached', () => {
    expect(RealizationConditionRowSchema.safeParse({ ...collision, resourceId: null }).success).toBe(true);
  });

  it('rejects "ignore" as a severity', () => {
    expect(RealizationConditionRowSchema.safeParse({ ...collision, severity: 'ignore' }).success).toBe(false);
  });

  // The six provenance columns. They are REQUIRED and nullable rather than
  // optional, so a producer states "no reference provoked this" instead of
  // leaving a key out — an absent key and a null one would be two spellings of
  // one fact, which is the failure ContentStateSchema exists to prevent.
  const refusal = {
    ...collision,
    code: 'SKILL_REFUSED_PATTERN_MATCHED',
    severity: 'info',
    sourcePath: 'skills/x/SKILL.md',
    sourceLine: 12,
    sourceRef: '../agents/tabby.md',
    targetExists: true,
    matchedPattern: '**/agents/**',
    matchedPayload: { ruleIndex: 1, template: 'see {{path}}' },
  };

  it('accepts a refusal condition carrying the reference that provoked it', () => {
    expect(RealizationConditionRowSchema.safeParse(refusal).success).toBe(true);
  });

  it('accepts an empty sourceRef — an empty href is authorable markdown', () => {
    expect(RealizationConditionRowSchema.safeParse({ ...refusal, sourceRef: '' }).success).toBe(true);
  });

  it('rejects a non-positive sourceLine — lines are 1-based', () => {
    expect(RealizationConditionRowSchema.safeParse({ ...refusal, sourceLine: 0 }).success).toBe(false);
  });

  it('rejects a row that omits a provenance column rather than nulling it', () => {
    // eslint-disable-next-line sonarjs/no-unused-vars
    const { targetExists: _omitted, ...withoutColumn } = refusal;
    expect(RealizationConditionRowSchema.safeParse(withoutColumn).success).toBe(false);
  });

  it('rejects an unknown column — our own output stays strict', () => {
    expect(RealizationConditionRowSchema.safeParse({ ...refusal, matchedTemplate: 'x' }).success).toBe(false);
  });
});

describe('CONDITION_WITHOUT_REFERENCE', () => {
  it('nulls every provenance column and names no other', () => {
    // Pinned as a SET, not spot-checked: the constant's whole job is to be the
    // complete "no reference behind this" answer, so a column added to the row
    // and forgotten here must fail rather than silently leave producers short
    // one key.
    // In DECLARATION order, not sorted: sorting to compare would need a
    // comparator the lint config is opinionated about, and the constant's own
    // order is deterministic and readable.
    expect(Object.keys(CONDITION_WITHOUT_REFERENCE)).toEqual([
      'sourcePath', 'sourceLine', 'sourceRef', 'targetExists', 'matchedPattern', 'matchedPayload',
    ]);
    expect(Object.values(CONDITION_WITHOUT_REFERENCE).every((value) => value === null)).toBe(true);
  });
});

describe('ResourceTagRowSchema', () => {
  it('accepts a valued tag', () => {
    const row = { resourceId: 'r1', tag: 'kind', value: 'adr', source: 'config' };
    expect(ResourceTagRowSchema.safeParse(row).success).toBe(true);
  });

  it('accepts a boolean-presence tag with a null value', () => {
    const row = { resourceId: 'r1', tag: 'archived', value: null, source: 'filename' };
    expect(ResourceTagRowSchema.safeParse(row).success).toBe(true);
  });

  it('accepts a contributor id VAT ships no enum member for — source is open', () => {
    const row = { resourceId: 'r1', tag: 'tenant', value: 'acme', source: 'adopter/sharepoint-classifier' };
    expect(ResourceTagRowSchema.safeParse(row).success).toBe(true);
  });

  it('rejects an empty source', () => {
    const row = { resourceId: 'r1', tag: 'kind', value: 'adr', source: '' };
    expect(ResourceTagRowSchema.safeParse(row).success).toBe(false);
  });
});
