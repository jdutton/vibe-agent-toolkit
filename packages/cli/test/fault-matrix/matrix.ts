/**
 * `planMatrixShard` — the one runner every fault-matrix file calls.
 *
 * For its case it runs the verb uninjected twice (the GOLDEN after-state, then the steady-state
 * fs trace the injections are chosen from), then hands back one test per injection: rebuild the fixture,
 * snapshot, install the one fault, run, restore, snapshot, and judge the invariants. Any
 * violation fails the test: nothing excuses an injection.
 *
 * Every run of a case reuses ONE root path, wiped in between: absolute paths the verb writes
 * (a `--dev` link's target, a registry's install path) are then the same in GOLDEN and in every
 * injected run, so nothing has to be rewritten to compare them.
 *
 * ⚠️ The golden run happens while the file is COLLECTED (the injection points come from its
 * trace, and a test can only be declared once they are known), so each matrix file awaits
 * `planMatrixShard` at top level and declares the tests it returns. Its cost is part of the
 * file's duration all the same.
 */

import { mkdirSyncReal } from '@vibe-agent-toolkit/utils';
import { diffSnapshots, installFaultFs, removeTempDir, tempDirTracker, type FaultFsSession, type FsCall } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, expect, it, vi } from 'vitest';

import { refusalOfRecord } from './composite.js';
import { makeCaseRoot, provenanceMismatch, rootsOf, runVerb, snapshotCase, type CaseRoot, type CaseSnapshots, type VerbCase } from './drive.js';
import type { VerbOutcome } from './invariants.js';
import { NO_REPORT, violations } from './invariants.js';
import { assertWithinShardLimit, normaliseCallPath, selectInjectionPoints, shardOf, type InjectionPoint } from './select.js';

interface PlannedCase {
  readonly c: VerbCase;
  /** The one root path every run of this case uses. */
  readonly base: string;
  readonly golden: CaseSnapshots;
  readonly goldenOutcome: VerbOutcome;
  /** How the discovery run's after-state differs from GOLDEN's: anything here is a verb that is not deterministic. */
  readonly drift: readonly string[];
  readonly points: readonly InjectionPoint[];
  readonly ids: readonly string[];
}

/** How much of an INTERNAL_ERROR run's stderr (its stack) a failing injection prints. */
const STACK_TAIL = 2000;

/** `VAT_FAULT_MATRIX=full` selects the whole product, for local runs; it adds cases and never skips one. */
const MODE: 'covering' | 'full' = process.env['VAT_FAULT_MATRIX'] === 'full' ? 'full' : 'covering';

/** Wipe the case's root and mint its trees again at the same path (`makeCaseRoot` stubs the env). */
function freshRoot(base: string): CaseRoot {
  removeTempDir(base);
  mkdirSyncReal(base, { recursive: true });
  return makeCaseRoot(base);
}

/**
 * Build the fixture and run the verb under `session` (made by `faults`, installed only around
 * the verb so the harness never sees the fixture or the snapshots). The spawned smoke runs its
 * in-process half through this too, so both halves are judged by one driver.
 */
export async function runOnce(c: VerbCase, base: string, install: (r: CaseRoot) => FaultFsSession): Promise<{ r: CaseRoot; before: CaseSnapshots; after: CaseSnapshots; outcome: VerbOutcome; session: FaultFsSession; firedAfterExit: readonly FsCall[] }> {
  const r = freshRoot(base);
  let before: CaseSnapshots;
  let session: FaultFsSession;
  try {
    c.fixture(r);
    before = snapshotCase(c, r);
    session = install(r);
  } catch (error) {
    // runVerb is what unstubs; a fixture or an install that threw never reached it.
    vi.unstubAllEnvs();
    throw error;
  }
  let outcome: VerbOutcome;
  // How many faults had fired when the verb first exited: any after that fired in code the real process never runs.
  let firedAtExit: number | undefined;
  try {
    outcome = await runVerb(c, r, () => {
      firedAtExit = session.fired.length;
    });
    // The run is over when its fs work is, not when the verb returns: Node's rm rejects on the first
    // child that fails and leaves the siblings running, which then ran under the NEXT run's session,
    // on its fixture at this same root (an injection there never fired).
    await session.settled();
  } finally {
    session.restore();
  }
  return { r, before, after: snapshotCase(c, r), outcome, session, firedAfterExit: session.fired.slice(firedAtExit ?? session.fired.length) };
}

