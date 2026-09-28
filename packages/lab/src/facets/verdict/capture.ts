/**
 * Capture the verdict facet: every subject of a subject set, every verb of its
 * matrix, under one arm — one envelope per subject alias.
 *
 * ## What each arm gets, on top of the caller's `--env`/`--unset`
 *
 * - `VAT_PROJECTION_STORE_DIR=<out>/<alias>/store` — a private projection store
 *   per arm and subject (`packages/cli/src/utils/projection-store.ts`). Two
 *   arms sharing one store would let the second read what the first wrote, and
 *   a verdict would then measure the store rather than the build.
 * - `CLAUDE_CONFIG_DIR` unset — the operator's own Claude config must not decide
 *   what `claude context` reports for an adopter's tree.
 *
 * Both are lab-owned: a caller naming either is refused rather than silently
 * overridden.
 *
 * ## Nothing lands inside a subject
 *
 * `--out` inside any subject path is refused (VAT itself is a subject). The
 * build-verb clone lives under the OS temp directory, and is refused too if that
 * lies inside a subject.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';

import { canonicalPath, isUnderRoot, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';

import type { ReportEnvelope } from '../../envelope/envelope.js';
import { type ArmEnvironment, mergeArmEnvironments } from '../../harness/arm-env.js';
import { messageOf } from '../../harness/dumps.js';
import { runOutcome } from '../../harness/outcome.js';
import { resolveSubject } from '../../harness/subject.js';
import type { ResolvedInstrument } from '../../harness/types.js';
import { writeReport } from '../../store.js';

import { executeClonePlan, planApfsClone, readCloneSource } from './clone.js';
import { extractVerdict } from './extract.js';
import { type NormalizeContext, normalizeCommandOutput } from './normalize.js';
import type { VerdictSubject } from './subjects.js';
import { VERDICT_FACET, type VerdictBody, type VerdictRow } from './types.js';
import { buildVerbInvocations, type VerbInvocation, type VerbQuery, type VerbSubject, verdictVerb } from './verbs.js';
import type { Validated } from './yaml-file.js';

/** The variable a private projection store is selected by. */
const PROJECTION_STORE_ENV = 'VAT_PROJECTION_STORE_DIR';

/** The variable the operator's Claude config is found by. */
const CLAUDE_CONFIG_ENV = 'CLAUDE_CONFIG_DIR';

