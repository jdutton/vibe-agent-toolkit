/**
 * The verdict facet's union mode: a "row" may be a SEQUENCE of rows — CI's
 * `resources validate` → `resources check` → `skills validate` against one
 * `validate` — whose findings are the union of its steps' documents, keyed by
 * `(code, location, line, severity)`.
 *
 * Coverage is set inclusion: every key of the left union must appear in the
 * right one. A step that never ran, exited 2, or printed a document the lab
 * cannot read refuses the union — an absent document is never an empty one.
 */

import { rowLinedFindings } from './extract.js';
import type { VerdictBody } from './types.js';

/** vat's system-error exit: a step that did not complete. */
const SYSTEM_ERROR_EXIT = 2;

/** One finding's identity in union mode. */
export interface UnionKey {
  readonly code: string;
  readonly location: string | null;
  readonly line: number | null;
  readonly severity: string;
}

/** A union, or why there is none. */
export type UnionResult =
  | { readonly ok: true; readonly keys: readonly UnionKey[] }
  | { readonly ok: false; readonly refusal: string };

/** A coverage judgement, or why none could be made. */
export type CoverageResult =
  | { readonly ok: true; readonly covered: boolean; readonly missing: readonly UnionKey[] }
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
    if (row.exitCode === SYSTEM_ERROR_EXIT) return refused(`row '${name}' exited 2 — a run that did not complete`);
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

/**
 * Is every finding of the left sequence among the right sequence's findings?
 *
 * @param left - The capture the left sequence ran in
 * @param leftNames - Its steps
 * @param right - The capture the right sequence ran in
 * @param rightNames - Its steps
 * @returns Whether it is covered, and the left keys the right lacks
 */
export function unionCoverage(
  left: VerdictBody,
  leftNames: readonly string[],
  right: VerdictBody,
  rightNames: readonly string[],
): CoverageResult {
  const from = unionFindings(left, leftNames);
  if (!from.ok) return from;
  const into = unionFindings(right, rightNames);
  if (!into.ok) return into;
  const present = new Set(into.keys.map((key) => identity(key)));
  const missing = from.keys.filter((key) => !present.has(identity(key)));
  return { ok: true, covered: missing.length === 0, missing };
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
