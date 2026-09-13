/**
 * `vat skills validate` must never answer `success` for a run that validated no
 * skill.
 *
 * ## The defect
 *
 * `discoverSkillsFromConfig` returning `[]` — a typo in a `skills.include` glob,
 * a renamed directory, an `exclude` that swallows every match — took an early
 * return that printed one info line to stderr and handed back `{ document:
 * undefined, exitCode: 0 }`. `vat validate` folded that into `status: success`,
 * so the one command the docs name as THE gate stayed green forever on a config
 * that checked nothing, with no document on stdout at all. `vat verify` refused
 * the same config in its `packaged-content` phase; `vat skills validate`, which
 * that refusal's own message sends the operator to, did not.
 *
 * ## The two empty cases are different claims, and only one is refused
 *
 * No `skills:` block at all is a CHOICE — the project declares no skills, and
 * both orchestrators (`vat validate`, `vat verify`) already skip the phase
 * entirely on that config. That stays the not-configured exit: no document,
 * exit 0. A `skills:` block whose globs discover nothing is not a choice; it is
 * a gate that asserted nothing, and it is refused through the shared mechanism
 * in `run-integrity.ts`: one non-overridable `RESOURCE_CHECK_BROKEN` at `error`,
 * `status: error`, exit 1 — the gate-FAILED class, not the could-not-run class.
 *
 * ## Why the rows drive the real entry point
 *
 * The refusal is derived in the builder, but the defect was an early return
 * BEFORE the builder, so a builder-only test cannot see it. Each row here runs
 * `runSkillsValidatePhase` on a project on disk and reads the outcome the
 * orchestrators consume. The builder rows at the end pin the seam itself.
 */

/* eslint-disable security/detect-non-literal-fs-filename -- Test code with temp directories */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  buildValidateSummary,
  formatValidationReportLines,
  runSkillsValidatePhase,
} from '../../../src/commands/skills/validate.js';
import { resetSkillDiscoveryCache } from '../../../src/skill-resolution/packaging-config.js';

/** The code every run-integrity refusal carries, shared with every other gate. */
const RUN_INTEGRITY_CODE = 'RESOURCE_CHECK_BROKEN';

/** The glob that names the fixture's skill, and one that names nothing. */
const MATCHING_GLOB = 'skills/*/SKILL.md';
const TYPO_GLOB = 'skillz/*/SKILL.md';

/** Temp roots this file created, removed once at the end. */
const tempRoots: string[] = [];

afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

/**
 * A project with ONE real skill at `skills/alpha/SKILL.md` and the given config
 * body — so a glob that matches nothing is a typo, not an empty tree.
 */
function writeProject(configBody: string): string {
  const root = safePath.resolve(mkdtempSync(safePath.join(normalizedTmpdir(), 'skills-validate-nothing-checked-')));
  tempRoots.push(root);
  const skillDir = safePath.join(root, 'skills', 'alpha');
  mkdirSyncReal(skillDir, { recursive: true });
  writeFileSync(
    safePath.join(skillDir, 'SKILL.md'),
    '---\nname: alpha\ndescription: Fixture skill alpha for the empty-discovery refusal.\n---\n\n# alpha\n\nBody.\n',
  );
  writeFileSync(safePath.join(root, 'vibe-agent-toolkit.config.yaml'), configBody);
  return root;
}

/** The phase's document, typed by what the builder publishes. */
type Summary = ReturnType<typeof buildValidateSummary>;

describe('vat skills validate refuses a run that discovered no skill', () => {
  beforeEach(() => {
    resetSkillDiscoveryCache();
  });

  it('a skills.include glob matching nothing is a run-integrity refusal, exit 1', async () => {
    const root = writeProject(`version: 1\nskills:\n  include:\n    - "${TYPO_GLOB}"\n`);

    const outcome = await runSkillsValidatePhase(root, {});

    expect(outcome.exitCode).toBe(1);
    expect(outcome.failed).toBeUndefined();
    const document = outcome.document as Summary;
    expect(document.status).toBe('error');
    expect(document.skillsValidated).toBe(0);
    expect(document.issueCounts).toEqual({ errors: 1, warnings: 0, info: 0 });
    expect(document.runIssueCounts).toEqual({ errors: 1, warnings: 0, info: 0 });
    expect(document.runIssues).toHaveLength(1);
    const [refusal] = document.runIssues;
    expect(refusal?.code).toBe(RUN_INTEGRITY_CODE);
    expect(refusal?.severity).toBe('error');
    // Names the glob that matched nothing, and what to do about it.
    expect(refusal?.message).toContain(TYPO_GLOB);
    expect(refusal?.message).toContain('skills.include');
  });

  it('an exclude that swallows every match is the same refusal, and names the exclude', async () => {
    const root = writeProject(
      `version: 1\nskills:\n  include:\n    - "${MATCHING_GLOB}"\n  exclude:\n    - "**"\n`,
    );

    const outcome = await runSkillsValidatePhase(root, {});

    expect(outcome.exitCode).toBe(1);
    const document = outcome.document as Summary;
    expect(document.status).toBe('error');
    expect(document.runIssues.map((issue) => issue.code)).toEqual([RUN_INTEGRITY_CODE]);
    expect(document.runIssues[0]?.message).toContain('skills.exclude');
  });

  it('a config with no skills: block is the not-configured exit — no document, exit 0', async () => {
    const root = writeProject('version: 1\n');

    const outcome = await runSkillsValidatePhase(root, {});

    // The orchestrators never run this phase without `skills:`; when invoked
    // directly it declines the same way, because "not declared" is a choice.
    expect(outcome).toEqual({ document: undefined, exitCode: 0 });
  });

  it('a glob that matches the skill still validates it — the refusal is off the populated path', async () => {
    const root = writeProject(`version: 1\nskills:\n  include:\n    - "${MATCHING_GLOB}"\n`);

    const outcome = await runSkillsValidatePhase(root, {});

    const document = outcome.document as Summary;
    expect(document.skillsValidated).toBe(1);
    expect(document.runIssues.map((issue) => issue.code)).not.toContain(RUN_INTEGRITY_CODE);
  });
});

describe('the seam: builder and stderr renderer both derive the refusal', () => {
  const include = [TYPO_GLOB];

  it('buildValidateSummary over zero results publishes the refusal, not success', () => {
    const summary = buildValidateSummary([], 3, false, [], { include });

    expect(summary.status).toBe('error');
    expect(summary.issueCounts).toEqual({ errors: 1, warnings: 0, info: 0 });
    expect(summary.runIssueCounts).toEqual({ errors: 1, warnings: 0, info: 0 });
    expect(summary.runIssues.map((issue) => issue.code)).toEqual([RUN_INTEGRITY_CODE]);
  });

  it('formatValidationReportLines over zero results renders the same refusal, so stderr agrees', () => {
    const lines = formatValidationReportLines([], [], false, { include });

    expect(lines.join('\n')).toContain(RUN_INTEGRITY_CODE);
    expect(lines.join('\n')).not.toContain('✅');
  });

  it('a run already carrying a run-integrity finding gets no second one', () => {
    const existing = { code: RUN_INTEGRITY_CODE, severity: 'error', message: 'already refused' } as const;
    const summary = buildValidateSummary([], 3, false, [existing], { include });

    expect(summary.runIssues).toEqual([existing]);
  });
});
