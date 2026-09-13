/**
 * `vat audit` honours `resources.validation.severity`.
 *
 * 🔑 **One dial, two commands, one answer.** `vat resources validate` hands
 * `config.resources.validation` to the framework and gets both directions —
 * `ignore` suppresses, `error` promotes. `vat audit` read `skills.defaults` and
 * `skills.config.<name>` and nothing else, so an adopter who silenced a link code
 * for their project saw it silenced by one command and reported at full severity
 * by the other, from the same config file. Measured before the fix on a two-code
 * fixture: `LINK_MISSING_TARGET: ignore` and `LINK_TO_NAVIGATION_FILE: error` set
 * under `resources.validation.severity` moved neither finding.
 *
 * Audit is still ADVISORY — every row below exits nothing and asserts nothing
 * about an exit code. The dial decides which findings are reported and at what
 * severity, never whether the command fails.
 *
 * The rows drive `buildAuditReport` (exported `@internal` for exactly this) rather
 * than `applySeverityFilter`, because the defect was not in the resolver — the
 * resolver was already shared and already correct. It was that this command never
 * asked it about this section, which is a fact about the CALLER and invisible to a
 * test of the merge function.
 */

/* eslint-disable security/detect-non-literal-fs-filename -- Test code with temp directories */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import type { ValidationIssue } from '@vibe-agent-toolkit/schema';
import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { buildAuditReport, resetAuditCaches } from '../../../src/commands/audit.js';
import { resetSkillDiscoveryCache } from '../../../src/skill-resolution/packaging-config.js';
import { silentLogger } from '../../test-helpers.js';

/** An error-severity code the fixture skill raises, and a warning-severity one. */
const MISSING_TARGET = 'LINK_MISSING_TARGET';
const NAVIGATION_FILE = 'LINK_TO_NAVIGATION_FILE';
/** An info-severity code a PLUGIN raises — the subject of the no-skills-section row. */
const PLUGIN_NO_DESCRIPTION = 'PLUGIN_MISSING_DESCRIPTION';

const tempRoots: string[] = [];

afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

/**
 * A one-skill project whose SKILL.md raises exactly {@link MISSING_TARGET} (a
 * link to a file that is not there) and {@link NAVIGATION_FILE} (a link to a
 * README), governed by `configYaml`.
 *
 * Two codes at two DEFAULT severities on purpose: one row needs something to
 * silence and another needs something to promote, and a fixture with one code
 * cannot show that the merge is a map rather than a single switch.
 */
function writeProject(configYaml: string): string {
  const root = safePath.resolve(mkdtempSync(safePath.join(normalizedTmpdir(), 'audit-resources-severity-')));
  tempRoots.push(root);
  const skillDir = safePath.join(root, 'skills', 'alpha');
  mkdirSyncReal(skillDir, { recursive: true });
  writeFileSync(
    safePath.join(skillDir, 'SKILL.md'),
    '---\nname: alpha\ndescription: A fixture skill linking one absent file and one navigation file.\n---\n\n'
      + '# Alpha\n\nSee [the missing reference](./reference.md) and [the readme](./README.md).\n',
  );
  writeFileSync(safePath.join(skillDir, 'README.md'), '# Alpha readme\n');
  writeFileSync(safePath.join(root, 'vibe-agent-toolkit.config.yaml'), configYaml);
  return root;
}

/** Every issue the audit reported, across every result. */
async function auditIssues(root: string): Promise<ValidationIssue[]> {
  const { results } = await buildAuditReport(root, {}, Date.now(), silentLogger as never);
  return results.flatMap((r) => r.issues);
}

/** The severities reported for one code — `[]` when the code was suppressed. */
function severitiesOf(issues: readonly ValidationIssue[], code: string): string[] {
  return issues.filter((i) => i.code === code).map((i) => i.severity);
}

const SKILLS_SECTION = 'skills:\n  include:\n    - "skills/*/SKILL.md"\n';

describe('vat audit applies resources.validation.severity', () => {
  beforeEach(() => {
    resetAuditCaches();
    resetSkillDiscoveryCache();
  });

  it('suppresses a code the adopter set to ignore', async () => {
    const root = writeProject(
      `version: 1\nresources:\n  validation:\n    severity:\n      ${MISSING_TARGET}: ignore\n${SKILLS_SECTION}`,
    );

    const issues = await auditIssues(root);

    expect(severitiesOf(issues, MISSING_TARGET)).toEqual([]);
    // The OTHER code is untouched — proof the run still validated the skill, so the
    // empty list above is a suppression and not an audit that found nothing.
    expect(severitiesOf(issues, NAVIGATION_FILE)).toEqual(['warning']);
  });

  it('promotes a code the adopter set to error', async () => {
    const root = writeProject(
      `version: 1\nresources:\n  validation:\n    severity:\n      ${NAVIGATION_FILE}: error\n${SKILLS_SECTION}`,
    );

    const issues = await auditIssues(root);

    expect(severitiesOf(issues, NAVIGATION_FILE)).toEqual(['error']);
  });

  /**
   * The skills dial is the more specific statement, so it wins. Without a row
   * pinning the direction, a later edit could reorder the spread and nothing
   * would notice: both maps carry the same key, and either order "works".
   */
  it('lets the skills dial override it for the same code', async () => {
    const root = writeProject(
      `version: 1\nresources:\n  validation:\n    severity:\n      ${NAVIGATION_FILE}: error\n`
        + `skills:\n  include:\n    - "skills/*/SKILL.md"\n  defaults:\n    validation:\n      severity:\n        ${NAVIGATION_FILE}: info\n`,
    );

    const issues = await auditIssues(root);

    expect(severitiesOf(issues, NAVIGATION_FILE)).toEqual(['info']);
  });

  /**
   * A project can configure `resources` and declare no skills at all — a repo of
   * plugins is the ordinary case. The filter returned early on a missing `skills`
   * section, which made the resources dial inert for exactly those projects.
   *
   * The subject is a plugin rather than the skill fixture above because a project
   * with no `skills` section validates its skills config-free, and that lane's
   * link findings are not registry codes a `severity` map can name.
   */
  it('applies to a project with no skills section at all', async () => {
    const root = safePath.resolve(mkdtempSync(safePath.join(normalizedTmpdir(), 'audit-resources-severity-')));
    tempRoots.push(root);
    mkdirSyncReal(safePath.join(root, 'plug', '.claude-plugin'), { recursive: true });
    writeFileSync(safePath.join(root, 'plug', '.claude-plugin', 'plugin.json'), '{ "name": "bare-plugin" }\n');
    writeFileSync(
      safePath.join(root, 'vibe-agent-toolkit.config.yaml'),
      `version: 1\nresources:\n  validation:\n    severity:\n      ${PLUGIN_NO_DESCRIPTION}: error\n`,
    );

    const issues = await auditIssues(root);

    expect(severitiesOf(issues, PLUGIN_NO_DESCRIPTION)).toEqual(['error']);
  });
});
