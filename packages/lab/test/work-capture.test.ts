/**
 * Folding a command's repeats into one `work` row.
 *
 * No process is spawned and no directory is made: the fold takes the repeat
 * reader as an argument, so these cases hand it readings keyed by directory and
 * can watch which directories it read. The reader itself is the shared
 * `readDumpFiles`, covered where every facet's dumps are.
 *
 * The fixtures make the right and the wrong answer different numbers: the
 * warm-up repeat is given a count nothing else has (90), so a fold that compared
 * or reported it says 90 where the truth is 4.
 */

import { WORK_COUNTER_NAMES, type WorkCounter } from '@vibe-agent-toolkit/utils';
import { InvalidArgumentError } from 'commander';
import { describe, expect, it } from 'vitest';

import { createProgram } from '../src/bin/vat-lab.js';
import { captureWork, workRowFromRepeats } from '../src/facets/work/capture.js';
import { countOf, mergeWorkDumps, type WorkDumpsRead } from '../src/facets/work/dump.js';
import { WORK_FACET } from '../src/facets/work/types.js';
import { DEFAULT_MEASURED_COMMANDS } from '../src/harness/commands.js';
import { armRunFailure, type SpecMeasurement } from '../src/harness/repeat.js';
import type { SequenceResult } from '../src/harness/sequence.js';
import type { CacheMode, CaptureRequest } from '../src/harness/types.js';

const [SPEC] = DEFAULT_MEASURED_COMMANDS;
if (SPEC === undefined) throw new Error('no default measured command');

/** What a signalled repeat's violation says, as the sequence runner phrases it. */
const SIGNALLED = 'exited with no code: ';

/** One repeat's raw outcome. */
function repeat(violation: string | null = null): SequenceResult {
  return {
    exitCode: violation === null ? 0 : null,
    started: true,
    wallMs: 10,
    stdout: '',
    stderr: '',
    spawnError: null,
    steps: [],
    violation,
  } as unknown as SequenceResult;
}

/** A measurement of `runs` repeats, judged by the shared rule. */
function measurement(results: readonly SequenceResult[], cache: CacheMode = 'warm'): SpecMeasurement {
  return {
    spec: SPEC as NonNullable<typeof SPEC>,
    args: ['resources', 'scan', '.'],
    cache,
    results,
    priming: null,
    failure: armRunFailure({ priming: null, results }),
    removed: [],
    npmNetwork: [],
  };
}

/** A repeat's reading: one cli process with every counter zero except those given. */
function reading(over: Partial<Record<WorkCounter, number>> = {}): WorkDumpsRead {
  const counters = { ...Object.fromEntries(WORK_COUNTER_NAMES.map((name) => [name, 0])), ...over };
  return mergeWorkDumps([{ pid: 1, role: 'cli', counters }]);
}

/** A reader over fixed readings, recording which directories it was asked for. */
function reader(readings: Readonly<Record<string, WorkDumpsRead>>): {
  read: (directory: string) => Promise<WorkDumpsRead>;
  asked: string[];
} {
  const asked: string[] = [];
  return {
    asked,
    read: (directory) => {
      asked.push(directory);
      const found = readings[directory];
      if (found === undefined) throw new Error(`no fixture for ${directory}`);
      return Promise.resolve(found);
    },
  };
}

const DIRS = ['r0', 'r1', 'r2'] as const;

