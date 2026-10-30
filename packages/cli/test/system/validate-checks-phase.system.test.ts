/**
 * `vat validate` runs the project's checks as a phase: whenever `resources:` is configured, the
 * phases are `[resources, checks, skills]`, the checks phase is the supervised `vat resources
 * check` child rooted at the root `vat validate` resolved, and its phase report is the child's own.
 *
 * One case per exit-table row reachable today, through the real binary. The faults a parent and a
 * child would share (they share the environment and the filesystem) are injected into ONE of them
 * by a test-only preload under `test-helpers/`, loaded through `NODE_OPTIONS=--import "<file:
 * URL>"` (a `file:` URL, because `--import` takes a module specifier and a bare Windows path is not
 * one; quoted, because a path may hold spaces). Each preload discriminates on `--cost-log`, which
 * only a supervised child carries. VAT's source gains no knob.
 *
 * 🪤 The phase runs its child under the DEFAULT bound and `vat validate` accepts no flag to change
 * it, so a kill case would wait five minutes. `parent-only-fast-clock.mjs` scales the supervising
 * process's clock from the spawn on, so the default bound elapses in the real seconds
 * `measureBudget()` derives for this machine, exactly as a standalone kill case derives `--budget`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import yaml from 'yaml';

import { DEFAULT_BUDGET_SECONDS } from '../../src/commands/resources/check-supervisor.js';
import { useScratchTmpdir } from '../helpers/scratch-tmpdir.js';

import { cleanupTestTempDir, fs, getBinPath, safePath } from './test-common.js';
import { createMarkdownGitFixture, executeCli } from './test-helpers/index.js';
import { measureBudget } from './test-helpers/measure-check-budget.js';

// ⛔ Disposal paths: every `vat` process (and its checks child) inherits the scratch TMPDIR.
const scratch = useScratchTmpdir('vat-scratch-validate-checks-');

const binPath = getBinPath(import.meta.url);

/** The test-only preload of that name, as a quoted `--import` of its `file:` URL. */
function preload(name: string): string {
  const url = new URL('test-helpers/' + name, import.meta.url);
  return `--import "${url.href}"`;
}

/** A statement that never terminates: an aggregate over an unbounded recursive CTE. */
const RUNAWAY_SQL = 'WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM c) SELECT count(*) FROM c';
/** Selects the fixture's markdown files, so a check over it always has violations. */
const MD_ROWS = "SELECT path FROM resource_realizations WHERE ext = '.md'";
/** Selects nothing, so a check over it is a clean pass. */
const TXT_ROWS = "SELECT path FROM resource_realizations WHERE ext = '.txt'";
/** The warning a standalone `vat resources check` prints for a project with no checks of its own. */
const NO_OWN_CHECKS = 'No checks of this project\'s own are declared';
const RUN_INTEGRITY = 'RESOURCE_CHECK_BROKEN';

/** One declared check: its name, statement and (optional) severity. */
type CheckSpec = readonly [name: string, sql: string, severity?: 'error' | 'warning' | 'info'];

/** Write `resources:` with the given checks (none → a block with no `checks`). */
function writeConfig(dir: string, ...checks: readonly CheckSpec[]): void {
  const body = checks.length === 0
    ? 'resources: {}\n'
    : 'resources:\n  checks:\n' + checks.map(([name, sql, severity]) =>
      `    ${name}:\n      description: ${name}\n      sql: "${sql}"\n`
      + (severity === undefined ? '' : `      severity: ${severity}\n`)).join('');
  fs.writeFileSync(safePath.join(dir, 'vibe-agent-toolkit.config.yaml'), body, 'utf-8');
}

interface PhaseEntry {
  name: string;
  status: string;
  error?: { code: string; message: string };
  data: Record<string, unknown> | null;
}

interface Finding {
  code: string;
  message: string;
  severity: string;
}

interface Run {
  status: number | null;
  stderr: string;
  findings: Finding[];
  phases: PhaseEntry[];
  error: { code: string; message: string } | undefined;
  elapsedMs: number;
}

