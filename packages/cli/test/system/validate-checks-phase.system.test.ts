/**
 * `vat validate` runs the project's checks as a phase: whenever `resources:` is configured, the
 * phases are `[resources, checks, skills]`, the checks phase is the supervised `vat resources
 * check` child rooted at the root `vat validate` resolved, and its phase report is the child's own.
 *
 * The exit-table rows a healthy child reaches, through the real binary, plus the store the two
 * processes share. A faulty or misrooted child is `validate-checks-phase-faults.system.test.ts`; the
 * kill rows are `validate-checks-phase-kill.system.test.ts`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PROJECTION_STORE_DIR_ENV } from '../../src/utils/projection-store.js';
import { storeFilesUnder } from '../helpers/projection-store-probe.js';
import { useScratchTmpdir } from '../helpers/scratch-tmpdir.js';

import { cleanupTestTempDir, fs, safePath } from './test-common.js';
import {
  checkNames,
  checkRows,
  checksPhase,
  count,
  MD_ROWS,
  RUN_INTEGRITY,
  TXT_ROWS,
  vat,
  writeConfig,
} from './test-helpers/checks-phase.js';
import { createMarkdownGitFixture } from './test-helpers/index.js';

// ⛔ Disposal paths: every `vat` process (and its checks child) inherits the scratch TMPDIR.
const scratch = useScratchTmpdir('vat-scratch-validate-checks-');

/** The warning a standalone `vat resources check` prints for a project with no checks of its own. */
const NO_OWN_CHECKS = 'No checks of this project\'s own are declared';
/** The store notice for a tree that cannot be keyed — absent from any run over a git fixture. */
const UNCACHED = 'Populating without a cache';

let projectDir: string;

describe('vat validate — the checks phase', () => {
  beforeAll(() => {
    projectDir = createMarkdownGitFixture('vat-validate-checks-');
  });

  afterAll(() => {
    cleanupTestTempDir(projectDir);
  });

  it('runs resources, then checks, and an error row fails the run (exit 1)', () => {
    writeConfig(projectDir, [['md-present', MD_ROWS]]);

    const run = vat(projectDir, ['validate']);

    expect(run.status).toBe(1);
    expect(run.phases.map((phase) => phase.name)).toEqual(['resources', 'checks']);
    expect(checksPhase(run).status).toBe('findings');
    expect(run.findings.filter((f) => f.code === 'CUSTOM:md-present').map((f) => f.severity)).toContain('error');
  });

  it.each(['warning', 'info'] as const)('passes on %s-only check rows (exit 0)', (severity) => {
    writeConfig(projectDir, [['md-present', MD_ROWS, severity]]);

    const run = vat(projectDir, ['validate']);

    expect(run.status, run.stderr).toBe(0);
    expect(checksPhase(run).status).toBe('findings');
    expect(run.findings.some((f) => f.code === 'CUSTOM:md-present' && f.severity === severity)).toBe(true);
  });

  it('reports a refused statement as RESOURCE_CHECK_BROKEN (exit 1)', () => {
    writeConfig(projectDir, [['stale', 'SELECT no_such_column FROM no_such_table']]);

    const run = vat(projectDir, ['validate']);

    expect(run.status).toBe(1);
    expect(run.findings.some((f) => f.code === RUN_INTEGRITY && f.message.includes('stale'))).toBe(true);
  });

  /**
   * The phase entry is a standalone `vat resources check` document of the same tree: compared,
   * field by field that does not measure time or cache state, with one run of that command.
   */
  it('passes under -v (exit 0), its phase entry the same verdict a standalone vat resources check gives', () => {
    writeConfig(projectDir, [['md-present', MD_ROWS, 'warning'], ['quick', TXT_ROWS]]);

    const run = vat(projectDir, ['validate', '-v']);
    const standalone = vat(projectDir, ['resources', 'check', '--format', 'json']);

    expect(run.status, run.stderr).toBe(0);
    expect(standalone.status, standalone.stderr).toBe(0);
    const phase = checksPhase(run);
    expect(phase.status).toBe(standalone.document['status']);
    expect(phase.examined).toBe(standalone.document['examined']);
    expect(phase.summary).toStrictEqual(standalone.document['summary']);
    expect(phase.data?.['checksRun']).toBe(standalone.data['checksRun']);
    expect(checkRows(phase.data)).toStrictEqual(checkRows(standalone.data));
    expect(checkNames(phase.data)).toContain('quick');
    // Every finding the standalone run reports is in the orchestrator's flat list.
    expect(standalone.findings.length).toBeGreaterThan(0);
    expect(run.findings).toEqual(expect.arrayContaining(standalone.findings));
  });

  it('prints "no checks of its own" only from a standalone vat resources check, never from the phase', () => {
    writeConfig(projectDir, []);

    const validated = vat(projectDir, ['validate']);
    // The phase ran — the built-in set — so a warning had a process to come from.
    expect(checksPhase(validated).status, validated.stderr).toBe('ok');
    expect(checksPhase(validated).data?.['checksRun']).toBeGreaterThan(0);
    expect(count(validated.stderr, NO_OWN_CHECKS)).toBe(0);
    expect(count(vat(projectDir, ['resources', 'check']).stderr, NO_OWN_CHECKS)).toBe(1);
    expect(count(vat(projectDir, ['resources', 'check', '--budget', '0']).stderr, NO_OWN_CHECKS)).toBe(1);
  });

  /**
   * A SMOKE test of the two processes sharing one store: the parent opens it for its population
   * scope and the child opens and writes it on a miss. It observes what the child reports — the
   * first run's checks phase derived and left a store behind, and the second run's was served from
   * it (acceptance bar 4's checks half, on a fixture) — but not that the parent's handle was open
   * at the instant the child wrote, so it does not pin a contention it never arranged.
   */
  it('smoke: the checks phase derives into a fresh store under vat validate, and the next run is served from it', () => {
    writeConfig(projectDir, [['quick', TXT_ROWS]]);
    const storeDir = safePath.join(scratch(), 'fresh-store');
    fs.mkdirSync(storeDir, { mode: 0o700 });
    const env = { [PROJECTION_STORE_DIR_ENV]: storeDir };

    const cold = vat(projectDir, ['validate'], env);

    expect(cold.status, cold.stderr).toBe(0);
    expect(checksPhase(cold).status).toBe('ok');
    expect(checksPhase(cold).data?.['population']).toBe('derived');
    expect(storeFilesUnder(storeDir).length).toBeGreaterThan(0);
    expect(cold.stderr).not.toContain(UNCACHED);

    const warm = vat(projectDir, ['validate'], env);

    expect(warm.status, warm.stderr).toBe(0);
    expect(checksPhase(warm).data?.['population']).toBe('store');
  });
});
