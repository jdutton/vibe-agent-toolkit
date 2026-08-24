/**
 * `vat claude budget [paths...]` — the always-loaded context budget CHECK.
 *
 * The capability used to ride inside `vat resources validate` as a default-on
 * check with a `--no-context-budget` opt-out. It does not any more, by ruling:
 * a validate run must not emit findings nobody asked for. So this suite pins
 * BOTH halves of that move, against ONE fixture, because the only way to know
 * the check moved rather than died is to see it fire on the same tree that
 * validate is now silent about:
 *
 *  - `vat claude budget` reports the finding, wired end to end — a threshold in
 *    `resources.validation.thresholds` really reaches the sweep, and the finding
 *    really reaches the document;
 *  - `severity.ALWAYS_LOADED_CONTEXT_BUDGET: ignore` silences it, and — the
 *    direction that gets forgotten — `error` promotes it all the way to exit 1;
 *  - ONE finding, however many working locations share the chain. The fixture
 *    has four directories under one root `CLAUDE.md` precisely so a
 *    per-location regression shows up here as four findings rather than one;
 *  - a `[paths...]` scope narrows WHICH chains are reported without falsifying
 *    how many locations pay one — the count in the message stays the whole
 *    tree's;
 *  - `vat resources validate` on that same tree emits NOTHING about the budget
 *    and no longer accepts `--no-context-budget` in either direction.
 */

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  createSuiteContext,
  executeCli,
  executeCliAndParseYaml,
  writeTestFile,
} from '../system/test-common.js';

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

/** A path the fixture never realizes, so no working location can match it. */
const UNREALIZED = 'no/such/dir';

/** Owns `binPath` and the per-test temp dirs; each `createTempDir()` is a fresh, independent tree. */
const ctx = createSuiteContext('vat-claude-budget-', import.meta.url);

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
 * @returns The fixture root
 */
function setupBudgetFixture(options: BudgetFixtureOptions = {}): string {
  const tempDir = ctx.createTempDir();
  writeInstructedTree(tempDir, options.rootTokens ?? OVER_BUDGET_TOKENS);
  writeBudgetConfig(tempDir, options.severity);
  return tempDir;
}

/** One finding, as the yaml document spells it. */
interface BudgetFinding {
  code: string;
  severity: string;
  location?: string;
  message: string;
}

/** The reported view of one run: exit status, stderr, the document, its findings. */
interface BudgetRun {
  status: number | null;
  stderr: string;
  parsed: Record<string, unknown>;
  findings: BudgetFinding[];
}

/**
 * Run `vat claude budget` inside a fixture and summarize what it reported.
 *
 * ⚠️ Run with `cwd` set to the fixture, never with the fixture as an argument:
 * the command discovers its own corpus root, and its arguments are working
 * locations INSIDE that root.
 *
 * @param tempDir - The fixture root, used as the working directory
 * @param extraArgs - Arguments after `claude budget`
 * @returns The run's reported view
 */
async function runBudget(
  tempDir: string,
  extraArgs: readonly string[] = [],
): Promise<BudgetRun> {
  const { result, parsed } = await executeCliAndParseYaml(
    ctx.binPath,
    ['claude', 'budget', ...extraArgs, '--format', 'yaml'],
    { cwd: tempDir },
  );
  return {
    status: result.status,
    stderr: result.stderr,
    parsed,
    findings: (parsed['findings'] ?? []) as BudgetFinding[],
  };
}

