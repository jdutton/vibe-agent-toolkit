/**
 * `captureIo` is where a call count either describes the measured run or
 * describes something else entirely while looking identical, and every test here
 * is aimed at one of those confusions.
 *
 * The shape of the danger is different from `perf`'s. A wrong timing is usually
 * *implausible* — a 0 ms audit reads as broken. A wrong call count is always
 * plausible: 4, 9, 0 and 8 are all perfectly reasonable numbers for a command to
 * produce, and nothing in a well-formed `io` report says which one belongs to
 * the run it claims to describe. So the fixtures below are built so that the
 * right answer and the wrong answer are DIFFERENT NUMBERS, never the same number
 * arrived at two ways:
 *
 * - the warm-up repeat is given a count nothing else has (9), so a capture that
 *   compared it or reported it says 9 where the truth is 4;
 * - the two compared repeats are given equal counts in the stability case and
 *   unequal ones in its control, so `stable` can be observed being both;
 * - an earlier repeat is made to write TWO dumps where the reported one writes
 *   one, so a reused dump directory shows up as `processes: 2` and a doubled
 *   count rather than as nothing at all.
 *
 * ## The stand-in counter
 *
 * The shared probe (`command-probe.ts`) is a plain node script; it does not
 * count I/O and never will. What it does do is honour `NODE_OPTIONS`, which is
 * the entire mechanism under test — so this suite supplies its own CommonJS
 * counter through the production `counterPath` option and drives it through the
 * production env contract (`VAT_LAB_IO_LOG`). Nothing is stubbed and no seam
 * exists here that production does not use: the fake counter is loaded exactly
 * the way the real one is, by the string `captureIo` puts in `NODE_OPTIONS`.
 *
 * That is also why the counter writes a TRACE line for every process it is
 * loaded into. The trace is the only way to observe, from outside, which
 * children got the preload and what their `NODE_OPTIONS` actually said — and
 * "the cache clear must not be instrumented" is otherwise an untestable claim.
 */

/* eslint-disable security/detect-non-literal-fs-filename -- every path here is derived from a controlled mkdtemp scratch dir */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { SubjectVersion } from '../src/envelope/coordinate.js';
import { REPORT_FORMAT_VERSION, type ReportEnvelope } from '../src/envelope/envelope.js';
import { captureIo, type CaptureIoOptions } from '../src/facets/io/capture.js';
import { IO_DUMP_VERSION } from '../src/facets/io/dump.js';
import {
  IO_FACET,
  IO_FACET_VERSION,
  type IoBody,
  IoBodySchema,
  type IoCommandStats,
} from '../src/facets/io/types.js';
import type { MeasuredCommandSpec } from '../src/harness/commands.js';
import type { ResolvedSubject } from '../src/harness/types.js';

import {
  cleanupProbes,
  PROBE_DEFAULT_STDERR,
  PROBE_FAIL_EXIT,
  PROBE_FAIL_TOKEN,
  PROBE_VERSION,
  setupProbe,
  type Probe,
} from './command-probe.js';

/** Temp-directory prefix, so a stray directory names this suite. */
const PREFIX = 'lab-io-capture-';

/** The caller owns the clock, so this exact string must come back in the report. */
const CAPTURED_AT = '2026-08-09T12:34:56.000Z';

/** The production contract with the counter: where it is told to write its dumps. */
const LOG_DIR_ENV = 'VAT_LAB_IO_LOG';

/** Where the stand-in counter appends one line per process it is loaded into. */
const TRACE_ENV = 'LAB_IO_TRACE';

/** Per-repeat call counts, comma-separated; the last value repeats. */
const COUNTS_ENV = 'LAB_IO_COUNTS';

/** Per-repeat dump-file counts, comma-separated; the last value repeats. */
const DUMPS_ENV = 'LAB_IO_DUMPS';

/** The site every synthesised row is attributed to. */
const SITE_ENV = 'LAB_IO_SITE';

/** A site under neither root, so normalization leaves it exactly as written. */
const FOREIGN_SITE = '/somewhere/foreign/x.js:1';

/** The one method the stand-in counter reports. */
const METHOD = 'fs.readFile';

/** Count the default fixture produces, chosen not to collide with any other constant. */
const DEFAULT_COUNT = 7;

/** A command that always succeeds. */
const PASSES: MeasuredCommandSpec = { name: 'audit', args: ['audit'] };

