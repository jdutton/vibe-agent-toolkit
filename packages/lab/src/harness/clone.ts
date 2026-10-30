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
 *    `TMPDIR` under `<out>/arms/`, never the defaults, so no round-1 arm alone
 *    pays for writing the clone's loose objects.
 * 4. **Proven back at the committed tree**: `git status --porcelain` is empty
 *    and a `git add --all` snapshot of the clone has the commit's own tree hash.
 *    A step that wrote a non-ignored file fails the preparation, naming it.
 */

import { everywhere, mkdirSyncReal, pathPresent, safePath } from '@vibe-agent-toolkit/utils';
import { runGit } from '@vibe-agent-toolkit/utils/git';

import { armDirectories } from './arm-dirs.js';
import { runRepeats } from './repeat.js';
import type { SequenceStep } from './sequence.js';
import type { ResolvedInstrument } from './types.js';

/** What to clone and how to prepare it. */
export interface ClonePreparation {
  /** The subject repository. */
  readonly source: string;
  /** The measured commit, as any committish the subject resolves. */
  readonly commit: string;
  /** The lab's `--out`; the clone is `<out>/clone`. */
  readonly out: string;
  /** Untimed, exit-checked, in order. */
  readonly prerequisites: readonly SequenceStep[];
  /** The one warm-up VAT run and the build that runs it. */
  readonly warmup: { readonly instrument: ResolvedInstrument; readonly step: SequenceStep };
  readonly timeoutMs?: number;
}

/** A prepared clone, or why there is none. */
export type PreparedClone =
  | { readonly ok: true; readonly path: string; readonly commit: string; readonly tree: string }
  | { readonly ok: false; readonly refusal: string };

/**
 * Clone, prepare and prove a subject at one commit.
 *
 * @param preparation - See {@link ClonePreparation}
 * @returns The clone's path, commit and tree, or the refusal
 */
export async function prepareClone(preparation: ClonePreparation): Promise<PreparedClone> {
  const path = safePath.join(preparation.out, 'clone');
  // An entry, a dangling link included, is "already there"; a refused look throws rather than reading as absent.
  if (pathPresent(path, 'entry', everywhere('destination'), 'confirmed')) return refused(`the clone '${path}' already exists; preparation starts from nothing`);

  const commit = runGit(['rev-parse', '--verify', `${preparation.commit}^{commit}`], { cwd: preparation.source });
  if (commit.status !== 0) return refused(`'${preparation.commit}' is not a commit of '${preparation.source}'`);
  const sha = commit.stdout;

  mkdirSyncReal(preparation.out, { recursive: true });
  const cloned = runGit(['clone', '--quiet', '--local', '--no-checkout', preparation.source, path], {
    cwd: preparation.out,
  });
  if (cloned.status !== 0) return refused(`git clone --local exited ${String(cloned.status)}: ${cloned.stderr}`);
  const checkedOut = runGit(['checkout', '--quiet', '--detach', sha], { cwd: path });
  if (checkedOut.status !== 0) return refused(`git checkout ${sha} exited ${String(checkedOut.status)}: ${checkedOut.stderr}`);

  const arm = { out: preparation.out, build: 'prepare', arm: 'warmup', state: 'cold' } as const;
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

  return proveCommitted(path, sha, safePath.join(armDirectories(arm).tmp, 'snapshot-index'));
}

/**
 * Assert the clone is at the committed tree: nothing `git status` reports, and
 * a snapshot of the working tree with the commit's own tree hash.
 *
 * @param path - The clone
 * @param sha - The commit it must match
 * @param index - A scratch index file, so the clone's own index is untouched
 * @returns The prepared clone, or the refusal naming the offending paths
 */
function proveCommitted(path: string, sha: string, index: string): PreparedClone {
  const status = runGit(['status', '--porcelain', '--untracked-files=all'], { cwd: path });
  if (status.status !== 0) return refused(`git status exited ${String(status.status)} in '${path}'`);
  if (status.stdout !== '') {
    return refused(`the clone '${path}' is not at the committed tree after preparation:\n${status.stdout}`);
  }

  const committed = runGit(['rev-parse', `${sha}^{tree}`], { cwd: path });
  const env = { GIT_INDEX_FILE: index };
  const added = runGit(['add', '--all'], { cwd: path, env });
  const snapshot = runGit(['write-tree'], { cwd: path, env });
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
