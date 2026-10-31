/**
 * Capture the verdict facet: every subject of a subject set, every verb of its
 * matrix, under one arm — one envelope per subject alias.
 *
 * ## What each arm gets, on top of the caller's `--env`/`--unset`
 *
 * A cleared environment — no inherited `VAT_*`, temp, XDG or global git config
 * (`harness/arm-env.ts`) — and the arm's own directories under
 * `<arms root>/<alias>/` (`openArmsRoot`: `--arms-dir`, else a fresh run
 * directory under the OS temp directory; never `--out`), created at 0700 BEFORE
 * any verb runs (VAT refuses a store whose parent is missing):
 *
 * - `VAT_PROJECTION_STORE_DIR=<arms root>/<alias>/store` — a private projection store
 *   per arm and subject, left for VAT to create. Two arms sharing one store would
 *   let the second read what the first wrote, and a verdict would then measure
 *   the store rather than the build.
 * - `TMPDIR`/`TEMP`/`TMP=<arms root>/<alias>/tmp` — the parse cache is private too.
 * - `HOME` and `CLAUDE_CONFIG_DIR=<arms root>/<alias>/home`, empty — the operator's own
 *   Claude config must not decide what `claude context` reports for an adopter's
 *   tree, and an UNSET `CLAUDE_CONFIG_DIR` would fall back to `HOME`.
 *
 * All are lab-owned: a caller naming one is refused rather than silently
 * overridden.
 *
 * ## Nothing lands inside a subject
 *
 * `--out`, or an alias's arm directory, inside any subject path is refused
 * (VAT itself is a subject). The
 * build-verb clone lives under the OS temp directory, and is refused too if that
 * lies inside a subject.
 */

import { existsSync, readFileSync } from 'node:fs';

import { everyInOrder, safePath, withTempDir } from '@vibe-agent-toolkit/utils';

import type { ReportEnvelope } from '../../envelope/envelope.js';
import {
  type ArmDirectories,
  armDirectoriesAt,
  armOwnedEnvRefusal,
  armPlacementRefusal,
  armStepEnvironment,
  prepareArmDirectories,
  resetArmHome,
} from '../../harness/arm-dirs.js';
import type { ArmEnvironment } from '../../harness/arm-env.js';
import { messageOf } from '../../harness/dumps.js';
import { runOutcome } from '../../harness/outcome.js';
import { resolveSubject } from '../../harness/subject.js';
import type { ResolvedInstrument } from '../../harness/types.js';
import { writeReport } from '../../store.js';

import { executeClonePlan, planApfsClone, readCloneSource } from './clone.js';
import { type NormalizeContext, normalizeCommandOutput } from './normalize.js';
import type { VerdictSubject } from './subjects.js';
import { VERDICT_FACET, type VerdictBody, type VerdictRow } from './types.js';
import { planBuildVerbs, type VerbInvocation, type VerbQuery, type VerbSubject, verdictVerb } from './verbs.js';
import type { Validated } from './yaml-file.js';

/** What one verdict capture is asked for. */
export interface VerdictCaptureRequest {
  readonly instrument: ResolvedInstrument;
  readonly subjects: readonly VerdictSubject[];
  /** Directory the subjects file's relative `sqlFiles` resolve against. */
  readonly subjectsDir: string;
  /** The caller's `--env`/`--unset` — the arm's distinguishing environment. */
  readonly env: ArmEnvironment;
  /**
   * Alias → the prepared clone (`perf arms`' report's `prepared.path`) it runs in
   * instead of its subjects-file path; the body records it as `preparedClone`.
   */
  readonly prepared: Readonly<Record<string, string>>;
  /** Where the envelopes are written; outside every subject. */
  readonly outDir: string;
  /** The invocation's arms root (`openArmsRoot`); each alias's arm is `<armsRoot>/<alias>/`. */
  readonly armsRoot: string;
  readonly capturedAt: string;
  readonly timeoutMs?: number;
}

/** A capture's outcome. */
export type VerdictCaptureResult =
  | {
      readonly ok: true;
      readonly envelopes: readonly ReportEnvelope<VerdictBody>[];
      readonly written: readonly string[];
    }
  | { readonly ok: false; readonly refusal: string };

/**
 * Capture every subject under one arm, writing one envelope per alias into `outDir`.
 *
 * @param request - See {@link VerdictCaptureRequest}
 * @returns The envelopes and where they were written, or a refusal
 */
