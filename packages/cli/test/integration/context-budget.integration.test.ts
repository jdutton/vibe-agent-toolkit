/**
 * `vat resources validate` reports the always-loaded context budget.
 *
 * What this suite exists to pin, over and above the unit tests next door:
 *
 *  - the check is **default-on and wired end to end** — a threshold in
 *    `resources.validation.thresholds` really reaches the sweep, and the finding
 *    really reaches the reported document;
 *  - it is `info`, so the run still **exits 0**. A number that fails a build is a
 *    number people learn to stop reading;
 *  - `severity.ALWAYS_LOADED_CONTEXT_BUDGET: ignore` silences it, and — the
 *    direction that gets forgotten — `error` promotes it all the way to exit 1;
 *  - ONE finding, however many working locations share the chain. The fixture has
 *    four directories under one root `CLAUDE.md` precisely so a per-location
 *    regression would show up here as four findings rather than one.
 *
 * Every case below is the same two moves — `setupBudgetFixture()` to build a
 * tree, `runBudgetValidate()` to measure it — so the tests read as intent and
 * the scaffolding exists exactly once.
 */

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createSuiteContext, executeCliAndParseYaml, writeTestFile } from '../system/test-common.js';

/** The code under test, spelled once. */
const CODE = 'ALWAYS_LOADED_CONTEXT_BUDGET';

/**
 * A budget low enough that an ordinary `CLAUDE.md` blows it.
 *
 * Configured rather than relying on the shipped 12,000, so the fixture stays a
 * few kilobytes instead of the ~48 KB the real default would need — and so the
 * test proves the CONFIG path reaches the sweep, which a default-sized fixture
 * could not distinguish.
 */
const LOW_THRESHOLD = 200;

/** Comfortably over {@link LOW_THRESHOLD}. */
const OVER_BUDGET_TOKENS = LOW_THRESHOLD * 5;

/** Comfortably under {@link LOW_THRESHOLD} — the ONLY thing that differs from the over-budget tree. */
const UNDER_BUDGET_TOKENS = 10;

/** Owns `binPath` and the per-test temp dirs; each `createTempDir()` is a fresh, independent tree. */
const ctx = createSuiteContext('vat-context-budget-', import.meta.url);

/**
 * A tree with a root `CLAUDE.md` and four working locations that inherit it.
 *
 * `estimateTokens` is `ceil(bytes / 4)`, so the root file is sized in bytes
 * against the threshold the caller passes.
 *
 * @param tempDir - The fixture root
 * @param rootTokens - Roughly how many tokens the root `CLAUDE.md` should cost
 */
function writeInstructedTree(tempDir: string, rootTokens: number): void {
  writeTestFile(
    safePath.join(tempDir, 'CLAUDE.md'),
    `# Project\n\n${'instruction text. '.repeat(Math.ceil((rootTokens * 4) / 18))}\n`,
  );
  // Three more working locations, none of them instructed, so all four share the
  // ROOT chain and the sweep must collapse them onto one representative.
  for (const dir of ['docs', 'docs/guides', 'src']) {
    mkdirSyncReal(safePath.join(tempDir, dir), { recursive: true });
    writeTestFile(safePath.join(tempDir, dir, 'note.md'), `# Note\n\nNothing links anywhere.\n`);
  }
}

/**
 * A config declaring the budget threshold, and optionally a severity override.
 *
 * @param tempDir - The fixture root
 * @param severity - The override for {@link CODE}, or undefined for the default
 */
function writeBudgetConfig(tempDir: string, severity?: string): void {
  const severityBlock = severity === undefined
    ? ''
    : `    severity:\n      ${CODE}: ${severity}\n`;
  writeTestFile(
    safePath.join(tempDir, 'vibe-agent-toolkit.config.yaml'),
    'version: 1\n'
    + 'resources:\n'
    + '  validation:\n'
    + '    thresholds:\n'
    + `      alwaysLoadedContextTokens: ${String(LOW_THRESHOLD)}\n`
    + severityBlock,
  );
}

interface BudgetFixtureOptions {
  /** Root `CLAUDE.md` size in tokens. Defaults to over budget. */
  rootTokens?: number;
  /** Severity override for {@link CODE}. Omit for the shipped default. */
  severity?: string;
}

/**
 * Build a self-contained fixture root: an instructed tree plus the config that
 * declares {@link LOW_THRESHOLD}. Returns the root, tracked for cleanup.
 *
 * @param options - Which of the two dials this case is turning
 */
