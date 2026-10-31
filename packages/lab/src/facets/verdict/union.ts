/**
 * The verdict facet's union mode: a "row" may be a SEQUENCE of rows — CI's
 * `resources validate` → `resources check` → `skills validate` against one
 * `validate` — whose findings are the union of its steps' documents, keyed by
 * `(code, location, line, severity)`.
 *
 * Coverage is set inclusion: every key of the left union must appear in the
 * right one ({@link judgeUnion}). A step that never ran, exited 2, or printed a document the lab
 * cannot read refuses the union — an absent document is never an empty one.
 *
 * ## Bar 3, judged in one place
 *
 * {@link judgeUnion} is bar 3 whole: CI's sequence B against the candidate's
 * `validate` C, over captures and arms of ONE prepared clone.
 *
 * - **One tree.** Both captures are of one subject at one subject version, and
 *   each ran in the prepared clone the arms ran in (`VerdictBody.preparedClone`
 *   against the arms report's `prepared.path`), at its commit, clean.
 * - **Findings, both ways.** `union(B) ⊆ findings(C)`, and what C finds beyond
 *   `union(B)` is exactly the deltas file's `unions` entry for this pair —
 *   an undeclared extra fails, and so does a declared one C did not report.
 * - **Exits, every round.** Paired by round, C's exit is B's first non-zero
 *   step exit (0 when every step passed), and never 2: a run that did not
 *   complete is never what CI would have reported.
 */

import { ExitCode } from '@vibe-agent-toolkit/schema';

import { movedAxes } from '../../envelope/coordinate.js';
import type { ReportEnvelope } from '../../envelope/envelope.js';

import { type DeclaredUnionFinding, unionFindingIdentity, type VerdictDeltas } from './deltas.js';
import { rowLinedFindings } from './extract.js';
import { multisetDifference } from './multiset.js';
import type { VerdictBody } from './types.js';

/** One finding's identity in union mode. */
export interface UnionKey {
  readonly code: string;
  readonly location: string | null;
  readonly line: number | null;
  readonly severity: string;
}

/** A union, or why there is none. */
type UnionResult =
  | { readonly ok: true; readonly keys: readonly UnionKey[] }
  | { readonly ok: false; readonly refusal: string };

/**
 * Union the findings of the named rows of one capture.
 *
 * @param body - One subject's captured rows
 * @param names - The steps of the sequence, by row name
 * @returns The distinct keys, sorted, or the refusal
 */
export function unionFindings(body: VerdictBody, names: readonly string[]): UnionResult {
  const keys = new Map<string, UnionKey>();
  for (const name of names) {
    const row = body.rows.find((candidate) => candidate.name === name);
    if (row === undefined) return refused(`no row named '${name}' in this capture`);
    if (row.exitCode === ExitCode.ERROR) return refused(`row '${name}' exited 2 — a run that did not complete`);
    const read = rowLinedFindings(row);
    if (read === null || read.shape === 'unparsed') {
      const why = row.spawnError ?? `exit ${String(row.exitCode)}`;
      return refused(`row '${name}' has no readable document (${why})`);
    }
    for (const finding of read.findings) {
      const key: UnionKey = { code: finding.code, location: finding.location, line: finding.line, severity: finding.severity };
      keys.set(identity(key), key);
    }
  }
  return { ok: true, keys: [...keys.entries()].sort(([a], [b]) => byCodeUnit(a, b)).map(([, key]) => key) };
}

/** One side of bar 3: a capture and the rows of its sequence. */
export interface UnionSide {
  readonly envelope: ReportEnvelope<VerdictBody>;
  readonly rows: readonly string[];
}

/** One timed arm's rounds, as an arms report records them. */
export interface UnionArmEvidence {
  /** The arm, in `--arm` spelling, for the message. */
  readonly name: string;
  readonly repetitions: readonly {
    readonly exitCode: number | null;
    readonly steps: readonly { readonly name: string; readonly exitCode: number | null }[];
  }[];
}

/** Everything bar 3 is judged over. */
export interface UnionRequest {
  /** B: CI's sequence. */
  readonly left: UnionSide;
  /** C: the candidate's one command. */
  readonly right: UnionSide;
  /** The arms report's prepared clone, and B's and C's timed arms in it. */
  readonly arms: {
    readonly prepared: { readonly path: string; readonly commit: string };
    readonly left: UnionArmEvidence;
    readonly right: UnionArmEvidence;
  };
  /** The deltas file's `unions` section. */
  readonly declared: VerdictDeltas['unions'];
}

/** Bar 3's outcome, or why it cannot be judged. */
export type UnionJudgement =
  | {
      readonly ok: true;
      readonly passed: boolean;
      /** Keys of union(B) C lacks. */
      readonly missing: readonly UnionKey[];
      /** Keys C reports beyond union(B) that no `unions` entry declares. */
      readonly undeclared: readonly UnionKey[];
      /** Declared extras C did not report. */
      readonly unused: readonly DeclaredUnionFinding[];
      /** One line per round whose C exit breaks the exit rule. */
      readonly exitViolations: readonly string[];
    }
  | { readonly ok: false; readonly refusal: string };

/**
 * Judge bar 3 — see this module's docstring.
 *
 * @param request - See {@link UnionRequest}
 * @returns The judgement, or the refusal naming what makes the inputs unjudgeable
 */