/** A command that always fails, on every repeat, by argv. */
const FAILS: MeasuredCommandSpec = { name: 'broken', args: [PROBE_FAIL_TOKEN] };

/**
 * The stand-in counter, in CommonJS because `--require` accepts nothing else.
 *
 * It does two jobs. It records that it ran at all — the directory it was handed,
 * and the `NODE_OPTIONS` it was launched with — which is what makes the preload
 * observable from outside the child. And it writes dumps in the real dump
 * format, indexed by how many processes have already logged, so a case can give
 * each repeat a different measurement without the counter knowing anything about
 * repeats.
 *
 * The index is taken BEFORE the line is appended, so it is zero-based; in `warm`
 * mode, where the only instrumented children are the measured runs, it is
 * exactly the repeat index.
 */
const COUNTER_SOURCE = [
  "const { appendFileSync, readFileSync, writeFileSync } = require('node:fs');",
  "const { join } = require('node:path');",
  '',
  `const trace = process.env.${TRACE_ENV};`,
  `const dir = process.env.${LOG_DIR_ENV};`,
  'let shot = 0;',
  "if (typeof trace === 'string') {",
  '  try {',
  String.raw`    shot = readFileSync(trace, 'utf-8').split('\n').filter((l) => l !== '').length;`,
  '  } catch {',
  '    shot = 0;',
  '  }',
  '  appendFileSync(',
  '    trace,',
  '    JSON.stringify({ dir: dir ?? null, nodeOptions: process.env.NODE_OPTIONS ?? null }) +',
  String.raw`      '\n',`,
  '  );',
  '}',
  '',
  "if (typeof dir === 'string' && dir !== '') {",
  '  const pick = (name, fallback) => {',
  '    const raw = process.env[name];',
  "    const parts = raw === undefined || raw === '' ? fallback : raw.split(',');",
  '    return Number(parts[shot] !== undefined ? parts[shot] : parts[parts.length - 1]);',
  '  };',
  `  const count = pick(${JSON.stringify(COUNTS_ENV)}, [${JSON.stringify(String(DEFAULT_COUNT))}]);`,
  `  const files = pick(${JSON.stringify(DUMPS_ENV)}, ['1']);`,
  `  const site = process.env.${SITE_ENV} ?? ${JSON.stringify(FOREIGN_SITE)};`,
  '  for (let index = 0; index < files; index++) {',
  '    writeFileSync(',
  '      join(dir, `io-${process.pid}-${index}.json`),',
  '      JSON.stringify({',
  `        dumpVersion: ${String(IO_DUMP_VERSION)},`,
  '        pid: process.pid + index,',
  '        rows: [',
  `          { cls: 'user', method: ${JSON.stringify(METHOD)}, site, count, distinctArgs: 1, argsCapped: false },`,
  '        ],',
  '      }),',
  '    );',
  '  }',
  '}',
  '',
].join('\n');

/** Scratch directories this suite made, dropped in one go. */
const scratchDirs: string[] = [];

/** The stand-in counter at a path with no spaces — the normal case. */
let counterPath: string;

/** The same counter at a path that CONTAINS a space. See the quoting tests. */
let spacedCounterPath: string;

beforeAll(() => {
  counterPath = writeCounter('lab-io-counter-');
  spacedCounterPath = writeCounter('lab io counter ');
});

afterAll(() => {
  cleanupProbes();
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
  scratchDirs.length = 0;
});

/**
 * Write the stand-in counter into a fresh temp directory.
 *
 * @param prefix - Temp-directory prefix; one of them deliberately ends in a space
 * @returns Absolute path to the written counter
 */
function writeCounter(prefix: string): string {
  const dir = mkdtempSync(safePath.join(normalizedTmpdir(), prefix));
  scratchDirs.push(dir);
  const file = safePath.join(dir, 'counter.cjs');
  writeFileSync(file, COUNTER_SOURCE, 'utf-8');
  return file;
}

/**
 * A subject literal pointing at the probe's directory.
 *
 * Constructed rather than resolved: `resolveSubject` runs git, and this suite is
 * about what happens to dumps, not about how axis B is discovered.
 *
 * @param path - The probe's working directory
 * @returns A snapshot-kind subject at that path
 */
function subjectAt(path: string): ResolvedSubject {
  const version: SubjectVersion = { kind: 'snapshot', fingerprint: 'a'.repeat(16), fileCount: 3 };
  return { path, ref: { id: 'io-probe-subject', source: path }, version };
}

