import { describe, expect, it } from 'vitest';

import {
  EdgeRowSchema,
  ResourceRealizationRowSchema,
  ResourceRowSchema,
  ResourceTagRowSchema,
  ResourceZoneRowSchema,
  RootRowSchema,
} from '../src/schemas/projection-resources.js';

const VALID_KEY = 'markdown.' + '0'.repeat(64);

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
    rootId: 'primary',
    path: 'docs/guide.md',
    pathLower: 'docs/guide.md',
    basenameLower: 'guide.md',
    contentKey: VALID_KEY,
    dir: 'docs',
    depth: 1,
    ext: '.md',
    mtime: new Date('2026-01-01T00:00:00Z'),
    vatId: 'guide',
    origin: 'git-tracked',
    observed: true,
    fromEnumeration: true,
    exists: true,
    isDirectory: false,
    gitignored: false,
    isSymlink: false,
    symlinkResolves: null,
  };

  it('accepts a normal tracked file', () => {
    expect(ResourceRowSchema.safeParse(base).success).toBe(true);
  });

  it('accepts a declared-but-unwritten node with a null content key', () => {
    const row = { ...base, contentKey: null, mtime: null, observed: false, exists: false };
    expect(ResourceRowSchema.safeParse(row).success).toBe(true);
  });

  it('accepts a resolved symlink', () => {
    const row = { ...base, isSymlink: true, symlinkResolves: true };
    expect(ResourceRowSchema.safeParse(row).success).toBe(true);
  });

  it('coerces an ISO date string for mtime (as published by the generated JSON Schema)', () => {
    const row = { ...base, mtime: '2026-01-01T00:00:00.000Z' };
    const result = ResourceRowSchema.safeParse(row);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mtime).toBeInstanceOf(Date);
      expect(result.data.mtime?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    }
  });

  it('rejects symlinkResolves set on a non-symlink', () => {
    const row = { ...base, isSymlink: false, symlinkResolves: true };
    expect(ResourceRowSchema.safeParse(row).success).toBe(false);
  });

  it('rejects a row with no rootId', () => {
    // eslint-disable-next-line sonarjs/no-unused-vars
    const { rootId: _rootId, ...withoutRoot } = base;
    expect(ResourceRowSchema.safeParse(withoutRoot).success).toBe(false);
  });
});

describe('ResourceRealizationRowSchema', () => {
  it('accepts a realization row', () => {
    const row = { resourceId: 'skill-x', zoneId: 'skill-x', path: 'dist/skills/x/SKILL.md' };
    expect(ResourceRealizationRowSchema.safeParse(row).success).toBe(true);
  });
});

describe('ResourceZoneRowSchema', () => {
  it('accepts a tree zone with a role', () => {
    const row = { resourceId: 'r1', zoneKind: 'tree', zoneId: 'root', role: 'source' };
    expect(ResourceZoneRowSchema.safeParse(row).success).toBe(true);
  });

  it('accepts a non-tree zone with a null role', () => {
    const row = { resourceId: 'r1', zoneKind: 'skill', zoneId: 'skill-x', role: null };
    expect(ResourceZoneRowSchema.safeParse(row).success).toBe(true);
  });

  it('rejects a role on a non-tree zone', () => {
    const row = { resourceId: 'r1', zoneKind: 'skill', zoneId: 'skill-x', role: 'source' };
    expect(ResourceZoneRowSchema.safeParse(row).success).toBe(false);
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
});

describe('EdgeRowSchema', () => {
  it('accepts a resolved internal-file edge', () => {
    const row = {
      src: 'guide',
      linkOrdinal: 0,
      zoneId: 'root',
      dstResource: 'other',
      dstAnchor: null,
      kind: 'local_file',
      resolution: 'resolved',
    };
    expect(EdgeRowSchema.safeParse(row).success).toBe(true);
  });

  it('accepts an unresolved edge with a null target', () => {
    const row = {
      src: 'guide',
      linkOrdinal: 1,
      zoneId: 'root',
      dstResource: null,
      dstAnchor: null,
      kind: 'local_file',
      resolution: 'unresolved',
    };
    expect(EdgeRowSchema.safeParse(row).success).toBe(true);
  });

  it('rejects an invalid kind', () => {
    const row = {
      src: 'guide',
      linkOrdinal: 0,
      zoneId: 'root',
      dstResource: null,
      dstAnchor: null,
      kind: 'bogus',
      resolution: 'unresolved',
    };
    expect(EdgeRowSchema.safeParse(row).success).toBe(false);
  });
});
