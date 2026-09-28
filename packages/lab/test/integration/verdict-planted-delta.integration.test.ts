/**
 * The verdict facet's compare must be able to FAIL.
 *
 * Every later wave-A document change is measured with this instrument, so a
 * compare that passes whatever it is given would bless every one of them. These
 * cases plant a delta through two probe "instruments" — distinct literal
 * closures, each arm printing a chosen document and exiting a chosen code — and
 * pin that the compare notices it: undeclared → failure, declared but absent →
 * failure, declared exactly → pass, and an UNMEASURED row (both arms exit 2, or
 * both print something unparseable) is never read as "no change".
 *
 * Integration-tier because capture spawns the probe for every verb.
 */

import { writeFileSync } from 'node:fs';

import { ExitCode } from '@vibe-agent-toolkit/schema';
import { safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, describe, expect, it } from 'vitest';

import { captureVerdict } from '../../src/facets/verdict/capture.js';
import { compareVerdict, type VerdictComparisonResult } from '../../src/facets/verdict/compare.js';
import type { VerdictDeltas } from '../../src/facets/verdict/deltas.js';
import type { FindingKey } from '../../src/facets/verdict/extract.js';
import type { ArmEnvironment } from '../../src/harness/arm-env.js';
import type { ResolvedInstrument } from '../../src/harness/types.js';
import {
  PROBE_EXIT_CODE_ENV,
  PROBE_FAIL_AT_ENV,
  PROBE_NO_LOG_ENV,
  PROBE_STDOUT_ENV,
  PROBE_VERSION,
  setupProbe,
} from '../command-probe.js';
import { verdictDeltaEntryFactory } from '../verdict-deltas-fixtures.js';

import { cleanupVerdictFixtures, FIXTURE_ALIAS, fixtureSubject, tempDir } from './verdict-fixtures.js';

const ALIAS = FIXTURE_ALIAS;
const VERB = 'audit';
const CHANGELOG_FILE = '.changes/verdict-fixture.md';
const CHANGELOG_REF = `${CHANGELOG_FILE}#planted-delta`;
const CHANGELOG = new Map([[CHANGELOG_FILE, '# Fixture\n\n## Planted delta\n']]);
const REASON = 'the planted fixture delta under test';

const KEPT: FindingKey = { code: 'LINK_BROKEN', severity: 'error', location: 'docs/a.md', scope: null };
const ADDED: FindingKey = { code: 'LINK_BROKEN', severity: 'error', location: 'docs/b.md', scope: null };

afterAll(cleanupVerdictFixtures);

/**
 * @param findings - The findings the report carries
 * @returns A `Report<T>` document as a vat verb would print it
 */
function reportOf(findings: readonly FindingKey[]): string {
  return JSON.stringify(
    {
      status: findings.length > 0 ? 'error' : 'success',
      examined: 3,
      findings: findings.map(({ code, severity, location }) => ({ code, severity, location, message: 'm' })),
      summary: { error: findings.length, warning: 0, info: 0 },
      data: {},
    },
    null,
    2,
  );
}

/** One fixture arm: what it prints, what it exits with, which closure it is. */
interface ArmSpec {
  readonly closure: 'a' | 'b';
  readonly stdout: string;
  readonly exit?: number;
}

/** A fixture arm, ready to capture. */
interface Arm {
  readonly instrument: ResolvedInstrument;
  readonly env: ArmEnvironment;
}

/**
 * @param spec - What the arm prints and exits with
 * @returns A probe instrument with a literal closure, and the env that makes it behave so
 */
function arm(spec: ArmSpec): Arm {
  const probe = setupProbe('lab-verdict-arm-');
  return {
    instrument: { ...probe.instrument, version: { ...PROBE_VERSION, closure: spec.closure.repeat(64) } },
    env: {
      set: {
        [PROBE_NO_LOG_ENV]: '1',
        [PROBE_STDOUT_ENV]: JSON.stringify([spec.stdout]),
        ...(spec.exit === undefined ? {} : { [PROBE_FAIL_AT_ENV]: '0', [PROBE_EXIT_CODE_ENV]: String(spec.exit) }),
      },
      unset: [],
    },
  };
}

