/**
 * `vat skills validate` must never answer `ok` for a run that validated no
 * skill.
 *
 * ## The defect
 *
 * `discoverSkillsFromConfig` returning `[]` — a typo in a `skills.include` glob,
 * a renamed directory, an `exclude` that swallows every match — took an early
 * return that printed one info line to stderr and handed back `{ document:
 * undefined, exitCode: 0 }`. `vat validate` folded that into `status: success`,
 * so the one command the docs name as THE gate stayed green forever on a config
 * that checked nothing, with no document on stdout at all.
 *
 * ## One refusal, decided by the writer
 *
 * The document is the report envelope, and a run over zero skills — globs that
 * discover nothing, or a config with no `skills:` block at all — carries the
 * writer's one non-overridable `RESOURCE_CHECK_BROKEN` at `error`, derived from
 * the registry's declared denominator: `status: findings`, exit 1, the
 * gate-FAILED class. The globs that matched nothing are named on stderr, where
 * the writer — which cannot see the config — does not reach.
 *
 * ## Why the rows drive the real entry point
 *
 * The defect was an early return BEFORE the builder, so a builder-only test
 * cannot see it. Each row runs `runSkillsValidatePhase` on a project on disk and
 * reads the PUBLISHED document the orchestrators consume.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type { SkillsValidateReport } from '../../../src/commands/skills/validate-schema.js';
import { buildSkillsValidateReport, nothingDiscoveredLine } from '../../../src/commands/skills/validate.js';
import { resetSkillDiscoveryCache } from '../../../src/skill-resolution/packaging-config.js';

import { publishedSkillsValidate } from './skills-validate-document.js';

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


/** Expect exactly the writer's one refusal, and nothing validated. */
function expectRefusedOverNothing(exitCode: number, document: SkillsValidateReport): void {
  expect(exitCode).toBe(1);
  expect(document.status).toBe('findings');
  expect(document.examined).toBe(0);
  expect(document.data.skills).toEqual([]);
  expect(document.summary).toEqual({ errors: 1, warnings: 0, info: 0 });
  expect(document.findings.map((finding) => [finding.code, finding.severity])).toEqual([[RUN_INTEGRITY_CODE, 'error']]);
  expect(document.findings[0]?.message).toContain('skills.include');
}

describe('vat skills validate refuses a run that discovered no skill', () => {
  beforeEach(() => {
    resetSkillDiscoveryCache();
  });

  it('a skills.include glob matching nothing is a run-integrity refusal, exit 1', async () => {
    const { exitCode, document } = await publishedSkillsValidate(writeProject(`skills:\n  include:\n    - "${TYPO_GLOB}"\n`));
    expectRefusedOverNothing(exitCode, document);
  });

  it('an exclude that swallows every match is the same refusal', async () => {
    const { exitCode, document } = await publishedSkillsValidate(
      writeProject(`skills:\n  include:\n    - "${MATCHING_GLOB}"\n  exclude:\n    - "**"\n`),
    );
    expectRefusedOverNothing(exitCode, document);
  });

  it('a config with no skills: block examined nothing, and says so — a document, exit 1', async () => {
    // It used to publish NO document at exit 0. Both orchestrators still skip
    // this phase without `skills:`; invoked directly, a run over nothing is
    // the same claim as a glob over nothing.
    const { exitCode, document } = await publishedSkillsValidate(writeProject('{}\n'));
    expectRefusedOverNothing(exitCode, document);
  });

  it('a glob that matches the skill still validates it — the refusal is off the populated path', async () => {
    const { document } = await publishedSkillsValidate(writeProject(`skills:\n  include:\n    - "${MATCHING_GLOB}"\n`));

    expect(document.examined).toBe(1);
    expect(document.data.skills.map((skill) => skill.name)).toEqual(['alpha']);
    expect(document.findings.map((finding) => finding.code)).not.toContain(RUN_INTEGRITY_CODE);
  });
});

describe('the stderr half names what the document cannot', () => {
  it('names the include globs that matched nothing, and the exclude that swallowed them', () => {
    expect(nothingDiscoveredLine({ include: [TYPO_GLOB] })).toContain(`\`${TYPO_GLOB}\``);
    const line = nothingDiscoveredLine({ include: [MATCHING_GLOB], exclude: ['**'] });
    expect(line).toContain('skills.exclude');
    expect(line).toContain('`**`');
  });

  it('names the missing skills: block when there is none', () => {
    expect(nothingDiscoveredLine(undefined)).toContain('no `skills:` block');
  });

  it('the builder leaves the zero-examined decision to the writer', () => {
    const report = buildSkillsValidateReport({ root: '/project', results: [], runIssues: [], durationMs: 3 });

    expect(report.status).toBe('ok');
    expect(report.examined).toBe(0);
    expect(report.findings).toEqual([]);
  });
});