/**
 * Where a probe's counter trace lives.
 *
 * @param probe - The probe whose children are being traced
 * @returns Absolute path to its trace file
 */
function tracePath(probe: Probe): string {
  return safePath.join(probe.cwd, 'io-trace.log');
}

/** One process the stand-in counter was loaded into. */
interface TraceLine {
  /** The dump directory it was handed, or `null` when it had none. */
  readonly dir: string | null;
  /** `NODE_OPTIONS` exactly as the child saw it. */
  readonly nodeOptions: string | null;
}

/**
 * Every process the counter ran in, in order.
 *
 * @param probe - The probe whose children are being traced
 * @returns One entry per instrumented process, or none when the counter never loaded
 */
function trace(probe: Probe): TraceLine[] {
  let raw: string;
  try {
    raw = readFileSync(tracePath(probe), 'utf-8');
  } catch {
    return [];
  }
  return raw
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as TraceLine);
}

/**
 * Capture against a probe, defaulting everything a case does not vary.
 *
 * The trace variable is merged in last so no case can accidentally drop it; a
 * case that needs its own environment supplies `env` and gets both.
 *
 * @param probe - Supplies the instrument and the subject path
 * @param overrides - What the case varies
 * @returns The complete report envelope
 */
async function capture(
  probe: Probe,
  overrides: Partial<CaptureIoOptions> = {},
): Promise<ReportEnvelope<IoBody>> {
  return captureIo({
    instrument: probe.instrument,
    subject: subjectAt(probe.cwd),
    commands: [PASSES],
    runs: 3,
    cache: 'warm',
    capturedAt: CAPTURED_AT,
    counterPath,
    ...overrides,
    env: { [TRACE_ENV]: tracePath(probe), ...overrides.env },
  });
}

/**
 * The single row of a one-command capture.
 *
 * @param report - A report captured with exactly one command
 * @returns That command's row
 * @throws When the capture produced no row at all, which is never the contract
 */
function onlyRow(report: ReportEnvelope<IoBody>): IoCommandStats {
  const [row] = report.body.commands;
  if (row === undefined) throw new Error('captureIo produced no command rows');
  return row;
}

describe('captureIo — which repeat is reported, and which are compared', () => {
  it('reports the LAST repeat and never the warm-up', async () => {
    const probe = setupProbe(PREFIX);

    // Repeat 0 is worth 9 calls and repeats 1 and 2 are worth 4. Both wrong
    // answers are therefore visible as themselves: a capture that reported the
    // warm-up says 9, and one that compared it says `stable: false`.
    const row = onlyRow(await capture(probe, { runs: 3, env: { [COUNTS_ENV]: '9,4,4' } }));

    expect(row.userCalls).toBe(4);
    expect(row.runs).toBe(3);
    expect(row.comparedRuns).toBe(2);
    expect(row.stable).toBe(true);
    expect(row.processes).toBe(1);
    expect(row.failed).toBe(false);
    expect(row.sites).toEqual([
      { method: METHOD, site: FOREIGN_SITE, count: 4, distinctArgs: 1, argsCapped: false },
    ]);
  });

  it('CONTROL: reports stable false when the compared repeats disagree', async () => {
    const probe = setupProbe(PREFIX);

    // The same fixture, one digit different. Without this the assertion above
    // could be passing because `stable` is hardcoded true — and the reported
    // count could be right by coincidence rather than by position.
    const row = onlyRow(await capture(probe, { runs: 3, env: { [COUNTS_ENV]: '9,4,5' } }));

    expect(row.stable).toBe(false);
    expect(row.userCalls).toBe(5);
    // False is not failure: the numbers are still the last repeat's, and still
    // real. Only an exact-equality delta against them is unwarranted.
    expect(row.failed).toBe(false);
  });

  it('reports stable null for a single repeat, which is its own reported run', async () => {
    const probe = setupProbe(PREFIX);

    const row = onlyRow(await capture(probe, { runs: 1, env: { [COUNTS_ENV]: '3,99' } }));

    expect(row.runs).toBe(1);
    expect(row.comparedRuns).toBe(0);
    // Not false, and emphatically not true: with nothing to disagree with,
    // determinism was never tested. A boolean here would assert a property the
    // capture has no warrant for, and a comparator would trust it.
    expect(row.stable).toBeNull();
    expect(row.userCalls).toBe(3);
  });

  it('reports stable null for two repeats, having compared exactly one', async () => {
    const probe = setupProbe(PREFIX);

    const row = onlyRow(await capture(probe, { runs: 2, env: { [COUNTS_ENV]: '9,4' } }));

    expect(row.runs).toBe(2);
    expect(row.comparedRuns).toBe(1);
    expect(row.stable).toBeNull();
    // The warm-up is still dropped: 4 is repeat 1, 9 is the discarded repeat 0.
    expect(row.userCalls).toBe(4);
  });
});