export async function captureVerdict(given: VerdictCaptureRequest): Promise<VerdictCaptureResult> {
  const unknown = Object.keys(given.prepared).find((alias) => !given.subjects.some((subject) => subject.alias === alias));
  if (unknown !== undefined) {
    return { ok: false, refusal: `REFUSED: --prepared names subject '${unknown}', which the subjects file does not list.` };
  }
  // Every rail below — placement, the build-verb clone — sees the path the subject really runs at.
  const request = {
    ...given,
    subjects: given.subjects.map((subject) => ({ ...subject, path: given.prepared[subject.alias] ?? subject.path })),
  };
  const refusal = requestRefusal(request);
  if (refusal !== null) return { ok: false, refusal };

  const envelopes: ReportEnvelope<VerdictBody>[] = [];
  const written: string[] = [];
  let failed: VerdictCaptureResult | undefined;
  // In order: the first subject that fails stops the run, and reports are written in subject order.
  await everyInOrder(request.subjects, async (subject) => {
    const captured = await captureSubject(request, subject);
    if (!captured.ok) {
      failed = captured;
      return false;
    }
    envelopes.push(captured.envelope);
    written.push(await writeReport(request.outDir, captured.envelope));
    return true;
  });
  return failed ?? { ok: true, envelopes, written };
}

/**
 * Every reason a request must not run at all.
 *
 * @param request - The request
 * @returns A refusal, or `null`
 */
function requestRefusal(request: VerdictCaptureRequest): string | null {
  const owned = armOwnedEnvRefusal(request.env);
  if (owned !== null) return `REFUSED: ${owned}.`;
  const subjects = request.subjects.map((subject) => subject.path);
  // --out, and every alias's arm directory: neither may be, lie inside, or contain a measured tree.
  for (const dir of [request.outDir, ...request.subjects.map((subject) => subjectDirectories(request.armsRoot, subject.alias).root)]) {
    const placement = armPlacementRefusal(dir, subjects);
    if (placement !== null) return `REFUSED: ${placement}. Point --out and --arms-dir outside every subject.`;
  }
  return reusedArmRefusal(request);
}

/**
 * An arm is private to ONE capture. Reusing an `--arms-dir` would hand this
 * capture the store and parse cache an earlier one warmed — the leak the arm
 * exists to prevent — so an existing `<arms root>/<alias>/` is refused whole,
 * its `tmp/` as much as its store.
 *
 * @param request - The request
 * @returns A refusal naming the used arm and the remedy, or `null`
 */
function reusedArmRefusal(request: VerdictCaptureRequest): string | null {
  const used = request.subjects
    .map((subject) => subjectDirectories(request.armsRoot, subject.alias).root)
    .find((dir) => existsSync(dir));
  return used === undefined
    ? null
    : `REFUSED: the arm directory '${used}' already exists — this --arms-dir was used by an earlier ` +
        'capture, and its store and temp directory would be warm for this one. Capture into a fresh --arms-dir.';
}

/**
 * @param armsRoot - The capture's arms root
 * @param alias - A subject alias
 * @returns That subject's private store, tmp and home under `<armsRoot>/<alias>/`
 */
function subjectDirectories(armsRoot: string, alias: string): ArmDirectories {
  return armDirectoriesAt(safePath.join(armsRoot, alias));
}

/**
 * Capture one subject.
 *
 * @param request - The whole request
 * @param subject - The subject to capture
 * @returns Its envelope, or a refusal
 */
async function captureSubject(
  request: VerdictCaptureRequest,
  subject: VerdictSubject,
): Promise<{ readonly ok: true; readonly envelope: ReportEnvelope<VerdictBody> } | { readonly ok: false; readonly refusal: string }> {
  const queries = readQueries(subject, request.subjectsDir);
  if (!queries.ok) return queries;
  // Resolved BEFORE any verb runs, so the coordinate names the tree as it was
  // measured rather than whatever the verbs left behind.
  const resolved = await resolveSubject({ id: subject.alias, path: subject.path });
  // Made before any verb, owner-only: every verb's TMPDIR and HOME must exist
  // when it starts. `store/` itself is left for VAT to create.
  const dirs = subjectDirectories(request.armsRoot, subject.alias);
  prepareArmDirectories(dirs);
  await resetArmHome(dirs);
  const { env, removed, npmNetwork } = armStepEnvironment(dirs, request.env);
  const verbSubject: VerbSubject = { path: resolved.path, contextPath: subject.contextPath, queries: queries.value };
  const run = (invocations: readonly VerbInvocation[], cwd: string): VerdictRow[] =>
    invocations.map((invocation) => runRow(request, invocation, { cwd, env, homeDir: dirs.home }));

  const rows = run(
    subject.verbs.flatMap((verb) => verdictVerb(verb).args(verbSubject, request.instrument.version)),
    resolved.path,
  );
  // An exclusion is a claim, and the verb it names still runs (last — see
  // `planBuildVerbs`): the compare checks the claim against both arms.
  const { excluded } = planBuildVerbs(subject, verbSubject, request.instrument.version);
  if (subject.buildVerbs) {
    const built = await inClone(request, subject, resolved.path, (clonePath) =>
      run(planBuildVerbs(subject, { ...verbSubject, path: clonePath }, request.instrument.version).invocations, clonePath),
    );
    if (!built.ok) return built;
    rows.push(...built.rows);
  }

  return {
    ok: true,
    envelope: {
      facet: VERDICT_FACET,
      coordinate: { subject: resolved.ref, subjectVersion: resolved.version, instrument: request.instrument.version },
      capturedAt: request.capturedAt,
      removedEnv: removed,
      npmNetworkEnv: npmNetwork,
      // Each row records its own exit; a verdict judges no commitment.
      exits: [],
      body: {
        arm: request.env,
        rows,
        excluded: [...excluded],
        preparedClone: request.prepared[subject.alias] === undefined ? null : resolved.path,
      },
    },
  };
}

