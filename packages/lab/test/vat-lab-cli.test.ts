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
import { InvalidArgumentError, type Option } from 'commander';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  collectMeasuredCommand,
  createProgram,
  EXIT_CHANGED,
  EXIT_REFUSED,
  EXIT_UNMEASURABLE,
  nonNegativeNumber,
  parseCacheMode,
} from '../src/bin/vat-lab.js';
import type { PerfBody, PerfCommandStats } from '../src/facets/perf/types.js';
import { PERF_FACET, PERF_FACET_VERSION } from '../src/facets/perf/types.js';
import { MEASURABLE_COMMAND_NAMES, MEASURABLE_COMMANDS } from '../src/harness/commands.js';
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

/**
 * The `--command` option as one facet's `run` subcommand declares it.
 *
 * Reaches into the built program rather than spawning a run: resolving an
 * instrument and spawning vat is not what this asserts, and the two facets share
 * `createFacetCommand`, so both must carry the identical option.
 *
 * @param facet - `perf` or `io`
 * @returns The option, or `undefined` when the facet does not declare it
 */
function commandOption(facet: string): Option | undefined {
  const run = createProgram()
    .commands.find((group) => group.name() === facet)
    ?.commands.find((sub) => sub.name() === 'run');
  return run?.options.find((option) => option.long === '--command');
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

describe('collectMeasuredCommand', () => {
  it('selects the named spec from the registry, exactly as declared', () => {
    expect(collectMeasuredCommand('validate', undefined)).toEqual([MEASURABLE_COMMANDS.validate]);
  });

  it('accumulates repeats of the flag rather than letting the last one win', () => {
    // Commander hands the parser what the option holds so far; a parser that
    // returned `[spec]` would silently measure only `verify` here.
    const first = collectMeasuredCommand('validate', undefined);
    const both = collectMeasuredCommand('verify', first);

    expect(both.map((spec) => spec.name)).toEqual(['validate', 'verify']);
  });

  it('throws a Commander InvalidArgumentError naming EVERY valid command', () => {
    // Same mechanism as `parseCacheMode`: only an error out of the option's own
    // parser becomes a usage message rather than a raw stack trace.
    let caught: unknown;
    try {
      collectMeasuredCommand('nonesuch', undefined);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(InvalidArgumentError);
    const message = (caught as Error).message;
    expect(message).toContain("got 'nonesuch'");
    for (const name of MEASURABLE_COMMAND_NAMES) expect(message).toContain(name);
  });
});

/**
 * One option, as a facet's named subcommand declares it.
 *
 * @param facet - `perf`, `io` or `parse`
 * @param subcommand - `run`, `compare` or `ab`
 * @param long - The option's long spelling
 * @returns The option, or `undefined` when the subcommand does not declare it
 */
function optionOf(facet: string, subcommand: string, long: string): Option | undefined {
  const sub = createProgram()
    .commands.find((group) => group.name() === facet)
    ?.commands.find((candidate) => candidate.name() === subcommand);
  return sub?.options.find((option) => option.long === long);
}

/**
 * The `--cache` option as one facet's `run` subcommand declares it.
 *
 * @param facet - `perf`, `io` or `parse`
 * @returns The option, or `undefined` when the facet does not declare it
 */
function cacheOption(facet: string): Option | undefined {
  return optionOf(facet, 'run', '--cache');
}

/** Every facet the CLI exposes, so a new one cannot quietly skip a verb. */
const FACETS = ['perf', 'io', 'parse'] as const;

/** The flag naming arm A, spelled once. */
const ARM_A_FLAG = '--instrument-a';

/**
 * Argv up to (not including) an `ab` run's options.
 *
 * Both refusal tests below must be refused *before* anything is resolved, so
 * they pass instrument paths that do not exist; a run that got as far as
 * resolution would throw rather than set an exit code.
 *
 * @returns The leading argv
 */
function abArgv(): readonly string[] {
  return ['node', 'vat-lab', 'perf', 'ab', tempDir];
}

describe('nonNegativeNumber', () => {
  const parse = nonNegativeNumber('--noise-floor');

  it('accepts a fractional value rather than rounding a measurement', () => {
    // A noise floor is a measurement, not a count: rounding it up would widen
    // the band in which real effects are dismissed as noise.
    expect(parse('12.4')).toBe(12.4);
    expect(parse('0')).toBe(0);
  });

  it('throws a Commander InvalidArgumentError for anything else, naming the flag', () => {
    // The empty string is the one worth spelling out: `Number('')` is 0, so
    // coercion alone would turn a typo into "nothing counts as noise".
    for (const bad of ['-1', 'abc', 'Infinity', '']) {
      expect(() => parse(bad)).toThrow(InvalidArgumentError);
    }
  });
});

describe('vat-lab <facet> ab — every facet gets the verb, not just the one that needed it first', () => {
  it.for(FACETS)('declares ab on %s', (facet) => {
    const group = createProgram().commands.find((candidate) => candidate.name() === facet);

    expect(group?.commands.map((sub) => sub.name())).toEqual(['run', 'compare', 'ab']);
  });

  it.for(FACETS)('gives %s ab both arms, the pair count and a control switch', (facet) => {
    expect(optionOf(facet, 'ab', ARM_A_FLAG)?.required).toBe(true);
    expect(optionOf(facet, 'ab', '--instrument-b')).toBeDefined();
    expect(optionOf(facet, 'ab', '--pairs')?.defaultValue).toBe(6);
    expect(optionOf(facet, 'ab', '--control')?.defaultValue).toBe(false);
    expect(optionOf(facet, 'ab', '--noise-floor')).toBeDefined();
  });

  it.for([
    { facet: 'perf', expected: 'warm' },
    { facet: 'io', expected: 'warm' },
    // Same rule as `run`: a warm `parse` A/B would attribute nothing on either
    // arm and compare two breakdowns of zeroes.
    { facet: 'parse', expected: 'cold' },
  ] as const)('defaults $facet ab to the facet’s own cache mode, $expected', ({ facet, expected }) => {
    expect(optionOf(facet, 'ab', '--cache')?.defaultValue).toBe(expected);
  });

  it('refuses --control alongside --instrument-b instead of ignoring one of them', async () => {
    // Both flags are meaningful and they contradict each other. Silently
    // dropping --instrument-b would run a control the caller thought was an A/B.
    await createProgram().parseAsync([
      ...abArgv(),
      ARM_A_FLAG,
      'tree:/nowhere-a',
      '--instrument-b',
      'tree:/nowhere-b',
      '--control',
    ]);

    expect(process.exitCode).toBe(EXIT_REFUSED);
  });

  it('refuses an A/B with only one arm, pointing at --control', async () => {
    await createProgram().parseAsync([...abArgv(), ARM_A_FLAG, 'tree:/nowhere-a']);

    expect(process.exitCode).toBe(EXIT_REFUSED);
  });
});

describe('vat-lab <facet> run — the --command flag is wired to that parser', () => {
  for (const facet of ['perf', 'io', 'parse']) {
    it(`declares --command on ${facet} run, parsed by collectMeasuredCommand`, () => {
      const option = commandOption(facet);

      expect(option?.parseArg).toBe(collectMeasuredCommand);
      // No default: "absent" has to stay distinguishable from "given", because
      // absent means the default command set and an empty list would mean
      // measuring nothing.
      expect(option?.defaultValue).toBeUndefined();
      for (const name of MEASURABLE_COMMAND_NAMES) {
        expect(option?.description).toContain(name);
      }
    });
  }

});

describe('vat-lab <facet> run — the cache default is per facet, not shared', () => {
  it.for([
    { facet: 'perf', expected: 'warm' },
    { facet: 'io', expected: 'warm' },
    // The one facet a warm default RUINS: vat's parse cache short-circuits the
    // parse function on a hit, so a warm `parse` run attributes nothing at all
    // and publishes a breakdown of zeroes that reads as "parsing is free". A
    // single shared default made that the out-of-the-box experience.
    { facet: 'parse', expected: 'cold' },
  ] as const)('defaults $facet to $expected', ({ facet, expected }) => {
    expect(cacheOption(facet)?.defaultValue).toBe(expected);
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