/**
 * Capture one arm over the subject.
 *
 * @param subjectPath - The subject root
 * @param fixture - The arm
 * @returns Its envelopes
 */
async function capture(subjectPath: string, fixture: Arm): Promise<Awaited<ReturnType<typeof captureVerdict>>> {
  return captureVerdict({
    instrument: fixture.instrument,
    subjects: [{ alias: ALIAS, path: subjectPath, verbs: [VERB], sqlFiles: [], buildVerbs: false }],
    subjectsDir: subjectPath,
    env: fixture.env,
    outDir: tempDir('lab-verdict-out-'),
    capturedAt: new Date().toISOString(),
  });
}

/** How a comparison of two captured arms is run. */
interface CompareSpec {
  readonly entries?: VerdictDeltas['deltas'];
  readonly control?: boolean;
  /** Runs between the two captures, against the subject root. */
  readonly between?: (subjectPath: string) => void;
}

/**
 * Capture two fixture arms over one subject and compare them.
 *
 * @param a - The baseline arm
 * @param b - The candidate arm
 * @param spec - Declared deltas, `--control`, and anything to do between the captures
 * @returns The comparison
 */
async function compareArms(a: Arm, b: Arm, spec: CompareSpec = {}): Promise<VerdictComparisonResult> {
  const subjectPath = fixtureSubject();
  const baseline = await capture(subjectPath, a);
  spec.between?.(subjectPath);
  const candidate = await capture(subjectPath, b);
  if (!baseline.ok || !candidate.ok) throw new Error('capture refused');
  return compareVerdict(baseline.envelopes, candidate.envelopes, {
    control: spec.control ?? false,
    deltas: { baseline: PROBE_VERSION.version, deltas: spec.entries ?? [] },
    changelog: CHANGELOG,
  });
}

/**
 * Plant a delta: two arms built from specs, captured and compared.
 *
 * @param a - The baseline arm's behaviour
 * @param b - The candidate arm's behaviour
 * @param entries - The declared deltas
 * @returns The comparison
 */
async function plant(a: ArmSpec, b: ArmSpec, entries: VerdictDeltas['deltas'] = []): Promise<VerdictComparisonResult> {
  return compareArms(arm(a), arm(b), { entries });
}

const entry = verdictDeltaEntryFactory({ subject: ALIAS, verb: VERB, changelog: CHANGELOG_REF, reason: REASON });

/**
 * @param result - A comparison that must not have been refused
 * @returns It, narrowed
 */
function accepted(result: VerdictComparisonResult): Extract<VerdictComparisonResult, { ok: true }> {
  if (!result.ok) throw new Error(`unexpected refusal: ${result.refusal}`);
  return result;
}

