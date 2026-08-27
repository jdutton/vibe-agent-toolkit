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

/** The banner an unstable row carries, asserted both ways across the suite. */
const DISAGREE = 'PAIRS DISAGREE';

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

/**
 * What one scripted pair's comparison should return.
 *
 * A bare string is the verdict kind. The object forms script a refusal, or a
 * verdict arriving with the caveat its facet attached — the channel `ab` reports
 * blind, without knowing what a `parse` caveat means versus an `io` one.
 */
type PairScript =
  | string
  | { readonly refusal: string }
  | { readonly kind: string; readonly caveat: string };

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
  /** Extra environment for arm A's children only. */
  readonly envA?: Readonly<Record<string, string>>;
  /** Extra environment for arm B's children only. */
  readonly envB?: Readonly<Record<string, string>>;
}

/** A run's outcome plus the capture order it produced. */
interface FixtureRun {
  readonly result: AbResult;
  /** One entry per capture, naming the arm — the ordering evidence. */
  readonly order: readonly string[];
  /** The `env` each capture was asked for, in capture order. */
  readonly envs: readonly (Readonly<Record<string, string>> | undefined)[];
}

/**
 * Build the comparison the script calls for.
 *
 * @param script - This pair's entry
 * @returns A refusal or a one-command comparison
 */
