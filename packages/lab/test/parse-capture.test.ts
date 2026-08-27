/**
 * `captureParse` is where a timing either describes the measured run or
 * describes something else entirely while looking identical.
 *
 * The stand-in seam below is a plain CommonJS file preloaded into the measured
 * child through the capture's own `env`. Nothing is stubbed: it activates on the
 * production variable (`VAT_PARSE_TIMING`), writes the production dump format
 * into whatever directory that variable names, and is read by the production
 * reader. What it stands in for is the seam compiled into a real vat — which
 * this repo's built vat does not have yet, and which an A/B baseline arm will
 * never have.
 *
 * The fixtures are built so that the right answer and the wrong answer are
 * DIFFERENT NUMBERS, never the same number arrived at two ways:
 *
 * - the three repeats are given totals `300, 150, 100`, so reporting the first
 *   says 300, the last says 100, the mean says 183.3, and only the median says
 *   150 — four readers, four visibly different answers;
 * - the document counts can be made to differ between repeats, so `stable` is
 *   observed being both `true` and `false` on the same machinery;
 * - a repeat can be told to write two dumps, so a reused dump directory would
 *   show up as `processes: 2` and doubled milliseconds rather than as nothing.
 */

/* eslint-disable security/detect-non-literal-fs-filename -- every path here is derived from a controlled mkdtemp scratch dir */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ReportEnvelope } from '../src/envelope/envelope.js';
import { captureParse, type CaptureParseOptions } from '../src/facets/parse/capture.js';
import {
  PARSE_TIMING_DIR_ENV,
  parseTotalName,
} from '../src/facets/parse/dump.js';
import {
  PARSE_FACET,
  type ParseBody,
  ParseBodySchema,
  type ParseCommandStats,
} from '../src/facets/parse/types.js';
import type { MeasuredCommandSpec } from '../src/harness/commands.js';
import type { ResolvedSubject } from '../src/harness/types.js';

import { expectBodyMatchesSchema, expectStamp, probeSubject } from './capture-fixtures.js';
import { cleanupProbes, PROBE_FAIL_EXIT, PROBE_FAIL_TOKEN, setupProbe, type Probe } from './command-probe.js';

/** Temp-directory prefix, so a stray directory names this suite. */
const PREFIX = 'lab-parse-capture-';

/** The caller owns the clock, so this exact string must come back in the report. */
const CAPTURED_AT = '2026-08-14T12:34:56.000Z';

/** Where the stand-in seam keeps its zero-based invocation counter. */
const SHOT_ENV = 'LAB_PARSE_SHOT';

/** Per-repeat document counts, comma-separated; the last value repeats. */
const DOCS_ENV = 'LAB_PARSE_DOCS';

/** Per-repeat totals in milliseconds, comma-separated; the last value repeats. */
const TOTAL_ENV = 'LAB_PARSE_TOTAL';

/** Per-repeat cache hits, comma-separated; the last value repeats. */
const HITS_ENV = 'LAB_PARSE_HITS';

/** Per-repeat dump-file counts, comma-separated; the last value repeats. */
const DUMPS_ENV = 'LAB_PARSE_DUMPS';

/**
 * Set to `1` to make every dump of a repeat carry the SAME pid.
 *
 * The parse worker pool's shape: a `worker_threads` Worker shares its parent's
 * pid, and each thread's copy of the seam writes its own dump carrying the whole
 * PROCESS's lifetime. Off by default, so the cases that want two distinct
 * processes still get them.
 */
const SAME_PID_ENV = 'LAB_PARSE_SAME_PID';

/** What a row's attribution says when there is no reading at all. */
const NOT_MEASURED = 'not-measured';

/** The pass the stand-in seam attributes half of each total to. */
const LEXER = 'remark-parse';

/** The parser kind the stand-in seam reports its group under. */
const MARKDOWN = 'markdown';

/**
 * Three repeat totals whose median, first, last and mean are four different
 * numbers — see this module's header for why that matters.
 */
const THREE_TOTALS = '300,150,100';

/** A command that always succeeds. */
const PASSES: MeasuredCommandSpec = { name: 'audit', args: ['audit'] };