/** The test id of one injection: the case, then what was failed, where, and with what. */
function injectionId(c: VerbCase, point: InjectionPoint, r: CaseRoot): string {
  const { rule, side, call } = point;
  return `${c.id}#${rule.family ?? '*'}:${rule.op ?? '*'}:${normaliseCallPath(call.path, rootsOf(c, r))}@${rule.nth ?? 1}:${rule.errno}:${side}`;
}

async function planCase(c: VerbCase, base: string, shard: readonly [number, number]): Promise<PlannedCase> {
  const trace = (r: CaseRoot): FaultFsSession => installFaultFs({ within: r.root, rewrites: c.statRewrites?.(r) ?? [] });
  const golden = await runOnce(c, base, trace);
  // A second uninjected run is the trace the injections are chosen from: the first one also pays for
  // every lazy load and in-process memo, whose fs calls the injected runs would never make again.
  const run = await runOnce(c, base, trace);
  const roots = rootsOf(c, run.r);
  const [slice, count] = shard;
  const all = selectInjectionPoints(run.session.calls, roots, MODE).map((point) => ({ point, id: injectionId(c, point, run.r) }));
  // The floor beside the per-file ceiling: a case whose trace selects NO injection is two green golden
  // tests per file and nothing else — a matrix case that injects nothing has stopped being one.
  if (all.length === 0 && goldenIsClean(golden.outcome)) throw new Error(`fault matrix: ${c.id} selected no injection point from ${run.session.calls.length} traced call(s)`);
  const allIds = all.map(({ id }) => id);
  const duplicate = allIds.find((id, index) => allIds.indexOf(id) !== index);
  if (duplicate !== undefined) throw new Error(`fault matrix: two injections of ${c.id} share the id ${duplicate}`);
  // Sliced by id, never by position: a trace in another order must not move a point into no file, or into two.
  const mine = all.filter(({ id }) => shardOf(id, count) === slice);
  const points = mine.map(({ point }) => point);
  const ids = mine.map(({ id }) => id);
  return { c, base, golden: golden.after, goldenOutcome: golden.outcome, drift: diffSnapshots(golden.after.watched, run.after.watched), points, ids };
}

async function injectAndJudge(plan: PlannedCase, index: number): Promise<void> {
  const point = plan.points[index];
  const id = plan.ids[index];
  if (point === undefined || id === undefined) throw new Error(`fault matrix: no injection ${index} for ${plan.c.id}`);
  const { r, before, after, outcome, session, firedAfterExit } = await runOnce(plan.c, plan.base, (root) => installFaultFs({ within: root.root, faults: [point.rule], rewrites: plan.c.statRewrites?.(root) ?? [] }));
  const record = refusalOfRecord(outcome, plan.c.composite === true);
  if ('problem' in record) throw new Error(`${id}: ${record.problem} (exit ${String(outcome.exitCode)} ${outcome.refusal ?? ''}: ${outcome.message ?? ''})`);
  const found = violations({
    before: before.watched,
    after: after.watched,
    golden: plan.golden.watched,
    sourcesBefore: before.sources,
    sourcesAfter: after.sources,
    tmpBefore: before.tmp,
    tmpAfter: after.tmp,
    units: plan.c.units(r),
    outcome,
    fired: session.fired,
    firedAfterExit,
    ...(plan.c.registered === undefined ? {} : { registered: plan.c.registered(r) }),
    injected: { side: point.side, errno: point.rule.errno },
    ...(record.via === 'top level' || record.refusal === undefined ? {} : { refusalOfRecord: record.refusal }),
    ...(plan.c.shapeFromSource === true ? { shapeFromSource: true } : {}),
    ...(plan.c.packagingFinding === true ? { packagingFinding: true } : {}),
    ...(plan.c.presencePreflight === undefined ? {} : { presencePreflight: plan.c.presencePreflight(r) }),
  });
  // A defect's stack is on stderr: it names the site that let the errno through.
  const stack = outcome.refusal === 'INTERNAL_ERROR' ? `\n${outcome.stderr.slice(-STACK_TAIL)}` : '';
  expect(found, `${id}\nexit ${String(outcome.exitCode)} ${outcome.refusal ?? ''}: ${outcome.message ?? ''}${stack}`).toEqual([]);
  // I8 judges a refusal by the value it was built from: a refusal the observer did not see would pass I8 unjudged.
  const unseen = outcome.refusal !== undefined && outcome.refusal !== NO_REPORT && outcome.thrown === undefined;
  expect(unseen, `${id}: refused ${outcome.refusal ?? ''} but refusal-observer.ts saw no thrown value, so I8 could not judge it`).toBe(false);
  // …and a value it saw must be the one the published message was built from, not a stale earlier one.
  expect(await provenanceMismatch(outcome, record), `${id}: the refusal observer's thrown value is not the refusal's`).toBeUndefined();
}