export function judgeUnion(request: UnionRequest): UnionJudgement {
  const tree = oneTreeRefusal(request);
  if (tree !== null) return refused(tree);
  const exits = exitViolations(request.arms.left, request.arms.right);
  if (!exits.ok) return exits;
  const from = unionFindings(request.left.envelope.body, request.left.rows);
  if (!from.ok) return from;
  const into = unionFindings(request.right.envelope.body, request.right.rows);
  if (!into.ok) return into;

  const present = new Set(into.keys.map((key) => identity(key)));
  const missing = from.keys.filter((key) => !present.has(identity(key)));
  const covered = new Set(from.keys.map((key) => identity(key)));
  const extras = into.keys.filter((key) => !covered.has(identity(key)));
  const declared = declaredExtras(request);
  if (!declared.ok) return declared;
  const matched = multisetDifference(declared.findings, extras, unionFindingIdentity);
  const passed = missing.length === 0 && matched.onlyLeft.length === 0 && matched.onlyRight.length === 0 && exits.violations.length === 0;
  return { ok: true, passed, missing, undeclared: matched.onlyRight, unused: matched.onlyLeft, exitViolations: exits.violations };
}

/**
 * @param request - Bar 3's inputs
 * @returns Why the two captures are not of the one prepared tree the arms ran in, or `null`
 */
function oneTreeRefusal(request: UnionRequest): string | null {
  const moved = movedAxes(request.left.envelope.coordinate, request.right.envelope.coordinate).filter((axis) => axis !== 'instrument');
  if (moved.length > 0) return `the two captures differ in ${moved.join(' and ')} — bar 3 compares two sequences over ONE tree`;
  const { prepared } = request.arms;
  for (const side of [request.left, request.right]) {
    const { body, coordinate } = side.envelope;
    const alias = coordinate.subject.id;
    if (body.preparedClone === null) {
      return `subject '${alias}' ran at its subjects-file path, not in the prepared clone — capture it with --prepared ${alias}=${prepared.path}`;
    }
    if (body.preparedClone !== prepared.path) {
      return `subject '${alias}' ran in '${body.preparedClone}', but the arms ran in '${prepared.path}'`;
    }
    const version = coordinate.subjectVersion;
    if (version.kind !== 'git' || version.commit !== prepared.commit || version.dirty) {
      return `subject '${alias}' was not captured at the prepared commit ${prepared.commit}, clean`;
    }
  }
  return null;
}

/**
 * Pair B's and C's rounds and check C's exit on every one.
 *
 * @param left - B's arm
 * @param right - C's arm
 * @returns One violation per round that breaks the rule, or the refusal when rounds cannot be paired
 */
function exitViolations(
  left: UnionArmEvidence,
  right: UnionArmEvidence,
): { readonly ok: true; readonly violations: readonly string[] } | { readonly ok: false; readonly refusal: string } {
  if (left.repetitions.length !== right.repetitions.length || left.repetitions.length === 0) {
    return refused(`the exit rule pairs rounds, but there are ${String(left.repetitions.length)} round(s) of ${left.name} against ${String(right.repetitions.length)} of ${right.name}`);
  }
  const violations: string[] = [];
  for (const [index, b] of left.repetitions.entries()) {
    const round = `round ${String(index + 1)}`;
    const c = right.repetitions[index]?.exitCode ?? null;
    const unexited = b.steps.find((step) => step.exitCode === null);
    if (c === null || unexited !== undefined) return refused(`${round}: a step never exited, so it has no exit to judge`);
    const expected = b.steps.find((step) => step.exitCode !== 0)?.exitCode ?? 0;
    if (c === ExitCode.ERROR) violations.push(`${round}: ${right.name} exited 2 — a run that did not complete is never a bar-3 exit`);
    else if (c !== expected) violations.push(`${round}: ${right.name} exited ${String(c)}, but ${left.name}'s first non-zero step exit is ${String(expected)}`);
  }
  return { ok: true, violations };
}

/**
 * @param request - Bar 3's inputs
 * @returns The extras the deltas file declares for this subject and pair, or the refusal for a repeated entry
 */
function declaredExtras(
  request: UnionRequest,
): { readonly ok: true; readonly findings: readonly DeclaredUnionFinding[] } | { readonly ok: false; readonly refusal: string } {
  const alias = request.left.envelope.coordinate.subject.id;
  const same = (a: readonly string[], b: readonly string[]): boolean => JSON.stringify(a) === JSON.stringify(b);
  const entries = request.declared.filter(
    (entry) => entry.subject === alias && same(entry.left, request.left.rows) && same(entry.right, request.right.rows),
  );
  if (entries.length > 1) return refused(`the deltas file declares subject '${alias}' and this pair of sequences ${String(entries.length)} times; declare it once`);
  return { ok: true, findings: entries[0]?.findingsAdded ?? [] };
}

/**
 * @param key - A union key
 * @returns Its identity, in a fixed field order
 */
function identity(key: UnionKey): string {
  return JSON.stringify([key.code, key.location, key.line, key.severity]);
}

/** Order by UTF-16 code unit, never by locale. */
function byCodeUnit(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/**
 * @param refusal - Why
 * @returns The refused result
 */
function refused(refusal: string): { readonly ok: false; readonly refusal: string } {
  return { ok: false, refusal };
}