/** A command that always fails, on every repeat, by argv. */
const FAILS: MeasuredCommandSpec = { name: 'broken', args: [PROBE_FAIL_TOKEN] };

/**
 * The stand-in seam, in CommonJS because `--require` accepts nothing else.
 *
 * It keeps its own invocation counter in a file so a case can give each repeat
 * different numbers without the seam knowing anything about repeats. Half of
 * each total is attributed to one pass and a quarter to another, which leaves a
 * quarter unattributed — a remainder the assertions can check rather than a tidy
 * zero that would pass whatever the reader did with it.
 */
const SEAM_SOURCE = [
  "'use strict';",
  "const { readFileSync, writeFileSync } = require('node:fs');",
  "const { join } = require('node:path');",
  '',
  `const dir = process.env.${PARSE_TIMING_DIR_ENV};`,
  `const shotFile = process.env.${SHOT_ENV};`,
  '',
  "if (typeof dir === 'string' && dir !== '') {",
  '  // Counted only here, INSIDE the dump-directory guard, so the repeat index',
  '  // advances once per measured run. A counter outside it would also count the',
  "  // cache clears that cold mode runs, and every repeat's numbers would shift.",
  '  let shot = 0;',
  "  if (typeof shotFile === 'string') {",
  "    try { shot = Number(readFileSync(shotFile, 'utf-8')) || 0; } catch { shot = 0; }",
  '    writeFileSync(shotFile, String(shot + 1));',
  '  }',
  '  const nth = (name, fallback) => {',
  '    const list = String(process.env[name] || fallback).split(",");',
  '    return Number(list[Math.min(shot, list.length - 1)]);',
  '  };',
  `  const docs = nth(${JSON.stringify(DOCS_ENV)}, '4');`,
  `  const total = nth(${JSON.stringify(TOTAL_ENV)}, '100');`,
  `  const hits = nth(${JSON.stringify(HITS_ENV)}, '0');`,
  `  const records = nth(${JSON.stringify(DUMPS_ENV)}, '1');`,
  // One process writes one file carrying every thread, so the two shapes this
  // suite needs are different ARRANGEMENTS of the same records: N separate files
  // of one main thread each is N processes, and one file of N threads is one
  // process running a pool, of which index 0 is the main thread.
  `  const pooled = process.env[${JSON.stringify(SAME_PID_ENV)}] === '1';`,
  '  const thread = (threadId) => ({',
  '    threadId,',
  '    cache: { hits, misses: docs },',
  '    tier: [],',
  '    kinds: [',
  '      {',
  `        kind: ${JSON.stringify(MARKDOWN)},`,
  '        documents: { count: docs, bytes: docs * 100 },',
  `        total: { pass: ${JSON.stringify(parseTotalName(MARKDOWN))}, calls: docs, elapsedMs: total },`,
  '        passes: [',
  `          { pass: ${JSON.stringify(LEXER)}, calls: docs, elapsedMs: total / 2 },`,
  "          { pass: 'ast-facts', calls: docs, elapsedMs: total / 4 },",
  '        ],',
  '      },',
  '    ],',
  '  });',
  '  const lifetime = { wallMs: 1000, cpuUserMs: 800, cpuSystemMs: 100 };',
  '  const write = (index, threads) =>',
  '    writeFileSync(',
  '      join(dir, `parse-timing-${process.pid}-${index}.json`),',
  '      JSON.stringify({ pid: process.pid + index, process: lifetime, threads }),',
  '    );',
  '  if (pooled) {',
  '    const threads = [];',
  '    for (let index = 0; index < records; index++) threads.push(thread(index));',
  '    write(0, threads);',
  '  } else {',
  '    for (let index = 0; index < records; index++) write(index, [thread(0)]);',
  '  }',
  '}',
  '',
].join('\n');

/** Scratch directories this suite made, dropped in one go. */
const scratchDirs: string[] = [];

/** The stand-in seam on disk. */
let seamPath = '';

beforeAll(() => {
  const directory = mkdtempSync(safePath.join(normalizedTmpdir(), 'lab-parse-seam-'));
  scratchDirs.push(directory);
  seamPath = safePath.join(directory, 'seam.cjs');
  writeFileSync(seamPath, SEAM_SOURCE, 'utf-8');
});

