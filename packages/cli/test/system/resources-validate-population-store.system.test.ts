/**
 * `vat resources validate`, run twice against one pinned projection store,
 * gives the same answer both times — and the second run SAYS the store served
 * it.
 *
 * `data.population` is derived from `populate()`'s own outcome, never from a
 * side tell, so the only way the warm run can report `'store'` is that every
 * root's population was a hit. Each fixture shape is one most likely to make a
 * stored extent differ from a derived one, and each case first asserts its shape
 * DID produce its finding — an equality between two runs that never saw the
 * shape proves nothing about it:
 *
 * - two broken links in two files (every host) — findings from more than one
 *   file, so their order is observable;
 * - two declined symlinks (hosts that can create one) — two conditions of one
 *   code, the shape whose order a stored extent once reversed;
 * - a gitignored directory the OS will not list (hosts that can deny reads) — a
 *   condition row, not a refusal: the resources verbs refuse only a NON-ignored
 *   one;
 * - that directory AND a declined symlink together (hosts that can do both) —
 *   two condition CODES. This is the case that went red when the population was
 *   unsorted: a derived run emits the unlistable directory before the link, the
 *   store hands them back in its own order, and the warm findings came out
 *   reversed. Two links of one code did not reproduce it.
 *
 * A findings-only run writes nothing to stderr, so stderr is compared whole
 * rather than as one line.
 *
 * Isolation: `HOME`, `USERPROFILE`, `CLAUDE_CONFIG_DIR` and `TMPDIR` all point
 * into scratch, and the store directory is pinned through the variable the
 * module under test owns.
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { createSymlink, mkdirSyncReal, normalizedTmpdir, safePath, symlinkCapability } from '@vibe-agent-toolkit/utils';
import { CANNOT_DENY_READS } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PROJECTION_STORE_DIR_ENV } from '../../src/utils/projection-store.js';
import { commitTestFixture } from '../test-helpers.js';

import { executeCli, fakeHomeEnv, getBinPath } from './test-common.js';

const binPath = getBinPath(import.meta.url);

/** The directory the OS refuses to list. Gitignored, so the run is not refused. */
const LOCKED_DIR = 'locked';

/** Null on a host that cannot create symlinks; the symlink case is skipped there. */
const SYMLINKS = symlinkCapability();

/** The two files whose links are broken, in every fixture. */
const BROKEN_ONE = 'docs/one.md';
const BROKEN_TWO = 'docs/three.md';

/** The two declined links of the symlink fixture. */
const LINK_Z = 'docs/linked-z.md';
const LINK_Y = 'docs/linked-y.md';

let scratch: string;

interface Finding {
  readonly code: string;
  readonly location: string;
}

interface Run {
  readonly status: number | null;
  readonly document: { readonly findings: Finding[]; readonly summary: unknown; readonly data: Record<string, unknown> };
  readonly stderr: string;
}

/**
 * A committed corpus holding the two broken links, plus whatever `plant` adds.
 *
 * @param name - The corpus directory's name under scratch
 * @param plant - Adds this case's shape; runs before the commit
 * @returns The corpus root
 */
function corpusWith(name: string, plant: (corpus: string) => void): string {
  const corpus = safePath.join(scratch, name);
  mkdirSyncReal(safePath.join(corpus, 'docs'), { recursive: true });
  writeFileSync(safePath.join(corpus, BROKEN_ONE), '# One\n\nSee [missing](./missing.md).\n', 'utf-8');
  writeFileSync(safePath.join(corpus, 'docs', 'two.md'), '# Two\n', 'utf-8');
  writeFileSync(safePath.join(corpus, BROKEN_TWO), '# Three\n\nSee [gone](./gone.md).\n', 'utf-8');
  plant(corpus);
  commitTestFixture(corpus);
  return corpus;
}

/**
 * Run `vat resources validate` once against a pinned store.
 *
 * @param corpus - The tree to validate
 * @param storeDir - The store directory, shared by both runs of one case
 * @returns The exit status, the parsed document and stderr
 */
async function validateOnce(corpus: string, storeDir: string): Promise<Run> {
  const result = await executeCli(binPath, ['resources', 'validate', '--format', 'json'], {
    cwd: corpus,
    env: {
      ...fakeHomeEnv(safePath.join(scratch, 'home')),
      TMPDIR: safePath.join(scratch, 'tmp'),
      VAT_RESOURCES_CRAWL: 'projection',
      VAT_PROJECTION_STORE: 'sqlite',
      [PROJECTION_STORE_DIR_ENV]: storeDir,
    },
  });
  return {
    status: result.status,
    document: JSON.parse(result.stdout) as Run['document'],
    stderr: result.stderr,
  };
}