describe('verdict compare — the planted delta', () => {
  it('fails on a planted exit-code and finding delta that is not declared', async () => {
    const result = accepted(
      await plant({ closure: 'a', stdout: reportOf([KEPT]) }, { closure: 'b', stdout: reportOf([KEPT, ADDED]), exit: 1 }),
    );

    expect(result.undeclared.map((delta) => delta.change)).toEqual(
      expect.arrayContaining([
        { kind: 'exit', from: 0, to: 1 },
        { kind: 'finding-added', finding: ADDED },
      ]),
    );
    expect(result.exitCode).toBe(ExitCode.FINDINGS);
  });

  it('fails on a declared delta that did not occur', async () => {
    const same = reportOf([KEPT]);
    const result = accepted(
      await plant({ closure: 'a', stdout: same }, { closure: 'b', stdout: same }, [entry({ findingsAdded: [ADDED] })]),
    );

    expect(result.undeclared).toEqual([]);
    expect(result.unused.map((delta) => delta.change)).toEqual([{ kind: 'finding-added', finding: ADDED }]);
    expect(result.exitCode).toBe(ExitCode.FINDINGS);
  });

  it('passes when the planted delta is declared exactly', async () => {
    const result = accepted(
      await plant(
        { closure: 'a', stdout: reportOf([KEPT]) },
        { closure: 'b', stdout: reportOf([KEPT, ADDED]), exit: 1 },
        [entry({ exit: { from: 0, to: 1 }, findingsAdded: [ADDED], document: 'reshaped' })],
      ),
    );

    expect(result.undeclared).toEqual([]);
    expect(result.unused).toEqual([]);
    expect(result.refusals).toEqual([]);
    expect(result.exitCode).toBe(ExitCode.OK);
  });

  it('fails when both arms exit 2 on a verb and no delta declares it unmeasured', async () => {
    const same = reportOf([KEPT]);
    const result = accepted(
      await plant({ closure: 'a', stdout: same, exit: 2 }, { closure: 'b', stdout: same, exit: 2 }),
    );

    expect(result.undeclared.map((delta) => delta.change)).toEqual([{ kind: 'unmeasured' }]);
    expect(result.exitCode).toBe(ExitCode.FINDINGS);
  });

  it('fails when both arms print unparseable stdout', async () => {
    const garbage = 'plain text, not a document';
    const result = accepted(await plant({ closure: 'a', stdout: garbage }, { closure: 'b', stdout: garbage }));

    expect(result.undeclared.map((delta) => delta.change)).toEqual([{ kind: 'unmeasured' }]);
    expect(result.exitCode).toBe(ExitCode.FINDINGS);
  });
});

/**
 * Written only after every case above was seen red, then green: these are the
 * control and refusal cases, which a compare that reported nothing would ALSO
 * satisfy — so on their own they prove nothing about failability.
 */
describe('verdict compare — control and refusals', () => {
  const report = reportOf([KEPT]);

  it('reports zero deltas for the same arm run twice under --control', async () => {
    const only = arm({ closure: 'a', stdout: report });
    const result = accepted(await compareArms(only, only, { control: true }));

    // Positive control: the row WAS compared — an empty observed list over zero
    // rows would pass this case for the wrong reason.
    expect(result.rows.map((row) => row.verb)).toEqual([VERB]);
    expect(result.rows.flatMap((row) => row.observed)).toEqual([]);
    expect(result.exitCode).toBe(ExitCode.OK);
  });

  it('refuses to compare indistinguishable arms without --control', async () => {
    const only = arm({ closure: 'a', stdout: report });
    const result = await compareArms(only, only);

    expect(result).toMatchObject({ ok: false, refusal: expect.stringContaining('indistinguishable') });
  });

  it('refuses a compare where the subject version moved', async () => {
    const result = await compareArms(arm({ closure: 'a', stdout: report }), arm({ closure: 'b', stdout: report }), {
      between: (subjectPath) => {
        writeFileSync(safePath.join(subjectPath, 'NEW.md'), '# moved\n', 'utf-8');
      },
    });

    expect(result).toMatchObject({ ok: false, refusal: expect.stringContaining('subjectVersion') });
    expect(result).toMatchObject({ refusal: expect.stringContaining('re-capture the baseline immediately before the candidate') });
  });

  it('refuses movedAxes = [] without --control', async () => {
    const base = arm({ closure: 'a', stdout: report });
    const sameBuildOtherEnv: Arm = {
      instrument: base.instrument,
      env: { set: { ...base.env.set, LAB_VERDICT_UNRELATED: '1' }, unset: [] },
    };
    const result = await compareArms(base, sameBuildOtherEnv);

    expect(result).toMatchObject({ ok: false, refusal: expect.stringContaining('no axis moved') });
  });
});