/** One test a shard file declares: its name, and what it runs. */
interface MatrixTest {
  readonly name: string;
  readonly run: () => void | Promise<void>;
}

/** The uninjected run ended cleanly: exit 0 and no refusal (a throw is INTERNAL_ERROR with no exit). */
const goldenIsClean = (outcome: VerbOutcome): boolean => (outcome.exitCode ?? 0) === 0 && outcome.refusal === undefined;

function testsOf(plan: PlannedCase): MatrixTest[] {
  const { goldenOutcome } = plan;
  const tests: MatrixTest[] = [
    {
      name: `${plan.c.id} GOLDEN: the uninjected run exits 0 (a red golden is a fixture bug)`,
      run: () => {
        // A verb that threw is exit-undefined with INTERNAL_ERROR: not a clean golden, whatever `?? 0` would say.
        expect({ exitCode: goldenOutcome.exitCode ?? 0, refusal: goldenOutcome.refusal }, `${goldenOutcome.message ?? ''}\n${goldenOutcome.stderr}`).toEqual({ exitCode: 0, refusal: undefined });
      },
    },
    {
      name: `${plan.c.id} GOLDEN is reproducible: a second uninjected run ends in the same tree`,
      run: () => {
        expect(plan.drift).toEqual([]);
      },
    },
  ];
  if (!goldenIsClean(goldenOutcome)) return tests;
  return [...tests, ...plan.ids.map((name, index) => ({ name, run: () => injectAndJudge(plan, index) }))];
}

/** One case's place in the shard table: how to build it, and how many files share its injections. */
export interface MatrixShard {
  readonly make: () => VerbCase;
  readonly files: number;
  /** `--dev` links: refused on win32, so every test of the case is a visible skip there. */
  readonly posixOnly?: boolean;
}

/** The test file name of shard `index` of the case `name`; the shard table's file-check reads it. */
export function shardFileName(name: string, index: number, files: number): string {
  return `fault-matrix-${name.replaceAll('/', '-')}-${index + 1}of${files}.integration.test.ts`;
}

/**
 * Plan shard file `index` of `shard.files`: run the case's golden and discovery runs, keep this
 * file's slice of the injections (those whose id hashes to it: `shardOf(id, files) === index`), and hand back its tests.
 * Await it at the top level of the file and declare each test it returns.
 *
 * A `posixOnly` case on win32 declares its own visible skip and returns no tests.
 */
export async function planMatrixShard(shard: MatrixShard, index: number): Promise<readonly MatrixTest[]> {
  const c = shard.make();
  const refusedHere = shard.posixOnly === true && process.platform === 'win32';
  if (refusedHere) {
    it.skipIf(refusedHere)(`${c.id}: --dev links are refused on win32 (NOT_IMPLEMENTED), so the case cannot run here`, () => {
      expect(refusedHere).toBe(false);
    });
    return [];
  }
  const scratch = tempDirTracker('vat-fault-matrix-');
  afterAll(() => scratch.cleanupAll());
  try {
    const plan = await planCase(c, scratch.create(), [index, shard.files]);
    if (MODE === 'covering') assertWithinShardLimit(plan.points.length, `${c.id} (file ${index + 1} of ${shard.files})`);
    return testsOf(plan);
  } catch (error) {
    // A file that fails while it is collected never runs its afterAll: the case root goes now.
    scratch.cleanupAll();
    throw error;
  }
}
