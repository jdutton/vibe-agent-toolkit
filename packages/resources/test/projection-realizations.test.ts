/* eslint-disable security/detect-non-literal-fs-filename -- controlled temp fixture tree */
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';

import {
  GitTracker,
  canCreateSymlinks,
  mkdirSyncReal,
  normalizedTmpdir,
  safeExecSync,
  safePath,
  toForwardSlash,
} from '@vibe-agent-toolkit/utils';
import { beforeEach, describe, expect, it } from 'vitest';

import { RunContentCache } from '../src/projection/content-cache.js';
import {
  collectRealization,
  realPathOrNull,
  relativize,
  type RealizationContext,
} from '../src/projection/realizations.js';
import type { ResourceRealizationRow } from '../src/schemas/projection-resources.js';
import { ResourceRealizationRowSchema } from '../src/schemas/projection-resources.js';

// Hoisted: sonarjs/no-duplicate-string blocks a literal used 3+ times.
const EXTENT_ID = 'ctx-filesystem';
const RESOURCE_ID = 'res-0000';
const NESTED_RELATIVE = 'docs/guides/Setup.MD';
const NOWHERE = 'nowhere.md';
const IGNORED_LOG = 'ignored.log';
const IGNORED_DIR = 'dist';
const DOCS_DIR = 'docs';

let root: string;

/** The parts of a {@link RealizationContext} a case may vary. */
type RealizationOptions = Partial<Pick<
  RealizationContext,
  'contentCache' | 'contentDemand' | 'gitTracker'
>>;

/** Realize a fixture path, varying only the policy inputs a case cares about. */
async function realize(
  relativePath: string,
  options: RealizationOptions = {},
): Promise<ResourceRealizationRow> {
  return collectRealization(safePath.join(root, relativePath), RESOURCE_ID, {
    root,
    extentId: EXTENT_ID,
    ...options,
  });
}

/** The realization of the nested fixture file, which most cases ask about. */
async function nestedRow(): Promise<ResourceRealizationRow> {
  return realize(NESTED_RELATIVE);
}

/**
 * A git oracle over the fixture root, ignoring {@link IGNORED_LOG} and
 * {@link IGNORED_DIR}.
 *
 * No commit is needed — `isIgnored` falls back to `git check-ignore`, which
 * reads `.gitignore` directly.
 */
async function trackerOverFixture(): Promise<GitTracker> {
  writeFileSync(safePath.join(root, '.gitignore'), `${IGNORED_LOG}\n${IGNORED_DIR}/\n`);
  safeExecSync('git', ['init'], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  const tracker = new GitTracker(root);
  await tracker.initialize();
  return tracker;
}

/** Realize a fixture path under the filesystem extent's own demand policy. */
async function ignoreAwareRow(relativePath: string): Promise<ResourceRealizationRow> {
  return realize(relativePath, {
    gitTracker: await trackerOverFixture(),
    contentDemand: 'deferGitignored',
  });
}

/**
 * A cache stand-in whose every read throws, so the `unreadable` branch is
 * reachable on every platform and under every uid.
 *
 * @returns A {@link RunContentCache}-shaped object that always rejects
 */
function throwingCache(): RunContentCache {
  return {
    read: () => Promise.reject(new Error('EACCES: permission denied')),
    stats: { hits: 0, misses: 0, entries: 0, bytesHeld: 0 },
  } as unknown as RunContentCache;
}

beforeEach(() => {
  root = toForwardSlash(mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-realization-')));
  mkdirSyncReal(safePath.join(root, 'docs/guides'), { recursive: true });
  mkdirSyncReal(safePath.join(root, IGNORED_DIR), { recursive: true });
  writeFileSync(safePath.join(root, NESTED_RELATIVE), '# setup\n');
  writeFileSync(safePath.join(root, IGNORED_LOG), 'noise\n');
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
    expect(row.contentState).toBe('keyed');
  });

  it('reports a live symlink as a symlink that resolves', async ({ skip }) => {
    // Creating a symlink on Windows needs the privilege Developer Mode grants,
    // which CI agents and most dev boxes lack — `symlinkSync` throws EPERM
    // there. Skip loudly rather than no-op: a silently skipped symlink case
    // reads as a passing test. Same gate `fs-utils.test.ts` already uses.
    if (!canCreateSymlinks(root)) skip();

    symlinkSync(safePath.join(root, NESTED_RELATIVE), safePath.join(root, 'alias.md'));

    const row = await realize('alias.md');

    expect(row.isSymlink).toBe(true);
    expect(row.symlinkResolves).toBe(true);
    expect(row.exists).toBe(true);
  });

  it('reports a dangling symlink as present but unresolving, with no bytes to key', async ({ skip }) => {
    if (!canCreateSymlinks(root)) skip();

    symlinkSync(safePath.join(root, NOWHERE), safePath.join(root, 'dangling.md'));

    const row = await realize('dangling.md');

    expect(row.exists).toBe(true);
    expect(row.isSymlink).toBe(true);
    expect(row.symlinkResolves).toBe(false);
    expect(row.contentKey).toBeNull();
    // Not "unreadable": nothing was ever attempted, there is simply nothing there.
    expect(row.contentState).toBe('none');
  });

  it('nulls symlinkResolves for a plain file — the schema superRefine requires it', async () => {
    const row = await nestedRow();

    expect(row.isSymlink).toBe(false);
    expect(row.symlinkResolves).toBeNull();
  });

  it('records an absent path without throwing, with mtime null', async () => {
    const row = await realize('missing.md');

    expect(row.exists).toBe(false);
    expect(row.mtime).toBeNull();
    expect(row.contentKey).toBeNull();
    expect(row.contentState).toBe('none');
  });

  it('takes mtime from the lstat that already answered isSymlink', async () => {
    const row = await nestedRow();

    expect(row.mtime).toBeInstanceOf(Date);
    expect(row.mtime?.getTime() ?? Number.NaN).toBeGreaterThan(0);
  });

  it('reports a directory as a directory with no content key', async () => {
    const row = await realize(DOCS_DIR);

    expect(row.isDirectory).toBe(true);
    expect(row.contentKey).toBeNull();
    expect(row.contentState).toBe('none');
    expect(row.ext).toBe('');
    expect(row.dir).toBe('');
    expect(row.depth).toBe(1);
  });

  it('records a read that threw as unreadable — a fact about the corpus, not an abort', async () => {
    // The failure is injected at the cache seam rather than by chmod: EACCES via
    // chmod is POSIX-only and is a no-op when the suite runs as root, which would
    // make this a test that silently stops testing anything.
    const row = await realize(NESTED_RELATIVE, { contentCache: throwingCache() });

    expect(row.exists).toBe(true);
    expect(row.isDirectory).toBe(false);
    expect(row.contentKey).toBeNull();
    expect(row.contentState).toBe('unreadable');
  });

  it('produces a row the shipped schema accepts', async () => {
    const row = await nestedRow();

    expect(() => ResourceRealizationRowSchema.parse(row)).not.toThrow();
  });
});

