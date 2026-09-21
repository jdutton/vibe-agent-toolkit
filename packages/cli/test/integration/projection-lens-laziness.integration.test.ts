/**
 * Lazy lens evaluation in the query lane, and the refusal that makes it safe.
 *
 * ## The pair, and why neither half stands alone
 *
 * **Cheap.** A statement that names no derived relation must not pay for one.
 * Every lens used to be evaluated on every run: on this repository `SELECT 1 AS
 * x` reported `lensSecs 0.16` for rows it could not read, and the claude-context
 * lens is far worse — it runs a population of its own.
 *
 * **Correct.** A statement that DOES name one must still get real rows. A lens
 * that silently stopped running would leave the relation present and empty,
 * which selects `0` at exit 0 — the *"a check that cannot fail"* drift class,
 * introduced by the optimisation itself.
 *
 * **Refused.** And the case between them: a statement naming a relation this run
 * did not evaluate is refused outright — the relation does not exist in the
 * run's database — rather than answered from an empty table. Without that third
 * assertion the first two describe a lane where the cheap path is simply blind.
 *
 * ⚠️ Integration tier: every case builds a real tree on disk and populates it.
 */

import { writeFileSync } from 'node:fs';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { setupSyncTempDirSuite } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createLogger } from '../../src/utils/logger.js';
import { withQueriedProjection } from '../../src/utils/projection-query.js';

const logger = createLogger({ debug: false });

/** A statement that names no relation at all — the cheap case. */
const NAMES_NOTHING = 'SELECT 1 AS x';

/** A statement over the authored-link lens's relation. */
const COUNT_EDGES = 'SELECT COUNT(*) AS n FROM edges';

/** A statement over the claude-context lens's relations. */
const COUNT_ALWAYS_LOADED =
  "SELECT COUNT(*) AS n FROM claude_context_loads WHERE launchCharge = 'charged'";

/**
 * A tree with an authored markdown link AND an always-loaded `CLAUDE.md`, so one
 * fixture reaches both lenses.
 *
 * @param root - The fixture root
 */
function writeTree(root: string): void {
  mkdirSyncReal(safePath.join(root, 'docs'), { recursive: true });
  writeFileSync(
    safePath.join(root, 'CLAUDE.md'),
    '# Rules\n\nInstructions the harness loads at launch for every directory here.\n',
    'utf8',
  );
  writeFileSync(
    safePath.join(root, 'docs', 'a.md'),
    '# A\n\nAn authored link to [B](./b.md), which is what gives the edge lens an edge.\n',
    'utf8',
  );
  writeFileSync(safePath.join(root, 'docs', 'b.md'), '# B\n\nThe link target.\n', 'utf8');
}

/** One run's observable lens outcome. */
interface LensOutcome {
  readonly lensesEvaluated: readonly string[];
  readonly lensMs: number;
  readonly rows: readonly Record<string, unknown>[];
}

/**
 * Run one statement, declaring exactly it, and report what the lenses did.
 *
 * @param root - The fixture root
 * @param sql - The statement to declare AND to run
 * @returns The lenses that were evaluated, what they cost, and the rows
 */
async function runDeclaring(root: string, sql: string): Promise<LensOutcome> {
  return withQueriedProjection({ root, logger, statements: [sql] }, (ask, provenance) => ({
    rows: ask(sql),
    lensesEvaluated: provenance.lensesEvaluated,
    lensMs: provenance.lensMs,
  }));
}

/**
 * The `n` a `COUNT(*) AS n` statement returned.
 *
 * @param outcome - The run
 * @returns The count
 */
function countOf(outcome: LensOutcome): number {
  return Number(outcome.rows[0]?.n);
}