/**
 * Read a subject's SQL files, refusing — never throwing — on one that cannot be read.
 *
 * @param subject - The subject
 * @param dir - Where its `sqlFiles` resolve from (the subjects file's directory)
 * @returns One query per file, in subjects-file order, or a refusal
 */
function readQueries(subject: VerdictSubject, dir: string): Validated<VerbQuery[]> {
  const queries: VerbQuery[] = [];
  for (const file of subject.sqlFiles) {
    try {
      queries.push({ file, sql: readFileSync(safePath.resolve(dir, file), 'utf-8') });
    } catch (error) {
      return { ok: false, refusal: `REFUSED: subject '${subject.alias}' names SQL file '${file}': ${messageOf(error)}` };
    }
  }
  return { ok: true, value: queries };
}

/** The rows a build verb produced inside its clone, or why there is no clone. */
type CloneOutcome = { readonly ok: true; readonly rows: VerdictRow[] } | { readonly ok: false; readonly refusal: string };

/**
 * Run `work` inside a fresh APFS clone of the subject, then delete the clone.
 *
 * @param request - The whole request (for the subject set)
 * @param subject - The subject being cloned
 * @param path - Its resolved root
 * @param work - What to run, given the clone's root
 * @returns The rows `work` produced, or a refusal
 */
async function inClone(
  request: VerdictCaptureRequest,
  subject: VerdictSubject,
  path: string,
  work: (clonePath: string) => VerdictRow[],
): Promise<CloneOutcome> {
  const { value, leftover } = await withTempDir<CloneOutcome>('vat-lab-verdict-clone-', (parent) => {
    const clonePath = safePath.join(parent, subject.alias);
    const placement = armPlacementRefusal(clonePath, request.subjects.map((each) => each.path));
    if (placement !== null) return Promise.resolve({ ok: false, refusal: `REFUSED: the build-verb clone: ${placement}.` });
    const listed = readCloneSource(path, subject.alias);
    if (!listed.ok) return Promise.resolve(listed);
    const plan = planApfsClone(listed.source, clonePath, process.platform);
    if (!plan.ok) return Promise.resolve(plan);
    const failed = executeClonePlan(plan);
    if (failed !== null) return Promise.resolve({ ok: false, refusal: failed });
    return Promise.resolve({ ok: true, rows: work(clonePath) });
  });
  // A clone the OS will not remove is no measurement to stand on: the capture stops on it.
  if (leftover !== undefined) throw leftover;
  return value;
}

/**
 * Run one invocation and read its verdict.
 *
 * The verdict is read from the NORMALIZED stdout, so a finding's location that
 * spelled an absolute path compares across machines and across a clone.
 *
 * @param request - The whole request (instrument, timeout)
 * @param invocation - What to run
 * @param where - Where to run it (the subject root, or the clone), the arm's full
 *   environment, and the arm's home — the child's HOME, so the one its output names
 * @returns The row
 */
function runRow(
  request: VerdictCaptureRequest,
  invocation: VerbInvocation,
  where: { readonly cwd: string; readonly env: ArmEnvironment; readonly homeDir: string },
): VerdictRow {
  const { cwd, env, homeDir } = where;
  const outcome = runOutcome(request.instrument, invocation.argv, {
    cwd,
    env,
    ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
  });
  const context: NormalizeContext = { corpusRoot: cwd, vatRoot: request.instrument.root ?? '', homeDir };
  const document = normalizeCommandOutput(outcome.stdout, context);
  const base = { name: invocation.name, argv: [...invocation.argv], document };
  if (outcome.kind === 'not-run') {
    return { ...base, outcome: 'not-run', exitCode: null, spawnError: outcome.spawnError };
  }
  return { ...base, outcome: 'exited', exitCode: outcome.exitCode, spawnError: null };
}