afterAll(() => {
  cleanupProbes();
  for (const directory of scratchDirs) rmSync(directory, { recursive: true, force: true });
  scratchDirs.length = 0;
});

/**
 * This suite's subject, so two capture suites' reports stay distinguishable.
 *
 * @param path - The probe's working directory
 * @returns A snapshot-kind subject at that path
 */
function subjectAt(path: string): ResolvedSubject {
  return probeSubject(path, 'parse-probe-subject', 'b'.repeat(16));
}

/**
 * Capture against a probe, defaulting everything a case does not vary.
 *
 * The seam preload and the shot counter are merged in last so no case can
 * accidentally drop them; a case that needs its own environment supplies `env`
 * and gets both.
 *
 * @param probe - Supplies the instrument and the subject path
 * @param overrides - What the case varies
 * @returns The complete report envelope
 */
async function capture(
  probe: Probe,
  overrides: Partial<CaptureParseOptions> = {},
): Promise<ReportEnvelope<ParseBody>> {
  return captureParse({
    instrument: probe.instrument,
    subject: subjectAt(probe.cwd),
    commands: [PASSES],
    runs: 3,
    cache: 'cold',
    capturedAt: CAPTURED_AT,
    ...overrides,
    env: {
      NODE_OPTIONS: `--require "${seamPath}"`,
      [SHOT_ENV]: safePath.join(probe.cwd, 'shot.txt'),
      ...overrides.env,
    },
  });
}

/**
 * The single row of a one-command capture.
 *
 * @param report - A report captured with exactly one command
 * @returns That command's row
 * @throws When the capture produced no row at all, which is never the contract
 */
function onlyRow(report: ReportEnvelope<ParseBody>): ParseCommandStats {
  const [row] = report.body.commands;
  if (row === undefined) throw new Error('captureParse produced no command rows');
  return row;
}

describe('captureParse — which repeat is reported', () => {
  it('reports the repeat whose total is the median, not the first or the last', async () => {
    const probe = setupProbe(PREFIX);

    const row = onlyRow(await capture(probe, { env: { [TOTAL_ENV]: THREE_TOTALS } }));

    // 300 would be the first repeat, 100 the last, 183.3 the mean. Only the
    // median is 150, so all four readers give visibly different answers here.
    expect(row.totalMs).toBe(150);
    expect(row.totalMsSamples).toEqual([300, 150, 100]);
    expect(row.runs).toBe(3);
  });

  it('keeps the reported repeat internally consistent', async () => {
    const probe = setupProbe(PREFIX);

    const row = onlyRow(
      await capture(probe, { env: { [TOTAL_ENV]: THREE_TOTALS, [DOCS_ENV]: '7,3,9' } }),
    );

    // Every figure comes from ONE run. Averaging per pass across repeats would
    // produce a breakdown no run ever exhibited — the shares would not sum to
    // the total and the remainder would become an artifact of the averaging.
    expect(row.documents).toBe(3);
    expect(row.kinds.map((kind) => kind.kind)).toEqual([MARKDOWN]);
    expect(row.kinds[0]?.passes.map((pass) => pass.elapsedMs)).toEqual([75, 37.5]);
    expect(row.kinds[0]?.unattributedMs).toBe(37.5);
    expect(row.unattributedMs).toBe(37.5);
    expect(row.totalCalls).toBe(3);
  });

  it('never discards a repeat as a warm-up', async () => {
    const probe = setupProbe(PREFIX);

    // The io facet drops repeat 0 because it wants the steady state. Here repeat
    // 0 is, in warm mode, the ONLY repeat that parses anything — dropping it
    // would throw the whole measurement away and report the empty steady state.
    const row = onlyRow(await capture(probe, { runs: 2, env: { [TOTAL_ENV]: '10,90' } }));

    expect(row.runs).toBe(2);
    expect(row.totalMsSamples).toEqual([10, 90]);
    // The lower of the two middles, deliberately: interpolating would invent a
    // repeat, and every number reported has to describe a run that happened.
    expect(row.totalMs).toBe(10);
  });
});

