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

import { mkdtemp, writeFile } from 'node:fs/promises';

import { ExitCode } from '@vibe-agent-toolkit/schema';
import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { InvalidArgumentError, type Option } from 'commander';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  armNameOption,
  collectArmsBuild,
  collectArmsSelection,
  collectBar,
  collectCommandExpectedExit,
  collectExpectedExit,
  committedCommands,
  collectMeasuredCommand,
  collectPreparedSubject,
  collectPrerequisite,
  collectUnset,
  createProgram,
  fastestRepeat,
  nonNegativeNumber,
  parseCacheMode,
  splitRowNames,
} from '../src/bin/vat-lab.js';
import type { ReportEnvelope } from '../src/envelope/envelope.js';
import type { PerfBody, PerfCommandStats } from '../src/facets/perf/types.js';
import { PERF_FACET } from '../src/facets/perf/types.js';
import type { VerdictBody } from '../src/facets/verdict/types.js';
import { exactExit, MEASURABLE_COMMAND_NAMES, MEASURABLE_COMMANDS } from '../src/harness/commands.js';
import { writeReport } from '../src/store.js';

import { makeReport } from './report-fixtures.js';

let tempDir: string;

beforeAll(async () => {
  tempDir = await mkdtemp(safePath.join(normalizedTmpdir(), 'lab-cli-'));
});

