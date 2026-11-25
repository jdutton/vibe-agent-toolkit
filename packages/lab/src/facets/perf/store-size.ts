/**
 * The store-size arm: how VAT's store grows as a subject's history is replayed.
 *
 * The subject's last N first-parent commits are replayed oldest first in a
 * lab-owned clone (`prepareClone` at the oldest, then `git checkout --detach`
 * of each), one `vat validate` each into ONE arm store that starts empty, so
 * row 1 is a fresh store and every later row is that store carried forward one
 * commit. Each row records the store's size and the step's wall time.
 *
 * **What the size is.** `page_count * page_size` of the database file VAT keeps
 * under the arm's `VAT_CACHE_DIR`, read through a READ-WRITE connection after
 * `PRAGMA wal_checkpoint(TRUNCATE)` (a read-only connection cannot checkpoint),
 * so when the write-ahead log was folded in never moves the number. The `-wal`
 * file's own size is not the measure: VAT checkpoints before every close and
 * SQLite removes the file at the last close, so after a run it is absent (or
 * empty) whatever the store holds.
 *
 * The store is a file under a directory the lab owns and hands VAT as
 * `VAT_CACHE_DIR`; its one name inside it (`projection.db`, under the build's
 * namespace) is found by walking that directory, and exactly one is required.
 */

import { readdirSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

import { safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { runGitBytes } from '@vibe-agent-toolkit/utils/git';

import { armRefusal } from '../../harness/arm-dirs.js';
import { prepareClone } from '../../harness/clone.js';
import { MEASURABLE_COMMANDS } from '../../harness/commands.js';
import { commandStep } from '../../harness/repeat.js';

import { armGitOrRefuse, openScratchArm, runArmVat, type ScratchArm, type ScratchBuild } from './scratch-arm.js';

/** The database file VAT keeps under `<VAT_CACHE_DIR>/<namespace>/projection-<digest>/`. */
const STORE_FILE_NAME = 'projection.db';

/** The arm's name, its directory segment. */
const STORE_SIZE_ARM = 'store-size';

/** The default number of commits replayed (`--commits`). */
export const DEFAULT_STORE_SIZE_COMMITS = 20;

/** One replayed commit. */
export interface StoreSizeRow {
  /** The commit checked out, full SHA. */
  readonly commit: string;
  /** `page_count * page_size` after a truncating checkpoint. */
  readonly storeBytes: number;
  /** The `validate` step's wall time. */
  readonly wallMs: number;
  /** Its exit: 0, or 1 when the commit has findings. */
  readonly exitCode: number;
}

/** The arm's result. */
export interface StoreSizeReport {
  /** Oldest first. */
  readonly perCommit: readonly StoreSizeRow[];
}

/** How the arm runs. */
interface StoreSizeOptions {
  /** The invocation's arms root; the clone is `<armsRoot>/clone`. */
  readonly armsRoot: string;
  /** First-parent commits to replay, ending at HEAD. */
  readonly commits: number;
  readonly timeoutMs: number | undefined;
}

/** The step every commit runs: `vat validate`, which may exit 1 on a commit with findings. */
const VALIDATE = MEASURABLE_COMMANDS['validate-ci'];

/** `node:sqlite`'s connection class, loaded only by the arm that reads a store (a type import is erased). */
type DatabaseSyncClass = typeof DatabaseSync;

/**
 * Replay the subject's last `commits` first-parent commits, one warm `validate` each.
 *
 * @param subject - The subject repository
 * @param build - The build that runs `validate`
 * @param options - See {@link StoreSizeOptions}
 * @returns One row per commit, oldest first
 * @throws {VatError} `LAB_ARM_REFUSED` when the subject has too few commits, the
 *   clone cannot be prepared, a checkout or a step fails, or the store is not one file
 */
export async function runStoreSizeArm(subject: string, build: ScratchBuild, options: StoreSizeOptions): Promise<StoreSizeReport> {
  const commits = firstParentCommits(subject, options.commits);
  const step = commandStep(VALIDATE, VALIDATE.args);
  const prepared = await prepareClone({
    source: subject,
    commit: commits[0] as string,
    armsRoot: options.armsRoot,
    prerequisites: [],
    warmup: { instrument: build.instrument, step },
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  if (!prepared.ok) throw armRefusal(prepared.refusal);

  const { DatabaseSync } = await import('node:sqlite');
  const arm = openScratchArm(options.armsRoot, build, STORE_SIZE_ARM, options.timeoutMs);
  const perCommit = commits.map((commit) => replayCommit(arm, prepared.path, commit, DatabaseSync));
  return { perCommit };
}

/**
 * @param subject - The subject repository
 * @param count - How many commits
 * @returns The last `count` first-parent commits of HEAD, oldest first
 * @throws {VatError} `LAB_ARM_REFUSED` when git cannot list them or there are fewer
 */
function firstParentCommits(subject: string, count: number): string[] {
  const listed = runGitBytes(['rev-list', '--first-parent', '-n', String(count), '--reverse', 'HEAD'], { cwd: subject });
  if (!listed.ok) throw armRefusal(`cannot list the first-parent commits of '${subject}' (git exit ${String(listed.status)})`);
  // Object names only: hex, so ASCII is exact.
  return commitsToReplay(listed.stdout.toString('ascii'), count, subject);
}

/**
 * @param listing - `rev-list` output, one commit per line
 * @param count - How many `--commits` asks for
 * @param subject - The subject, for the refusal
 * @returns The commits, oldest first
 * @throws {VatError} `LAB_ARM_REFUSED` when the listing holds fewer than `count`
 */
export function commitsToReplay(listing: string, count: number, subject: string): string[] {
  const commits = listing.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  if (commits.length < count) {
    throw armRefusal(`'${subject}' has ${String(commits.length)} first-parent commits at HEAD; --commits asks for ${String(count)}`);
  }
  return commits;
}

/**
 * Check one commit out, run `validate`, and read the store.
 *
 * @param arm - The arm
 * @param clone - The prepared clone
 * @param commit - The commit
 * @param database - `node:sqlite`'s connection class
 * @returns The commit's row
 */
function replayCommit(
  arm: ScratchArm,
  clone: string,
  commit: string,
  database: DatabaseSyncClass,
): StoreSizeRow {
  armGitOrRefuse(arm, ['checkout', '--quiet', '--detach', commit], clone);
  const ran = runArmVat(arm, VALIDATE.args, clone, {}, VALIDATE.exit);
  return { commit, storeBytes: storeBytes(arm.dirs.store, database), wallMs: ran.wallMs, exitCode: ran.exitCode };
}

/**
 * The store's size: `page_count * page_size` after a truncating checkpoint, through a read-write connection.
 *
 * @param cacheDir - The arm's `VAT_CACHE_DIR`
 * @param database - `node:sqlite`'s connection class
 * @returns Bytes
 * @throws {VatError} `LAB_ARM_REFUSED` unless exactly one store file lies under `cacheDir`
 */
function storeBytes(cacheDir: string, database: DatabaseSyncClass): number {
  const found = readdirSync(cacheDir, { recursive: true, encoding: 'utf8' })
    .map((relative) => toForwardSlash(relative))
    .filter((relative) => relative === STORE_FILE_NAME || relative.endsWith(`/${STORE_FILE_NAME}`));
  const [only] = found;
  if (only === undefined || found.length !== 1) {
    const named = found.length > 0 ? ': ' + found.join(', ') : '';
    throw armRefusal(`expected one ${STORE_FILE_NAME} under '${cacheDir}', found ${String(found.length)}${named}`);
  }
  const connection = new database(safePath.join(cacheDir, only));
  try {
    connection.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    const pages = pragmaNumber(connection.prepare('PRAGMA page_count').get(), 'page_count');
    const size = pragmaNumber(connection.prepare('PRAGMA page_size').get(), 'page_size');
    return pages * size;
  } finally {
    connection.close();
  }
}

/**
 * @param row - A one-column pragma row
 * @param name - The pragma, which names its column
 * @returns Its number
 * @throws {Error} when the row carries no number under that name
 */
function pragmaNumber(row: unknown, name: string): number {
  const value = (row as Record<string, unknown> | undefined)?.[name];
  if (typeof value !== 'number') throw new Error(`PRAGMA ${name} returned no number`);
  return value;
}

/**
 * @param report - What {@link runStoreSizeArm} returned
 * @returns One line per commit
 */
export function renderStoreSizeReport(report: StoreSizeReport): string {
  const lines = report.perCommit.map(
    (row, index) => `${String(index + 1).padStart(3)}  ${row.commit.slice(0, 12)}  ${String(row.storeBytes).padStart(12)} bytes  ${row.wallMs.toFixed(1)}ms  exit ${String(row.exitCode)}`,
  );
  return [`perf store-size — ${String(report.perCommit.length)} commits, oldest first`, ...lines].join('\n');
}
