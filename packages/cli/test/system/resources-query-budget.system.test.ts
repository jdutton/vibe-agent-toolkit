/**
 * `vat resources query --budget` end to end: supervision is OPT-IN, and opting in buys the bound.
 *
 * Without `--budget`, `query` runs in the process the operator started, exactly as it always has:
 * one process, no supervision module loaded, the same stderr. With `--budget <seconds>` it runs
 * under `check`'s supervisor, and a statement that never returns — or a child that never boots —
 * is killed at the limit and refused as `RUN_INCOMPLETE`, exit 2.
 *
 * Only a real spawn can prove either half: the kill is an external SIGKILL reaching a process
 * wedged inside synchronous `node:sqlite`, and "no cost" is a fact about which processes ran and
 * which modules they loaded.
 *
 * ## 🪤 Red for the right reason
 *
 * Each kill case would also pass for a run killed by something else, so each pins the mechanism:
 * the kill's own sentence (and no death phrase), a lower bound on the elapsed time, and — for the
 * startup stall — a marker only a SPAWNED child writes. A build that accepts `--budget` and runs in
 * process anyway fails all three: the runaway never returns (the harness timeout ends it), the
 * stall's marker is never written, and the coverage control sees one process.
 */

import { spawnSync } from 'node:child_process';

import { gitExecutable, NODE_EXECUTABLE } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import yaml from 'yaml';

import { loadedScripts } from '../helpers/loaded-scripts.js';
import { useScratchTmpdir } from '../helpers/scratch-tmpdir.js';

import { cleanupTestTempDir, createTestTempDir, fs, safePath, writeFileTree } from './test-common.js';
import { BIN_PATH, preload, RUNAWAY_SQL } from './test-helpers/checks-phase.js';
import { measureBudget, type MeasuredBudget } from './test-helpers/measure-check-budget.js';

// ⛔ Disposal paths: every `vat` process (and its supervised child) inherits the scratch TMPDIR.
const scratch = useScratchTmpdir('vat-scratch-query-budget-');

/** A cheap statement over the population: the fixture's one markdown file. */
const MD_ROWS = "SELECT path FROM resource_realizations WHERE ext = '.md'";

/** A statement naming a column the projection lacks: refused before the population. */
const UNKNOWN_COLUMN = 'SELECT no_such_column FROM resource_realizations';

/** A bound no healthy run here comes near, for the cases that must complete under supervision. */
const ROOMY_BUDGET = '600';

/**
 * How many budgets past the measured baseline the kill may take. Generous on purpose: an unbounded
 * runaway never returns at all, so the bound only stops a pathologically slow kill passing.
 */
const KILL_SLACK = 4;

/** The sentence every query kill opens with — and no death says. */
const killSentence = (budgetSeconds: number, where: string): string =>
  `This run made no progress for ${String(budgetSeconds)}s and was killed ${where}, so there is no answer.`;

/** What one spawn produced. */
interface QueryRun {
  status: number | null;
  stderr: string;
  document: Record<string, unknown>;
  elapsedMs: number;
}

/**
 * Run `vat resources query <args>` in `cwd`, ended by SIGKILL after `timeoutMs` at the latest.
 *
 * @param cwd - Where to run it
 * @param args - The verb's arguments
 * @param options - Extra environment (an extra `NODE_OPTIONS` is APPENDED) and the hard timeout
 * @param options.env - Extra environment for both processes
 * @param options.timeoutMs - The harness's own bound, for a run that would otherwise never return
 * @returns What the spawn produced
 */
function query(cwd: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): QueryRun {
  const extra = options.env ?? {};
  const nodeOptions = [process.env['NODE_OPTIONS'], extra['NODE_OPTIONS']].filter((part) => part !== undefined && part !== '').join(' ');
  const startedAt = Date.now();
  const result = spawnSync(NODE_EXECUTABLE, [BIN_PATH, 'resources', 'query', ...args], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, ...extra, ...(nodeOptions === '' ? {} : { NODE_OPTIONS: nodeOptions }) },
    ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs, killSignal: 'SIGKILL' as const }),
  });
  return {
    status: result.status,
    stderr: result.stderr,
    document: (yaml.parse(result.stdout) ?? {}) as Record<string, unknown>,
    elapsedMs: Date.now() - startedAt,
  };
}

/** The refusal a document carries, or undefined. */
function errorOf(run: QueryRun): { code: string; message: string } | undefined {
  return run.document['error'] as { code: string; message: string } | undefined;
}

