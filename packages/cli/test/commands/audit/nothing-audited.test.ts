/**
 * `vat audit` must never publish `status: success` over a run that audited no
 * file.
 *
 * ## The defect
 *
 * `calculateValidationStatus([])` is `success`, so an existing directory holding
 * nothing auditable — moved plugins, a wrong subdirectory, an excluded tree, or a
 * tree of files no lane recognises — published `status: success` beside
 * `filesScanned: 0`, and stderr said "Audit successful: 0 file(s) passed". The
 * command's own documentation tells CI to gate on that `status`. `vat corpus
 * scan` refuses the identical input one lane up; the command adopters actually
 * wire into CI did not.
 *
 * ## What changes, and what deliberately does not
 *
 * The refusal goes through the shared mechanism in `run-integrity.ts`: one
 * non-overridable `RESOURCE_CHECK_BROKEN` at `error`, published under a
 * top-level `issues:` (present only when non-empty — the claim is about the run,
 * not about any file, so it is not a `files[]` row and does not inflate
 * `filesScanned`), counted in the header `issueCounts`, and `status: error`.
 *
 * The EXIT CODE is untouched. `vat audit` publishes two verdicts on purpose:
 * `status` describes the findings, the exit code describes whether the run
 * completed — and this run completed. Making exit follow `status` would turn an
 * advisory report into a gate, which its published contract promises it is
 * not (see `status-is-not-the-exit-code.test.ts`).
 *
 * ## Why the rows drive the real report builder
 *
 * `buildAuditReport` is the directory lane's entry point, exported `@internal`
 * for exactly this; the `--user` lane shares the document builder beneath it
 * (`buildBaseSummary`), which is where the refusal is derived, so one lane
 * exercised end to end pins both.
 */

/* eslint-disable security/detect-non-literal-fs-filename -- Test code with temp directories */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { buildAuditReport, resetAuditCaches } from '../../../src/commands/audit.js';
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

async function audit(root: string) {
  resetAuditCaches();
  return buildAuditReport(root, {}, Date.now(), silentLogger as never);
}

describe('vat audit refuses a run that audited no file', () => {
  beforeEach(() => {
    resetAuditCaches();
  });

  it.each([
    ['an existing but empty tree', emptyTree],
    ['a tree whose files no lane can audit', unauditableTree],
  ])('%s is a run-integrity refusal: status error, one finding, zero files', async (_name, make) => {
    const { document } = await audit(make());

    expect(document.summary.filesScanned).toBe(0);
    expect(document.files).toEqual([]);
    expect(document.status).toBe('error');
    expect(document.issueCounts).toEqual({ errors: 1, warnings: 0, info: 0 });
    expect(document.issues).toHaveLength(1);
    const [refusal] = document.issues ?? [];
    expect(refusal?.code).toBe(RUN_INTEGRITY_CODE);
    expect(refusal?.severity).toBe('error');
    // Says what did not run and what the operator can do — not that the tree is broken.
    expect(refusal?.message).toContain('0 files');
    expect(refusal?.message).not.toMatch(/broken/i);
  });

  it('a populated tree carries no run-level issues key at all — the clean shape is unchanged', async () => {
    const { document } = await audit(skillTree());

    expect(document.summary.filesScanned).toBeGreaterThan(0);
    expect(document).not.toHaveProperty('issues');
    expect(document.status).not.toBe('error');
  });
});
