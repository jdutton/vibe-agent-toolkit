/**
 * `vat resources check --budget` end to end: a statement that never finishes is
 * KILLED and REPORTED, instead of hanging the build.
 *
 * ## What only a real spawn can prove here
 *
 * The unit suite pins the reasoning — when the watchdog fires, what the log
 * reader tolerates, what the recovered document says. None of it can prove the
 * mechanism, because the mechanism is the one thing that is not a function: an
 * external `SIGKILL` reaching a real process that is genuinely wedged inside
 * synchronous native SQLite. Every in-process alternative was measured and does
 * NOT work — `worker.terminate()` never resolves against such a thread, the
 * parent's own `process.exit()` does not exit, SIGTERM is not delivered, and
 * installing a signal handler makes the process survive SIGINT that would
 * otherwise have killed it instantly. So this file is where the design is either
 * true or not.
 *
 * ## 🪤 The wall-time bound is DERIVED, never a literal
 *
 * A hardcoded "under 5 seconds" is a test that passes or fails on the machine
 * rather than on the code. The bound below is measured from a real run of the
 * same verb on the same fixture in the same process, so it scales with whatever
 * this box costs, and it is compared as a multiple rather than as a floor.
 *
 * It is also not the point. An UNBOUNDED runaway never returns at all, so the
 * decisive fact is that the process terminated; the bound only stops a
 * pathologically slow kill from passing as a prompt one.
 *
 * ## 🚨 TWO death modes, and both must be covered
 *
 * A runaway ends one of two ways and the supervisor takes a different branch for
 * each: the watchdog fires (`killed` true, exit code never consulted), or the
 * child DIES on its own — out of memory, aborted by Node or killed by the
 * runner (`killed` false, and `close` reports a signal instead of a code).
 *
 * This file originally covered only the first, and said so: it picked an
 * aggregate over the recursive CTE because "a cross join would eventually
 * exhaust memory and die on its own, which would let this test pass without the
 * watchdog doing anything". The avoided mode was where the defect lived — the
 * signal argument was unread, `?? 0` made every signal death exit 0, and the run
 * printed nothing. Steering a fixture around a mode is not the same as knowing
 * what the mode does, so both are exercised here now.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import yaml from 'yaml';

import { cleanupTestTempDir, fs, getBinPath, safePath } from './test-common.js';
import { createMarkdownGitFixture, executeCli } from './test-helpers/index.js';

const binPath = getBinPath(import.meta.url);

let projectDir: string;

/**
 * A statement that never terminates.
 *
 * `count(*)` over an unbounded recursive CTE: the row source is infinite and the
 * aggregate never has a final answer, so SQLite spins in native code with flat
 * memory — which is exactly the shape that defeats every in-process remedy. A
 * cross join would eventually exhaust memory and die on its own, which would let
 * this test pass without the watchdog doing anything.
 */
const RUNAWAY_SQL
  = 'WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM c) SELECT count(*) FROM c';

/**
 * A statement that never terminates and MATERIALISES rows while it runs.
 *
 * 🚨 The other death mode, and it must be covered BESIDE the aggregate above —
 * not instead of it. The two exercise different halves of the supervisor:
 *
 * - `count(*)` returns no rows, so memory stays flat and the run only ends when
 *   the WATCHDOG fires. That is the case where `killed` is true.
 * - This one returns a row per iteration, `.all()` materialises them, V8 hits
 *   its heap limit and Node ABORTS the process. `killed` is false, `close` fires
 *   with `code === null` and `signal === 'SIGABRT'`, and nothing outside the run
 *   was involved.
 *
 * The original file chose the aggregate deliberately — "a cross join would
 * eventually exhaust memory and die on its own, which would let this test pass
 * without the watchdog doing anything" — and so every case in it landed in the
 * one branch where the exit code is never consulted. The avoided mode was the
 * one that was broken: `close`'s signal argument was unread and `?? 0` turned
 * every signal death into `{ completed, code: 0 }`, so this input printed
 * nothing and exited 0. A CI gate reads that as a clean pass, on exactly the
 * shape the bound exists to catch.
 */
const MEMORY_DEATH_SQL
  = 'WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM c) SELECT i AS path FROM c';

/**
 * A heap cap for the spawned processes, so the abort above takes ~1 s.
 *
 * 🪤 It changes the TIME to the abort, never the mechanism — and it is what
 * stops this case depending on how much memory the machine happens to have.
 * Without it the same run aborts after minutes of paging on a large box.
 */
const CHILD_HEAP_CAP = { NODE_OPTIONS: '--max-old-space-size=192' };

