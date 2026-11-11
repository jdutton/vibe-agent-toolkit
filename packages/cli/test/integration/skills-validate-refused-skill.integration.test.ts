/**
 * A SKILL.md the parse worker refused is a skill this run examined and could
 * not check — never "matched no SKILL.md" — and its finding is resolved by the
 * project's `resources.validation` alone, as `vat resources validate` resolves it.
 *
 * 50,000 levels of frontmatter nesting: past the parse's stack in any thread.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { overOutputRowsMarkdown } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { buildAuditReport, resetAuditCaches } from '../../src/commands/audit.js';
import type { ResourcesValidateReport } from '../../src/commands/resources/validate-schema.js';
import { runResourcesValidatePhase } from '../../src/commands/resources/validate.js';
import { resetSkillDiscoveryCache } from '../../src/skill-resolution/packaging-config.js';
import { publishedSkillsValidate } from '../commands/skills/skills-validate-document.js';
import { publishedPhase } from '../helpers/published-phase.js';
import { build } from '../helpers/skills-build-fixture.js';
import { silentLogger } from '../test-helpers.js';


const DEPTH = 50_000;
const REFUSED_SKILL_MD = `---\nname: deep\nnested: ${'['.repeat(DEPTH)}${']'.repeat(DEPTH)}\n---\n# Deep\n`;
const LIMIT = 'RESOURCE_PARSE_LIMIT_EXCEEDED';
const RUN_INTEGRITY_CODE = 'RESOURCE_CHECK_BROKEN';

const SKILLS_BLOCK = 'skills:\n  include:\n    - "skills/*/SKILL.md"\n';
const ALLOW_DEEP = `resources:\n  validation:\n    allow:\n      ${LIMIT}:\n        - paths: ['skills/deep/SKILL.md']\n          reason: generated\n`;
const SKILLS_IGNORE = `${SKILLS_BLOCK}  defaults:\n    validation:\n      severity:\n        ${LIMIT}: ignore\n`;

const tempRoots: string[] = [];

afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

/**
 * A project with a refused `skills/deep/SKILL.md` and, when asked, a clean `skills/alpha` —
 * linking a `reference.md` whose parse is refused when `alphaLinksRefused` is set.
 */
function writeProject(configBody: string, options: { withAlpha: boolean; alphaLinksRefused?: boolean }): string {
  const root = safePath.resolve(mkdtempSync(safePath.join(normalizedTmpdir(), 'skills-validate-refused-')));
  tempRoots.push(root);
  const deep = mkdirSyncReal(safePath.join(root, 'skills', 'deep'), { recursive: true });
  writeFileSync(safePath.join(deep, 'SKILL.md'), REFUSED_SKILL_MD);
  if (options.withAlpha) {
    const alpha = mkdirSyncReal(safePath.join(root, 'skills', 'alpha'), { recursive: true });
    const link = options.alphaLinksRefused === true ? ' See [the reference](reference.md).' : '';
    writeFileSync(
      safePath.join(alpha, 'SKILL.md'),
      `---\nname: alpha\ndescription: Fixture skill alpha beside a refused one.\n---\n\n# alpha\n\nBody.${link}\n`,
    );
    if (options.alphaLinksRefused === true) writeFileSync(safePath.join(alpha, 'reference.md'), overOutputRowsMarkdown('SKILL.md'));
  }
  writeFileSync(safePath.join(root, 'vibe-agent-toolkit.config.yaml'), configBody);
  return root;
}

const codesOf = (findings: readonly { code: string }[]): string[] => findings.map((finding) => finding.code);

