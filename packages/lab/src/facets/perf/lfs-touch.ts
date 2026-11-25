/**
 * The touched-LFS arm: what a store HIT costs when git must re-clean filtered files.
 *
 * It builds a scratch repository under the arms root whose `filter.lfs.clean`
 * and `filter.lfs.smudge` run the lab's own filter script
 * (`test/fixtures/lfs-filter.mjs`) as `"<runtime>" "<script>" clean|smudge`,
 * the runtime running the lab (git runs a filter through `sh`, so never a bare
 * `node`), commits N files of S bytes under it, and primes one warm store with
 * an untimed `vat resources validate`. Then each round:
 *
 * 1. **touched** — every filtered file's mtime moves one second below the last
 *    second it held ({@link touchSeconds}), at least ten seconds in the past;
 *    the bytes, and so the tree hash, are unchanged. One `vat resources validate` is measured: a store hit whose
 *    snapshot finds every file stat-dirty and re-cleans it.
 * 2. **refreshed** — `git update-index -q --refresh` (untimed) re-cleans them
 *    once and records their stat in the index; the same step is measured again.
 *
 * Each measured step reports, from the filter's own log (`LAB_LFS_LOG`, one
 * `<bytes>\n` line per invocation, truncated before the step), how many times git
 * ran the filter and over how many bytes, with the step's wall time, the
 * resources population its document published (`store` on a hit), and
 * `git.snapshots` from that step's own work dump (`VAT_WORK_COUNTERS`). One
 * process, `resources validate`, so the checks child's own snapshot never
 * enters the count. The io facet cannot see this work: it counts Node calls in
 * VAT's process (`facets/io/types.ts`), not bytes and not git's children.
 *
 * **No entry is racily clean.** Git trusts an index entry's stat only when the
 * file's mtime is older than the index file's; one written in the same second is
 * re-checked by content on every look. Every fixture file is backdated ten
 * seconds (`utimesSync`) before the commit, and every touch lies further back
 * still before every refresh, so "refreshed" means clean by stat, and its count
 * is git's, not the clock's.
 *
 * Git here runs under the arm's environment (`GIT_CONFIG_NOSYSTEM=1`, the arm's
 * empty home), so a machine's git-lfs `filter.lfs.process` never replaces the
 * lab's filter; the repository sets `core.autocrlf=false`.
 */

