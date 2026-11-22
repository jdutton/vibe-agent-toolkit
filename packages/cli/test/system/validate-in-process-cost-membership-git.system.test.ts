/**
 * What `vat validate`'s two in-process phases (resources, skills) read of the store's extent and
 * which git processes they start, warm (ADR I10): the membership read reads only the tables
 * membership consumes, and every git spawn is named per phase.
 *
 * The store-read, admission and `fs.lstat` arms over the same fixture are in
 * `validate-in-process-cost.system.test.ts`; the two share `validate-in-process-cost-fixture.ts`.
 */

import { MEMBERSHIP_EXTENT_REQUEST } from '@vibe-agent-toolkit/resources';
import { createSymlink, normalizePath, safePath, symlinkCapability, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { runGitOrThrow } from '@vibe-agent-toolkit/utils/git';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type GitSpawnRun, runWithGitSpawns } from '../helpers/git-spawn-run.js';
import { writeCommittedCorpus } from '../test-helpers.js';

import { createSuiteContext } from './test-common.js';
import {
  type DamageTarget,
  expectEveryDamageObserved,
  IN_PROCESS_COST_FIXTURE,
  storedRowCount,
  validateOver,
  type ValidateRun,
  withStoreDatabase,
  writeInProcessCostFixture,
} from './validate-in-process-cost-fixture.js';

const context = createSuiteContext('vat-in-process-membership-git-', import.meta.url);

beforeAll(() => {
  context.setup();
});

afterAll(() => {
  context.cleanup();
});

// ── The membership extent read ───────────────────────────────────────────────────────────────
//
// Membership reads `MEMBERSHIP_EXTENT_REQUEST`: three extent tables and no reconstruction step.
// The fixture holds no `realization_conditions` row of its own, so this arm plants one: a symlink,
// which the crawl declines with an `EXTENT_SYMLINK_NOT_REALIZED` row. Skipped where this host
// cannot create a link (Windows without Developer Mode).

/** The planted link, beside its in-root target. */
const PLANTED_LINK = 'docs/linked.md';

describe.skipIf(symlinkCapability() === null)('the membership read reads only what membership consumes, warm', () => {
  let repo: string;
  let warmCache: string;
  let warm: ValidateRun;

  beforeAll(async () => {
    const cap = symlinkCapability();
    if (cap === null) throw new Error('gated by skipIf');
    repo = writeInProcessCostFixture(context.createTempDir());
    createSymlink(cap, 'two.md', safePath.join(repo, PLANTED_LINK));
    warmCache = context.createTempDir();
    await validateOver(context, repo, warmCache, 'overlapped');
    warm = await validateOver(context, repo, warmCache, 'overlapped');
  });

  // The control: the damage arm below can only fail on a table that holds a row to damage.
  it('holds a row in every table membership reads', () => {
    withStoreDatabase(warmCache, (database) => {
      for (const table of MEMBERSHIP_EXTENT_REQUEST.tables) expect(storedRowCount(database, table, 'all'), `${table} rows`).toBeGreaterThan(0);
    });
  });

  it('changes what membership answers when any row it reads is damaged', async () => {
    const targets = MEMBERSHIP_EXTENT_REQUEST.tables.map((table): DamageTarget => ({ table, form: null }));
    await expectEveryDamageObserved(context, { repo, cacheDir: warmCache, warm }, targets, 'membership');
  });
});

// ── Git spawns per phase ─────────────────────────────────────────────────────────────────────
//
// Every git process validate's two in-process phases start, named with its arguments and working
// directory from the run's git spawn log (`VAT_GIT_SPAWNS`), and checked against the phase's
// `git.calls`. `core.symlinks` is pinned both ways on every OS: Git for Windows reads an unset key
// as `false`, which adds the index read of the links lane wherever that lane runs. The warm run
// (store on) never runs it, so both values name the same spawns there; the storeless run does, and
// is the arm that shows the pin reaches the run.
//
// The fixture declares a skill `files:` entry, so both phases discover the skills (the resources
// phase registers the declared files as deferred artifacts): the one shape in which the two phases
// crawl the same include base, with the same arguments in the same directory over the same tree.
// The run crawls it once.

/** The in-process phases the arms name. */
const GIT_PHASES = ['resources', 'skills'] as const;

/** One spawn as the arms name it: what ran, and where, relative to the fixture (`.` for its root). */
interface NamedSpawn {
  readonly via: 'runGit' | 'snapshot';
  readonly args: readonly string[];
  readonly cwd: string;
}

/** `git ls-files` of every tracked and untracked-not-ignored name: a `GitTracker`'s, and a git-routed crawl's. */
const NAME_LISTING = ['ls-files', '-z', '--cached', '--others', '--exclude-standard'] as const;

/** The fixture's one `skills.include` base (`skills/**\/SKILL.md`): skill discovery crawls it. */
const SKILLS_INCLUDE_BASE = 'skills';

/** The declared skill file's source: committed, so the deferred artifact resolves. */
const DECLARED_SKILL_FILE = 'assets/generated.txt';

/**
 * The cost fixture with the skill declaring one `files:` entry, committed under `root`.
 *
 * @param root - An empty directory
 * @returns `root`
 */
