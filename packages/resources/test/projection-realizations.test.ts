/* eslint-disable security/detect-non-literal-fs-filename -- controlled temp fixture tree */
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { beforeEach, describe, expect, it } from 'vitest';

import { collectRealization, realPathOrNull, relativize } from '../src/projection/realizations.js';
import { ResourceRealizationRowSchema } from '../src/schemas/projection-resources.js';

// Hoisted: sonarjs/no-duplicate-string blocks a literal used 3+ times.
const EXTENT_ID = 'ctx-filesystem';
const RESOURCE_ID = 'res-0000';
const NESTED_RELATIVE = 'docs/guides/Setup.MD';
const NOWHERE = 'nowhere.md';

let root: string;

/** The realization of the nested fixture file, which most cases ask about. */
async function nestedRow(): Promise<Awaited<ReturnType<typeof collectRealization>>> {
  return collectRealization(safePath.join(root, NESTED_RELATIVE), RESOURCE_ID, {
    root,
    extentId: EXTENT_ID,
  });
}

beforeEach(() => {
  root = toForwardSlash(mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-realization-')));
  mkdirSyncReal(safePath.join(root, 'docs/guides'), { recursive: true });
  writeFileSync(safePath.join(root, NESTED_RELATIVE), '# setup\n');
});

describe('collectRealization', () => {
  it('derives the six path columns from the root-relative path', async () => {
    const row = await nestedRow();

    expect(row.path).toBe(NESTED_RELATIVE);
    expect(row.pathLower).toBe('docs/guides/setup.md');
    expect(row.basenameLower).toBe('setup.md');
    expect(row.dir).toBe('docs/guides');
    expect(row.depth).toBe(3);
    expect(row.ext).toBe('.md');
  });

  it('carries the identity and extent it was asked for', async () => {
    const row = await nestedRow();

    expect(row.resourceId).toBe(RESOURCE_ID);
    expect(row.extentId).toBe(EXTENT_ID);
  });

  it('keys the bytes of THIS realization, not of the identity', async () => {
    const row = await nestedRow();

    expect(row.contentKey).toMatch(/^markdown\.[\da-f]{64}$/u);
  });

  it('reports a live symlink as a symlink that resolves', async () => {
    const alias = safePath.join(root, 'alias.md');
    symlinkSync(safePath.join(root, NESTED_RELATIVE), alias);

    const row = await collectRealization(alias, RESOURCE_ID, { root, extentId: EXTENT_ID });

    expect(row.isSymlink).toBe(true);
    expect(row.symlinkResolves).toBe(true);
    expect(row.exists).toBe(true);
  });

  it('reports a dangling symlink as present but unresolving, with no content key', async () => {
    const dangling = safePath.join(root, 'dangling.md');
    symlinkSync(safePath.join(root, NOWHERE), dangling);

    const row = await collectRealization(dangling, RESOURCE_ID, { root, extentId: EXTENT_ID });

    expect(row.exists).toBe(true);
    expect(row.isSymlink).toBe(true);
    expect(row.symlinkResolves).toBe(false);
    expect(row.contentKey).toBeNull();
  });

  it('nulls symlinkResolves for a plain file — the schema superRefine requires it', async () => {
    const row = await nestedRow();

    expect(row.isSymlink).toBe(false);
    expect(row.symlinkResolves).toBeNull();
  });

  it('records an absent path without throwing, with mtime null', async () => {
    const row = await collectRealization(safePath.join(root, 'missing.md'), RESOURCE_ID, {
      root,
      extentId: EXTENT_ID,
    });

    expect(row.exists).toBe(false);
    expect(row.mtime).toBeNull();
    expect(row.contentKey).toBeNull();
  });

  it('takes mtime from the lstat that already answered isSymlink', async () => {
    const row = await nestedRow();

    expect(row.mtime).toBeInstanceOf(Date);
    expect(row.mtime?.getTime() ?? Number.NaN).toBeGreaterThan(0);
  });

  it('reports a directory as a directory with no content key', async () => {
    const row = await collectRealization(safePath.join(root, 'docs'), RESOURCE_ID, {
      root,
      extentId: EXTENT_ID,
    });

    expect(row.isDirectory).toBe(true);
    expect(row.contentKey).toBeNull();
    expect(row.ext).toBe('');
    expect(row.dir).toBe('');
    expect(row.depth).toBe(1);
  });

  it('produces a row the shipped schema accepts', async () => {
    const row = await nestedRow();

    expect(() => ResourceRealizationRowSchema.parse(row)).not.toThrow();
  });
});

describe('relativize', () => {
  it('renders the root itself as "."', () => {
    expect(relativize(root, root)).toBe('.');
  });

  it('forward-slashes a nested path', () => {
    expect(relativize(safePath.join(root, NESTED_RELATIVE), root)).toBe(NESTED_RELATIVE);
  });
});

describe('realPathOrNull', () => {
  it('resolves a symlink to its target rather than reporting the link', () => {
    const alias = safePath.join(root, 'alias.md');
    symlinkSync(safePath.join(root, NESTED_RELATIVE), alias);

    expect(realPathOrNull(alias)).toBe(realPathOrNull(safePath.join(root, NESTED_RELATIVE)));
  });

  it('returns null for a path that cannot be resolved', () => {
    expect(realPathOrNull(safePath.join(root, NOWHERE))).toBeNull();
  });
});
