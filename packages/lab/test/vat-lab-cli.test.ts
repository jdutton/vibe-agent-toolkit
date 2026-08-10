/**
 * The CLI's contract with a script checking `$?`: an exit code must mean one
 * thing, and `0` must never be shared between "nothing changed" and "we could
 * not tell". Two defects lived here before this file existed:
 *
 * - `compare` set a non-zero exit code only when a command's verdict was
 *   `changed`. A comparison where every command came back `unmeasurable` —
 *   real work attempted, no usable result — rendered its warnings and then
 *   exited `0`, indistinguishable from a genuinely clean run to anything
 *   reading the process exit code.
 * - `--cache`'s validation lived inside the async `run` action instead of in
 *   its own Commander argument parser, so an invalid value never produced
 *   Commander's normal `error: option '--cache <mode>' argument '...' is
 *   invalid` usage message — it surfaced as a raw, uncaught stack trace (see
 *   `parseCacheMode`'s doc comment for the mechanism).
 */

import { mkdtemp } from 'node:fs/promises';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { InvalidArgumentError } from 'commander';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  createProgram,
  EXIT_CHANGED,
  EXIT_UNMEASURABLE,
  parseCacheMode,
} from '../src/bin/vat-lab.js';
import type { PerfBody, PerfCommandStats } from '../src/facets/perf/types.js';
import { PERF_FACET, PERF_FACET_VERSION } from '../src/facets/perf/types.js';
import { writeReport } from '../src/store.js';

import { makeReport } from './report-fixtures.js';

let tempDir: string;

beforeAll(async () => {
  tempDir = await mkdtemp(safePath.join(normalizedTmpdir(), 'lab-cli-'));
});

afterEach(() => {
  // `compare`'s action sets this as a side effect on the real process object;
  // a value leaked from one test would let the next test's assertion pass
  // whether or not the code under test did anything.
  process.exitCode = undefined;
});

/** A row that failed to produce a usable measurement. */
function failedRow(name: string): PerfCommandStats {
  return {
    name,
    args: [],
    cache: 'warm',
    runs: 1,
    medianMs: 0,
    minMs: 0,
    maxMs: 0,
    iqrMs: 0,
    samplesMs: [],
    exitCode: null,
    failed: true,
    failure: 'boom',
  };
}

/** A clean row with the given median, otherwise a plausible sample set. */
function cleanRow(name: string, medianMs: number): PerfCommandStats {
  return {
    name,
    args: [],
    cache: 'warm',
    runs: 3,
    medianMs,
    minMs: medianMs - 5,
    maxMs: medianMs + 5,
    iqrMs: 5,
    samplesMs: [medianMs - 5, medianMs, medianMs + 5],
    exitCode: 0,
    failed: false,
    failure: null,
  };
}

/** An unmeasured `perf` body, so tests never invent a reading with no source. */
const NOT_MEASURED = { before: null, after: null, cpus: 1, available: false, contaminated: false };

/**
 * Write a `perf` report whose body is exactly the given commands.
 *
 * @param label - Distinguishes the file on disk; not part of the coordinate
 * @param commands - The command rows the report carries
 * @returns The path `writeReport` wrote to
 */
async function writePerfReport(label: string, commands: readonly PerfCommandStats[]): Promise<string> {
  const body: PerfBody = { commands, load: NOT_MEASURED };
  return writeReport(
    safePath.join(tempDir, label),
    makeReport({ facet: PERF_FACET, facetVersion: PERF_FACET_VERSION, body }),
  );
}

describe('parseCacheMode', () => {
  it('passes warm and cold through unchanged', () => {
    expect(parseCacheMode('warm')).toBe('warm');
    expect(parseCacheMode('cold')).toBe('cold');
  });

  it('throws a Commander InvalidArgumentError for anything else, naming the value', () => {
    // This is the fix in isolation: a synchronous per-option parser is the
    // ONLY place Commander recognises an InvalidArgumentError as a usage
    // error. A check that only ran inside the async action never surfaced
    // this way — see the CLI test below for the end-to-end symptom.
    let caught: unknown;
    try {
      parseCacheMode('bogus');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InvalidArgumentError);
    expect((caught as Error).message).toContain("got 'bogus'");
  });
});

describe('vat-lab perf compare — exit codes', () => {
  it('exits EXIT_UNMEASURABLE, not 0, when every command is unmeasurable', async () => {
    const before = await writePerfReport('unmeasurable-before', [failedRow('vat audit')]);
    const after = await writePerfReport('unmeasurable-after', [failedRow('vat audit')]);

    await createProgram().parseAsync(['node', 'vat-lab', 'perf', 'compare', before, after]);

    // The control this test exists to fail without the fix: exit code 0 is
    // what an all-unmeasurable comparison produced before, indistinguishable
    // from a genuinely clean run.
    expect(process.exitCode).not.toBe(0);
    expect(process.exitCode).toBe(EXIT_UNMEASURABLE);
  });

  it('still exits EXIT_CHANGED when a real change sits alongside an unmeasurable row', async () => {
    // Priority the fix chose: an actionable `changed` verdict must not be
    // masked by an `unmeasurable` one reported for a different command.
    const before = await writePerfReport('mixed-before', [
      cleanRow('vat build', 100),
      failedRow('vat audit'),
    ]);
    const after = await writePerfReport('mixed-after', [
      cleanRow('vat build', 100_000),
      failedRow('vat audit'),
    ]);

    await createProgram().parseAsync(['node', 'vat-lab', 'perf', 'compare', before, after]);

    expect(process.exitCode).toBe(EXIT_CHANGED);
  });

  it('leaves the exit code at its default (0) for a genuinely clean comparison', async () => {
    // The negative control: nothing about the fix should turn a real
    // "nothing moved" result into a false alarm.
    const before = await writePerfReport('clean-before', [cleanRow('vat build', 100)]);
    const after = await writePerfReport('clean-after', [cleanRow('vat build', 101)]);

    await createProgram().parseAsync(['node', 'vat-lab', 'perf', 'compare', before, after]);

    expect(process.exitCode).toBeUndefined();
  });
});