import { readFileSync, utimesSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, mapInOrder, resolveFromImportMeta, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';

import { armRefusal } from '../../harness/arm-dirs.js';
import { exactExit, MEASURABLE_COMMANDS } from '../../harness/commands.js';
import { readProvenance } from '../../harness/provenance.js';
import { countOf, readWorkDumps, type WorkDumpsRead } from '../work/dump.js';

import { armGitOrRefuse, openScratchArm, runArmVat, type ScratchArm, type ScratchBuild } from './scratch-arm.js';

/**
 * The lab's filter script. The lab is private and runs from its checkout, and
 * `src/facets/perf/` and `dist/facets/perf/` sit at one depth under the package,
 * so one relative path reaches it from both.
 */
export const LFS_FILTER_SCRIPT = resolveFromImportMeta(import.meta.url, '../../../test/fixtures/lfs-filter.mjs');

/** Default `--files`. */
export const DEFAULT_LFS_FILES = 100;
/** Default `--size`: 2 MB. */
export const DEFAULT_LFS_SIZE = 2 * 1024 * 1024;
/** Default `--rounds`. */
export const DEFAULT_LFS_ROUNDS = 3;

/** The arm's name, its directory segment. */
const LFS_TOUCH_ARM = 'lfs-touch';
/** The variable the filter appends its log lines to. */
const LFS_LOG_ENV = 'LAB_LFS_LOG';
/** How far every fixture mtime lies behind the clock, in seconds. */
const BACKDATE_SECONDS = 10;
/** The measured step: one `vat resources validate` process, exit 0. */
const RESOURCES_VALIDATE = MEASURABLE_COMMANDS['resources-validate-ci'];
const CLEAN = exactExit(0);
/** Identity and signing for the fixture commit: the arm's home has no git config. */
const COMMIT_IDENTITY = ['-c', 'user.name=Lab', '-c', 'user.email=lab@example.invalid', '-c', 'commit.gpgsign=false'];

/** How the arm runs. */
interface LfsTouchOptions {
  /** The invocation's arms root; the scratch repository is `<armsRoot>/lfs-touch/repo`. */
  readonly armsRoot: string;
  /** Filtered files, N. */
  readonly files: number;
  /** Bytes per file, S. */
  readonly size: number;
  /** Rounds, each one touched and one refreshed step. */
  readonly rounds: number;
  /** The filter script git runs. */
  readonly filterScript: string;
  readonly timeoutMs: number | undefined;
}

/** One measured step. */
interface LfsStep {
  /** Filter processes git ran during the step. */
  readonly invocations: number;
  /** Bytes they read, summed. */
  readonly bytes: number;
  readonly wallMs: number;
  /**
   * The resources population the step's document published (`data.population`),
   * read as the edit arms read it; `store` is a hit. `null` when it published none.
   */
  readonly population: string | null;
  /** `git.snapshots` in the step's work dump; `null` when the dump could not be read. */
  readonly gitSnapshots: number | null;
  /** Why the dump could not be read, or `null`. */
  readonly workRefusal: string | null;
}

/** One round. */
interface LfsRound {
  readonly touched: LfsStep;
  readonly refreshed: LfsStep;
}

/** The arm's result. */
interface LfsTouchReport {
  readonly files: number;
  readonly size: number;
  readonly rounds: readonly LfsRound[];
}

/** The scratch repository and the arm that runs in it. */
interface LfsScratch {
  readonly arm: ScratchArm;
  readonly repo: string;
  readonly log: string;
  readonly work: string;
  readonly paths: readonly string[];
  /** The whole second every fixture file was backdated to before the commit. */
  readonly backdated: number;
}

/**
 * Build the scratch repository, prime its store, and measure every round.
 *
 * @param build - The build that runs `resources validate`
 * @param options - See {@link LfsTouchOptions}
 * @returns Every round's touched and refreshed step
 * @throws {VatError} `LAB_ARM_REFUSED` when a fixture git or a step fails
 */
export async function runLfsTouchArm(build: ScratchBuild, options: LfsTouchOptions): Promise<LfsTouchReport> {
  const scratch = buildScratchRepository(build, options);
  runArmVat(scratch.arm, RESOURCES_VALIDATE.args, scratch.repo, { [LFS_LOG_ENV]: scratch.log }, CLEAN);
  const seconds = touchSeconds(scratch.backdated, options.rounds);
  const rounds = await mapInOrder(seconds, async (second, round) => {
    for (const path of scratch.paths) utimesSync(path, second, second);
    const touched = await measureStep(scratch, `${String(round)}-touched`);
    armGitOrRefuse(scratch.arm, ['update-index', '-q', '--refresh'], scratch.repo);
    const refreshed = await measureStep(scratch, `${String(round)}-refreshed`);
    return { touched, refreshed };
  });
  return { files: options.files, size: options.size, rounds };
}

/**
 * @param build - The build
 * @param options - The arm's options
 * @returns The committed scratch repository
 */
function buildScratchRepository(build: ScratchBuild, options: LfsTouchOptions): LfsScratch {
  const arm = openScratchArm(options.armsRoot, build, LFS_TOUCH_ARM, options.timeoutMs);
  const base = safePath.join(options.armsRoot, LFS_TOUCH_ARM);
  const repo = safePath.join(base, 'repo');
  const work = safePath.join(base, 'work');
  mkdirSyncReal(repo, { recursive: true });
  mkdirSyncReal(work, { recursive: true });
  const log = safePath.join(base, 'filter.log');
  writeFileSync(log, '');

  armGitOrRefuse(arm, ['init', '--quiet'], repo);
  armGitOrRefuse(arm, ['symbolic-ref', 'HEAD', 'refs/heads/lab'], repo);
  for (const [key, value] of [
    ['core.autocrlf', 'false'],
    ['filter.lfs.clean', filterCommand(process.execPath, options.filterScript, 'clean')],
    ['filter.lfs.smudge', filterCommand(process.execPath, options.filterScript, 'smudge')],
    ['filter.lfs.required', 'true'],
  ] as const) {
    armGitOrRefuse(arm, ['config', key, value], repo);
  }

  const plain = [
    writeFixture(repo, 'vibe-agent-toolkit.config.yaml', 'resources:\n  collections:\n    docs:\n      include:\n        - "docs/**/*.md"\n'),
    writeFixture(repo, 'docs/guide.md', '# guide\n'),
    writeFixture(repo, '.gitattributes', 'lfs/*.bin filter=lfs diff=lfs merge=lfs -text\n'),
  ];
  const paths = Array.from({ length: options.files }, (_, index) =>
    writeFixture(repo, `lfs/file-${String(index)}.bin`, Buffer.alloc(options.size, `lfs file ${String(index)} `)),
  );
  // Every fixture file, filtered or not, so no index entry the commit writes is racily clean.
  const backdated = Math.floor(Date.now() / 1000) - BACKDATE_SECONDS;
  for (const path of [...plain, ...paths]) utimesSync(path, backdated, backdated);
  armGitOrRefuse(arm, ['add', '--all'], repo);
  armGitOrRefuse(arm, [...COMMIT_IDENTITY, 'commit', '--quiet', '-m', 'lfs fixture'], repo);
  return { arm, repo, log, work, paths, backdated };
}

/**
 * @param repo - The repository
 * @param relative - A forward-slashed path in it
 * @param content - Its bytes
 * @returns The file's absolute path
 */
function writeFixture(repo: string, relative: string, content: string | Buffer): string {
  const path = safePath.join(repo, relative);
  mkdirSyncReal(safePath.join(path, '..'), { recursive: true });
  writeFileSync(path, content);
  return path;
}

/**
 * The whole second each round's touch moves every filtered file's mtime to:
 * one below the fixture's backdated second, then one lower per round. Every
 * touch is strictly earlier than every mtime used before it, so no touch can
 * land on the mtime an index entry holds, on any host (Git for Windows reads
 * no ctime change from `utimes`, so a repeated mtime would read clean there),
 * and each lies at least {@link BACKDATE_SECONDS} behind the clock, so no later
 * index write can see a file as racily clean.
 *
 * @param backdated - The second the fixture was backdated to before its commit
 * @param rounds - How many touches
 * @returns One second per round
 */
export function touchSeconds(backdated: number, rounds: number): number[] {
  return Array.from({ length: rounds }, (_, round) => backdated - (round + 1));
}

/**
 * Run one measured `vat resources validate` and read the filter log and the work dump.
 *
 * @param scratch - The repository
 * @param name - The step's work directory name
 * @returns The step
 */
async function measureStep(scratch: LfsScratch, name: string): Promise<LfsStep> {
  const workDir = safePath.join(scratch.work, name);
  mkdirSyncReal(workDir, { recursive: true });
  writeFileSync(scratch.log, '');
  const ran = runArmVat(
    scratch.arm,
    RESOURCES_VALIDATE.args,
    scratch.repo,
    { [LFS_LOG_ENV]: scratch.log, VAT_WORK_COUNTERS: workDir },
    CLEAN,
  );
  const logged = readFilterLog(scratch.log);
  const dumps = await readWorkDumps(workDir);
  // `resources validate` publishes its population where `resources check` does: `data.population`.
  const population = readProvenance('resources-check', ran.stdout)?.resources ?? null;
  return { ...logged, wallMs: ran.wallMs, population, ...snapshotReading(dumps) };
}

/**
 * @param dumps - One measured step's work dumps
 * @returns `git.snapshots` from them, or `null` and why
 */
export function snapshotReading(dumps: WorkDumpsRead): Pick<LfsStep, 'gitSnapshots' | 'workRefusal'> {
  if (!dumps.ok) return { gitSnapshots: null, workRefusal: dumps.refusal };
  const snapshots = countOf(dumps.merged, 'git.snapshots');
  // A build that predates the counter has no reading: never a measured 0.
  if (snapshots === undefined) return { gitSnapshots: null, workRefusal: 'the measured vat does not emit git.snapshots' };
  return { gitSnapshots: snapshots, workRefusal: null };
}

/**
 * The filter command git runs through `sh`: the runtime running the lab (node, or
 * bun when bun launched it) and the script, each forward-slashed and
 * double-quoted. A path holding a character `sh` still reads inside double
 * quotes (`"`, `$`, a backtick, or a backslash that survives: on POSIX it is a
 * filename character, never a separator) is refused rather than escaped.
 *
 * @param runtime - The runtime's executable (`process.execPath`)
 * @param script - The filter script
 * @param mode - `clean` or `smudge`
 * @returns The command
 * @throws {VatError} `LAB_ARM_REFUSED` naming a path `sh` would not read verbatim
 */
export function filterCommand(runtime: string, script: string, mode: 'clean' | 'smudge'): string {
  const quoted = [runtime, script].map((path) => {
    const forward = toForwardSlash(path);
    if (/["$`\\]/u.test(forward)) {
      throw armRefusal(`the LFS filter path '${forward}' holds a character sh reads inside double quotes (", $, \` or \\)`);
    }
    return `"${forward}"`;
  });
  return `${quoted.join(' ')} ${mode}`;
}

/**
 * @param log - The filter log
 * @returns Its line count and the bytes they record
 * @throws {VatError} `LAB_ARM_REFUSED` on a line that is not a byte count
 */
function readFilterLog(log: string): { readonly invocations: number; readonly bytes: number } {
  return parseFilterLog(readFileSync(log, 'utf8'), log);
}

/**
 * @param text - The filter log's text, one `<bytes>` line per invocation
 * @param log - Its path, for the refusal
 * @returns Its line count and the bytes they record
 * @throws {VatError} `LAB_ARM_REFUSED` on a line that is not a byte count
 */
export function parseFilterLog(text: string, log: string): { readonly invocations: number; readonly bytes: number } {
  const lines = text.split('\n').filter((line) => line !== '');
  let bytes = 0;
  for (const line of lines) {
    if (!/^\d+$/u.test(line)) throw armRefusal(`the LFS filter log '${log}' holds a line that is not a byte count: '${line}'`);
    bytes += Number(line);
  }
  return { invocations: lines.length, bytes };
}

/**
 * @param report - What {@link runLfsTouchArm} returned
 * @returns One line per measured step
 */
export function renderLfsTouchReport(report: LfsTouchReport): string {
  const step = (label: string, each: LfsStep): string => {
    const snapshots = each.gitSnapshots === null ? 'unread (' + (each.workRefusal ?? 'no dump') + ')' : String(each.gitSnapshots);
    return `${label.padEnd(10)} ${String(each.invocations).padStart(5)} filter runs  ${String(each.bytes).padStart(12)} bytes  ` +
      `${each.wallMs.toFixed(1)}ms  population ${each.population ?? 'unpublished'}  git.snapshots ${snapshots}`;
  };
  const lines = report.rounds.flatMap((round, index) => [
    `round ${String(index + 1)}`,
    `  ${step('touched', round.touched)}`,
    `  ${step('refreshed', round.refreshed)}`,
  ]);
  return [`perf lfs-touch — ${String(report.files)} files of ${String(report.size)} bytes`, ...lines].join('\n');
}
