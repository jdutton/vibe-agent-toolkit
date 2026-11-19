/**
 * An unreadable input under the run's one population is refused the way it was
 * before the phases shared it: the same exit code and the same sentence, in
 * every phase that reaches it.
 *
 * The companion of `work-counters-validate.system.test.ts`, whose corpus holds
 * only readable files. Two fixtures, each a committed git tree with one input
 * made unreadable after the commit:
 *
 * - an unreadable FILE: enumerated, its read refused, reported per phase as
 *   `RESOURCE_UNREADABLE` (exit 1).
 * - an unreadable DIRECTORY: its listing refused, the run refused with
 *   `INPUT_UNREADABLE` (exit 2) before any phase admits anything.
 *
 * The expected sentences are the ones v0.2.0-rc.17 prints for these fixtures.
 * `chmod 000` is the whole fixture, so the suite is POSIX-only and refuses to
 * run as root, where nothing is denied and it would pass by reading the input.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, utimesSync } from 'node:fs';

import { mkdirSyncReal, WORK_COUNTERS_ENV, type WorkCounterDump } from '@vibe-agent-toolkit/utils';
import { CANNOT_DENY_READS, gitExecutable } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PROJECTION_STORE_DIR_ENV } from '../../src/utils/projection-store.js';
import { commitTestFixture } from '../test-helpers.js';

import { createSuiteContext, executeCli, fs, join, writeTestFile } from './test-common.js';

const context = createSuiteContext('vat-work-unreadable-', import.meta.url);

const UNREADABLE = 0o000;
const READABLE = 0o755;

const FILES: Readonly<Record<string, string>> = {
  'vibe-agent-toolkit.config.yaml': 'resources:\n  include:\n    - "**/*.md"\n',
  'README.md': '# Corpus\n\nSee [the guide](./docs/guide.md).\n',
  'docs/guide.md': '# Guide\n',
  'docs/secret.md': '# Secret\n',
  'docs/locked/inner.md': '# Inner\n',
};

const LOCKED_FILE = 'docs/secret.md';
const LOCKED_DIR = 'docs/locked';

/** rc.17's per-phase sentences for the unreadable file. */
const FILE_RESOURCES_SENTENCE =
  "docs/secret.md: error: 'docs/secret.md' was enumerated but could not be read (EACCES), so it was skipped: nothing in it was checked. [RESOURCE_UNREADABLE]";
const FILE_CHECKS_SENTENCE =
  "docs/secret.md: error: 'docs/secret.md' was enumerated but could not be read, so no check saw its rows and this run's verdict does not cover it. [RESOURCE_UNREADABLE]";

/** rc.17's refusal for the unreadable directory. */
const DIR_SENTENCE =
  "Listing the directory 'docs/locked' was refused (EACCES): any file beneath it that no other listing named is absent from every count, and the result cannot be told from a complete one. Fix the permissions on that directory, or — if it is not part of the project — gitignore it: the population is every non-ignored path beneath the root regardless of resources.include or resources.exclude, so only an ignore rule keeps a directory out of it.. Grant read permission on the named input, or point the command at one it can read.";
const DIR_RUN_SENTENCE =
  "The run did not finish: phase 'resources' (INPUT_UNREADABLE), 'checks' (INPUT_UNREADABLE) stopped before it did. The phases that finished are in data.phases.";

/** An mtime well before any index this suite's commits write (seconds since the epoch). */
const BACKDATED = Date.now() / 1000 - 3600;

/** A committed copy of the fixture with `locked` made unreadable after the commit. */
function lockedFixture(locked: string): { root: string; path: string } {
  const root = join(context.createTempDir(), 'corpus');
  for (const [path, content] of Object.entries(FILES)) {
    const absolute = join(root, path);
    mkdirSyncReal(join(absolute, '..'), { recursive: true });
    writeTestFile(absolute, content);
    // Older than the index the commit writes: a file whose mtime is not older
    // than its index is "racily clean", and git re-reads it whatever its stat.
    utimesSync(absolute, BACKDATED, BACKDATED);
  }
  commitTestFixture(root);
  // The chmod below changes the file's ctime. Git compares ctime at second
  // granularity, so whether the store's snapshot (`git add --all` into a
  // scratch index) re-reads the locked file, and refuses the run at exit 2,
  // depends on whether the chmod lands in the same second as the commit's add.
  // rc.17 shows the same race. Not trusting ctime, with the backdated mtime
  // above, pins the case under test: an unreadable committed file the index
  // still vouches for.
  spawnSync(gitExecutable(), ['-C', root, 'config', 'core.trustctime', 'false'], { stdio: 'ignore' });
  const path = join(root, locked);
  chmodSync(path, UNREADABLE);
  return { root, path };
}

const lockedPaths: string[] = [];

/** One run of `vat <args>` in `root`, with a private store and counters. */
async function run(root: string, args: string[]) {
  const workDir = context.createTempDir();
  const result = await executeCli(context.binPath, args, {
    cwd: root,
    env: {
      [PROJECTION_STORE_DIR_ENV]: context.createTempDir(),
      [WORK_COUNTERS_ENV]: workDir,
    },
  });
  const dumps = fs
    .readdirSync(workDir)
    .map((name) => JSON.parse(fs.readFileSync(join(workDir, name), 'utf-8')) as WorkCounterDump)
    .filter((dump) => dump.role === 'cli');
  return { ...result, dumps };
}

beforeAll(() => {
  context.setup();
});

afterAll(() => {
  for (const path of lockedPaths) chmodSync(path, READABLE);
  context.cleanup();
});

describe.skipIf(CANNOT_DENY_READS)('an unreadable input under the run population', () => {
  let file: { root: string; path: string };
  let dir: { root: string; path: string };

  beforeAll(() => {
    file = lockedFixture(LOCKED_FILE);
    dir = lockedFixture(LOCKED_DIR);
    lockedPaths.push(file.path, dir.path);
  });

  it('vat validate: an unreadable file is reported by each phase as in rc.17, exit 1', async () => {
    const result = await run(file.root, ['validate']);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain(FILE_RESOURCES_SENTENCE);
    expect(result.stderr).toContain(FILE_CHECKS_SENTENCE);
    // Positive control: the validate process dumped its counters.
    const parent = result.dumps.filter((dump) => 'resources' in dump.phases);
    expect(parent).toHaveLength(1);
  });

  it('vat resources validate: an unreadable file is reported as in rc.17, exit 1', async () => {
    const result = await run(file.root, ['resources', 'validate']);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain(FILE_RESOURCES_SENTENCE);
  });

  it('vat validate: an unreadable directory refuses the run as in rc.17, exit 2', async () => {
    const result = await run(dir.root, ['validate']);
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain(DIR_SENTENCE);
    expect(result.stderr).toContain(DIR_RUN_SENTENCE);
    expect(result.stdout).toContain('code: RUN_INCOMPLETE');
  });

  it('vat resources validate: an unreadable directory refuses the command as in rc.17, exit 2', async () => {
    const result = await run(dir.root, ['resources', 'validate']);
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain(DIR_SENTENCE);
    expect(result.stdout).toContain('code: INPUT_UNREADABLE');
  });
});
