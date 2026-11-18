/**
 * The parts of `validate-repo-structure.ts` that only real I/O can prove.
 *
 * Integration tier: `contrabandPopulation` spawns real `git` against a temp repo,
 * because what it must get right is git's own staging semantics (an untracked file
 * is in, an ignored one is out), which no mocked listing can reproduce. The
 * listing merge itself is pure and unit-tested beside the severity-counts
 * recognisers. `readTrackedFile` and `walkDirectory` are proven against a real
 * file the OS refuses to read and a directory it refuses to list.
 */
import { chmodSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { CANNOT_DENY_READS } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  contrabandPopulation,
  readTrackedFile,
  walkDirectory,
} from '../../src/validate-repo-structure.js';
import {
  cleanupTestTempDir,
  commitAllAsRepo,
  createTestTempDir,
  writeFiles,
} from '../test-helpers.js';

/** Encoding for every fixture file this suite writes. */
const UTF8 = 'utf8';

/** Committed before the gate runs — the population `git ls-files` already saw. */
const TRACKED_FILE = 'tracked.ts';
/** Written but never committable: the shape the token list itself has. */
const IGNORED_FILE = 'ignored.ts';
/** Written, not staged — the state every new file is in when the gate runs. */
const NEW_FILE = 'nested/brand-new.ts';

/** One temp root for the file, removed after it. */
let root = '';
beforeAll(() => {
  root = createTestTempDir({ prefix: 'validate-repo-structure-' });
});
afterAll(() => {
  cleanupTestTempDir(root);
});

/**
 * A throwaway repo holding one file in each staging state that matters.
 *
 * @returns The repo root
 */
function repoWithStagingStates(): string {
  const repo = safePath.join(root, 'repo');
  writeFiles(repo, { '.gitignore': `${IGNORED_FILE}\n`, [TRACKED_FILE]: '// tracked\n' });
  commitAllAsRepo(repo);
  // The state the gate was blind to: a NEW file, written but not yet staged.
  // This repo validates ONCE and commits at the end, so every new file is in
  // exactly this state at the moment the gate runs.
  writeFiles(repo, { [NEW_FILE]: '// new\n', [IGNORED_FILE]: '// ignored\n' });
  return repo;
}

describe('contrabandPopulation — what the confidentiality gate is allowed to miss', () => {
  // One fixture repo for the block: every case reads the same population.
  let population: readonly string[] = [];
  beforeAll(() => {
    population = contrabandPopulation(repoWithStagingStates()).map((p) => toForwardSlash(p));
  });

  it('includes a brand-new untracked file, because that is what the commit will publish', () => {
    expect(population).toContain(NEW_FILE);
  });

  it('still includes tracked files', () => {
    expect(population).toContain(TRACKED_FILE);
  });

  it('excludes ignored files, which no commit will publish', () => {
    // Not pedantry: the token list itself may be a gitignored file in the repo
    // root, so a population that swept ignored files would report the list of
    // secrets as a leak of them.
    expect(population).not.toContain(IGNORED_FILE);
  });
});

/** `chmod 000` denies nothing to uid 0 and binds nothing on Windows. */

/**
 * The content rules read every tracked file. A file that is absent from the
 * working tree (a sparse checkout, a delete not yet committed) has no content
 * to check and is skipped. A file the OS REFUSES to read is different: the
 * rules over its content did not run, and a gate that says nothing about that
 * reads as a clean bill of health for a file it never saw.
 */
describe('readTrackedFile — what an unreadable tracked file does to the gate', () => {
  it('returns null and records nothing for a file that is not there', async () => {
    const recorded: string[] = [];

    const bytes = await readTrackedFile(safePath.join(root, 'gone.ts'), (reason) => recorded.push(reason));

    expect(bytes).toBeNull();
    expect(recorded).toEqual([]);
  });

  it.skipIf(CANNOT_DENY_READS)('returns null and records the refusal, naming the errno, for a file it may not read', async () => {
    const locked = safePath.join(root, 'locked.ts');
    writeFileSync(locked, '// locked\n', UTF8);
    chmodSync(locked, 0o000);
    const recorded: string[] = [];

    try {
      const bytes = await readTrackedFile(locked, (reason) => recorded.push(reason));
      expect(bytes).toBeNull();
    } finally {
      chmodSync(locked, 0o600);
    }
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toContain('EACCES');
  });
});

describe('walkDirectory — a directory the walk could not list', () => {
  it('is a no-op over a directory that does not exist', () => {
    const seen: string[] = [];

    walkDirectory(safePath.join(root, 'absent'), 'absent', {
      onFile: ({ relPath }) => {
        seen.push(relPath);
      },
    });

    expect(seen).toEqual([]);
  });

  it.skipIf(CANNOT_DENY_READS)('throws rather than reporting the directory as empty when the listing is refused', () => {
    const locked = safePath.join(root, 'locked-dir');
    mkdirSyncReal(locked, { recursive: true });
    writeFileSync(safePath.join(locked, 'inside.ts'), '// inside\n', UTF8);
    chmodSync(locked, 0o000);

    try {
      expect(() => walkDirectory(locked, 'locked-dir', {})).toThrow(expect.objectContaining({ code: 'EACCES' }));
    } finally {
      chmodSync(locked, 0o700);
    }
  });
});
