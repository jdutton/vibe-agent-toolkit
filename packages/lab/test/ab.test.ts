/**
 * The interleaved A/B.
 *
 * Every test here runs against a fake facet rather than a real vat, because what
 * is under test is the *design of the run* — the ordering, the estimator, and
 * what the output is allowed to claim — and none of that is observable through a
 * real capture whose numbers move on their own. A fake facet is what lets the
 * ordering assertion be exact rather than statistical.
 *
 * Three properties are load-bearing, and each has a negative control:
 *
 * 1. **Arms alternate.** A block design charges machine drift to whichever arm
 *    ran during it, and vat's per-build parse-cache namespaces make each arm's
 *    first invocation cold. The assertion compares the whole capture order
 *    against both the interleaved and the blocked spelling, so it cannot pass
 *    for a run that did all of A and then all of B.
 * 2. **The estimator is `min`.** The samples are chosen so that min, p25 and
 *    median are three different numbers.
 * 3. **Pairs that disagree are reported as disagreeing.** Two pairs in a prior
 *    session contradicted each other, and averaging them would have manufactured
 *    a consensus no pair reported.
 */

import { mkdtemp, readdir } from 'node:fs/promises';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { beforeAll, describe, expect, it } from 'vitest';

import type { ReportEnvelope } from '../src/envelope/envelope.js';
import {
  abExitCondition,
  type AbResult,
  type AbSpec,
  type ComparisonLike,
  type FacetEstimate,
  type RefusalLike,
  renderAb,
  runAb,
} from '../src/harness/ab.js';
import { MEASURABLE_COMMANDS } from '../src/harness/commands.js';
import { buildReportEnvelope } from '../src/harness/report.js';
import type { CaptureRequest, ResolvedInstrument, ResolvedSubject } from '../src/harness/types.js';

let tempDir: string;

beforeAll(async () => {
  tempDir = await mkdtemp(safePath.join(normalizedTmpdir(), 'lab-ab-'));
});

/** The one command every fake capture reports on. */
const COMMAND = 'vat audit';

/** The fake facet's body: one value per command, and nothing else. */
interface FakeBody {
  readonly commands: readonly { readonly name: string; readonly failed: boolean; readonly value: number }[];
}

/** Never opened — the fake facet's capture spawns nothing. */
const SUBJECT_PATH = '/nowhere/subject';

const SUBJECT: ResolvedSubject = {
  path: SUBJECT_PATH,
  ref: { id: 'subject', source: SUBJECT_PATH },
  version: { kind: 'snapshot', fingerprint: 'f'.repeat(64), fileCount: 3 },
};

/**
 * A resolved instrument that is distinguishable from another by its commit.
 *
 * @param commit - A one-character seed for the commit
 * @returns The instrument
 */
function arm(commit: string): ResolvedInstrument {
  return {
    command: 'node',
    leadingArgs: ['/nowhere/bin.js'],
    version: { version: '0.2.0', commit: commit.repeat(40), dirty: false },
  };
}

const ARM_A = arm('a');
const ARM_B = arm('b');

/** What one scripted pair's comparison should return. */
type PairScript = string | { readonly refusal: string };

/** Everything a fixture varies about a run. */
interface FixtureOptions {
  readonly pairs: number;
  /** Value arm A's capture publishes, per pair. */
  readonly aValues: readonly number[];
  /** Value arm B's capture publishes, per pair. */
  readonly bValues: readonly number[];
  /** Verdict (or refusal) the comparison returns, per pair. */
  readonly script: readonly PairScript[];
  readonly control?: boolean;
  readonly noiseFloor?: number;
}

/** A run's outcome plus the capture order it produced. */
interface FixtureRun {
  readonly result: AbResult;
  /** One entry per capture, naming the arm — the ordering evidence. */
  readonly order: readonly string[];
}

/**
 * Build the comparison the script calls for.
 *
 * @param script - This pair's entry
 * @returns A refusal or a one-command comparison
 */
function comparisonFor(script: PairScript | undefined): RefusalLike | ComparisonLike {
  if (script === undefined) return { ok: false, refusal: 'script exhausted' };
  if (typeof script !== 'string') return { ok: false, refusal: script.refusal };
  return { ok: true, commands: [{ name: COMMAND, verdict: { kind: script } }] };
}

/**
 * Run an A/B against a fake facet, recording the order the arms were captured
 * in.
 *
 * @param options - See {@link FixtureOptions}
 * @param label - Subdirectory of the scratch dir to write reports into
 * @returns The result and the capture order
 */