describe('captureParse — whether the repeats agreed', () => {
  it('reports stable when every repeat parsed the same work', async () => {
    const probe = setupProbe(PREFIX);

    const row = onlyRow(await capture(probe, { env: { [TOTAL_ENV]: THREE_TOTALS } }));

    // The totals differ on every repeat and the flag is still true: durations
    // always vary, and a flag that folded them in would be permanently false.
    expect(row.stable).toBe(true);
  });

  it('CONTROL: reports unstable when a repeat parsed a different corpus', async () => {
    const probe = setupProbe(PREFIX);

    const row = onlyRow(await capture(probe, { env: { [DOCS_ENV]: '4,4,5' } }));

    expect(row.stable).toBe(false);
    // Unstable is not failure: the numbers are still one real run's.
    expect(row.failed).toBe(false);
  });

  it('reports stable null for a single repeat, which could not disagree', async () => {
    const probe = setupProbe(PREFIX);

    const row = onlyRow(await capture(probe, { runs: 1 }));

    expect(row.runs).toBe(1);
    expect(row.stable).toBeNull();
  });
});

describe('captureParse — one dump directory per repeat', () => {
  it('cannot let an earlier repeat’s dumps reach the report', async () => {
    const probe = setupProbe(PREFIX);

    // Repeat 0 writes TWO dumps worth 200ms each; the others write one worth 100.
    // A directory reused across repeats cannot tell a leftover dump from a
    // descendant process — both are files with distinct PIDs — so it would
    // report three processes and 500ms, and look well-formed doing it.
    const row = onlyRow(
      await capture(probe, { env: { [DUMPS_ENV]: '2,1,1', [TOTAL_ENV]: '200,100,100' } }),
    );

    expect(row.processes).toBe(1);
    expect(row.totalMs).toBe(100);
  });

  it('CONTROL: two dumps written BY the reported repeat do merge', async () => {
    const probe = setupProbe(PREFIX);

    // The same seam, the same two files — written by the repeat that IS
    // reported. This is what proves the assertion above is about the directories
    // rather than about the seam: the fixture can produce `processes: 2` and a
    // doubled total, so seeing 1 and 100 there is evidence.
    const row = onlyRow(
      await capture(probe, { env: { [DUMPS_ENV]: '1,2,1', [TOTAL_ENV]: '10,100,900' } }),
    );

    expect(row.processes).toBe(2);
    expect(row.mainThreads).toBe(2);
    expect(row.totalMs).toBe(200);
  });

  it('reports one process running three threads as one lifetime', async () => {
    const probe = setupProbe(PREFIX);

    // The parse worker pool, end to end: one process, one main thread and two
    // workers, one file. The lifetime is the PROCESS's (1000ms in this seam), so
    // a row that charged it once per thread would publish 3000ms of wall clock
    // for a process that lived 1000 — an inflation of exactly the pool's width,
    // which reads as a regression of that factor.
    const row = onlyRow(
      await capture(probe, { runs: 1, env: { [DUMPS_ENV]: '3', [SAME_PID_ENV]: '1' } }),
    );

    expect(row.processes).toBe(1);
    expect(row.mainThreads).toBe(1);
    expect(row.workerThreads).toBe(2);
    expect(row.wallMs).toBe(1000);
    expect(row.cpuUserMs).toBe(800);
    // And everything each thread measured for ITSELF still sums — three threads
    // of four documents and 100ms are twelve documents and 300ms, not four
    // and 100.
    expect(row.documents).toBe(12);
    expect(row.cacheMisses).toBe(12);
    expect(row.totalMs).toBe(300);
  });

  it('instruments the measured run and not the cache clear', async () => {
    const probe = setupProbe(PREFIX);

    // Four children ran — a clear before each repeat — and only the two measured
    // ones were handed a dump directory. A clear that dumped into the repeat's
    // own directory would double `processes` and every millisecond in it.
    const row = onlyRow(await capture(probe, { runs: 2, cache: 'cold' }));

    expect(probe.entries()).toHaveLength(4);
    expect(row.processes).toBe(1);
  });
});