/** A cheap statement that selects the fixture's markdown files. */
const MD_ROWS = "SELECT path FROM resource_realizations WHERE ext = '.md'";
/** A cheap statement that selects nothing, so a run over it is a clean pass. */
const TXT_ROWS = "SELECT path FROM resource_realizations WHERE ext = '.txt'";

/** The bound the killed cases use. Small, so the suite does not pay for it. */
const BUDGET_SECONDS = 2;

/** The hidden flag a supervising parent hands its child. */
const COST_LOG_FLAG = '--cost-log';

/**
 * How many times the measured baseline plus the budget the kill may take.
 *
 * Generous on purpose. The tight bound is not what this file is proving — an
 * unbounded runaway never returns — and a snug multiple would flake on a loaded
 * machine while catching nothing a loose one misses.
 */
const KILL_SLACK = 4;

/** Write the project's config with the given `resources.checks` entries. */
function writeChecks(...entries: readonly (readonly [string, string])[]): void {
  const checks = entries
    .map(([name, sql]) => `    ${name}:\n      description: ${name}\n      sql: "${sql}"\n`)
    .join('');
  fs.writeFileSync(
    safePath.join(projectDir, 'vibe-agent-toolkit.config.yaml'),
    `version: 1\nresources:\n  checks:\n${checks}`,
    'utf-8',
  );
}

/** What one spawn produced, and how long the whole thing took. */
interface BudgetRun {
  status: number | null;
  doc: Record<string, unknown>;
  elapsedMs: number;
}

/** Run the verb in the fixture and time it. */
function check(...args: string[]): BudgetRun {
  return checkWithEnv({}, ...args);
}

/**
 * The same run with extra environment for BOTH processes.
 *
 * `executeCli` replaces the environment when it is given one, so the ambient one
 * is spread in first — and the parent passes its own environment to the child it
 * spawns, which is how a heap cap reaches the process that actually runs the SQL.
 *
 * @param extra - Variables to add
 * @param args - The verb's arguments
 * @returns What the spawn produced
 */
function checkWithEnv(extra: NodeJS.ProcessEnv, ...args: string[]): BudgetRun {
  const startedAt = Date.now();
  const result = executeCli(binPath, ['resources', 'check', ...args], {
    cwd: projectDir,
    env: { ...process.env, ...extra },
  });
  return {
    status: result.status,
    doc: (yaml.parse(result.stdout) ?? {}) as Record<string, unknown>,
    elapsedMs: Date.now() - startedAt,
  };
}

/** One finding, as these cases read it back off the document. */
interface CheckFinding {
  code: string;
  message: string;
  severity: string;
}

/** One entry of the document's per-rule cost list. */
interface PublishedCheck {
  name: string;
  rows?: number;
}