afterEach(() => {
  vi.restoreAllMocks();
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
    makeReport({ facet: PERF_FACET, body }),
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

describe('collectCommandExpectedExit — a single-command facet commits a command to its one exit', () => {
  it('parses <command>=<code> for a registered command, accumulating', () => {
    const first = collectCommandExpectedExit('validate=1', undefined);

    expect(first).toEqual([{ command: 'validate', exit: 1 }]);
    expect(collectCommandExpectedExit('audit=0', first)).toEqual([
      { command: 'validate', exit: 1 },
      { command: 'audit', exit: 0 },
    ]);
  });

  it.for([
    { value: 'validate=0,1', pattern: /one exit code/u },
    { value: 'validate=2', pattern: /exit 2/u },
    { value: 'validate=256', pattern: /from 0 to 255/u },
    { value: 'nonesuch=1', pattern: /got 'nonesuch'/u },
    { value: 'validate=', pattern: /<command>=<code>/u },
    { value: 'validate', pattern: /<command>=<code>/u },
  ])('refuses $value', ({ value, pattern }) => {
    expect(() => collectCommandExpectedExit(value, undefined)).toThrow(InvalidArgumentError);
    expect(() => collectCommandExpectedExit(value, undefined)).toThrow(pattern);
  });

  it('refuses the same command twice — one command, one committed exit', () => {
    const first = collectCommandExpectedExit('validate=1', undefined);

    expect(() => collectCommandExpectedExit('validate=0', first)).toThrow(/validate more than once/u);
  });
});

describe('committedCommands — the one place a caller expectation replaces a spec\'s exit', () => {
  it('replaces the named command\'s exit and leaves every other spec as registered', () => {
    const specs = [MEASURABLE_COMMANDS.validate, MEASURABLE_COMMANDS.audit];

    const committed = committedCommands(specs, [{ command: 'validate', exit: 1 }]);

    expect(committed.map((spec) => [spec.name, spec.exit])).toEqual([['validate', exactExit(1)], ['audit', MEASURABLE_COMMANDS.audit.exit]]);
    expect(committed[1]).toBe(MEASURABLE_COMMANDS.audit);
  });

  it('refuses an expectation for a command the run does not measure — it would leave 0 silently in force', () => {
    expect(() => committedCommands([MEASURABLE_COMMANDS.audit], [{ command: 'validate', exit: 1 }])).toThrow(
      /--expect-exit names validate, which this run does not measure/u,
    );
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

/** An instrument spec that cannot resolve — see {@link abArgv}. */
const ABSENT_TREE = 'tree:/nowhere-a';

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
    expect(parse('12.4')).toBeCloseTo(12.4, 10);
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

describe('fastestRepeat — the reduction `parse` and `crawl` hand to ab', () => {
  // Three DISTINCT values, ordered so that min, median and last-listed all
  // differ. A fixture whose samples were symmetric (or whose median happened to
  // equal its minimum) would pass against a median estimator too, which is the
  // whole reason the median defect survived: no test exercised a real estimate.
  const SAMPLES = [9258.195, 9085.774, 9381.952];
  const MIN = 9085.774;
  // The three samples are ~170ms and ~300ms apart, so a 5e-7 tolerance still tells
  // the minimum apart from the median and from the row total the fallback would use.
  const PRECISION = 6;

  it('publishes the smallest repeat, not the reported median one', () => {
    // `totalMs` is the median repeat the row reports whole. Handing that to `ab`
    // is a min-over-medians, and it measured +172.4ms of phantom effect on the
    // first real `parse ab` — ~1.8x that run's noise floor.
    expect(fastestRepeat({ totalMs: SAMPLES[0] as number, totalMsSamples: SAMPLES })).toBeCloseTo(MIN, PRECISION);
  });

  it('ignores the row total whenever samples exist, even a smaller one', () => {
    // Pins the direction of the fallback: samples win because they are the
    // per-repeat truth, not because they happen to be smaller. A reduction that
    // took `Math.min(totalMs, ...samples)` would pass the test above and fail
    // this one.
    expect(fastestRepeat({ totalMs: 1, totalMsSamples: SAMPLES })).toBeCloseTo(MIN, PRECISION);
  });

  it('falls back to the row total only when no repeat published a sample', () => {
    expect(fastestRepeat({ totalMs: 42, totalMsSamples: [] })).toBe(42);
  });
});

describe('vat-lab <facet> ab — every facet gets the verb, not just the one that needed it first', () => {
  it.for(FACETS)('declares ab on %s', (facet) => {
    const group = createProgram().commands.find((candidate) => candidate.name() === facet);

    // `perf` alone also times whole CI sequences, and judges bars over them.
    const expected = facet === 'perf' ? ['run', 'compare', 'ab', 'arms', 'bars'] : ['run', 'compare', 'ab'];
    expect(group?.commands.map((sub) => sub.name())).toEqual(expected);
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
      ABSENT_TREE,
      '--instrument-b',
      'tree:/nowhere-b',
      '--control',
    ]);

    expect(process.exitCode).toBe(ExitCode.ERROR);
  });

  it('refuses an A/B with only one arm, pointing at --control', async () => {
    await createProgram().parseAsync([...abArgv(), ARM_A_FLAG, ABSENT_TREE]);

    expect(process.exitCode).toBe(ExitCode.ERROR);
  });

  it('refuses --control when the two arms carry DIFFERENT environments', async () => {
    // --control guarantees one instrument by construction — the same resolved
    // object is handed to both arms. Per-arm environment arrived later and that
    // guarantee was never extended to it, so this run would measure a real pool
    // effect and publish it as the machine's noise floor. Worse than one wrong
    // number: that floor is then what every later run is judged against.
    await createProgram().parseAsync([
      ...abArgv(),
      ARM_A_FLAG,
      ABSENT_TREE,
      '--control',
      '--env-b',
      'VAT_PARSE_POOL=1',
    ]);

    expect(process.exitCode).toBe(ExitCode.ERROR);
  });

  it('allows --control when both arms carry the SAME environment', async () => {
    // Pinning a configuration on both arms is how a floor is measured in the
    // regime the real A/B will run in, so it must stay available.
    // Reaching resolution is the proof it passed the guard: these argv name an
    // instrument that does not exist, and resolution THROWS where a refusal
    // would merely have set an exit code (see `abArgv`).
    await expect(
      createProgram().parseAsync([
        ...abArgv(),
        ARM_A_FLAG,
        ABSENT_TREE,
        '--control',
        '--env-a',
        'VAT_PARSE_POOL_SIZE=3',
        '--env-b',
        'VAT_PARSE_POOL_SIZE=3',
      ]),
    ).rejects.toThrow();
  });
});

describe('collectUnset', () => {
  it('accumulates names', () => {
    expect(collectUnset('--unset')('B', collectUnset('--unset')('A', undefined))).toEqual(['A', 'B']);
  });

  it('refuses a KEY=VALUE, which belongs to --env', () => {
    expect(() => collectUnset('--unset-a')('X=1', undefined)).toThrow(InvalidArgumentError);
    expect(() => collectUnset('--unset-a')('', undefined)).toThrow(/--unset-a/);
  });
});

describe('vat-lab <facet> run — the arm environment flags', () => {
  it.for(FACETS)('declares --env and --unset on %s run', (facet) => {
    expect(optionOf(facet, 'run', '--env')).toBeDefined();
    expect(optionOf(facet, 'run', '--unset')).toBeDefined();
  });

  it.for(FACETS)('declares --unset-a and --unset-b on %s ab', (facet) => {
    expect(optionOf(facet, 'ab', '--unset-a')).toBeDefined();
    expect(optionOf(facet, 'ab', '--unset-b')).toBeDefined();
  });
});

/** The flag naming the arms root. */
const ARMS_DIR = '--arms-dir';

describe('vat-lab — every --out is resolved once, by its parser', () => {
  const sites = [
    ...FACETS.flatMap((facet) => [
      [facet, 'run'],
      [facet, 'ab'],
    ]),
    ['perf', 'arms'],
    ['verdict', 'run'],
  ] as const;

  it.for(sites)('resolves %s %s --out to an absolute path, its default included', ([facet, subcommand]) => {
    const option = optionOf(facet, subcommand, '--out');
    expect(option?.parseArg?.('relative/out', undefined)).toBe(safePath.resolve('relative/out'));
    const fallback: unknown = option?.defaultValue;
    if (typeof fallback === 'string') expect(fallback).toBe(safePath.resolve(fallback));
    else expect(fallback).toBeUndefined();
  });

  it.for(sites)('declares %s %s --arms-dir, absolute only, with no default (a fresh run root outside every subject)', ([facet, subcommand]) => {
    const option = optionOf(facet, subcommand, ARMS_DIR);
    expect(option?.defaultValue).toBeUndefined();
    const absolute = safePath.join(normalizedTmpdir(), 'lab-arms');
    expect(option?.parseArg?.(absolute, undefined)).toBe(absolute);
    expect(() => option?.parseArg?.('relative/arms', undefined)).toThrow(InvalidArgumentError);
  });
});

describe('vat-lab <facet> run — the --command flag is wired to that parser', () => {
  for (const facet of ['perf', 'io', 'parse']) {
    it(`declares --expect-exit on ${facet} run and ab, parsed by collectCommandExpectedExit`, () => {
      expect(optionOf(facet, 'run', '--expect-exit')?.parseArg).toBe(collectCommandExpectedExit);
      expect(optionOf(facet, 'ab', '--expect-exit')?.parseArg).toBe(collectCommandExpectedExit);
    });

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
  it('exits ERROR, not 0, when every command is unmeasurable', async () => {
    const before = await writePerfReport('unmeasurable-before', [failedRow('vat audit')]);
    const after = await writePerfReport('unmeasurable-after', [failedRow('vat audit')]);

    await createProgram().parseAsync(['node', 'vat-lab', 'perf', 'compare', before, after]);

    // The control this test exists to fail without the fix: exit code 0 is
    // what an all-unmeasurable comparison produced before, indistinguishable
    // from a genuinely clean run.
    expect(process.exitCode).not.toBe(0);
    expect(process.exitCode).toBe(ExitCode.ERROR);
  });

  it('still exits FINDINGS when a real change sits alongside an unmeasurable row', async () => {
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

    expect(process.exitCode).toBe(ExitCode.FINDINGS);
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

describe('vat-lab perf arms — the option parsers', () => {
  it('collects --build as alias=instrument, refusing an alias that is not a directory segment', () => {
    expect(collectArmsBuild('rc11=dist:/x/vat', undefined)).toEqual([
      { alias: 'rc11', source: { kind: 'dist', path: '/x/vat' } },
    ]);
    expect(() => collectArmsBuild('../up=dist:/x', undefined)).toThrow(InvalidArgumentError);
    expect(() => collectArmsBuild('noequals', undefined)).toThrow(InvalidArgumentError);
  });

  it('collects --arm as build:sequence:state from the registered CI sequences', () => {
    const [arm] = collectArmsSelection('rc11:ci-b:warm', undefined);

    expect(arm?.build).toBe('rc11');
    expect(arm?.state).toBe('warm');
    expect(arm?.sequence.name).toBe('ci-b');
    expect(() => collectArmsSelection('rc11:nonesuch:warm', undefined)).toThrow(/ci-a/u);
    expect(() => collectArmsSelection('rc11:ci-a:tepid', undefined)).toThrow(InvalidArgumentError);
  });

  it('collects --prerequisite as an untimed tool step committed to exit 0', () => {
    const [step] = collectPrerequisite('pnpm install --frozen-lockfile', undefined);

    expect(step).toEqual({
      name: 'pnpm install --frozen-lockfile',
      command: { kind: 'tool', command: 'pnpm', args: ['install', '--frozen-lockfile'] },
      timed: false,
      exit: exactExit(0),
      provenance: 'none',
      populates: false,
    });
    expect(() => collectPrerequisite('   ', undefined)).toThrow(InvalidArgumentError);
  });

  it('collects --expect-exit as build:sequence:step=ONE code, refusing a list, exit 2 and anything malformed', () => {
    expect(collectExpectedExit('cand:ci-c:validate-ci=1', undefined)).toEqual([
      { build: 'cand', sequence: 'ci-c', step: 'validate-ci', exit: 1 },
    ]);
    expect(() => collectExpectedExit('cand:ci-c:validate-ci=0,1', undefined)).toThrow(/one exit code/u);
    expect(() => collectExpectedExit('cand:ci-c:validate-ci=2', undefined)).toThrow(/exit 2/u);
    expect(() => collectExpectedExit('cand:ci-c:validate-ci=300', undefined)).toThrow(/from 0 to 255/u);
    expect(() => collectExpectedExit('cand:ci-c=0', undefined)).toThrow(InvalidArgumentError);
    expect(() => collectExpectedExit('cand:ci-c:validate-ci=one', undefined)).toThrow(InvalidArgumentError);
    expect(() => collectExpectedExit('cand:ci-c:validate-ci=', undefined)).toThrow(InvalidArgumentError);
  });

  it('refuses a second --expect-exit for the same (build, sequence, step), whatever its code — no first-wins', () => {
    const first = collectExpectedExit('cand:ci-c:validate-ci=1', undefined);
    expect(() => collectExpectedExit('cand:ci-c:validate-ci=1', first)).toThrow(/cand:ci-c:validate-ci.*more than once/u);
    expect(() => collectExpectedExit('cand:ci-c:validate-ci=0', first)).toThrow(/more than once/u);
    expect(collectExpectedExit('rc11:ci-c:validate-ci=1', first)).toHaveLength(2);
  });

  it('wires every flag onto perf arms', () => {
    expect(optionOf('perf', 'arms', '--build')?.parseArg).toBe(collectArmsBuild);
    expect(optionOf('perf', 'arms', '--arm')?.parseArg).toBe(collectArmsSelection);
    expect(optionOf('perf', 'arms', '--prerequisite')?.parseArg).toBe(collectPrerequisite);
    expect(optionOf('perf', 'arms', '--expect-exit')?.parseArg).toBe(collectExpectedExit);
    expect(optionOf('perf', 'arms', '--rounds')?.defaultValue).toBe(5);
    expect(optionOf('perf', 'arms', '--commit')?.defaultValue).toBe('HEAD');
  });

  it('refuses fewer than 5 --rounds, the fewest a median and IQR are read over', () => {
    expect(() => optionOf('perf', 'arms', '--rounds')?.parseArg?.('4', undefined)).toThrow(InvalidArgumentError);
    expect(optionOf('perf', 'arms', '--rounds')?.parseArg?.('5', undefined)).toBe(5);
  });
});

/** An arms report's inputs when the caller chose none. */
const NO_INPUTS = { env: { set: {}, unset: [] }, expectedExits: [], prerequisites: [], timeoutMs: null };

/**
 * @param steps - One round's timed steps and their exits
 * @returns Five such rounds — the judged floor — as an arms report records them
 */
function cleanRounds(steps: readonly (readonly [string, number])[]): unknown[] {
  return Array.from({ length: 5 }, () => ({
    exitCode: steps.find(([, exit]) => exit !== 0)?.[1] ?? 0,
    violation: null,
    steps: steps.map(([name, exitCode]) => ({ name, timed: true, exitCode })),
  }));
}

const measured = (build: string, arm: string, medianMs: number, minMs: number) => ({
  build,
  arm,
  state: 'cold',
  exits: [],
  summary: { minMs, medianMs, iqrMs: 1, runs: 5 },
  repetitions: cleanRounds([['s', 0]]),
  failure: null,
});

/**
 * Run the lab CLI over these arguments, its output captured.
 *
 * @param args - What follows `vat-lab`
 * @returns What the command wrote to stdout and stderr
 */
async function runLab(args: readonly string[]): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  await createProgram().parseAsync(['node', 'vat-lab', ...args]);
  const text = (spy: typeof stdout): string => spy.mock.calls.map(([chunk]) => String(chunk)).join('');
  return { stdout: text(stdout), stderr: text(stderr) };
}

/**
 * Write an arms report and judge these bars over it.
 *
 * @param bars - The bars, as typed after --bar
 * @returns What the command wrote to stdout and stderr
 */
async function judge(bars: readonly string[]): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const report = safePath.join(tempDir, 'bars-arms-report.json');
  await writeFile(
    report,
    JSON.stringify({
      prepared: { ok: true, path: safePath.join(tempDir, 'clone'), commit: 'a'.repeat(40), tree: 'b'.repeat(40), removedEnv: [], removedToolEnv: [] },
      inputs: NO_INPUTS,
      cwd: tempDir,
      rounds: 5,
      builds: [
        { alias: 'rc11', source: { kind: 'npx', spec: 'vibe-agent-toolkit@0.2.0-rc.11' }, instrument: { version: '0.2.0-rc.11', commit: null, dirty: null, closure: null } },
        { alias: 'cand', source: { kind: 'dist', path: '/x/vat' }, instrument: { version: '0.2.0', commit: null, dirty: null, closure: null } },
      ],
      load: { before: null, after: null, cpus: 8, available: false, contaminated: false },
      arms: [measured('rc11', 'ci-a', 100, 90), measured('cand', 'ci-c', 110, 100)],
    }),
  );
  return runLab(['perf', 'bars', report, ...bars.flatMap((bar) => ['--bar', bar])]);
}

describe('vat-lab perf arms --build', () => {
  it('refuses a build alias given twice, in any case — two arms would share one arm directory', () => {
    const first = collectArmsBuild('rc11=dist:/x/vat', undefined);
    expect(() => collectArmsBuild('rc11=dist:/y/vat', first)).toThrow(/'rc11' more than once/u);
    expect(() => collectArmsBuild('RC11=dist:/y/vat', first)).toThrow(/'RC11' more than once/u);
  });
});

describe('vat-lab perf bars', () => {
  it('wires a required, repeatable --bar parsed by collectBar', () => {
    expect(optionOf('perf', 'bars', '--bar')?.parseArg).toBe(collectBar);
    expect(optionOf('perf', 'bars', '--bar')?.required).toBe(true);
    expect(() => collectBar('cand:ci-c:cold<=rc11:ci-a:cold', undefined)).toThrow(/factor/u);
  });

  it('exits 0 when every bar passes', async () => {
    const { stdout } = await judge(['cand:ci-c:cold<=1.15*rc11:ci-a:cold']);

    expect(process.exitCode).toBeUndefined();
    expect(stdout).toMatch(/^PASS {2}cand:ci-c:cold<=1\.15\*rc11:ci-a:cold/mu);
  });

  it('exits non-zero on a failed bar, and on an INCONCLUSIVE one', async () => {
    await judge(['cand:ci-c:cold<=1*rc11:ci-a:cold']);
    expect(process.exitCode).toBe(ExitCode.FINDINGS);

    process.exitCode = undefined;
    // median 110 ≤ 1.1 × 100 holds; min 100 ≤ 1.1 × 90 does not.
    const { stdout } = await judge(['cand:ci-c:cold<=1.1*rc11:ci-a:cold']);
    expect(process.exitCode).toBe(ExitCode.FINDINGS);
    expect(stdout).toMatch(/^INCONCLUSIVE/mu);
  });

  it('prints what every alias was before the verdicts', async () => {
    const { stdout } = await judge(['cand:ci-c:cold<=1.15*rc11:ci-a:cold']);

    expect(stdout).toMatch(/^ {2}rc11: vat 0\.2\.0-rc\.11 .* from npx:vibe-agent-toolkit@0\.2\.0-rc\.11$/mu);
    expect(stdout).toMatch(/^Machine load: NOT MEASURED/mu);
  });

  it('refuses a bar naming an arm the report does not hold', async () => {
    const { stderr } = await judge(['cand:ci-b:cold<=1*rc11:ci-a:cold']);

    expect(process.exitCode).toBe(ExitCode.ERROR);
    expect(stderr).toMatch(/^REFUSED: .*cand:ci-b:cold is not in the report/mu);
  });
});

describe('vat-lab verdict union', () => {
  it('splits a sequence of row names on commas, refusing an empty one', () => {
    expect(splitRowNames('resources-validate-ci, resources-check-ci,skills-validate-ci')).toEqual([
      'resources-validate-ci',
      'resources-check-ci',
      'skills-validate-ci',
    ]);
    expect(() => splitRowNames(' , ')).toThrow(InvalidArgumentError);
  });

  it('declares --left and --right parsed by splitRowNames, and a required --alias', () => {
    expect(optionOf('verdict', 'union', '--left')?.parseArg).toBe(splitRowNames);
    expect(optionOf('verdict', 'union', '--right')?.parseArg).toBe(splitRowNames);
    expect(optionOf('verdict', 'union', '--alias')?.required).toBe(true);
  });

  it('judges bar 3 over a perf arms report: --arms and both arms are required, each arm in --arm spelling', () => {
    expect(optionOf('verdict', 'union', '--arms')?.required).toBe(true);
    for (const flag of ['--left-arm', '--right-arm']) {
      expect(optionOf('verdict', 'union', flag)?.required, flag).toBe(true);
      expect(optionOf('verdict', 'union', flag)?.parseArg, flag).toBe(armNameOption);
    }
    expect(armNameOption('cand:ci-b:cold')).toEqual({ build: 'cand', arm: 'ci-b', state: 'cold' });
    expect(() => armNameOption('cand:ci-b')).toThrow(InvalidArgumentError);
  });
});

/** The two builds bar 3 runs: CI's sequence on the baseline, the single run on the candidate. */
const UNION_BUILDS = {
  rc11: { version: '0.2.0-rc.11', commit: null, dirty: null, closure: null },
  cand: { version: '0.2.0', commit: null, dirty: null, closure: null },
} as const;

/**
 * A verdict report of the `app` subject holding one row with one finding.
 *
 * @param row - The row name
 * @param preparedClone - Where it ran, or `null` for its subjects-file path
 * @param commit - The subject's commit
 * @param build - Which build captured it
 * @returns The envelope
 */
function unionEnvelope(row: string, preparedClone: string | null, commit: string, build: keyof typeof UNION_BUILDS): ReportEnvelope<VerdictBody> {
  const finding = { code: 'LINK_BROKEN_FILE', severity: 'error', location: 'docs/a.md', line: 3, message: 'm' };
  return {
    facet: 'verdict',
    coordinate: {
      subject: { id: 'app', source: preparedClone ?? '/work/app' },
      subjectVersion: { kind: 'git', commit, ref: null, dirty: false, workingFingerprint: null },
      instrument: UNION_BUILDS[build],
    },
    capturedAt: '2026-10-31T00:00:00.000Z',
    removedEnv: [],
    exits: [],
    body: {
      arm: { set: {}, unset: [] },
      rows: [
        {
          name: row,
          argv: [row],
          outcome: 'exited',
          exitCode: 1,
          spawnError: null,
          document: JSON.stringify({ status: 'findings', examined: 1, findings: [finding], summary: {}, data: {} }),
        },
      ],
      excluded: [],
      preparedClone,
    },
  };
}

/**
 * Write bar 3's inputs — two captures, an arms report, a deltas file — and run `verdict union` over them.
 *
 * @param prepared - Whether both captures ran in the arms' prepared clone
 * @param rightFailure - The right arm's recorded failure, or `null`
 * @returns What the command wrote to stdout and stderr
 */
async function union(prepared: boolean, rightFailure: string | null = null): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const root = await mkdtemp(safePath.join(tempDir, 'union-'));
  const clone = safePath.join(root, 'clone');
  const commit = 'a'.repeat(40);
  const left = safePath.join(root, 'left');
  const right = safePath.join(root, 'right');
  await writeReport(left, unionEnvelope('resources-validate-ci', prepared ? clone : null, commit, 'rc11'));
  await writeReport(right, unionEnvelope('validate', prepared ? clone : null, commit, 'cand'));
  const report = safePath.join(root, 'arms-report.json');
  await writeFile(
    report,
    JSON.stringify({
      prepared: { ok: true, path: clone, commit, tree: 'b'.repeat(40), removedEnv: [], removedToolEnv: [] },
      inputs: NO_INPUTS,
      builds: Object.entries(UNION_BUILDS).map(([alias, instrument]) => ({ alias, source: { kind: 'dist', path: `/builds/${alias}` }, instrument })),
      load: { before: null, after: null, cpus: 1, available: false, contaminated: false },
      arms: [
        { build: 'rc11', arm: 'ci-b', state: 'cold', exits: [], repetitions: cleanRounds([['resources-validate-ci', 1]]), summary: null, failure: null },
        { build: 'cand', arm: 'ci-c', state: 'cold', exits: [], repetitions: cleanRounds([['validate', 1]]), summary: null, failure: rightFailure },
      ],
    }),
  );
  const deltas = safePath.join(root, 'deltas.yaml');
  await writeFile(deltas, 'baseline: 0.2.0\ndeltas: []\n');
  return runLab([
    'verdict', 'union', left, right, '--alias', 'app', '--left', 'resources-validate-ci', '--right', 'validate',
    '--arms', report, '--left-arm', 'rc11:ci-b:cold', '--right-arm', 'cand:ci-c:cold', '--deltas', deltas,
  ]);
}

describe('vat-lab verdict union — bar 3 end to end', () => {
  it('holds over two captures of the prepared clone whose arms exit as CI would', async () => {
    const { stdout, stderr } = await union(true);

    expect(stderr).toBe('');
    expect(stdout).toBe('BAR 3 HOLDS\n');
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('refuses an arms report whose right arm failed — its rounds are never read as complete', async () => {
    const { stderr } = await union(true, "1 of 5 repeats failed — step 'validate' exited 2");

    expect(stderr).toBe("REFUSED: cand:ci-c:cold failed: 1 of 5 repeats failed — step 'validate' exited 2\n");
    expect(process.exitCode).toBe(ExitCode.ERROR);
  });

  it('refuses captures that did not run in the prepared clone', async () => {
    const { stderr } = await union(false);

    expect(stderr).toMatch(/^REFUSED: subject 'app' ran at its subjects-file path, not in the prepared clone/u);
    expect(process.exitCode).toBe(ExitCode.ERROR);
  });
});

describe('vat-lab verdict run --prepared', () => {
  it('collects alias=path pairs, resolving the path, and refuses a malformed one', () => {
    expect(collectPreparedSubject('app=/work/out/clone', undefined)).toEqual({ app: safePath.resolve('/work/out/clone') });
    expect(() => collectPreparedSubject('=/x', undefined)).toThrow(InvalidArgumentError);
    expect(() => collectPreparedSubject('app=', undefined)).toThrow(InvalidArgumentError);
  });

  it('declares --prepared on verdict run', () => {
    const option = optionOf('verdict', 'run', '--prepared');

    expect(option).toBeDefined();
    expect(option?.parseArg).toBe(collectPreparedSubject);
  });
});
