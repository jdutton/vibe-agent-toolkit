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

import { spawn, spawnSync } from 'node:child_process';

import { gitExecutable, NODE_EXECUTABLE } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import yaml from 'yaml';

import { loadedScripts } from '../helpers/loaded-scripts.js';
import { useScratchTmpdir } from '../helpers/scratch-tmpdir.js';

import { cleanupTestTempDir, createTestTempDir, fs, safePath, writeFileTree } from './test-common.js';
import { BIN_PATH, preload, RUNAWAY_SQL } from './test-helpers/checks-phase.js';
import { alive } from './test-helpers/live-vat.js';
import { measureBudget, type MeasuredBudget } from './test-helpers/measure-check-budget.js';

// ⛔ Disposal paths: every `vat` process (and its supervised child) inherits the scratch TMPDIR.
const scratch = useScratchTmpdir('vat-scratch-query-budget-');

/** A cheap statement over the population: the fixture's one markdown file. */
const MD_ROWS = "SELECT path FROM resource_realizations WHERE ext = '.md'";

/** A statement naming a column the projection lacks: refused before the population. */
const UNKNOWN_COLUMN = 'SELECT no_such_column FROM resource_realizations';

/** A result far past one pipe buffer (64 KiB): 200,000 rows, written after a reader has gone. */
const BIG_RESULT = 'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 200000) SELECT i FROM n';

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

/**
 * Run `vat resources query <args>` with its stdout read by a reader that closes after the first
 * chunk, as `| head -1` does.
 *
 * @param cwd - Where to run it
 * @param args - The verb's arguments
 * @returns The exit code and everything said on stderr
 */
function queryIntoClosingReader(cwd: string, args: readonly string[]): Promise<{ status: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE_EXECUTABLE, [BIN_PATH, 'resources', 'query', ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.stdout.once('data', () => {
      child.stdout.destroy();
    });
    child.once('error', reject);
    child.once('close', (status) => {
      resolve({ status, stderr });
    });
  });
}

/** The supervisor's progress directories left in the scratch TMPDIR. */
function progressDirsLeft(): string[] {
  return fs.readdirSync(scratch()).filter((entry) => entry.startsWith('vat-query-'));
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

  // ⛔ A red runaway case must not leave its child spinning in SQLite: kill the pid the preload
  // recorded while its file is still there. A case that saw the supervisor's kill take effect
  // deletes the file first, so a green case never signals a pid the OS may have reused.
  let sqlPidFile: string | undefined;
  afterEach(() => {
    const recorded = sqlPidFile !== undefined && fs.existsSync(sqlPidFile) ? Number(fs.readFileSync(sqlPidFile, 'utf-8')) : Number.NaN;
    if (Number.isInteger(recorded) && alive(recorded)) process.kill(recorded, 'SIGKILL');
    sqlPidFile = undefined;
  });

  it('kills a runaway statement at the limit: RUN_INCOMPLETE, exit 2, the statement kill sentence', () => {
    const { budgetSeconds, baselineMs } = measured;
    const boundMs = baselineMs * 2 + budgetSeconds * 1000 * KILL_SLACK;

    sqlPidFile = safePath.join(scratch(), 'sql.pid');

    const run = query(project, [RUNAWAY_SQL, '--budget', String(budgetSeconds)], {
      env: { NODE_OPTIONS: preload('sql-process-pid-at-runaway.mjs'), TEST_SQL_PID_FILE: sqlPidFile },
      timeoutMs: boundMs + 5000,
    });

    // Positive control: the statement did start in a child, so the kill had something to end.
    expect(fs.existsSync(sqlPidFile), run.stderr).toBe(true);
    expect(run.status, run.stderr).toBe(2);
    expect(errorOf(run)?.code).toBe('RUN_INCOMPLETE');
    expect(errorOf(run)?.message).toContain(killSentence(budgetSeconds, 'while the statement was running'));
    // The supervisor killed the child that ran the statement: nothing is left for afterEach.
    fs.rmSync(sqlPidFile);
    expect(errorOf(run)?.message).not.toContain('DIED');
    expect(run.elapsedMs).toBeGreaterThanOrEqual(budgetSeconds * 1000);
    expect(run.elapsedMs).toBeLessThan(boundMs);
    expect(progressDirsLeft()).toStrictEqual([]);
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
    expect(progressDirsLeft()).toStrictEqual([]);
  });

  it('costs nothing without --budget: one process, and no CLI module `check --budget 0` does not load', () => {
    // The CLI's own modules only: which parser modules a run loads depends on the parse cache.
    const cliModules = (urls: readonly string[]): Set<string> =>
      new Set(urls.filter((url) => url.includes('/packages/cli/dist/')).map((url) => url.replace(/^.*\/packages\/cli\/dist\//, '')));
    const plain = loadedScripts(BIN_PATH, ['resources', 'query', MD_ROWS], {}, project);
    const baseline = cliModules(loadedScripts(BIN_PATH, ['resources', 'check', '--budget', '0'], {}, project).urls);

    // Positive control first: the run happened, and loaded the query verb.
    expect(plain.status, plain.stderr).toBe(0);
    expect(plain.urls.some((url) => url.includes('commands/resources/query.js'))).toBe(true);
    expect(plain.processes.map((entry) => entry.pid)).toEqual([plain.pid]);
    // 🔑 A module a plain query newly imports, statically or not, is one an unsupervised run of
    // the sibling verb does not load — caught here, not by a name a regression would not share.
    expect([...cliModules(plain.urls)].filter((module) => !baseline.has(module))).toStrictEqual([]);
    // ⚠️ The baseline loads `query.js` too (`vat resources` registers every verb), so a STATIC
    // import added to it would join both sets; the one module this verb must never load unasked
    // is named.
    expect(plain.urls.filter((url) => url.includes('query-supervision.js'))).toStrictEqual([]);

    const supervised = loadedScripts(BIN_PATH, ['resources', 'query', MD_ROWS, '--budget', ROOMY_BUDGET], {}, project);

    expect(supervised.status, supervised.stderr).toBe(0);
    expect(supervised.processes).toHaveLength(2);
    const parent = supervised.processes.find((entry) => entry.pid === supervised.pid);
    // The instrument CAN fail: the supervising parent loads a module the baseline does not.
    expect([...cliModules(parent?.urls ?? [])].filter((module) => !baseline.has(module))).toContain('commands/resources/query-supervision.js');
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

  // Windows: unverified there, and a write to a pipe whose reader has closed can surface as an end
  // of file rather than EPIPE, so this pins the POSIX `| head` behaviour only.
  it.skipIf(process.platform === 'win32')('ends as the in-process run does when its reader closes after one line: same exit, silent stderr', async () => {
    const inProcess = await queryIntoClosingReader(project, [BIG_RESULT]);
    const supervised = await queryIntoClosingReader(project, [BIG_RESULT, '--budget', ROOMY_BUDGET]);

    // Positive control: the in-process run ends on its document's code and says nothing.
    expect(inProcess).toStrictEqual({ status: 0, stderr: '' });
    expect(supervised).toStrictEqual(inProcess);
  });
});