describe('vat resources check --budget', () => {
  /** A real run of the same verb over the same tree, in-process and complete. */
  let baselineMs: number;

  beforeAll(() => {
    projectDir = createMarkdownGitFixture('vat-check-budget-');

    // 🪤 The threshold PROBE, not a literal. What a spawn, a population and one
    // cheap statement cost on THIS machine, measured by doing it.
    writeChecks(['quick', TXT_ROWS]);
    baselineMs = check('--budget', '0').elapsedMs;
  });

  afterAll(() => {
    cleanupTestTempDir(projectDir);
  });

  it('passes a clean run with the bound REMOVED, entirely in this process', () => {
    // `--budget 0` is the documented escape hatch, and it has to keep working:
    // an operator who turns the bound off must not also lose the verb.
    writeChecks(['quick', TXT_ROWS]);

    const { status, doc } = check('--budget', '0');

    expect(status).toBe(0);
    expect(doc['status']).toBe('success');
    expect(doc['checksRun']).toBe(1);
    expect(doc['membersEnumerated']).toBeGreaterThan(0);
  });

  it('KILLS a statement that never finishes, and fails the run naming it', () => {
    // 🔑 The whole point. Without the bound this case does not fail — it never
    // returns, and neither does the CI job it stands for.
    writeChecks(['runaway', RUNAWAY_SQL]);

    const { status, doc, elapsedMs } = check('--budget', String(BUDGET_SECONDS));

    // ⛔ Never 0, and never a document that reads as a pass.
    expect(status).toBe(1);
    expect(doc['status']).toBe('error');

    const [finding] = doc['issues'] as CheckFinding[];
    // The non-overridable run-integrity code, so the project whose SQL hung
    // cannot silence the news with a severity entry.
    expect(finding?.code).toBe('RESOURCE_CHECK_BROKEN');
    expect(finding?.severity).toBe('error');
    // Names the rule, which is the only fact that makes the report actionable.
    expect(finding?.message).toContain('runaway');
    expect(finding?.message).toContain(String(BUDGET_SECONDS));

    // The process ended — `executeCli` is synchronous and cannot return until it
    // does — and it ended promptly against a locally measured cost.
    expect(elapsedMs).toBeLessThan(baselineMs * 2 + BUDGET_SECONDS * 1000 * KILL_SLACK);
  });

  it('keeps the checks that COMPLETED, with the rows each selected', () => {
    // A killed run is still evidence. The cheap rule finished and was priced
    // before the runaway was entered, and that is exactly what the progress log
    // exists to preserve across a SIGKILL.
    writeChecks(['quick', MD_ROWS], ['runaway', RUNAWAY_SQL]);

    const { status, doc } = check('--budget', String(BUDGET_SECONDS));

    expect(status).toBe(1);
    const checks = doc['checks'] as PublishedCheck[];
    expect(checks.map((entry) => entry.name)).toStrictEqual(['quick']);
    // Two markdown files in the fixture, so a truthful count is above zero — a
    // `rows: 0` here would mean the list was reconstructed rather than recovered.
    expect(checks[0]?.rows).toBeGreaterThan(0);
    // And the population the child actually reported, never a fabricated one.
    expect(doc['membersEnumerated']).toBeGreaterThan(0);
  });

  it('FAILS a run whose child died of memory, and never reports it as a pass', () => {
    // 🚨 The regression this closes, end to end. The budget here is far larger
    // than the run takes, so the watchdog is provably NOT what ends it: the
    // child aborts on its own heap limit in about a second. Before the fix this
    // printed nothing at all and exited 0.
    writeChecks(['runaway', MEMORY_DEATH_SQL]);

    const { status, doc } = checkWithEnv(CHILD_HEAP_CAP, '--budget', '30');

    // ⛔ Never 0, and never an empty document.
    expect(status).toBe(1);
    expect(doc['status']).toBe('error');

    const [finding] = doc['issues'] as CheckFinding[];
    expect(finding?.code).toBe('RESOURCE_CHECK_BROKEN');
    // The signal, because SIGABRT and SIGKILL point at different remedies.
    expect(finding?.message).toContain('SIGABRT');
    // And the rule that was in flight, which is what makes it actionable.
    expect(finding?.message).toContain('runaway');
    // ⛔ NOT the watchdog's advice. Raising the bound does not help a run that
    // exhausted its heap, and telling this operator to do it wastes their time.
    expect(finding?.message).not.toMatch(/no progress/);
  }, 120_000);

  it('refuses a budget that is not a number, as an operator error', () => {
    writeChecks(['quick', TXT_ROWS]);

    const { status, doc } = check('--budget', 'soon');

    // 2, not 1: a mistyped flag is an operator error, not a content violation.
    expect(status).toBe(2);
    expect(doc['error']).toContain('--budget');
  });

  it('writes one progress line per unit when given --cost-log', () => {
    // The child lane, observed directly. A supervisor that cannot see the
    // child's progress cannot tell a slow run from a hung one, so this is the
    // signal the whole bound is built on.
    writeChecks(['quick', MD_ROWS]);
    const logPath = safePath.join(projectDir, 'progress.jsonl');

    const { status } = check(COST_LOG_FLAG, logPath);

    expect(status).toBe(1);
    const kinds = fs.readFileSync(logPath, 'utf-8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => (JSON.parse(line) as { kind: string }).kind);
    // 🔑 `checks-complete` is the LAST line and it is not decoration: after the
    // final cost the child still resolves severities and serialises the
    // document, and it used to emit nothing at all during that phase — so a
    // budget that expired there SIGKILLed a run which already had its answer.
    // This line gives serialisation a fresh window, for one `appendFileSync`.
    expect(kinds).toStrictEqual(['population', 'start', 'check', 'checks-complete']);
  });

  it('refuses --budget alongside --cost-log rather than silently ignoring the bound', () => {
    // 🚨 `--cost-log` wins the supervise-or-work fork unconditionally, so
    // `--budget 60 --cost-log x` ran with NO bound and said nothing about it. An
    // explicitly-passed, documented flag must never be silently inert.
    writeChecks(['quick', TXT_ROWS]);

    const { status, doc } = check(
      '--budget', '60', COST_LOG_FLAG, safePath.join(projectDir, 'ignored.jsonl'),
    );

    expect(status).toBe(2);
    expect(doc['error']).toContain(COST_LOG_FLAG);
  });
});