describe('vat claude budget (integration)', () => {
  beforeAll(ctx.setup);
  afterEach(ctx.cleanup);

  it('reports ONE info finding for an over-budget root and still exits 0', async () => {
    const { status, parsed, findings } = await runBudget(setupBudgetFixture());

    // One finding, not four: the fixture's four working locations share one chain.
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe(CODE);
    expect(findings[0]?.severity).toBe('info');
    // `info` is not actionable, so the verdict is success and the run is green.
    expect(parsed['status']).toBe('success');
    expect(status).toBe(0);
  });

  it('names the threshold it was measured against, and who pays it', async () => {
    const { findings, parsed } = await runBudget(setupBudgetFixture());

    expect(findings[0]?.message).toContain('4 working locations pay it');
    expect(findings[0]?.message).toContain('200-token budget');
    expect(parsed['threshold']).toBe(LOW_THRESHOLD);
    expect(parsed['workingLocations']).toBe(4);
    expect(parsed['distinctChains']).toBe(1);
  });

  it('emits nothing when the tree is inside its budget', async () => {
    // A tiny root file against the same low threshold — the only thing that
    // differs from the over-budget fixture is the size, so a check that fired
    // unconditionally would be caught here.
    const { status, findings } = await runBudget(
      setupBudgetFixture({ rootTokens: UNDER_BUDGET_TOKENS }),
    );

    expect(findings).toHaveLength(0);
    expect(status).toBe(0);
  });

  it('emits nothing when the code is configured to ignore', async () => {
    const { status, findings } = await runBudget(setupBudgetFixture({ severity: 'ignore' }));

    expect(findings).toHaveLength(0);
    expect(status).toBe(0);
  });

  it('exits 1 when an adopter PROMOTES the code to error', async () => {
    const { status, parsed, findings } = await runBudget(setupBudgetFixture({ severity: 'error' }));

    // The direction that gets forgotten: an allow-filter-only implementation
    // silences fine and enforces nothing, and would report exit 0.
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('error');
    expect(parsed['status']).toBe('error');
    expect(status).toBe(1);
  });

  it('scopes to named paths WITHOUT falsifying how many locations pay the chain', async () => {
    const fixture = setupBudgetFixture();

    const scoped = await runBudget(fixture, ['docs/guides']);

    // The chain that `docs/guides` inherits is reported...
    expect(scoped.findings).toHaveLength(1);
    // ...and the count is still the TREE's, not the scope's. Filtering the
    // payers instead of the chains would say "1 working location pays it",
    // which is a number nobody measured.
    expect(scoped.findings[0]?.message).toContain('4 working locations pay it');
    expect(scoped.status).toBe(0);
  });

  it('announces a scope that matched no working location instead of reporting clean', async () => {
    const fixture = setupBudgetFixture();

    // The positive control, on the SAME tree, run FIRST: an "emits nothing"
    // assertion whose subject never fired verifies nothing.
    const wholeTree = await runBudget(fixture);
    expect(wholeTree.findings).toHaveLength(1);

    const missed = await runBudget(fixture, [UNREALIZED]);

    // Zero findings here means "we looked nowhere", not "you are in budget" —
    // and a silent zero is the failure mode, so it is named in both channels.
    expect(missed.findings).toHaveLength(0);
    expect(missed.parsed['unmatchedScope']).toEqual([UNREALIZED]);
    expect(missed.stderr).toContain(UNREALIZED);
    expect(missed.status).toBe(0);
  });

  it('refuses a path outside the corpus root rather than reporting nothing for it', async () => {
    const fixture = setupBudgetFixture();

    const result = await executeCli(ctx.binPath, ['claude', 'budget', '../elsewhere'], {
      cwd: fixture,
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('outside the corpus root');
  });

  it('documents the two things a reader cannot get from the flag list', async () => {
    const result = await executeCli(ctx.binPath, ['claude', 'budget', '--help']);

    expect(result.status).toBe(0);
    // The config keys, because they are the only way to move or silence the
    // budget and there is deliberately no flag for either...
    expect(result.stdout).toContain('alwaysLoadedContextTokens');
    expect(result.stdout).toContain(`severity.${CODE}`);
    // ...and the split from its query sibling, which is what stops a reader
    // running the wrong one of the two and concluding the other is broken.
    expect(result.stdout).toContain('vat claude context');
    expect(result.stdout).toContain('Exit Codes:');
  });
});

describe('vat resources validate no longer knows about the context budget', () => {
  beforeAll(ctx.setup);
  afterEach(ctx.cleanup);

  it('says nothing about the budget on a tree that is demonstrably over it', async () => {
    const fixture = setupBudgetFixture();

    // The positive control FIRST: prove the tree really is over budget, from
    // the command that now owns the check. Without it, "validate is silent"
    // would also pass on a tree that was never over budget in the first place.
    const budget = await runBudget(fixture);
    expect(budget.findings).toHaveLength(1);

    const { result, parsed } = await executeCliAndParseYaml(
      ctx.binPath,
      ['resources', 'validate', fixture],
    );

    const summary = (parsed['issueSummary'] ?? {}) as Record<string, number>;
    expect(summary[CODE]).toBeUndefined();
    expect(result.stdout).not.toContain(CODE);
    expect(result.status).toBe(0);
  });

  it('rejects --no-context-budget as an unknown option', async () => {
    // Neither default-on nor opt-out nor opt-in: the flag is GONE, in both
    // directions. A silently-accepted-and-ignored flag is the failure this
    // asserts against.
    const result = await executeCli(ctx.binPath, [
      'resources', 'validate', setupBudgetFixture(), '--no-context-budget',
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('--no-context-budget');
  });

  it('does not mention the budget in its help text', async () => {
    const result = await executeCli(ctx.binPath, ['resources', 'validate', '--help']);

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain(CODE);
    expect(result.stdout).not.toContain('context-budget');
  });
});