function writeGitSpawnFixture(root: string): string {
  const config = IN_PROCESS_COST_FIXTURE['vibe-agent-toolkit.config.yaml'];
  if (config?.endsWith('    - "skills/**/SKILL.md"\n') !== true) throw new Error('the cost fixture config no longer ends with its skills include');
  return writeCommittedCorpus(root, {
    ...IN_PROCESS_COST_FIXTURE,
    'vibe-agent-toolkit.config.yaml': `${config}  config:\n    cost:\n      files:\n        - source: ${DECLARED_SKILL_FILE}\n          dest: generated.txt\n`,
    [DECLARED_SKILL_FILE]: 'generated\n',
  });
}

/**
 * The spawns each phase starts, and why.
 *
 * Warm, store on:
 * - resources: the tree snapshot that keys the store, and the tree key's per-file flag read
 *   (`ls-files -v`, assume-unchanged and skip-worktree), both at the root; then skill discovery's
 *   git-routed crawl of the include base, for the declared files.
 * - skills: nothing. Its discovery is the resources phase's crawl, held by the run.
 *
 * The crawl's names are the root listing's under the base, but the run holds no root listing to
 * filter: the snapshot is another command (`add --all` into a temporary index, which drops a
 * tracked file deleted from the working tree that `--cached` keeps), and one root listing in place
 * of the per-base ones costs what they cost together on a large adopter. So each base is still
 * listed once per run.
 *
 * Store off: the home `GitTracker`'s listing, the links lane (`core.symlinks`, and the index under
 * `false` only), the prune listing, at the root, and the crawl; then `skills validate`'s shared
 * `GitTracker` at the root.
 *
 * @param store - Warm with the store on, or the store off
 * @param symlinks - The pinned `core.symlinks`
 * @returns The named spawns per phase, in order
 */
function expectedGitSpawns(store: 'warm' | 'off', symlinks: boolean): Record<(typeof GIT_PHASES)[number], NamedSpawn[]> {
  const crawl: NamedSpawn = { via: 'runGit', args: NAME_LISTING, cwd: SKILLS_INCLUDE_BASE };
  const tracker: NamedSpawn = { via: 'runGit', args: NAME_LISTING, cwd: '.' };
  if (store === 'warm') {
    return {
      resources: [{ via: 'snapshot', args: [], cwd: '.' }, { via: 'runGit', args: ['ls-files', '-v', '-z'], cwd: '.' }, crawl],
      skills: [],
    };
  }
  return {
    resources: [
      tracker,
      { via: 'runGit', args: ['config', '--type=bool', '--get', 'core.symlinks'], cwd: '.' },
      ...(symlinks ? [] : [{ via: 'runGit', args: ['ls-files', '-s', '-z'], cwd: '.' } as const]),
      { via: 'runGit', args: ['ls-files', '-z', '--others', '--exclude-standard', '--ignored', '--directory'], cwd: '.' },
      crawl,
    ],
    skills: [tracker],
  };
}

/**
 * The validate process's spawns per phase, named relative to the fixture, with each phase's
 * `git.calls` beside them.
 *
 * @param run - One `vat validate` run
 * @param repo - The fixture
 * @returns Per phase: the named spawns and the counter
 */
function namedGitSpawns(run: GitSpawnRun, repo: string): Record<string, { spawns: NamedSpawn[]; count: number | undefined }> {
  const parent = run.processes.find((process) => process.counters.phases['resources'] !== undefined);
  if (parent === undefined) throw new Error(`no validate process among ${String(run.processes.length)} dumps\n${run.result.stderr}`);
  const real = normalizePath(repo, { within: repo });
  const relative = (cwd: string): string => toForwardSlash(safePath.relative(real, normalizePath(cwd, { within: repo }))) || '.';
  return Object.fromEntries(GIT_PHASES.map((phase) => [phase, {
    spawns: parent.spawns.spawns.filter((spawn) => spawn.phase === phase).map(({ via, args, cwd }) => ({ via, args, cwd: relative(cwd) })),
    count: parent.counters.phases[phase]?.['git.calls'],
  }]));
}

describe('git spawns per phase, each named', () => {
  it.each([true, false])('core.symlinks=%s: names every spawn, warm and with the store off', async (symlinks) => {
    const repo = writeGitSpawnFixture(context.createTempDir());
    runGitOrThrow(['config', 'core.symlinks', String(symlinks)], { cwd: repo });
    const cacheDir = context.createTempDir();
    const cold = await runWithGitSpawns(context, repo, ['validate'], { cacheDir, storeOff: false });
    expect(cold.result.status, `cold\n${cold.result.stdout}\n${cold.result.stderr}`).toBe(0);
    const warm = await runWithGitSpawns(context, repo, ['validate'], { cacheDir, storeOff: false });
    expect(warm.result.status, `warm\n${warm.result.stdout}\n${warm.result.stderr}`).toBe(0);
    const off = await runWithGitSpawns(context, repo, ['validate'], { cacheDir: context.createTempDir(), storeOff: true });
    expect(off.result.status, `store off\n${off.result.stdout}\n${off.result.stderr}`).toBe(0);

    for (const [store, run] of [['warm', warm], ['off', off]] as const) {
      const named = namedGitSpawns(run, repo);
      const expected = expectedGitSpawns(store, symlinks);
      for (const phase of GIT_PHASES) {
        expect(named[phase]?.spawns, `${store}, ${phase}: the spawns`).toEqual(expected[phase]);
        expect(named[phase]?.count, `${store}, ${phase}: git.calls counts each named spawn`).toBe(expected[phase].length);
      }
    }
  });
});
