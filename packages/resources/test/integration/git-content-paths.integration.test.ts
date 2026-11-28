/**
 * `gitContentPathsOf`, the row-set stage's default git-content test for a git-content-only instance
 * (`ts`), over real repositories: on the default git crawl it answers `undefined` (every member is
 * git content already) and takes no snapshot; with the filesystem crawl forced it answers the root's
 * git content, root-relative, so a gitignored file is left out; outside a work tree it throws the
 * snapshot's coded `GIT_NO_ANSWER`, which the stage turns into the instance's refusal.
 *
 * Through the CLI the ignored file never reaches the stage (the resources population declines ignored
 * members on both crawl lanes), so its exclusion is proved here, on the function itself.
 */
import { mkdtempSync, rmSync } from 'node:fs';

import { isVatError, normalizedTmpdir, readWorkCounters, safePath } from '@vibe-agent-toolkit/utils';
import { GIT_NO_ANSWER_CODE } from '@vibe-agent-toolkit/utils/git';
import { afterEach, describe, expect, it } from 'vitest';

import { EXTENT_SOURCE_ENV, EXTENT_SOURCE_FILESYSTEM } from '../../src/projection/crawl-source.js';
import { gitContentPathsOf } from '../../src/projection/data-stage.js';
import { createCommittedRepo, writeFileIn } from '../test-helpers.js';

const roots: string[] = [];
const savedSource = process.env[EXTENT_SOURCE_ENV];

afterEach(() => {
  if (savedSource === undefined) delete process.env[EXTENT_SOURCE_ENV];
  else process.env[EXTENT_SOURCE_ENV] = savedSource;
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A committed repository with an untracked, unignored file and an ignored one. */
function repository(): string {
  const root = createCommittedRepo('vat-git-content-paths-', {
    files: { 'src/a.ts': 'export const a = 1;\n', 'types/env.d.ts': 'export {};\n' },
    gitignore: 'ignored/\n',
  });
  roots.push(root);
  writeFileIn(root, 'src/untracked.ts', 'export const u = 1;\n');
  writeFileIn(root, 'ignored/gen.ts', 'export const g = 1;\n');
  return root;
}

/** @returns `run`'s answer and how many git snapshots it took */
function counted<T>(run: () => T): { answer: T; snapshots: number } {
  const before = readWorkCounters()['git.snapshots'];
  const answer = run();
  return { answer, snapshots: readWorkCounters()['git.snapshots'] - before };
}

describe('gitContentPathsOf', () => {
  it('answers undefined on the default git crawl, taking no snapshot', () => {
    delete process.env[EXTENT_SOURCE_ENV];
    const root = repository();
    expect(counted(() => gitContentPathsOf(root))).toStrictEqual({ answer: undefined, snapshots: 0 });
  });

  it('answers the root\'s git content, root-relative, with the filesystem crawl forced: never an ignored file', () => {
    process.env[EXTENT_SOURCE_ENV] = EXTENT_SOURCE_FILESYSTEM;
    const root = repository();
    const { answer, snapshots } = counted(() => gitContentPathsOf(root));
    expect([...(answer ?? [])].toSorted((left, right) => left.localeCompare(right))).toStrictEqual(['.gitignore', 'src/a.ts', 'src/untracked.ts', 'types/env.d.ts']);
    expect(snapshots, 'one snapshot, the memoized one a filesystem-lane run shares').toBe(1);
  });

  it('throws the snapshot\'s GIT_NO_ANSWER outside a work tree', () => {
    process.env[EXTENT_SOURCE_ENV] = EXTENT_SOURCE_FILESYSTEM;
    const outside = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-git-content-paths-plain-'));
    roots.push(outside);
    let thrown: unknown;
    try {
      gitContentPathsOf(outside);
    } catch (error) {
      thrown = error;
    }
    expect(isVatError(thrown, GIT_NO_ANSWER_CODE), String(thrown)).toBe(true);
  });
});
