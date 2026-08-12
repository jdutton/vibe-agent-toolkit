import { describe, expect, it } from 'vitest';

import {
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
    const row = { ...base, contentKey: null, mtime: null, exists: false };
    expect(ResourceRealizationRowSchema.safeParse(row).success).toBe(true);
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