describe('captureIo — one dump directory per repeat', () => {
  it('hands every repeat its own directory and removes them all afterwards', async () => {
    const probe = setupProbe(PREFIX);

    await capture(probe, { runs: 3 });

    const dirs = trace(probe).map((line) => line.dir);
    expect(dirs).toHaveLength(3);
    expect(new Set(dirs).size).toBe(3);
    expect(dirs.filter((dir) => dir !== null && existsSync(dir))).toEqual([]);
  });

  it('cannot let an earlier repeat’s dumps reach the report', async () => {
    const probe = setupProbe(PREFIX);

    // Repeat 0 writes TWO dumps worth 50 calls each; repeats 1 and 2 write one
    // worth 4. A directory reused across repeats cannot tell a leftover dump
    // from a descendant process — both are files with distinct PIDs — so it
    // would report three processes and 104 calls, and look well-formed doing it.
    const row = onlyRow(
      await capture(probe, {
        runs: 3,
        env: { [DUMPS_ENV]: '2,1,1', [COUNTS_ENV]: '50,4,4' },
      }),
    );

    expect(row.processes).toBe(1);
    expect(row.userCalls).toBe(4);
  });

  it('CONTROL: two dumps in the reported repeat’s OWN directory do merge', async () => {
    const probe = setupProbe(PREFIX);

    // The same counter, the same two files — written by the repeat that IS
    // reported. This is what proves the assertion above is not vacuous: the
    // fixture can produce `processes: 2` and a doubled count, so seeing 1 and 4
    // there is evidence about the directories rather than about the counter.
    const row = onlyRow(
      await capture(probe, {
        runs: 3,
        env: { [DUMPS_ENV]: '1,1,2', [COUNTS_ENV]: '9,4,4' },
      }),
    );

    expect(row.processes).toBe(2);
    expect(row.userCalls).toBe(8);
  });
});

describe('captureIo — the counter preload', () => {
  /** The preload fragment `captureIo` must add, quoted. */
  const preloadOf = (path: string): string => `--require "${path}"`;

  it('APPENDS to a NODE_OPTIONS supplied through the capture’s env', async () => {
    const probe = setupProbe(PREFIX);

    await capture(probe, { runs: 1, env: { NODE_OPTIONS: '--no-warnings' } });

    // Assignment rather than append would strip `--no-warnings` — and in a real
    // capture would strip whatever the surrounding CI set, silently changing the
    // process being measured.
    expect(trace(probe).map((line) => line.nodeOptions)).toEqual([
      `--no-warnings ${preloadOf(counterPath)}`,
    ]);
  });

  it('APPENDS to a NODE_OPTIONS inherited from the surrounding process', async () => {
    const probe = setupProbe(PREFIX);
    const original = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = '--no-warnings';

    try {
      await capture(probe, { runs: 1 });
    } finally {
      if (original === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = original;
    }

    // The other base. `runRepeats` merges the capture's env over `process.env`,
    // so a capture that only consulted its own options would clobber this one
    // without ever seeing it.
    expect(trace(probe).map((line) => line.nodeOptions)).toEqual([
      `--no-warnings ${preloadOf(counterPath)}`,
    ]);
  });

  it('CONTROL: with no NODE_OPTIONS anywhere, the preload stands alone', async () => {
    const probe = setupProbe(PREFIX);
    const original = process.env.NODE_OPTIONS;
    delete process.env.NODE_OPTIONS;

    try {
      await capture(probe, { runs: 1 });
    } finally {
      if (original !== undefined) process.env.NODE_OPTIONS = original;
    }

    // Pins the empty base: an implementation that always prefixed a separator,
    // or that appended to the string `undefined`, passes both tests above and
    // fails here.
    expect(trace(probe).map((line) => line.nodeOptions)).toEqual([preloadOf(counterPath)]);
  });

  it('reaches the measured run and never the cache clear', async () => {
    const probe = setupProbe(PREFIX);

    await capture(probe, { runs: 2, cache: 'cold' });

    // Four children ran — a clear before each repeat — and only the two measured
    // ones were instrumented. Instrumenting the clear would fold setup's own I/O
    // into the measurement, which is why the preload rides `envFor` and not
    // `env`.
    expect(probe.entries()).toHaveLength(4);
    const lines = trace(probe);
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => line.dir !== null)).toBe(true);
  });

  it('CONTROL: a preload placed on the shared env DOES reach the cache clear', async () => {
    const probe = setupProbe(PREFIX);

    await capture(probe, {
      runs: 2,
      cache: 'cold',
      env: { NODE_OPTIONS: preloadOf(counterPath) },
    });

    // Same probe, same four children — but now the counter is loaded into all
    // of them, which is exactly what the assertion above claims cannot happen by
    // default. The clears have no dump directory, so they are identifiable.
    const lines = trace(probe);
    expect(lines).toHaveLength(4);
    expect(lines.map((line) => line.dir === null)).toEqual([true, false, true, false]);
  });

  it('quotes the counter path, so a directory containing a space still loads', async () => {
    const probe = setupProbe(PREFIX);

    const row = onlyRow(await capture(probe, { runs: 1, counterPath: spacedCounterPath }));

    expect(row.failed).toBe(false);
    expect(row.userCalls).toBe(DEFAULT_COUNT);
  });

  it('CONTROL: the same spaced path UNQUOTED breaks the run it was meant to measure', async () => {
    const probe = setupProbe(PREFIX);

    const row = onlyRow(
      await capture(probe, {
        runs: 1,
        counterPath: spacedCounterPath,
        env: { NODE_OPTIONS: `--require ${spacedCounterPath}` },
      }),
    );

    // `--require /lab io counter x/counter.cjs` parses as two arguments, node
    // cannot find `/lab`, and the child dies. Proof that the passing test above
    // is about the quoting and not about the path being harmless.
    expect(row.failed).toBe(true);
  });
});