/** Run `vat <args>` in `cwd` with `extra` added to the environment of BOTH processes. */
function vat(cwd: string, args: readonly string[], extra: NodeJS.ProcessEnv = {}): Run {
  const startedAt = Date.now();
  const result = executeCli(binPath, [...args], { cwd, env: { ...process.env, ...extra } });
  const doc = (yaml.parse(result.stdout) ?? {}) as Record<string, unknown>;
  const data = (doc['data'] ?? {}) as Record<string, unknown>;
  return {
    status: result.status,
    stderr: result.stderr,
    findings: (doc['findings'] ?? []) as Finding[],
    phases: (data['phases'] ?? []) as PhaseEntry[],
    error: doc['error'] as Run['error'],
    elapsedMs: Date.now() - startedAt,
  };
}

/** The checks phase's entry, failing loudly when the run has none. */
function checksPhase(run: Run): PhaseEntry {
  const phase = run.phases.find((entry) => entry.name === 'checks');
  if (phase === undefined) throw new Error(`no checks phase in ${JSON.stringify(run.phases.map((p) => p.name))}\n${run.stderr}`);
  return phase;
}

/** How many times `needle` occurs in `haystack`. */
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

let projectDir: string;

/**
 * The environment that makes the phase's default bound elapse in this machine's measured budget:
 * `NODE_OPTIONS` loading the fast clock (plus `more`), and the scale that maps the default bound
 * onto the measured one. Measured beside each killed case, never once per file.
 */
function boundedPhase(...more: string[]): NodeJS.ProcessEnv {
  const { budgetSeconds } = measureBudget(() => {
    writeConfig(projectDir, ['quick', TXT_ROWS]);
    return vat(projectDir, ['resources', 'check', '--budget', '0']).elapsedMs;
  });
  return {
    NODE_OPTIONS: [preload('parent-only-fast-clock.mjs'), ...more].join(' '),
    TEST_PARENT_CLOCK_SCALE: String(DEFAULT_BUDGET_SECONDS / budgetSeconds),
  };
}

