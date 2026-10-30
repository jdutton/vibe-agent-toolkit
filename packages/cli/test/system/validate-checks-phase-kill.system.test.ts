/**
 * The checks child, KILLED: by the watchdog while a check runs or during the population (the
 * kill rows of `vat validate`'s exit table). A supervisor ended from outside is
 * `checks-supervisor-orphan.system.test.ts`.
 *
 * 🪤 The phase runs its child under the DEFAULT bound and `vat validate` accepts no flag to change
 * it, so a watchdog kill case would wait five minutes. `parent-only-fast-clock.mjs` scales the
 * supervising process's clock from the spawn on, so the default bound elapses in the real seconds
 * `measureBudget()` derives for this machine, exactly as a standalone kill case derives `--budget`.
 *
 * 🚨 Every case asserts the run ended within {@link KILL_WITHIN_BUDGETS} measured budgets. A preload
 * that silently failed to load would leave the default bound in force, and the case would wait the
 * full default bound for the same kill. Only the scaled clock ends a run that soon: before it, the
 * run is two populations (the `resources` phase's and the child's), each a third of the measured
 * budget at most (`measure-check-budget.ts`); after it, one budget of scaled silence.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_BUDGET_SECONDS } from '../../src/commands/resources/check-supervisor.js';
import { useScratchTmpdir } from '../helpers/scratch-tmpdir.js';

import { cleanupTestTempDir } from './test-common.js';
import {
  checksPhase,
  preload,
  RUN_INTEGRITY,
  RUNAWAY_SQL,
  TXT_ROWS,
  vat,
  writeConfig,
} from './test-helpers/checks-phase.js';
import { createMarkdownGitFixture } from './test-helpers/index.js';
import { measureBudget } from './test-helpers/measure-check-budget.js';

// ⛔ Disposal paths: every `vat` process (and its checks child) inherits the scratch TMPDIR.
useScratchTmpdir('vat-scratch-validate-checks-kill-');

let projectDir: string;

/**
 * How many measured budgets a scaled kill may take, end to end: two populations of at most a third
 * of a budget each, one budget of silence, and the remainder as headroom for a loaded machine.
 */
const KILL_WITHIN_BUDGETS = 3;

/**
 * The environment that makes the phase's default bound elapse in this machine's measured budget:
 * `NODE_OPTIONS` loading the fast clock (plus `more`), and the scale that maps the default bound
 * onto the measured one — and the real time the kill must beat. Measured beside each killed case,
 * never once per file.
 */
function boundedPhase(...more: string[]): { env: NodeJS.ProcessEnv; withinMs: number } {
  const { budgetSeconds } = measureBudget(() => {
    writeConfig(projectDir, [['quick', TXT_ROWS]]);
    return vat(projectDir, ['resources', 'check', '--budget', '0']).elapsedMs;
  });
  return {
    env: {
      NODE_OPTIONS: [preload('parent-only-fast-clock.mjs'), ...more].join(' '),
      TEST_PARENT_CLOCK_SCALE: String(DEFAULT_BUDGET_SECONDS / budgetSeconds),
    },
    withinMs: KILL_WITHIN_BUDGETS * budgetSeconds * 1000,
  };
}

describe('vat validate — the checks phase, killed by its bound', () => {
  beforeAll(() => {
    projectDir = createMarkdownGitFixture('vat-validate-checks-kill-');
  });

  afterAll(() => {
    cleanupTestTempDir(projectDir);
  });

  it('kills a check that never finishes: RESOURCE_CHECK_BROKEN naming it, the statement remedy, exit 1', () => {
    const { env, withinMs } = boundedPhase();
    writeConfig(projectDir, [['runaway', RUNAWAY_SQL]]);

    const run = vat(projectDir, ['validate'], env);

    expect(run.elapsedMs).toBeLessThan(withinMs);
    expect(run.status).toBe(1);
    const broken = run.findings.find((f) => f.code === RUN_INTEGRITY && f.message.includes('runaway'));
    // The statement branch's own sentence — not the population's, startup's or reporting's.
    expect(broken?.message).toContain('A statement that will not finish');
    expect(broken?.message).toContain('`vat resources check --budget <seconds>`');
    expect(broken?.message).not.toMatch(/(?<!vat resources check )`--budget/);
  });

  it('a child killed during population is a phase error: RUN_INCOMPLETE, the population remedy, exit 2', () => {
    const { env, withinMs } = boundedPhase(preload('child-only-stall-in-population.mjs'));
    writeConfig(projectDir, [['quick', TXT_ROWS]]);

    const run = vat(projectDir, ['validate'], env);

    expect(run.elapsedMs).toBeLessThan(withinMs);
    expect(run.status).toBe(2);
    expect(run.error?.code).toBe('RUN_INCOMPLETE');
    const phase = checksPhase(run);
    expect(phase.status).toBe('error');
    expect(phase.error?.message).toContain('Population is legitimately slow');
    expect(phase.error?.message).toContain('`vat resources check --budget <seconds>`');
    expect(phase.error?.message).not.toMatch(/(?<!vat resources check )`--budget/);
  });
});