describe('lens evaluation is driven by what the run declares', () => {
  const suite = setupSyncTempDirSuite('vat-lens-lazy');
  let root: string;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(() => {
    suite.beforeEach();
    root = suite.getTempDir();
    writeTree(root);
  });

  it('evaluates NOTHING for a statement that names no derived relation', async () => {
    const outcome = await runDeclaring(root, NAMES_NOTHING);

    expect(outcome.lensesEvaluated).toStrictEqual([]);
    // 🪤 NOT `toBe(0)`. The span brackets an empty loop, so `performance.now()`
    // still returns a few hundred NANOseconds of its own — pinning zero makes
    // the case flaky on the clock rather than sensitive to the behaviour. The
    // empty `lensesEvaluated` above is the real tell; this bounds the cost.
    expect(outcome.lensMs).toBeLessThan(1);
    // The positive control on the two assertions above — the run still
    // answered. `toEqual`, not `toStrictEqual`: the backend returns
    // null-prototype row objects.
    expect(outcome.rows).toHaveLength(1);
    expect(outcome.rows[0]?.x).toBe(1);
  });

  it('still fills `edges` with real rows when the statement names it', async () => {
    const outcome = await runDeclaring(root, COUNT_EDGES);

    expect(outcome.lensesEvaluated).toStrictEqual(['authored-link']);
    // 🚨 The assertion that a skipped lens cannot satisfy. `edges` exists in the
    // schema either way, so `>= 0` would pass over a lens that stopped running;
    // the fixture has an authored link, so the honest answer is positive.
    expect(countOf(outcome)).toBeGreaterThan(0);
    expect(outcome.lensMs).toBeGreaterThan(0);
  });

  it('populates the Claude-context lane only when a chain relation is named', async () => {
    const outcome = await runDeclaring(root, COUNT_ALWAYS_LOADED);

    expect(outcome.lensesEvaluated).toStrictEqual(['claude-context']);
    // The fixture's root `CLAUDE.md` is charged to every chain in the tree, so a
    // lens that ran and found nothing is distinguishable from one that ran.
    expect(countOf(outcome)).toBeGreaterThan(0);
  });

  it('evaluates both lenses for a run that declares statements naming both', async () => {
    const both = await withQueriedProjection(
      { root, logger, statements: [COUNT_EDGES, COUNT_ALWAYS_LOADED] },
      (ask, provenance) => ({
        edges: Number(ask(COUNT_EDGES)[0]?.n),
        loads: Number(ask(COUNT_ALWAYS_LOADED)[0]?.n),
        lensesEvaluated: provenance.lensesEvaluated,
      }),
    );

    expect(both.lensesEvaluated).toStrictEqual(['authored-link', 'claude-context']);
    expect(both.edges).toBeGreaterThan(0);
    expect(both.loads).toBeGreaterThan(0);
  });

  it('REFUSES a statement reaching for a relation this run did not evaluate', async () => {
    // 🚨 The guard that makes the laziness an optimisation rather than a silent
    // narrowing. Without it this run answers `n: 0` at exit 0, which is
    // indistinguishable from a tree with no links.
    //
    // ⚠️ The DECLARED statement names no relation, and the ASKED one does — so
    // the lens selector never saw `edges`. An earlier refusal re-ran that same
    // scanner over the asked statement, and so could never fire for a statement
    // the selector had seen, nor for a spelling it missed. This passes only
    // because the relation is ABSENT from the run's database and SQLite itself
    // refuses it.
    await expect(
      withQueriedProjection({ root, logger, statements: [NAMES_NOTHING] }, (ask) =>
        ask(COUNT_EDGES)),
    ).rejects.toThrow(/no such table: edges.*not evaluated for this run/s);
  });

  it('evaluates every lens for a caller that declares no statements at all', async () => {
    // ⛔ The fail-safe direction. `vat resources check` used to reach the lane
    // this way, and a caller that cannot enumerate its statements must get
    // correct rows rather than cheap ones.
    const outcome = await withQueriedProjection({ root, logger }, (ask, provenance) => ({
      rows: ask(COUNT_EDGES),
      lensesEvaluated: provenance.lensesEvaluated,
      lensMs: provenance.lensMs,
    }));

    expect(outcome.lensesEvaluated).toStrictEqual(['authored-link', 'claude-context']);
    expect(countOf(outcome)).toBeGreaterThan(0);
  });
});
