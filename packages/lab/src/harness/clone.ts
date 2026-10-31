/**
 * The tree the timed arms run in: a lab-owned clone of the subject, prepared the
 * way CI prepares it, once, before round 1.
 *
 * 1. **`git clone --local` at the measured commit** — the COMMITTED tree, never
 *    a copy of the developer's working tree, whose `node_modules/` and
 *    gitignored `dist/` are in whatever state the developer left them.
 * 2. **The subject's prerequisites**, untimed and exit-checked, in order — a
 *    parameter of the subject (`pnpm install --frozen-lockfile`, a build), so no
 *    project's names live here.
 * 3. **One warm-up snapshot**: one untimed VAT run in its own scratch store and
 *    `TMPDIR` under the arms root, never the defaults, so no round-1 arm alone
 *    pays for writing the clone's loose objects.
 * 4. **Proven back at the committed tree**: `git status --porcelain` is empty
 *    and a `git add --all` snapshot of the clone, over an index seeded from the
 *    commit, has the commit's own tree hash.
 *    A step that wrote a non-ignored file fails the preparation, naming it.
 *
 * **Every preparation git runs where the arms' VAT runs** — under the warm-up
 * arm's {@link armStepEnvironment}, the one environment path: the developer's
 * global git config, excludes, `GIT_CONFIG_*` overrides and every name git
 * exports into a hook are gone, `HOME` is the empty arm home and
 * `GIT_CONFIG_NOSYSTEM=1` keeps the machine's system config out too.
 * Under the developer's own config a globally-excluded file a prerequisite
 * wrote would vanish from the proof while every arm still saw it.
 */

import { everywhere, pathPresent, safePath } from '@vibe-agent-toolkit/utils';

import {
  type ArmDirectories,
  armDirectories,
  armPlacementRefusal,
  armStepEnvironment,
  prepareArmDirectories,
} from './arm-dirs.js';
import { runRepeats } from './repeat.js';
import { runCommand } from './run.js';
import type { SequenceStep } from './sequence.js';
import type { ResolvedInstrument } from './types.js';

/** What to clone and how to prepare it. */
export interface ClonePreparation {
  /** The subject repository. */
  readonly source: string;
  /** The measured commit, as any committish the subject resolves. */
  readonly commit: string;
  /** The invocation's arms root (`openArmsRoot`), outside the subject; the clone is `<armsRoot>/clone`. */
  readonly armsRoot: string;
  /** Untimed, exit-checked, in order. */
  readonly prerequisites: readonly SequenceStep[];
  /** The one warm-up VAT run and the build that runs it. */
  readonly warmup: { readonly instrument: ResolvedInstrument; readonly step: SequenceStep };
  readonly timeoutMs?: number;
}

/** A prepared clone, or why there is none. */
export type PreparedClone =
  | {
      readonly ok: true;
      readonly path: string;
      readonly commit: string;
      readonly tree: string;
      /** Inherited names every preparation git and the warm-up ran without. */
      readonly removedEnv: readonly string[];
      /** Inherited names the prerequisites ran without (every `VAT_*` name too: they are tool steps). */
      readonly removedToolEnv: readonly string[];
    }
  | { readonly ok: false; readonly refusal: string };

/**
 * Clone, prepare and prove a subject at one commit.
 *
 * @param preparation - See {@link ClonePreparation}
 * @returns The clone's path, commit and tree, or the refusal
 */