function setupBudgetFixture(options: BudgetFixtureOptions = {}): string {
  const tempDir = ctx.createTempDir();
  writeInstructedTree(tempDir, options.rootTokens ?? OVER_BUDGET_TOKENS);
  writeBudgetConfig(tempDir, options.severity);
  return tempDir;
}

/** The reported view of one run: exit status, raw stdout, the document, and the by-code count. */
interface BudgetRun {
  status: number | null;
  stdout: string;
  parsed: Record<string, unknown>;
  budgetFindings: number;
}

/**
 * Run `vat resources validate` over a fixture and summarize what it reported.
 *
 * @param tempDir - The fixture root, passed as the path argument
 * @param extraArgs - Additional flags appended after the path (e.g. an opt-out)
 */
async function runBudgetValidate(
  tempDir: string,
  extraArgs: readonly string[] = [],
): Promise<BudgetRun> {
  const { result, parsed } = await executeCliAndParseYaml(ctx.binPath, [
    'resources', 'validate', tempDir, ...extraArgs,
  ]);
  const summary = (parsed['issueSummary'] ?? {}) as Record<string, number>;
  return {
    status: result.status,
    stdout: result.stdout,
    parsed,
    budgetFindings: summary[CODE] ?? 0,
  };
}

describe('vat resources validate always-loaded context budget (integration)', () => {
  beforeAll(ctx.setup);
  afterEach(ctx.cleanup);

  it('reports ONE info finding for an over-budget root and still exits 0', async () => {
    const { status, parsed, budgetFindings } = await runBudgetValidate(setupBudgetFixture());

    // One finding, not four: the fixture's four working locations share one chain.
    expect(budgetFindings).toBe(1);
    const counts = parsed['issueCounts'] as { errors: number; info: number };
    expect(counts.info).toBeGreaterThanOrEqual(1);
    expect(counts.errors).toBe(0);
    // `info` is not actionable, so the verdict is success and the run is green.
    expect(parsed['status']).toBe('success');
    expect(status).toBe(0);
  });

  it('names the threshold it was measured against in the finding', async () => {
    const { stdout } = await runBudgetValidate(setupBudgetFixture(), ['--verbose']);

    expect(stdout).toContain('4 working locations pay it');
    expect(stdout).toContain('200-token budget');
  });

  it('emits nothing when the tree is inside its budget', async () => {
    // A tiny root file against the same low threshold — the only thing that
    // differs from the over-budget fixture is the size, so a check that fired
    // unconditionally would be caught here.
    const fixture = setupBudgetFixture({ rootTokens: UNDER_BUDGET_TOKENS });

    const { status, budgetFindings } = await runBudgetValidate(fixture);

    expect(budgetFindings).toBe(0);
    expect(status).toBe(0);
  });

  it('emits nothing when the code is configured to ignore', async () => {
    const fixture = setupBudgetFixture({ severity: 'ignore' });

    const { status, budgetFindings } = await runBudgetValidate(fixture);

    expect(budgetFindings).toBe(0);
    expect(status).toBe(0);
  });

  it('exits 1 when an adopter PROMOTES the code to error', async () => {
    const fixture = setupBudgetFixture({ severity: 'error' });

    const { status, parsed, budgetFindings } = await runBudgetValidate(fixture);

    // The direction that gets forgotten: an allow-filter-only implementation
    // silences fine and enforces nothing, and would report `errors: 0`, exit 0.
    expect(budgetFindings).toBe(1);
    expect((parsed['issueCounts'] as { errors: number }).errors).toBe(1);
    expect(parsed['status']).toBe('error');
    expect(status).toBe(1);
  });

  it('emits nothing when --no-context-budget opts the run out', async () => {
    const fixture = setupBudgetFixture();

    // The positive control, on the SAME tree, run FIRST: a suppression test whose
    // subject never fired in the first place verifies nothing. Assert the finding
    // is really there before asserting the flag takes it away.
    const withCheck = await runBudgetValidate(fixture);
    expect(withCheck.budgetFindings).toBe(1);
    expect(withCheck.status).toBe(0);

    const optedOut = await runBudgetValidate(fixture, ['--no-context-budget']);

    // Commander must have reached `options.contextBudget === false`. If the flag
    // were merely ACCEPTED and read under a key Commander never emits (`noX`),
    // this count would still be 1 — which is the whole point of the assertion.
    expect(optedOut.budgetFindings).toBe(0);
    expect(optedOut.status).toBe(0);
  });
});