describe('collectRealization content demand', () => {
  it('keys eagerly when no demand is stated at all', async () => {
    const cache = new RunContentCache();

    const row = await realize(NESTED_RELATIVE, { contentCache: cache });

    expect(row.contentState).toBe('keyed');
    expect(row.contentKey).not.toBeNull();
    // The negative control for the deferral test below: this counter does move.
    expect(cache.stats.misses).toBe(1);
  });

  it('defers every path under "deferred", however readable', async () => {
    const row = await realize(NESTED_RELATIVE, { contentDemand: 'deferred' });

    expect(row.exists).toBe(true);
    expect(row.contentKey).toBeNull();
    expect(row.contentState).toBe('deferred');
  });

  it('does not read the bytes it defers', async () => {
    const cache = new RunContentCache();

    await realize(NESTED_RELATIVE, { contentCache: cache, contentDemand: 'deferred' });

    // Asserting the null key alone could not tell deferral from a read whose
    // result was discarded, which is the entire point of the change.
    expect(cache.stats.misses).toBe(0);
    expect(cache.stats.entries).toBe(0);
  });

  it('defers a gitignored file under "deferGitignored", keeping the row itself intact', async () => {
    const row = await ignoreAwareRow(IGNORED_LOG);

    expect(row.exists).toBe(true);
    expect(row.gitignored).toBe(true);
    expect(row.contentKey).toBeNull();
    expect(row.contentState).toBe('deferred');
  });

  it('keys a non-gitignored file under "deferGitignored"', async () => {
    const row = await ignoreAwareRow(NESTED_RELATIVE);

    expect(row.gitignored).toBe(false);
    expect(row.contentState).toBe('keyed');
    expect(row.contentKey).not.toBeNull();
  });

  it('calls a gitignored directory "none", never "deferred" — no bytes beats any policy', async () => {
    const row = await ignoreAwareRow(IGNORED_DIR);

    expect(row.isDirectory).toBe(true);
    // Genuinely inside the policy's reach: it would defer this path if the
    // no-bytes rule did not take precedence.
    expect(row.gitignored).toBe(true);
    expect(row.contentState).toBe('none');
  });

  it('calls an absent path "none" under a deferring policy', async () => {
    const row = await realize('missing.md', { contentDemand: 'deferred' });

    expect(row.exists).toBe(false);
    expect(row.contentState).toBe('none');
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
  it('resolves a symlink to its target rather than reporting the link', ({ skip }) => {
    if (!canCreateSymlinks(root)) skip();

    const alias = safePath.join(root, 'alias.md');
    symlinkSync(safePath.join(root, NESTED_RELATIVE), alias);

    expect(realPathOrNull(alias)).toBe(realPathOrNull(safePath.join(root, NESTED_RELATIVE)));
  });

  it('returns null for a path that cannot be resolved', () => {
    expect(realPathOrNull(safePath.join(root, NOWHERE))).toBeNull();
  });
});