async function runFixture(options: FixtureOptions, label: string): Promise<FixtureRun> {
  const order: string[] = [];
  let compared = 0;

  const capture = (request: CaptureRequest): Promise<ReportEnvelope<FakeBody>> => {
    const isA = request.instrument === ARM_A;
    // For a control run both arms are the same object, so the arm is decided by
    // how many captures have happened rather than by identity.
    const armIndex = options.control === true ? order.length % 2 : Number(!isA);
    const name = armIndex === 0 ? 'A' : 'B';
    const values = armIndex === 0 ? options.aValues : options.bValues;
    const value = values[Math.floor(order.length / 2)] ?? 0;
    order.push(name);
    return Promise.resolve(
      buildReportEnvelope('fake', 1, request, {
        commands: [{ name: COMMAND, failed: false, value }],
      }),
    );
  };

  const spec: AbSpec<FakeBody, ComparisonLike> = {
    subject: SUBJECT,
    armA: ARM_A,
    armB: options.control === true ? ARM_A : ARM_B,
    commands: [MEASURABLE_COMMANDS.audit],
    pairs: options.pairs,
    runs: 3,
    cache: 'warm',
    control: options.control === true,
    noiseFloor: options.noiseFloor ?? null,
    outDir: safePath.join(tempDir, label),
    now: () => new Date().toISOString(),
    capture,
    compare: () => comparisonFor(options.script[compared++]),
    estimate: (report): readonly FacetEstimate[] =>
      report.body.commands.map((row) => ({ name: row.name, value: row.value, unit: 'ms' })),
  };

  return { result: await runAb(spec), order };
}

/**
 * What a directory contains, in a deterministic order.
 *
 * @param directory - Directory to list
 * @returns Its entries, sorted
 */
async function sortedEntries(directory: string): Promise<readonly string[]> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path derived from this suite's own mkdtemp scratch dir
  const entries = await readdir(directory);
  return entries.sort((left, right) => left.localeCompare(right));
}

/**
 * The single command row every fixture produces.
 *
 * @param result - A completed A/B
 * @returns Its only command row
 */
function only(result: AbResult): AbResult['commands'][number] {
  const row = result.commands[0];
  if (row === undefined) throw new Error('fixture produced no command row');
  return row;
}

describe('runAb — the arms alternate', () => {
  it('captures A B A B …, never all of A and then all of B', async () => {
    const { order } = await runFixture(
      {
        pairs: 3,
        aValues: [10, 10, 10],
        bValues: [20, 20, 20],
        script: ['unchanged', 'unchanged', 'unchanged'],
      },
      'alternation',
    );

    expect(order).toEqual(['A', 'B', 'A', 'B', 'A', 'B']);
    // The control that makes the assertion above mean something: this is the
    // spelling a block design would have produced, and it is a permutation of
    // the same six captures, so a weaker assertion (a count, a set) could not
    // have told them apart.
    expect(order).not.toEqual(['A', 'A', 'A', 'B', 'B', 'B']);
  });

  it('stores every pair separately, so a later pair cannot overwrite an earlier one', async () => {
    // Two pairs of one arm share a coordinate and therefore a filename. Without
    // the per-pair directory a six-pair run would leave two reports on disk.
    const { result } = await runFixture(
      { pairs: 2, aValues: [10, 10], bValues: [10, 10], script: ['unchanged', 'unchanged'] },
      'storage',
    );

    expect(await sortedEntries(result.outDir)).toEqual(['pair-1', 'pair-2']);
    expect(await sortedEntries(safePath.join(result.outDir, 'pair-1'))).toEqual(['a', 'b']);
  });
});

describe('runAb — the estimator', () => {
  it('reports the min and the p25 of the per-pair values, never their median', async () => {
    // Arm A: 200, 100, 500 — min 100, p25 150, median 200. Three distinct
    // answers, so this fixture can tell the three estimators apart.
    const { result } = await runFixture(
      {
        pairs: 3,
        aValues: [200, 100, 500],
        bValues: [90, 90, 90],
        script: ['changed', 'changed', 'changed'],
      },
      'estimator',
    );

    const row = only(result);
    expect(row.a?.min).toBe(100);
    expect(row.a?.p25).toBe(150);
    expect(row.a?.min).not.toBe(200);
    // The effect is min-to-min: 90 - 100, not 90 - 200.
    expect(row.effect).toBe(-10);
  });

  it('keeps every per-pair value, so a reader can check the two statistics', async () => {
    const { result } = await runFixture(
      { pairs: 2, aValues: [30, 10], bValues: [10, 10], script: ['unchanged', 'unchanged'] },
      'samples',
    );

    expect(only(result).a?.samples).toEqual([30, 10]);
  });
});