/** What one verdict capture is asked for. */
export interface VerdictCaptureRequest {
  readonly instrument: ResolvedInstrument;
  readonly subjects: readonly VerdictSubject[];
  /** Directory the subjects file's relative `sqlFiles` resolve against. */
  readonly subjectsDir: string;
  /** The caller's `--env`/`--unset` — the arm's distinguishing environment. */
  readonly env: ArmEnvironment;
  /** Where envelopes and per-subject stores are written; outside every subject. */
  readonly outDir: string;
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
export async function captureVerdict(request: VerdictCaptureRequest): Promise<VerdictCaptureResult> {
  const refusal = requestRefusal(request);
  if (refusal !== null) return { ok: false, refusal };

  const envelopes: ReportEnvelope<VerdictBody>[] = [];
  const written: string[] = [];
  for (const subject of request.subjects) {
    const captured = await captureSubject(request, subject);
    if (!captured.ok) return captured;
    envelopes.push(captured.envelope);
    written.push(await writeReport(request.outDir, captured.envelope));
  }
  return { ok: true, envelopes, written };
}

/**
 * Every reason a request must not run at all.
 *
 * @param request - The request
 * @returns A refusal, or `null`
 */
function requestRefusal(request: VerdictCaptureRequest): string | null {
  const owned = [PROJECTION_STORE_ENV, CLAUDE_CONFIG_ENV].find(
    (key) => Object.hasOwn(request.env.set, key) || request.env.unset.includes(key),
  );
  if (owned !== undefined) {
    return (
      `REFUSED: ${owned} is set by the verdict facet itself on every arm (a private projection ` +
      'store, and no operator Claude config); an arm cannot choose it.'
    );
  }
  const host = subjectContaining(request.subjects, request.outDir);
  if (host !== undefined) {
    return (
      `REFUSED: --out '${request.outDir}' lies inside subject '${host}'. A measured tree must not ` +
      "receive the lab's own output — write the reports somewhere outside every subject."
    );
  }
  return reusedStoreRefusal(request);
}

/**
 * A private store is private to ONE capture. Reusing an `--out` would hand this
 * capture a store an earlier one warmed — the leak the store exists to prevent —
 * so an existing `<out>/<alias>/store` is refused.
 *
 * @param request - The request
 * @returns A refusal naming the warm store and the remedy, or `null`
 */
function reusedStoreRefusal(request: VerdictCaptureRequest): string | null {
  const warm = request.subjects
    .map((subject) => storeDir(request.outDir, subject.alias))
    .find((dir) => existsSync(dir));
  return warm === undefined
    ? null
    : `REFUSED: the projection store '${warm}' already exists — this --out was used by an earlier ` +
        'capture, and its store would be warm for this one. Capture into a fresh --out.';
}

/**
 * @param outDir - The capture's `--out`
 * @param alias - A subject alias
 * @returns That subject's private projection store under `--out`
 */
function storeDir(outDir: string, alias: string): string {
  return safePath.join(outDir, alias, 'store');
}

/**
 * @param subjects - The subject set
 * @param target - A path the lab is about to write under
 * @returns The alias of the first subject containing `target` (or equal to it), else `undefined`
 */
function subjectContaining(subjects: readonly VerdictSubject[], target: string): string | undefined {
  return subjects.find(
    (subject) =>
      canonicalPath(subject.path) === canonicalPath(target) || isUnderRoot(subject.path, target) !== 'outside',
  )?.alias;
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
  const env = mergeArmEnvironments(request.env, {
    set: { [PROJECTION_STORE_ENV]: storeDir(request.outDir, subject.alias) },
    unset: [CLAUDE_CONFIG_ENV],
  });
  const verbSubject: VerbSubject = { path: resolved.path, contextPath: subject.contextPath, queries: queries.value };
  const run = (invocations: readonly VerbInvocation[], cwd: string): VerdictRow[] =>
    invocations.map((invocation) => runRow(request, invocation, cwd, env));

  const rows = run(
    subject.verbs.flatMap((verb) => verdictVerb(verb).args(verbSubject, request.instrument.version)),
    resolved.path,
  );
  if (subject.buildVerbs) {
    const built = inClone(request, subject, resolved.path, (clonePath) =>
      run(buildVerbInvocations({ ...verbSubject, path: clonePath }, request.instrument.version), clonePath),
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
      body: { arm: request.env, rows },
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

/**
 * Run `work` inside a fresh APFS clone of the subject, then delete the clone.
 *
 * @param request - The whole request (for the subject set)
 * @param subject - The subject being cloned
 * @param path - Its resolved root
 * @param work - What to run, given the clone's root
 * @returns The rows `work` produced, or a refusal
 */
function inClone(
  request: VerdictCaptureRequest,
  subject: VerdictSubject,
  path: string,
  work: (clonePath: string) => VerdictRow[],
): { readonly ok: true; readonly rows: VerdictRow[] } | { readonly ok: false; readonly refusal: string } {
  const parent = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-lab-verdict-clone-'));
  try {
    const clonePath = safePath.join(parent, subject.alias);
    const host = subjectContaining(request.subjects, clonePath);
    if (host !== undefined) {
      return { ok: false, refusal: `REFUSED: the build-verb clone '${clonePath}' would lie inside subject '${host}'.` };
    }
    const plan = planApfsClone(readCloneSource(path, subject.alias), clonePath, process.platform);
    if (!plan.ok) return plan;
    const failed = executeClonePlan(plan);
    if (failed !== null) return { ok: false, refusal: failed };
    return { ok: true, rows: work(clonePath) };
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

/**
 * Run one invocation and read its verdict.
 *
 * The verdict is read from the NORMALIZED stdout, so a finding's location that
 * spelled an absolute path compares across machines and across a clone.
 *
 * @param request - The whole request (instrument, timeout)
 * @param invocation - What to run
 * @param cwd - Where to run it: the subject root, or the clone
 * @param env - The arm's full environment
 * @returns The row
 */
function runRow(
  request: VerdictCaptureRequest,
  invocation: VerbInvocation,
  cwd: string,
  env: ArmEnvironment,
): VerdictRow {
  const outcome = runOutcome(request.instrument, invocation.argv, {
    cwd,
    env,
    ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
  });
  const context: NormalizeContext = { corpusRoot: cwd, vatRoot: request.instrument.root ?? '', homeDir: homedir() };
  const document = normalizeCommandOutput(outcome.stdout, context);
  const base = { name: invocation.name, argv: [...invocation.argv], document };
  if (outcome.kind === 'not-run') {
    return { ...base, outcome: 'not-run', exitCode: null, spawnError: outcome.spawnError, verdict: null };
  }
  return {
    ...base,
    outcome: 'exited',
    exitCode: outcome.exitCode,
    spawnError: null,
    verdict: extractVerdict({ kind: 'exited', exitCode: outcome.exitCode, stdout: document, stderr: outcome.stderr }),
  };
}