describe('vat validate — the checks phase', () => {
  beforeAll(() => {
    projectDir = createMarkdownGitFixture('vat-validate-checks-');
  });

  afterAll(() => {
    cleanupTestTempDir(projectDir);
  });

  it('runs resources, then checks, and an error row fails the run (exit 1)', () => {
    writeConfig(projectDir, ['md-present', MD_ROWS]);

    const run = vat(projectDir, ['validate']);

    expect(run.status).toBe(1);
    expect(run.phases.map((phase) => phase.name)).toEqual(['resources', 'checks']);
    expect(checksPhase(run).status).toBe('findings');
    expect(run.findings.filter((f) => f.code === 'CUSTOM:md-present').map((f) => f.severity)).toContain('error');
  });

  it('passes on warning-only check rows (exit 0)', () => {
    writeConfig(projectDir, ['md-present', MD_ROWS, 'warning']);

    const run = vat(projectDir, ['validate']);

    expect(run.status).toBe(0);
    expect(run.findings.some((f) => f.code === 'CUSTOM:md-present' && f.severity === 'warning')).toBe(true);
  });

  it('reports a refused statement as RESOURCE_CHECK_BROKEN (exit 1)', () => {
    writeConfig(projectDir, ['stale', 'SELECT no_such_column FROM no_such_table']);

    const run = vat(projectDir, ['validate']);

    expect(run.status).toBe(1);
    expect(run.findings.some((f) => f.code === RUN_INTEGRITY && f.message.includes('stale'))).toBe(true);
  });

  it('passes a clean tree under -v (exit 0), its phase report the child\'s own document', () => {
    writeConfig(projectDir, ['quick', TXT_ROWS]);

    const run = vat(projectDir, ['validate', '-v']);

    expect(run.status).toBe(0);
    // The child's document: its population and its per-rule costs.
    expect(checksPhase(run).data?.['population']).toBeDefined();
    expect((checksPhase(run).data?.['checks'] as Array<{ name: string }>).map((c) => c.name)).toContain('quick');
  });

  it('kills a check that never finishes: RESOURCE_CHECK_BROKEN naming it, a phase remedy, exit 1', () => {
    const env = boundedPhase();
    writeConfig(projectDir, ['runaway', RUNAWAY_SQL]);

    const run = vat(projectDir, ['validate'], env);

    expect(run.status).toBe(1);
    const broken = run.findings.find((f) => f.code === RUN_INTEGRITY && f.message.includes('runaway'));
    expect(broken?.message).toContain('`vat resources check --budget <seconds>`');
    expect(broken?.message).not.toMatch(/(?<!vat resources check )`--budget/);
  });

  it('a child killed during population is a phase error: RUN_INCOMPLETE, exit 2, the remedy in the phase', () => {
    const env = boundedPhase(preload('child-only-stall-in-population.mjs'));
    writeConfig(projectDir, ['quick', TXT_ROWS]);

    const run = vat(projectDir, ['validate'], env);

    expect(run.status).toBe(2);
    expect(run.error?.code).toBe('RUN_INCOMPLETE');
    const phase = checksPhase(run);
    expect(phase.status).toBe('error');
    expect(phase.error?.message).toContain('`vat resources check --budget <seconds>`');
    expect(phase.error?.message).not.toMatch(/(?<!vat resources check )`--budget/);
  });

  it('a child that publishes nothing before population is a phase error (exit 2)', () => {
    writeConfig(projectDir, ['quick', TXT_ROWS]);

    const run = vat(projectDir, ['validate'], { NODE_OPTIONS: preload('child-only-exit-at-start.mjs') });

    expect(run.status).toBe(2);
    expect(run.error?.code).toBe('RUN_INCOMPLETE');
    expect(checksPhase(run).status).toBe('error');
  });

  it('garbled stdout after population is RESOURCE_CHECK_BROKEN (exit 1)', () => {
    writeConfig(projectDir, ['quick', TXT_ROWS]);

    const run = vat(projectDir, ['validate'], { NODE_OPTIONS: preload('child-only-garbled-stdout.mjs') });

    expect(run.status).toBe(1);
    expect(checksPhase(run).status).toBe('findings');
    expect(run.findings.some((f) => f.code === RUN_INTEGRITY)).toBe(true);
  });

  it('prints "no checks of its own" only from a standalone vat resources check, never from the phase', () => {
    writeConfig(projectDir);

    expect(count(vat(projectDir, ['validate']).stderr, NO_OWN_CHECKS)).toBe(0);
    expect(count(vat(projectDir, ['resources', 'check']).stderr, NO_OWN_CHECKS)).toBe(1);
    expect(count(vat(projectDir, ['resources', 'check', '--budget', '0']).stderr, NO_OWN_CHECKS)).toBe(1);
  });

  it('completes on a fresh store while the parent holds it open and the child writes it', () => {
    writeConfig(projectDir, ['quick', TXT_ROWS]);
    const storeDir = safePath.join(scratch(), 'fresh-store');
    fs.mkdirSync(storeDir, { mode: 0o700 });

    const run = vat(projectDir, ['validate'], { VAT_PROJECTION_STORE_DIR: storeDir });

    expect(run.status, run.stderr).toBe(0);
    expect(checksPhase(run).status).toBe('ok');
    expect(checksPhase(run).data?.['population']).toBeDefined();
  });
});

describe('vat validate — a nested project', () => {
  let outer: string;

  beforeAll(() => {
    outer = createMarkdownGitFixture('vat-validate-checks-nested-');
    writeConfig(outer, ['outer-check', MD_ROWS, 'warning']);
    const inner = safePath.join(outer, 'inner');
    fs.mkdirSync(safePath.join(inner, 'docs'), { recursive: true });
    fs.writeFileSync(safePath.join(inner, 'docs', 'c.md'), '# Charlie\n', 'utf-8');
    writeConfig(inner, ['inner-check', MD_ROWS, 'warning']);
  });

  afterAll(() => {
    cleanupTestTempDir(outer);
  });

  it('checks the project it resolved, and only that one', () => {
    const run = vat(safePath.join(outer, 'inner'), ['validate']);

    expect(run.status, run.stderr).toBe(0);
    const ran = (checksPhase(run).data?.['checks'] as Array<{ name: string }>).map((c) => c.name);
    expect(ran).toContain('inner-check');
    expect(ran).not.toContain('outer-check');
    const anchored = run.findings.filter((f) => f.code === 'CUSTOM:inner-check');
    expect(anchored.length).toBeGreaterThan(0);
  });
});