describe('workRowFromRepeats', () => {
  it('discards repeat 0, reports the last repeat, and calls agreeing repeats stable', async () => {
    const fake = reader({
      r0: reading({ 'git.calls': 90 }),
      r1: reading({ 'git.calls': 4 }),
      r2: reading({ 'git.calls': 4 }),
    });
    const row = await workRowFromRepeats(measurement([repeat(), repeat(), repeat()]), DIRS, fake.read);
    expect(fake.asked).toEqual(['r1', 'r2']);
    expect(row.failed).toBe(false);
    expect(row.runs).toBe(3);
    expect(row.comparedRuns).toBe(2);
    expect(row.stable).toBe(true);
    expect(row.varied).toEqual([]);
    expect(row.processes).toBe(1);
    expect(countOf(row, 'git.calls')).toBe(4);
  });

  it('calls repeats that disagree on an exact counter unstable, and names it', async () => {
    const fake = reader({ r0: reading(), r1: reading({ 'git.calls': 4 }), r2: reading({ 'git.calls': 5 }) });
    const row = await workRowFromRepeats(measurement([repeat(), repeat(), repeat()]), DIRS, fake.read);
    expect(row.stable).toBe(false);
    expect(row.varied).toEqual(['git.calls']);
    expect(countOf(row, 'git.calls')).toBe(5);
  });

  it('withholds stability when any compared repeat refused a parse under load', async () => {
    // A load refusal moves the counters downstream of the parse, so agreeing
    // repeats are no warrant: stable is null, and the repeats are counted.
    const fake = reader({
      r0: reading(),
      r1: reading(),
      r2: reading({ 'parse.refused.load': 1 }),
    });
    const row = await workRowFromRepeats(measurement([repeat(), repeat(), repeat()]), DIRS, fake.read);
    expect(row.stable).toBeNull();
    expect(row.loadRefusedRepeats).toBe(1);
    expect(row.varied).toEqual(['parse.refused.load']);
  });

  it('ignores a load refusal in the discarded warm-up', async () => {
    const fake = reader({ r0: reading({ 'parse.refused.load': 5 }), r1: reading(), r2: reading() });
    const row = await workRowFromRepeats(measurement([repeat(), repeat(), repeat()]), DIRS, fake.read);
    expect(row.stable).toBe(true);
    expect(row.loadRefusedRepeats).toBe(0);
  });

  it.each([
    ['cold', true],
    ['warm', false],
  ] as const)('in %s mode, a moving parse.dispatched leaves stable %s', async (cache, stable) => {
    const fake = reader({
      r0: reading(),
      r1: reading({ 'parse.dispatched': 10, 'parse.cache.hit': 2 }),
      r2: reading({ 'parse.dispatched': 11, 'parse.cache.hit': 1 }),
    });
    const row = await workRowFromRepeats(measurement([repeat(), repeat(), repeat()], cache), DIRS, fake.read);
    expect(row.stable).toBe(stable);
    expect(row.varied).toEqual(['parse.cache.hit', 'parse.dispatched']);
  });

  it('refuses a repeat that exited on a signal, without reading any dump', async () => {
    const fake = reader({});
    const row = await workRowFromRepeats(measurement([repeat(), repeat(SIGNALLED), repeat()]), DIRS, fake.read);
    expect(fake.asked).toEqual([]);
    expect(row.failed).toBe(true);
    expect(row.failure).toContain(SIGNALLED);
    expect(row.stable).toBeNull();
    expect(row.counters).toEqual([]);
  });

  it('refuses a repeat with no cli dump, with the reader’s refusal', async () => {
    const wrapperOnly = mergeWorkDumps([{ pid: 1, role: 'wrapper', counters: {} }]);
    const fake = reader({ r0: reading(), r1: reading(), r2: wrapperOnly });
    const row = await workRowFromRepeats(measurement([repeat(), repeat(), repeat()]), DIRS, fake.read);
    expect(row.failed).toBe(true);
    expect(row.failure).toMatch(/no 'cli' dump/);
    expect(row.counters).toEqual([]);
  });
});

describe('captureWork', () => {
  it('refuses fewer than three repeats before running anything', async () => {
    const request = { runs: 2, commands: [SPEC] } as unknown as CaptureRequest;
    await expect(captureWork(request)).rejects.toThrow(/at least 3 repeats/);
  });
});

describe('vat-lab work', () => {
  it.each(['run', 'ab'])('%s refuses --runs below three at the flag, and defaults to three', (verb) => {
    const option = createProgram()
      .commands.find((group) => group.name() === WORK_FACET)
      ?.commands.find((sub) => sub.name() === verb)
      ?.options.find((each) => each.long === '--runs');
    if (option?.parseArg === undefined) throw new Error(`work ${verb} declares no parsed --runs`);
    expect(option.defaultValue).toBe(3);
    expect(option.parseArg('3', undefined)).toBe(3);
    expect(() => option.parseArg?.('2', undefined)).toThrow(InvalidArgumentError);
  });
});