describe('captureIo — the counter has to exist', () => {
  it('throws naming the build command when the given counter is missing', async () => {
    const probe = setupProbe(PREFIX);
    const missing = safePath.join(probe.cwd, 'not-a-counter.cjs');

    // Never a fallback to an uninstrumented run. That would report zero calls —
    // the worst output this module can produce, because a report of zero I/O is
    // perfectly well-formed and nothing in it says it is a lie.
    await expect(capture(probe, { runs: 1, counterPath: missing })).rejects.toThrow(
      /bunx tsc --build packages\/lab\/tsconfig\.json/,
    );
    await expect(capture(probe, { runs: 1, counterPath: missing })).rejects.toThrow(missing);
  });

  it('throws rather than measuring nothing when no counter has been built', async () => {
    const probe = setupProbe(PREFIX);

    // No override: the default resolves beside this module, which under the test
    // runner is the SOURCE tree — where only `counter.cts` exists. The emitted
    // `counter.cjs` lives in `dist/`, so an unbuilt tree must fail loudly here.
    await expect(
      captureIo({
        instrument: probe.instrument,
        subject: subjectAt(probe.cwd),
        commands: [PASSES],
        runs: 1,
        cache: 'warm',
        capturedAt: CAPTURED_AT,
      }),
    ).rejects.toThrow(/counter\.cjs/);
  });
});

