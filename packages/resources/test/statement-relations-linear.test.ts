/**
 * The relation scan reads user SQL, so its cost must stay linear in the statement's length however
 * the statement is written. Openers left unclosed (`/*`, `[`, quotes) once cost a search to the end
 * of the text EACH, which is quadratic: 100,000 of them took seconds.
 *
 * Judged against a linear baseline of the same length measured in the same process, never against a
 * fixed time: a pathological input may cost at most a generous multiple of plain text's cost.
 */

import { describe, expect, it } from 'vitest';

import { definesCteNamed, relationsNamedBy } from '../src/projection/statement-relations.js';

/** Characters in every input below. */
const LENGTH = 200_000;

/** How many times the plain baseline a pathological input may cost. Quadratic is thousands. */
const ALLOWED_MULTIPLE = 20;

/** The fastest of three runs of `scan`, in milliseconds. */
function fastestMs(scan: () => void): number {
  let fastest = Number.POSITIVE_INFINITY;
  for (let run = 0; run < 3; run += 1) {
    const start = performance.now();
    scan();
    fastest = Math.min(fastest, performance.now() - start);
  }
  return fastest;
}

/** One scan of `sql` by both exported readers. */
function scanOf(sql: string): () => void {
  return () => {
    relationsNamedBy(sql, ['blobs', 'edges']);
    definesCteNamed(sql, 'changed_files');
  };
}

/** Text of `LENGTH` characters made of `unit` repeated. */
function repeated(unit: string): string {
  return unit.repeat(Math.ceil(LENGTH / unit.length)).slice(0, LENGTH);
}

describe('the relation scan is linear in the statement\'s length', () => {
  const baselineMs = fastestMs(scanOf(repeated('blobs, ')));

  it.each([
    ['unclosed block comments', 'x /*'],
    ['unclosed brackets', '['],
    ['unclosed double quotes after a name', 'x"'],
    ['unclosed backticks after a name', 'x`'],
    ['doubled single quotes', "''"],
    ['comment openers inside a line comment', '--/*'],
  ])('%s', (_label, unit) => {
    const pathologicalMs = fastestMs(scanOf(repeated(unit)));
    expect(pathologicalMs, `baseline ${baselineMs.toFixed(1)} ms`).toBeLessThan(Math.max(baselineMs, 1) * ALLOWED_MULTIPLE);
  });
});
