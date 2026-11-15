/**
 * `vat audit` must never publish a clean report over a run that audited no file.
 *
 * ## The defect
 *
 * An existing directory holding nothing auditable — moved plugins, a wrong
 * subdirectory, an excluded tree, or a tree of files no lane recognises — used
 * to publish a clean status beside zero files scanned, and stderr said "Audit
 * successful: 0 file(s) passed". `vat corpus scan` refused the identical input
 * one lane up; the command adopters actually wire into CI did not.
 *
 * ## Where the refusal is derived now
 *
 * In the WRITER, from the registry's denominator for `audit` (`examined` counts
 * files): one non-overridable `RESOURCE_CHECK_BROKEN` at `error`, among the
 * envelope's `findings` with no `location` (the claim is about the run, not a
 * file), and `status: findings`, exit 1. These rows drive the real report
 * builder and then the writer's own pass with the registry's declaration, so a
 * registry entry that stopped declaring the denominator reds them.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { buildAuditReport, resetAuditCaches } from '../../../src/commands/audit.js';
import { reportShapeFor } from '../../../src/report-schemas.js';
import { withRunIntegrity } from '../../../src/utils/run-integrity.js';
import { silentLogger } from '../../test-helpers.js';

/** The code every run-integrity refusal carries, shared with every other gate. */
const RUN_INTEGRITY_CODE = 'RESOURCE_CHECK_BROKEN';

/** Temp roots this file created, removed once at the end. */
const tempRoots: string[] = [];

afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

function newRoot(): string {
  const root = safePath.resolve(mkdtempSync(safePath.join(normalizedTmpdir(), 'audit-nothing-audited-')));
  tempRoots.push(root);
  return root;
}

/** An existing directory holding only an empty subdirectory. */
function emptyTree(): string {
  const root = newRoot();
  mkdirSyncReal(safePath.join(root, 'sub'), { recursive: true });
  return root;
}

/** An existing directory holding files, none of which any audit lane recognises. */
function unauditableTree(): string {
  const root = newRoot();
  mkdirSyncReal(safePath.join(root, 'notes'), { recursive: true });
  writeFileSync(safePath.join(root, 'notes', 'todo.txt'), 'nothing to audit here\n');
  writeFileSync(safePath.join(root, 'notes', 'data.json'), '{"not": "a manifest"}\n');
  return root;
}

/** One real skill, so the populated path stays a control on the refusal. */
function skillTree(): string {
  const root = newRoot();
  const skillDir = safePath.join(root, 'skills', 'alpha');
  mkdirSyncReal(skillDir, { recursive: true });
  writeFileSync(
    safePath.join(skillDir, 'SKILL.md'),
    '---\nname: alpha\ndescription: Fixture skill alpha for the zero-file audit refusal.\n---\n\n# alpha\n\nBody.\n',
  );
  return root;
}

/** The report as the writer would publish it: the builder's, through the registry's run-integrity pass. */
async function audit(root: string) {
  resetAuditCaches();
  const { report } = await buildAuditReport(root, {}, Date.now(), silentLogger as never);
  return withRunIntegrity(report, reportShapeFor('audit').examined);
}

describe('vat audit refuses a run that audited no file', () => {
  beforeEach(() => {
    resetAuditCaches();
  });

  it.each([
    ['an existing but empty tree', emptyTree],
    ['a tree whose files no lane can audit', unauditableTree],
  ])('%s is a run-integrity refusal: status findings, one finding, zero files', async (_name, make) => {
    const report = await audit(make());

    expect(report.examined).toBe(0);
    expect(report.data?.files).toEqual([]);
    expect(report.status).toBe('findings');
    expect(report.summary).toEqual({ errors: 1, warnings: 0, info: 0 });
    expect(report.findings).toHaveLength(1);
    const [refusal] = report.findings;
    expect(refusal?.code).toBe(RUN_INTEGRITY_CODE);
    expect(refusal?.severity).toBe('error');
    // About the run, so it names no file.
    expect(refusal?.location).toBeUndefined();
    // Says what did not run and what the operator can do — not that the tree is broken.
    expect(refusal?.message).toContain('0 files');
    expect(refusal?.message).not.toMatch(/broken/i);
  });

  it('a populated tree carries no run-integrity finding — the clean shape is unchanged', async () => {
    const report = await audit(skillTree());

    expect(report.examined).toBeGreaterThan(0);
    expect(report.findings.map((finding) => finding.code)).not.toContain(RUN_INTEGRITY_CODE);
    expect(report.status).not.toBe('error');
  });
});