describe('captureIo — a row that measured nothing says so', () => {
  it('poisons the whole row when a repeat failed', async () => {
    const probe = setupProbe(PREFIX);

    const row = onlyRow(await capture(probe, { runs: 2, commands: [FAILS] }));

    expect(row.failed).toBe(true);
    expect(row.failure).toBe(
      `2 of 2 repeats failed — exited ${String(PROBE_FAIL_EXIT)}: ${PROBE_DEFAULT_STDERR}`,
    );
    expect(row.runs).toBe(2);
    // Zeroed, not omitted — and `failed` carries the meaning. Counting the calls
    // a crash made before it died measures how far vat got, not what it does.
    expect(row.comparedRuns).toBe(0);
    expect(row.stable).toBeNull();
    expect(row.processes).toBe(0);
    expect(row.loaderCalls).toBe(0);
    expect(row.userCalls).toBe(0);
    expect(row.sites).toEqual([]);
  });

  it('fails the row when the REPORTED repeat wrote no dumps', async () => {
    const probe = setupProbe(PREFIX);

    const row = onlyRow(await capture(probe, { runs: 3, env: { [DUMPS_ENV]: '1,1,0' } }));

    expect(row.failed).toBe(true);
    expect(row.failure).toContain('REFUSED');
    expect(row.userCalls).toBe(0);
  });

  it('fails the row when a COMPARED repeat wrote no dumps', async () => {
    const probe = setupProbe(PREFIX);

    // Repeat 1 is neither the warm-up nor the reported run, and its absence
    // still poisons the row: without it, `stable` would be asserting over a set
    // that is missing a member.
    const row = onlyRow(await capture(probe, { runs: 4, env: { [DUMPS_ENV]: '1,0,1,1' } }));

    expect(row.failed).toBe(true);
    expect(row.failure).toContain('REFUSED');
  });

  it('CONTROL: a warm-up that wrote no dumps is never read, and never fails the row', async () => {
    const probe = setupProbe(PREFIX);

    // The same missing-dump fixture, moved to repeat 0. This is what proves the
    // two assertions above are about which repeats are read rather than about
    // any missing dump anywhere failing everything.
    const row = onlyRow(await capture(probe, { runs: 3, env: { [DUMPS_ENV]: '0,1,1' } }));

    expect(row.failed).toBe(false);
    expect(row.userCalls).toBe(DEFAULT_COUNT);
  });

  it('marks a row failed rather than reporting a command that made no calls', async () => {
    const probe = setupProbe(PREFIX);

    // Cold on purpose: a cache clear hoisted out of the repeat loop would still
    // spawn a child here, where nothing at all should run.
    const row = onlyRow(await capture(probe, { runs: 0, cache: 'cold' }));

    expect(row.runs).toBe(0);
    expect(row.comparedRuns).toBe(0);
    expect(row.stable).toBeNull();
    expect(row.failed).toBe(true);
    expect(row.failure).toBe('no repeats were requested');
    expect(row.userCalls).toBe(0);
    expect(probe.entries()).toEqual([]);
    expect(trace(probe)).toEqual([]);
  });
});

describe('captureIo — sites are expressed against the instrument and the subject', () => {
  it('rewrites a site under the instrument root into a root-relative one', async () => {
    const probe = setupProbe(PREFIX);
    const root = '/repo/vat';

    const row = onlyRow(
      await capture(probe, {
        runs: 1,
        instrument: { ...probe.instrument, root },
        env: { [SITE_ENV]: `${root}/packages/resources/dist/content-key.js:141` },
      }),
    );

    expect(row.sites.map((site) => site.site)).toEqual([
      'packages/resources/dist/content-key.js:141',
    ]);
  });

  it('CONTROL: leaves the same site absolute for an instrument with no root', async () => {
    const probe = setupProbe(PREFIX);
    const site = '/repo/vat/packages/resources/dist/content-key.js:141';

    // The `npx` case. An empty instrument root is deliberate, not a gap: a
    // published package is unpacked under an arbitrary cache path, and naming it
    // would bake a temp directory into every site.
    const row = onlyRow(await capture(probe, { runs: 1, env: { [SITE_ENV]: site } }));

    expect(row.sites.map((entry) => entry.site)).toEqual([site]);
    expect(probe.instrument.root).toBeUndefined();
  });
});

describe('captureIo — the envelope', () => {
  it('names the facet and stamps all three coordinate axes', async () => {
    const probe = setupProbe(PREFIX);
    const subject = subjectAt(probe.cwd);

    const report = await capture(probe, { runs: 1 });

    expect(report.formatVersion).toBe(REPORT_FORMAT_VERSION);
    expect(report.facet).toBe(IO_FACET);
    expect(report.facetVersion).toBe(IO_FACET_VERSION);
    expect(report.coordinate).toEqual({
      subject: subject.ref,
      subjectVersion: subject.version,
      instrument: PROBE_VERSION,
    });
    expect(report.capturedAt).toBe(CAPTURED_AT);
  });

  it('produces a body that validates against the facet schema, failures included', async () => {
    const probe = setupProbe(PREFIX);

    const report = await capture(probe, { runs: 2, commands: [PASSES, FAILS] });

    // Reported through the assertion rather than as a bare boolean: a strict
    // schema rejecting one field should say which one.
    const parsed = IoBodySchema.safeParse(report.body);
    expect(parsed.success ? null : parsed.error.message).toBeNull();
    expect(report.body.load.cpus).toBeGreaterThanOrEqual(1);
    // Rows are independent: a failing command must not take its neighbour with it.
    expect(report.body.commands.map((row) => row.failed)).toEqual([false, true]);
  });
});