describe('captureParse — the three states that all look like zero', () => {
  it('says a warm run was cache hits rather than a fast parse', async () => {
    const probe = setupProbe(PREFIX);

    const row = onlyRow(
      await capture(probe, { cache: 'warm', env: { [DOCS_ENV]: '0', [HITS_ENV]: '1364' } }),
    );

    expect(row.attribution).toBe('all-cache-hits');
    expect(row.failed).toBe(false);
    expect(row.documents).toBe(0);
    expect(row.cacheHits).toBe(1364);
  });

  it('flags a run that never reached the parse path, distinctly from a warm one', async () => {
    const probe = setupProbe(PREFIX);

    const row = onlyRow(await capture(probe, { env: { [DOCS_ENV]: '0', [HITS_ENV]: '0' } }));

    // Identical numbers to the warm case in every field a reader would look at
    // first, and a different conclusion.
    expect(row.attribution).toBe('nothing-parsed');
    expect(row.documents).toBe(0);
  });

  it('fails the row when the vat build wrote no dump at all', async () => {
    const probe = setupProbe(PREFIX);

    // The A/B baseline case: an instrument with no seam in it. This must never
    // be a report of zero milliseconds — that reads as "this build spends no
    // time parsing", which is the finding the whole exercise is trying to make.
    const row = onlyRow(await capture(probe, { env: { NODE_OPTIONS: '' } }));

    expect(row.failed).toBe(true);
    expect(row.failure).toContain('REFUSED');
    expect(row.failure).toContain(PARSE_TIMING_DIR_ENV);
    expect(row.attribution).toBe(NOT_MEASURED);
    expect(row.totalMs).toBe(0);
  });

  it('CONTROL: the identical capture WITH the seam is a measurement', async () => {
    const probe = setupProbe(PREFIX);

    // Same probe, same commands, same everything but the preload — so the
    // failure above is about the missing seam and not about the fixture.
    expect(onlyRow(await capture(probe, { runs: 1 })).attribution).toBe('measured');
  });
});

describe('captureParse — a row that measured nothing says so', () => {
  it('poisons the whole row when a repeat failed', async () => {
    const probe = setupProbe(PREFIX);

    const row = onlyRow(await capture(probe, { runs: 2, commands: [FAILS] }));

    // Asserted as one shape: every measurement field has to be zeroed together,
    // and `attribution` has to say `not-measured` rather than leaving a reader
    // to infer emptiness from a total of zero.
    expect({
      failed: row.failed,
      runs: row.runs,
      attribution: row.attribution,
      kinds: row.kinds,
      samples: row.totalMsSamples,
      totalMs: row.totalMs,
    }).toEqual({
      failed: true,
      runs: 2,
      attribution: NOT_MEASURED,
      kinds: [],
      samples: [],
      totalMs: 0,
    });
    expect(row.failure).toContain(`exited ${String(PROBE_FAIL_EXIT)}`);
  });

  it('marks a row failed rather than reporting a command that parsed nothing', async () => {
    const probe = setupProbe(PREFIX);

    // Cold on purpose: a cache clear hoisted out of the repeat loop would still
    // spawn a child here, where nothing at all should run.
    const row = onlyRow(await capture(probe, { runs: 0, cache: 'cold' }));

    expect([row.runs, row.failed, row.failure]).toEqual([0, true, 'no repeats were requested']);
    expect(probe.entries()).toEqual([]);
  });
});

describe('captureParse — the envelope', () => {
  it('stamps the coordinate it measured and the clock the caller supplied', async () => {
    const probe = setupProbe(PREFIX);

    const report = await capture(probe, { runs: 1 });

    expectStamp(report, {
      facet: PARSE_FACET,
      subject: subjectAt(probe.cwd),
      capturedAt: CAPTURED_AT,
    });
  });

  it('produces a schema-valid body when one of two commands failed', async () => {
    const probe = setupProbe(PREFIX);

    const report = await capture(probe, { runs: 2, commands: [PASSES, FAILS] });

    expectBodyMatchesSchema(ParseBodySchema, report.body);
    expect(report.body.load.cpus).toBeGreaterThanOrEqual(1);
    // Rows are independent, and each one's attribution describes only itself: a
    // failing command must neither take its neighbour with it nor borrow its state.
    expect(report.body.commands.map((row) => [row.name, row.failed, row.attribution])).toEqual([
      ['audit', false, 'measured'],
      ['broken', true, NOT_MEASURED],
    ]);
  });
});
