/**
 * The progress log `vat resources check` writes so that a run KILLED from
 * outside can still be reported.
 *
 * ## Why a file, and why a parser that expects damage
 *
 * The whole point of the log is that it survives `SIGKILL`. Nothing in-process
 * can stop a statement blocked in synchronous `node:sqlite` — the event loop is
 * not running, so no handler, no `worker.terminate()` and no `process.exit()`
 * can be scheduled — so the supervisor's only lever is an external signal, and a
 * signal lands wherever it lands. The child can therefore be cut off in the
 * middle of an `appendFileSync`, and the parent's reader must treat a half-line
 * as ordinary rather than as a crash.
 *
 * ## What each case here would let through if it were missing
 *
 * A reader that threw on the truncated tail turns a bounded failure back into a
 * useless one — the operator would get a stack trace instead of the name of the
 * rule that hung. A reader that GUESSED at a malformed line would publish a cost
 * record nobody measured. Both are worse than the hang, because both look like
 * reports.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  createProgressWriter,
  parseProgressLog,
  unitInFlight,
  type ProgressEntry,
} from '../../src/commands/resources/check-progress.js';
import { cleanupTestTempDir, createTestTempDir } from '../system/test-common.js';

/** The population line a real run writes the instant its projection is ready. */
const POPULATION: ProgressEntry = {
  kind: 'population',
  population: 'derived',
  populationMs: 1234.5,
  membersEnumerated: 12,
};

/** One complete check: the `start` that precedes the statement and its cost. */
const FIRST_START: ProgressEntry = { kind: 'start', name: 'no-markdown' };
const FIRST_COST: ProgressEntry = { kind: 'check', name: 'no-markdown', durationMs: 3.5, rows: 2 };
const SECOND_START: ProgressEntry = { kind: 'start', name: 'no-orphans' };

/** Serialize entries the way the writer does, so a case can hand-damage the tail. */
function logOf(...entries: readonly ProgressEntry[]): string {
  return entries.map((entry) => `${JSON.stringify(entry)}\n`).join('');
}

describe('parseProgressLog', () => {
  it('reads the entries a completed unit wrote, in order', () => {
    const entries = parseProgressLog(logOf(POPULATION, FIRST_START, FIRST_COST));

    expect(entries).toStrictEqual([POPULATION, FIRST_START, FIRST_COST]);
  });

  it('drops a TRUNCATED final line instead of throwing', () => {
    // 🔑 The case the whole design turns on. SIGKILL can land mid-`write`, so
    // the last line is routinely half a JSON object. Throwing here would replace
    // the report with a crash exactly when the report is the only thing the
    // operator gets.
    const damaged = `${logOf(POPULATION, FIRST_START)}{"kind":"check","name":"no-`;

    const entries = parseProgressLog(damaged);

    expect(entries).toStrictEqual([POPULATION, FIRST_START]);
  });

  it('drops a line that parses as JSON but is not a known entry', () => {
    // Dropped, never guessed at: a cost record the log did not actually contain
    // is a measurement nobody took, published beside ones somebody did.
    const entries = parseProgressLog(
      `${logOf(POPULATION)}{"kind":"check","name":"x"}\n{"kind":"nope"}\n`,
    );

    expect(entries).toStrictEqual([POPULATION]);
  });

  it('refuses a line carrying a field the entry does not declare', () => {
    // `.strict()`, so an entry shape that moved cannot half-parse. The npm
    // package version is this project's only contract; the schema is what
    // decides whether a line is readable.
    const entries = parseProgressLog('{"kind":"start","name":"a","extra":1}\n');

    expect(entries).toStrictEqual([]);
  });

  it('reads an empty log as no entries', () => {
    expect(parseProgressLog('')).toStrictEqual([]);
  });
});

describe('unitInFlight', () => {
  it('names the last check that started and never finished', () => {
    const inFlight = unitInFlight([POPULATION, FIRST_START, FIRST_COST, SECOND_START]);

    expect(inFlight).toStrictEqual({ kind: 'check', name: 'no-orphans' });
  });

  it('reports the POPULATION when no population line ever arrived', () => {
    // 🔑 There is no projection and therefore no honest document — the caller
    // has to refuse rather than publish a report with invented extent.
    expect(unitInFlight([])).toStrictEqual({ kind: 'population' });
  });

  it('keys the population sentinel on the POPULATION LINE, not on an empty log', () => {
    // A synthetic log — a real run cannot start a check before it populates —
    // and that is the point: it pins the DISCRIMINATOR. The cheaper
    // implementation (`entries.length === 0`) passes the case above and fails
    // here, and it is wrong for the reason that matters: "no projection" is a
    // claim about the population line, and an empty log is only one way to
    // arrive at it.
    expect(unitInFlight([FIRST_START])).toStrictEqual({ kind: 'population' });
  });

  it('reports no unit in flight when every started check also completed', () => {
    const inFlight = unitInFlight([POPULATION, FIRST_START, FIRST_COST]);

    expect(inFlight).toStrictEqual({ kind: 'idle' });
  });
});

describe('createProgressWriter', () => {
  it('appends each entry as its own line, flushed before the next unit begins', () => {
    // 🪤 The flush is the property, not the format. A buffered writer would hold
    // the line that names the hung rule in memory, where SIGKILL destroys it —
    // so the file is read back BETWEEN writes, which is exactly what the
    // supervisor does.
    const dir = createTestTempDir('vat-check-progress-');
    try {
      const path = `${dir}/progress.jsonl`;
      const write = createProgressWriter(path);

      write(POPULATION);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- test temp dir
      const afterFirst = readFileSync(path, 'utf-8');
      write(FIRST_START);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- test temp dir
      const afterSecond = readFileSync(path, 'utf-8');

      expect(parseProgressLog(afterFirst)).toStrictEqual([POPULATION]);
      expect(parseProgressLog(afterSecond)).toStrictEqual([POPULATION, FIRST_START]);
    } finally {
      cleanupTestTempDir(dir);
    }
  });
});