export async function prepareClone(preparation: ClonePreparation): Promise<PreparedClone> {
  const path = safePath.join(preparation.armsRoot, 'clone');
  // An entry, a dangling link included, is "already there"; a refused look throws rather than reading as absent.
  if (pathPresent(path, 'entry', everywhere('destination'), 'confirmed')) return refused(`the clone '${path}' already exists; preparation starts from nothing`);
  const placement = armPlacementRefusal(preparation.armsRoot, [preparation.source]);
  if (placement !== null) return refused(`the arms root: ${placement}`);

  const arm = { root: preparation.armsRoot, build: 'prepare', arm: 'warmup', state: 'cold' } as const;
  const dirs = armDirectories(arm);
  prepareArmDirectories(dirs);
  const git = preparationGit(dirs, preparation.timeoutMs);

  const commit = git(['rev-parse', '--verify', `${preparation.commit}^{commit}`], preparation.source);
  if (commit.status !== 0) return refused(`'${preparation.commit}' is not a commit of '${preparation.source}'`);
  const sha = commit.stdout;

  const cloned = git(['clone', '--quiet', '--local', '--no-checkout', preparation.source, path], preparation.armsRoot);
  if (cloned.status !== 0) return refused(`git clone --local exited ${String(cloned.status)}: ${cloned.stderr}`);
  const checkedOut = git(['checkout', '--quiet', '--detach', sha], path);
  if (checkedOut.status !== 0) return refused(`git checkout ${sha} exited ${String(checkedOut.status)}: ${checkedOut.stderr}`);

  const run = await runRepeats({
    instrument: preparation.warmup.instrument,
    cwd: path,
    steps: [...preparation.prerequisites, preparation.warmup.step].map((step) => ({ ...step, timed: false })),
    runs: 1,
    arm,
    env: { set: {}, unset: [] },
    ...(preparation.timeoutMs === undefined ? {} : { timeoutMs: preparation.timeoutMs }),
  });
  const violation = run.results[0]?.violation ?? null;
  if (violation !== null) return refused(`preparing '${path}': ${violation}`);

  const proven = proveCommitted(git, path, sha, safePath.join(dirs.tmp, 'snapshot-index'));
  // Git runs under the warm-up's own environment, so the run's two lists are the whole record.
  return proven.ok ? { ...proven, removedEnv: run.removed, removedToolEnv: run.removedTool } : proven;
}

/** One preparation git: its exit (`null` when it never ran or was killed), and trimmed streams. */
type PreparationGit = (
  args: readonly string[],
  cwd: string,
  set?: Readonly<Record<string, string>>,
) => { readonly status: number | null; readonly stdout: string; readonly stderr: string };

/**
 * Git, run the way the arms run VAT: through the lab's own {@link runCommand}
 * under {@link armStepEnvironment}, whose `unset` removes what `runGit`'s
 * merge-over-`process.env` can only override.
 *
 * @param dirs - The warm-up arm, whose home is git's global config
 * @param timeoutMs - Per-command ceiling, as for the steps
 * @returns The runner
 */
function preparationGit(dirs: ArmDirectories, timeoutMs: number | undefined): PreparationGit {
  return (args, cwd, set = {}) => {
    const ran = runCommand({ command: 'git', leadingArgs: [] }, args, {
      cwd,
      env: armStepEnvironment(dirs, { set, unset: [] }).env,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    return { status: ran.exitCode, stdout: ran.stdout.trim(), stderr: ran.stderr.trim() };
  };
}

/**
 * Assert the clone is at the committed tree: nothing `git status` reports, and
 * a snapshot of the working tree with the commit's own tree hash.
 *
 * @param git - The preparation's git
 * @param path - The clone
 * @param sha - The commit it must match
 * @param index - A scratch index file, so the clone's own index is untouched
 * @returns The prepared clone, or the refusal naming the offending paths
 */
function proveCommitted(
  git: PreparationGit,
  path: string,
  sha: string,
  index: string,
): Omit<Extract<PreparedClone, { ok: true }>, 'removedEnv' | 'removedToolEnv'> | Extract<PreparedClone, { ok: false }> {
  const status = git(['status', '--porcelain', '--untracked-files=all'], path);
  if (status.status !== 0) return refused(`git status exited ${String(status.status)} in '${path}'`);
  if (status.stdout !== '') {
    return refused(`the clone '${path}' is not at the committed tree after preparation:\n${status.stdout}`);
  }

  const committed = git(['rev-parse', `${sha}^{tree}`], path);
  const snapshotIndex = { GIT_INDEX_FILE: index };
  // Seeded from the commit: from an empty index `add --all` would drop a tracked
  // file the ignore rules match, and a clean clone would read as moved.
  const seeded = git(['read-tree', sha], path, snapshotIndex);
  const added = seeded.status === 0 ? git(['add', '--all'], path, snapshotIndex) : seeded;
  const snapshot = git(['write-tree'], path, snapshotIndex);
  if (committed.status !== 0 || added.status !== 0 || snapshot.status !== 0) {
    return refused(`could not take the clone's snapshot tree in '${path}'`);
  }
  if (snapshot.stdout !== committed.stdout) {
    return refused(
      `the clone '${path}' is not at the committed tree: snapshot ${snapshot.stdout}, commit tree ${committed.stdout}`,
    );
  }
  return { ok: true, path, commit: sha, tree: committed.stdout };
}

/**
 * @param refusal - Why
 * @returns The refused preparation
 */
function refused(refusal: string): PreparedClone {
  return { ok: false, refusal };
}