describe('vat skills validate over a refused SKILL.md', () => {
  beforeEach(() => {
    resetSkillDiscoveryCache();
  });

  it('counts the only skill, refused, in examined — no run-integrity refusal', async () => {
    const { exitCode, document } = await publishedSkillsValidate(writeProject(SKILLS_BLOCK, { withAlpha: false }));
    expect(document.examined).toBe(1);
    expect(codesOf(document.findings)).toEqual([LIMIT]);
    expect(exitCode).toBe(1);
  });

  // Only `resources.validation` resolves a refused file, so a skill config naming its code would
  // parse and do nothing: the config is refused, pointing at where the entry belongs.
  it('a skill config naming the code is refused as CONFIG_INVALID, pointing at resources.validation', async () => {
    const root = writeProject(SKILLS_IGNORE, { withAlpha: true, alphaLinksRefused: true });
    const { exitCode, document } = await publishedSkillsValidate(root, { skill: 'alpha' });
    const refusal = document.status === 'error' ? document.error : undefined;
    expect(refusal).toMatchObject({ code: 'CONFIG_INVALID' });
    expect(refusal?.message).toContain(`skills.defaults.validation.severity.${LIMIT}`);
    expect(refusal?.message).toContain('resources.validation.severity');
    expect(exitCode).toBe(2);
  });

  it('a --skill naming another skill is not failed by the refusal', async () => {
    const { exitCode, document } = await publishedSkillsValidate(writeProject(SKILLS_BLOCK, { withAlpha: true }), { skill: 'alpha' });
    expect(document.examined).toBe(1);
    expect(codesOf(document.findings)).not.toContain(LIMIT);
    expect(exitCode).toBe(0);
  });

  it('a --skill naming the refused skill\'s directory reports the refusal, not an unknown skill', async () => {
    const { document } = await publishedSkillsValidate(writeProject(SKILLS_BLOCK, { withAlpha: true }), { skill: 'deep' });
    expect(document.examined).toBe(1);
    expect(codesOf(document.findings)).toEqual([LIMIT]);
  });
});

describe('one resources.validation.allow entry clears the refused file in every verb', () => {
  beforeEach(() => {
    resetSkillDiscoveryCache();
  });

  const resourcesFindings = async (config: string): Promise<string[]> => {
    const root = writeProject(config, { withAlpha: false });
    const { document } = publishedPhase<ResourcesValidateReport>('resources validate', await runResourcesValidatePhase(root, {}));
    return codesOf(document.findings);
  };

  it('vat resources validate — and reports it without the entry', async () => {
    expect(await resourcesFindings(SKILLS_BLOCK)).toContain(LIMIT);
    expect(await resourcesFindings(`${SKILLS_BLOCK}${ALLOW_DEEP}`)).not.toContain(LIMIT);
  });

  it('vat skills validate', async () => {
    const { exitCode, document } = await publishedSkillsValidate(writeProject(`${SKILLS_BLOCK}${ALLOW_DEEP}`, { withAlpha: false }));
    expect(document.examined).toBe(1);
    expect(codesOf(document.findings)).not.toContain(LIMIT);
    expect(codesOf(document.findings)).not.toContain(RUN_INTEGRITY_CODE);
    expect(exitCode).toBe(0);
  });
});

describe('vat audit resolves the refused SKILL.md under resources.validation alone', () => {
  beforeEach(() => {
    resetAuditCaches();
    resetSkillDiscoveryCache();
  });

  const auditCodes = async (config: string): Promise<string[]> => {
    const { results } = await buildAuditReport(writeProject(config, { withAlpha: false }), {}, Date.now(), silentLogger as never);
    return codesOf(results.flatMap((result) => result.issues));
  };

  it('reports it without an entry, and the resources allow entry clears it', async () => {
    expect(await auditCodes(SKILLS_BLOCK)).toContain(LIMIT);
    expect(await auditCodes(`${SKILLS_BLOCK}${ALLOW_DEEP}`)).not.toContain(LIMIT);
  });
});

// `allow` governs what a run REPORTS, never what it SHIPS (ADR P1): validate may exit 0
// under the entry while the build still refuses the skill, before anything is written.
describe('vat skills build refuses a refused file the skill reaches, whatever resources.validation allows', () => {
  beforeEach(() => {
    resetSkillDiscoveryCache();
  });

  const ALLOW_REFERENCE = `resources:\n  validation:\n    allow:\n      ${LIMIT}:\n        - paths: ['skills/alpha/reference.md']\n          reason: generated\n`;

  it('validate is cleared by the allow entry; build refuses the skill and writes no output', async () => {
    const root = writeProject(`${SKILLS_BLOCK}${ALLOW_REFERENCE}`, { withAlpha: true, alphaLinksRefused: true });
    const validated = await publishedSkillsValidate(root, { skill: 'alpha' });
    expect(codesOf(validated.document.findings)).not.toContain(LIMIT);
    expect(validated.exitCode).toBe(0);

    const run = await build(root, [['alpha', 'See [the reference](reference.md).']], {
      onlySkill: 'alpha',
      resourcesValidation: { allow: { [LIMIT]: [{ paths: ['skills/alpha/reference.md'], reason: 'generated' }] } },
    });
    expect(run.results).toEqual([]);
    expect(run.failures.map((failure) => failure.name)).toEqual(['alpha']);
    expect(run.outputCommitted).toBe(false);
  });
});