describe('runAb — pairs that disagree', () => {
  it('records every pair’s verdict and marks the row unstable when they differ', async () => {
    const { result } = await runFixture(
      {
        pairs: 3,
        aValues: [10, 10, 10],
        bValues: [20, 20, 20],
        script: ['changed', 'unchanged', 'changed'],
      },
      'disagree',
    );

    const row = only(result);
    expect(row.verdicts).toEqual(['changed', 'unchanged', 'changed']);
    expect(row.stable).toBe(false);
    // Not a majority verdict, and not an average: an unstable row is not a
    // result at all, and the exit code says so.
    expect(abExitCondition(result)).toBe('unmeasurable');
    expect(renderAb(result)).toContain('PAIRS DISAGREE');
  });

  it('calls a row stable — and changed — only when every pair agreed', async () => {
    const { result } = await runFixture(
      {
        pairs: 3,
        aValues: [10, 10, 10],
        bValues: [20, 20, 20],
        script: ['changed', 'changed', 'changed'],
      },
      'agree',
    );

    expect(only(result).stable).toBe(true);
    expect(abExitCondition(result)).toBe('changed');
    expect(renderAb(result)).not.toContain('PAIRS DISAGREE');
  });

  it('never lets a refused pair read as agreement', async () => {
    const { result } = await runFixture(
      {
        pairs: 2,
        aValues: [10, 10],
        bValues: [10, 10],
        script: ['unchanged', { refusal: 'REFUSED: two axes moved' }],
      },
      'refused',
    );

    expect(result.refusals).toHaveLength(1);
    expect(only(result).verdicts).toContain('NO VERDICT (pair refused)');
    expect(only(result).stable).toBe(false);
    expect(abExitCondition(result)).toBe('refused');
  });
});

describe('runAb — the noise floor', () => {
  it('says the floor is UNMEASURED when no control has been run', async () => {
    const { result } = await runFixture(
      { pairs: 2, aValues: [100, 100], bValues: [80, 80], script: ['changed', 'changed'] },
      'no-floor',
    );

    expect(only(result).noise).toBe('unmeasured');
    // The whole point: a 20 ms effect with no measured floor cannot be called
    // real, and the output must not let a reader assume otherwise.
    expect(renderAb(result)).toContain('Noise floor: UNMEASURED');
  });

  it('reports an effect no larger than the floor as indistinguishable from noise', async () => {
    const { result } = await runFixture(
      {
        pairs: 2,
        aValues: [100, 100],
        bValues: [95, 95],
        script: ['unchanged', 'unchanged'],
        noiseFloor: 10,
      },
      'under-floor',
    );

    expect(only(result).noise).toBe('indistinguishable');
    expect(renderAb(result)).toContain('INDISTINGUISHABLE FROM NOISE');
  });

  it('reports an effect above the floor as exceeding it', async () => {
    // The control on the control: the same code path must be able to say the
    // opposite, or "indistinguishable" would be unfalsifiable.
    const { result } = await runFixture(
      {
        pairs: 2,
        aValues: [100, 100],
        bValues: [50, 50],
        script: ['changed', 'changed'],
        noiseFloor: 10,
      },
      'over-floor',
    );

    expect(only(result).noise).toBe('exceeds-floor');
  });

  it('names a control run as the noise floor rather than as a result', async () => {
    const { result } = await runFixture(
      {
        pairs: 2,
        aValues: [100, 100],
        bValues: [104, 96],
        script: ['unchanged', 'unchanged'],
        control: true,
      },
      'control',
    );

    expect(result.control).toBe(true);
    expect(only(result).noise).toBe('control');
    expect(renderAb(result)).toContain('THIS RUN IS THE CONTROL');
  });
});

describe('renderAb', () => {
  it('states the design, the estimator and both instruments', async () => {
    const { result } = await runFixture(
      { pairs: 2, aValues: [10, 10], bValues: [10, 10], script: ['unchanged', 'unchanged'] },
      'render',
    );

    const rendered = renderAb(result);
    expect(rendered).toContain('arms ALTERNATED (A B A B …)');
    expect(rendered).toContain('Estimator: MIN across pairs');
    expect(rendered).toContain('Instrument A: vat 0.2.0 (aaaaaaaa)');
    expect(rendered).toContain('Instrument B: vat 0.2.0 (bbbbbbbb)');
    expect(rendered).toContain(result.outDir);
  });
});