/**
 * Validate one corpus cold then warm, and assert the two answers are one answer
 * and the warm one was served.
 *
 * @param corpus - The tree to validate
 * @returns The cold run, for the case's own shape assertions
 */
async function expectServedIdentically(corpus: string): Promise<Run> {
  // A sibling of the corpus, so the store is not part of the tree it keys.
  const storeDir = `${corpus}-store`;
  const cold = await validateOnce(corpus, storeDir);
  const warm = await validateOnce(corpus, storeDir);

  expect(cold.status).not.toBe(0);
  expect(warm.status).toBe(cold.status);
  expect(warm.document.findings).toEqual(cold.document.findings);
  expect(warm.document.summary).toEqual(cold.document.summary);
  expect(warm.stderr).toBe(cold.stderr);
  expect(cold.document.data['population']).toBe('derived');
  expect(warm.document.data['population']).toBe('store');
  return cold;
}

/**
 * The locations a run reported a code at.
 *
 * @param run - One run
 * @param code - The finding code
 * @returns Every location carrying it, in published order
 */
function locationsOf(run: Run, code: string): string[] {
  return run.document.findings.filter((finding) => finding.code === code).map((finding) => finding.location);
}

/** Every corpus that locked its directory, so each is unlocked for removal. */
const locked: string[] = [];

/**
 * A corpus with the locked, gitignored directory, plus whatever `plant` adds.
 *
 * @param name - The corpus directory's name under scratch
 * @param plant - Adds anything else this case needs
 * @returns The corpus root, its directory already unlistable
 */
function lockedCorpus(name: string, plant: (corpus: string) => void): string {
  const corpus = corpusWith(name, (root) => {
    mkdirSyncReal(safePath.join(root, LOCKED_DIR), { recursive: true });
    writeFileSync(safePath.join(root, '.gitignore'), `${LOCKED_DIR}/\n`, 'utf-8');
    writeFileSync(safePath.join(root, LOCKED_DIR, 'hidden.md'), '# Hidden\n', 'utf-8');
    plant(root);
  });
  chmodSync(safePath.join(corpus, LOCKED_DIR), 0o000);
  locked.push(corpus);
  return corpus;
}

describe('vat resources validate twice against one pinned store (system test)', () => {
  beforeAll(() => {
    scratch = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-validate-population-'));
    mkdirSyncReal(safePath.join(scratch, 'home', '.claude'), { recursive: true });
    mkdirSyncReal(safePath.join(scratch, 'tmp'), { recursive: true });
  });

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it('answers broken links in two files identically, the second time from the store', async () => {
    const cold = await expectServedIdentically(corpusWith('links', () => undefined));

    expect(locationsOf(cold, 'LINK_BROKEN_FILE')).toEqual([
      expect.stringContaining(BROKEN_ONE),
      expect.stringContaining(BROKEN_TWO),
    ]);
  });

  it.skipIf(SYMLINKS === null)('answers two declined symlinks identically and in one order', async () => {
    const corpus = corpusWith('symlinks', (root) => {
      if (SYMLINKS === null) return;
      createSymlink(SYMLINKS, 'two.md', safePath.join(root, LINK_Z));
      createSymlink(SYMLINKS, 'two.md', safePath.join(root, LINK_Y));
    });
    const cold = await expectServedIdentically(corpus);

    expect(locationsOf(cold, 'EXTENT_SYMLINK_NOT_REALIZED')).toEqual([LINK_Y, LINK_Z]);
    expect(locationsOf(cold, 'LINK_BROKEN_FILE')).toHaveLength(2);
  });

  describe.skipIf(CANNOT_DENY_READS)('a gitignored directory the OS will not list', () => {
    afterAll(() => {
      for (const corpus of locked) chmodSync(safePath.join(corpus, LOCKED_DIR), 0o755);
    });

    it('is reported as a condition, identically, the second time from the store', async () => {
      const cold = await expectServedIdentically(lockedCorpus('locked', () => undefined));

      expect(locationsOf(cold, 'EXTENT_DIRECTORY_UNLISTABLE')).toEqual([LOCKED_DIR]);
      expect(locationsOf(cold, 'LINK_BROKEN_FILE')).toHaveLength(2);
    });

    it.skipIf(SYMLINKS === null)('beside a declined symlink, comes out in one order cold and warm', async () => {
      const corpus = lockedCorpus('locked-and-linked', (root) => {
        if (SYMLINKS !== null) createSymlink(SYMLINKS, 'two.md', safePath.join(root, LINK_Z));
      });
      const cold = await expectServedIdentically(corpus);

      expect(locationsOf(cold, 'EXTENT_DIRECTORY_UNLISTABLE')).toEqual([LOCKED_DIR]);
      expect(locationsOf(cold, 'EXTENT_SYMLINK_NOT_REALIZED')).toEqual([LINK_Z]);
    });
  });
});