function comparisonFor(script: PairScript | undefined): RefusalLike | ComparisonLike {
  if (script === undefined) return { ok: false, refusal: 'script exhausted' };
  if (typeof script === 'string') {
    return { ok: true, commands: [{ name: COMMAND, verdict: { kind: script } }] };
  }
  if ('refusal' in script) return { ok: false, refusal: script.refusal };
  return {
    ok: true,
    commands: [{ name: COMMAND, verdict: { kind: script.kind }, caveat: script.caveat }],
  };
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
  const envs: (Readonly<Record<string, string>> | undefined)[] = [];
  let compared = 0;

  const capture = (request: CaptureRequest): Promise<ReportEnvelope<FakeBody>> => {
    envs.push(request.env);
    const isA = request.instrument === ARM_A;
    // For a control run both arms are the same object, so the arm is decided by
    // how many captures have happened rather than by identity.
    const armIndex = options.control === true ? order.length % 2 : Number(!isA);
    const name = armIndex === 0 ? 'A' : 'B';
    const values = armIndex === 0 ? options.aValues : options.bValues;
    const value = values[Math.floor(order.length / 2)] ?? 0;
    order.push(name);
    return Promise.resolve(
      buildReportEnvelope('fake', request, {
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
    ...(options.envA === undefined ? {} : { envA: options.envA }),
    ...(options.envB === undefined ? {} : { envB: options.envB }),
    now: () => new Date().toISOString(),
    capture,
    compare: () => comparisonFor(options.script[compared++]),
    estimate: (report): readonly FacetEstimate[] =>
      report.body.commands.map((row) => ({ name: row.name, value: row.value, unit: 'ms' })),
  };

  return { result: await runAb(spec), order, envs };
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

describe('runAb — an arm can carry its own configuration', () => {
  const POOL_ON = { VAT_PARSE_POOL: '1' };

  it('hands each arm its OWN env, so one build can be measured in two configurations', async () => {
    // The pool-on/pool-off A/B: one build, two settings. Without this the only
    // axis `ab` can vary is which build runs, and a config change has to be
    // measured by two un-interleaved captures — which gives up the alternation
    // this verb exists to provide.
    const { envs } = await runFixture(
      {
        pairs: 2,
        aValues: [10, 10],
        bValues: [20, 20],
        script: ['changed', 'changed'],
        envB: POOL_ON,
      },
      'env-per-arm',
    );

    // Capture order is A B A B, so B's env must land on captures 1 and 3 only.
    expect(envs).toEqual([undefined, POOL_ON, undefined, POOL_ON]);
  });

  it('does not leak one arm’s env into the other when BOTH are set', async () => {
    const { envs } = await runFixture(
      {
        pairs: 1,
        aValues: [10],
        bValues: [20],
        script: ['changed'],
        envA: { VAT_PARSE_POOL: '0' },
        envB: POOL_ON,
      },
      'env-both-arms',
    );

    expect(envs).toEqual([{ VAT_PARSE_POOL: '0' }, POOL_ON]);
  });

  it('publishes each arm’s env on the result, so the report can disclose it', async () => {
    // Load-bearing for honesty: with one build in both arms the two instrument
    // labels are identical, so an effect with no disclosed config difference is
    // a number a reader cannot attribute to anything.
    const { result } = await runFixture(
      {
        pairs: 1,
        aValues: [10],
        bValues: [20],
        script: ['changed'],
        envB: POOL_ON,
      },
      'env-published',
    );

    expect(result.envA).toBeUndefined();
    expect(result.envB).toEqual(POOL_ON);
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
    expect(renderAb(result)).toContain(DISAGREE);
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
    expect(renderAb(result)).not.toContain(DISAGREE);
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

  it('discloses a config difference, which is the only visible axis when one build runs twice', async () => {
    // Two identical instrument labels beside a large effect is an unattributable
    // number. The env is the axis, so the report has to name it.
    const { result } = await runFixture(
      {
        pairs: 1,
        aValues: [100],
        bValues: [60],
        script: ['changed'],
        envB: { VAT_PARSE_POOL: '1' },
      },
      'render-config',
    );

    const rendered = renderAb(result);
    expect(rendered).toContain('Config A: (none)');
    expect(rendered).toContain('Config B: VAT_PARSE_POOL=1');
  });

  it('says nothing about config when neither arm set any, rather than printing empty lines', async () => {
    const { result } = await runFixture(
      { pairs: 1, aValues: [10], bValues: [10], script: ['unchanged'] },
      'render-no-config',
    );

    expect(renderAb(result)).not.toContain('Config A:');
  });
});

describe('renderAb — the report may not assert more than it measured', () => {
  /** A caveat in the shape `parse` attaches when the two arms ran different thread widths. */
  const WIDTH_CAVEAT =
    'the two sides ran a different number of parse worker THREADS (0 vs 4) — every millisecond ' +
    'here is summed across them';

  it('prints the caveat its facet attached, which until now only `compare` ever showed', async () => {
    // The gap this closes: `parse`'s comparator carries `threadWidthCaveat` for
    // exactly the pool-on/pool-off pair, and `ab` rendered the same data with no
    // caveat at all — the older manual verb warning while the newer automated one
    // stayed silent.
    const { result } = await runFixture(
      {
        pairs: 2,
        aValues: [100, 100],
        bValues: [60, 60],
        script: [
          { kind: 'changed', caveat: WIDTH_CAVEAT },
          { kind: 'changed', caveat: WIDTH_CAVEAT },
        ],
      },
      'render-caveat',
    );

    expect(renderAb(result)).toContain(WIDTH_CAVEAT);
  });

  it('states a caveat once, not once per pair that repeated it', async () => {
    const { result } = await runFixture(
      {
        pairs: 3,
        aValues: [100, 100, 100],
        bValues: [60, 60, 60],
        script: [
          { kind: 'changed', caveat: WIDTH_CAVEAT },
          { kind: 'changed', caveat: WIDTH_CAVEAT },
          { kind: 'changed', caveat: WIDTH_CAVEAT },
        ],
      },
      'render-caveat-once',
    );

    const occurrences = renderAb(result).split(WIDTH_CAVEAT).length - 1;
    expect(occurrences).toBe(1);
  });

  it('prints no caveat line at all when the facet attached none', async () => {
    const { result } = await runFixture(
      { pairs: 2, aValues: [10, 10], bValues: [10, 10], script: ['unchanged', 'unchanged'] },
      'render-no-caveat',
    );

    expect(renderAb(result)).not.toContain('note:');
  });

  it('refuses to call an unstable row’s effect real, however the floor judges it', async () => {
    // The 2026-08-14 review finding: this line was blind to `command.stable`, so
    // a run whose pairs contradicted each other still printed a confident
    // "exceeds the supplied noise floor" as the LAST thing a reader saw —
    // directly under the banner saying the row is not a result.
    const { result } = await runFixture(
      {
        pairs: 3,
        aValues: [100, 100, 100],
        bValues: [10, 10, 10],
        script: ['changed', 'unchanged', 'changed'],
        noiseFloor: 5,
      },
      'render-unstable-effect',
    );

    const rendered = renderAb(result);
    expect(rendered).toContain(DISAGREE);
    expect(rendered).toContain('NOT A RESULT');
    // The magnitude survives — a reader still needs it — but the confident
    // judgement on top of it does not.
    expect(rendered).toContain('-90');
    expect(rendered).not.toContain('exceeds the supplied noise floor');
  });

  it('still calls a stable row’s effect real, so the guard is not simply always-on', async () => {
    const { result } = await runFixture(
      {
        pairs: 3,
        aValues: [100, 100, 100],
        bValues: [10, 10, 10],
        script: ['changed', 'changed', 'changed'],
        noiseFloor: 5,
      },
      'render-stable-effect',
    );

    const rendered = renderAb(result);
    expect(rendered).toContain('exceeds the supplied noise floor');
    expect(rendered).not.toContain('NOT A RESULT');
  });
});