describe('vat resources query --budget', () => {
  let project: string;
  let noProject: string;
  let measured: MeasuredBudget;

  beforeAll(() => {
    project = createTestTempDir('vat-query-budget-');
    writeFileTree(project, { 'a.md': '# Alpha\n', 'vibe-agent-toolkit.config.yaml': 'resources: {}\n' });
    spawnSync(gitExecutable(), ['init', '--quiet'], { cwd: project });
    noProject = createTestTempDir('vat-query-budget-bare-');
    writeFileTree(noProject, { 'b.md': '# Bravo\n' });
    // One complete in-process run sizes the bound: spawn, population and one cheap statement.
    measured = measureBudget(() => query(project, [MD_ROWS, '--budget', '0']).elapsedMs);
  });

  afterAll(() => {
    cleanupTestTempDir(project);
    cleanupTestTempDir(noProject);
  });

  it('kills a runaway statement at the limit: RUN_INCOMPLETE, exit 2, the statement kill sentence', () => {
    const { budgetSeconds, baselineMs } = measured;
    const boundMs = baselineMs * 2 + budgetSeconds * 1000 * KILL_SLACK;

    const run = query(project, [RUNAWAY_SQL, '--budget', String(budgetSeconds)], { timeoutMs: boundMs + 5000 });

    expect(run.status, run.stderr).toBe(2);
    expect(errorOf(run)?.code).toBe('RUN_INCOMPLETE');
    expect(errorOf(run)?.message).toContain(killSentence(budgetSeconds, 'while the statement was running'));
    expect(errorOf(run)?.message).not.toContain('DIED');
    expect(run.elapsedMs).toBeGreaterThanOrEqual(budgetSeconds * 1000);
    expect(run.elapsedMs).toBeLessThan(boundMs);
  });

  it('kills a child that never finishes starting: RUN_INCOMPLETE, exit 2, the startup kill sentence', () => {
    const { budgetSeconds, baselineMs } = measured;
    const boundMs = baselineMs * 2 + budgetSeconds * 1000 * KILL_SLACK;
    const marker = safePath.join(scratch(), 'stalled-child.pid');

    const run = query(project, [MD_ROWS, '--budget', String(budgetSeconds)], {
      env: {
        NODE_OPTIONS: preload('child-only-stall-at-startup.mjs'),
        TEST_STARTUP_MARKER: marker,
        TEST_CHILD_MAX_STALL_MS: String(boundMs + 10_000),
      },
      timeoutMs: boundMs + 5000,
    });

    expect(fs.existsSync(marker), run.stderr).toBe(true);
    expect(run.status, run.stderr).toBe(2);
    expect(errorOf(run)?.code).toBe('RUN_INCOMPLETE');
    expect(errorOf(run)?.message).toContain(killSentence(budgetSeconds, 'before the child process had finished starting'));
    expect(run.elapsedMs).toBeGreaterThanOrEqual(budgetSeconds * 1000);
  });

  it('costs nothing without --budget: one process, and the supervision module never loads', () => {
    const plain = loadedScripts(BIN_PATH, ['resources', 'query', MD_ROWS], {}, project);

    // Positive control first: the run happened, and loaded the query verb.
    expect(plain.status, plain.stderr).toBe(0);
    expect(plain.urls.some((url) => url.includes('commands/resources/query.js'))).toBe(true);
    expect(plain.processes.map((entry) => entry.pid)).toEqual([plain.pid]);
    expect(plain.urls.filter((url) => url.includes('query-supervision.js'))).toEqual([]);

    const supervised = loadedScripts(BIN_PATH, ['resources', 'query', MD_ROWS, '--budget', ROOMY_BUDGET], {}, project);

    expect(supervised.status, supervised.stderr).toBe(0);
    expect(supervised.processes).toHaveLength(2);
    const parent = supervised.processes.find((entry) => entry.pid === supervised.pid);
    expect(parent?.urls.some((url) => url.includes('query-supervision.js'))).toBe(true);
  });

  // Each line has ONE owner: the refusal's message and the root warning are the parent's, every
  // notice the child's. A line said by both, or by neither, breaks the equality.
  it.each([
    ['a clean statement', () => project, MD_ROWS, false],
    ['a refused statement', () => project, UNKNOWN_COLUMN, true],
    ['a directory with no project ancestor', () => noProject, MD_ROWS, true],
  ])('says the same on stderr under --budget as in process: %s', (_case, cwd, sql, saysSomething) => {
    const inProcess = query(cwd(), [sql]);
    const supervised = query(cwd(), [sql, '--budget', ROOMY_BUDGET]);

    // Positive control: where the in-process run speaks, the comparison is not of two silences.
    if (saysSomething) expect(inProcess.stderr).not.toBe('');
    expect(supervised.status).toBe(inProcess.status);
    expect(supervised.stderr).toBe(inProcess.stderr);
  });
});
