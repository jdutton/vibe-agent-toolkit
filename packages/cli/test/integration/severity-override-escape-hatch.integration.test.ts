/* eslint-disable security/detect-non-literal-fs-filename -- all paths are temp dirs the test owns */
/**
 * A1 — the documented escape hatch has to actually work.
 *
 * `PACKAGED_AGENT_INSTRUCTION_FILE`'s own `fix` string instructs the reader, verbatim:
 * "If it must ship, set severity.PACKAGED_AGENT_INSTRUCTION_FILE to ignore so the
 * exception is recorded in config." That instruction is the entire reason the code
 * ships at `warning` rather than `error` — a legitimate exception exists (an official
 * plugin's intentional scaffold template) and the adopter is told how to record it.
 *
 * Measured before the fix, on the fixtures below:
 *   - `vat audit <bundle-path>`   1 warning → 1 with the override (defaults AND per-skill)
 *   - `vat audit <plugin-path>`   1 warning → 1 with the override
 *   - `vat verify` packaged-content  1 warning → 1 with the override
 * The override was a no-op in all three.
 *
 * ## Why these tests go through `buildAuditReport`, not `runAudit`
 *
 * `runAudit` (test-helpers) calls `getValidationResults` directly, which is UPSTREAM of
 * `applySeverityFilter`. Every existing audit integration test therefore runs a pipeline
 * in which severity config cannot be observed at all — which is how a no-op escape hatch
 * stayed green. `buildAuditReport` is the smallest entry point that includes the filter,
 * so a test written against it can distinguish the two answers.
 */

import { writeFileSync } from 'node:fs';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';

import { buildAuditReport, resetAuditCaches } from '../../src/commands/audit.js';
import { discoverSkillsFromConfig } from '../../src/commands/skills/skill-discovery.js';
import { checkPackagedAgentInstructionFiles } from '../../src/commands/verify.js';
import { loadConfig } from '../../src/utils/config-loader.js';
import { createTempDirTracker } from '../system/test-common.js';
import { commitTestFixture, silentLogger } from '../test-helpers.js';

const CODE = 'PACKAGED_AGENT_INSTRUCTION_FILE';
const SKILL_NAME = 'demo';
const PLUGIN_NAME = 'demo-plugin';

const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-severity-hatch-');

/**
 * Every lane gets one. A suppression test that passes because the fixture never
 * produced a finding is worthless, and only this case can tell the two apart.
 */
const CONTROL_CASE = 'reports the file when nothing overrides it';

/** Where a severity override is written in the project config. */
type OverrideScope = 'none' | 'defaults' | 'per-skill';

function severityBlock(indent: string): string {
  return `${indent}validation:\n${indent}  severity:\n${indent}    ${CODE}: ignore\n`;
}

/**
 * A config declaring the pool skill, with the override placed at `scope`.
 *
 * Both placements are exercised because both are documented: `skills.defaults`
 * is the project-wide switch and `skills.config.<name>` is the per-skill one.
 *
 * `skills.config.<name>` is present in EVERY variant, override or not — not because
 * `vat verify` needs it (the enumeration is the union of discovery and that map), but
 * because the `per-skill` scope has nowhere else to write its override.
 */
function configYaml(scope: OverrideScope): string {
  const base = `version: 1\nskills:\n  include:\n    - "skills/**/SKILL.md"\n`;
  const defaults = scope === 'defaults' ? `  defaults:\n${severityBlock('    ')}` : '';
  const perSkillBody = scope === 'per-skill' ? severityBlock('      ') : '      publish: true\n';
  return `${base}${defaults}  config:\n    ${SKILL_NAME}:\n${perSkillBody}`;
}

/** A minimal skill directory, plus any extra files named relative to it. */
function writeSkill(dir: string, extras: readonly string[]): void {
  mkdirSyncReal(dir, { recursive: true });
  writeFileSync(
    safePath.join(dir, 'SKILL.md'),
    `---\nname: ${SKILL_NAME}\ndescription: A demonstration skill used to exercise the severity escape hatch end to end.\n---\n\n# Demo\n\nBody.\n`,
    'utf-8',
  );
  for (const rel of extras) {
    writeFileSync(safePath.join(dir, rel), '# repo-internal guidance\n', 'utf-8');
  }
}

/**
 * A committed repo with a gitignored `dist/skills/<name>/` bundle carrying a
 * `CLAUDE.md`, and the project config at the ROOT — several levels above the
 * bundle. The distance is the point: the config root has to be found by walking
 * up, not by resolving the audit target.
 */
function projectWithBundle(scope: OverrideScope): { root: string; bundle: string } {
  const root = createTempDir();
  writeFileSync(safePath.join(root, '.gitignore'), 'dist/\n', 'utf-8');
  writeFileSync(safePath.join(root, 'vibe-agent-toolkit.config.yaml'), configYaml(scope), 'utf-8');
  writeSkill(safePath.join(root, 'skills', SKILL_NAME), []);
  commitTestFixture(root);
  const bundle = safePath.join(root, 'dist', 'skills', SKILL_NAME);
  writeSkill(bundle, ['CLAUDE.md']);
  return { root, bundle };
}

/** The same project, with a built plugin tree carrying a `CLAUDE.md` at its root. */
function projectWithPlugin(scope: OverrideScope): { root: string; plugin: string } {
  const { root } = projectWithBundle(scope);
  const plugin = safePath.join(root, 'dist', '.claude', 'plugins', PLUGIN_NAME);
  mkdirSyncReal(safePath.join(plugin, '.claude-plugin'), { recursive: true });
  writeFileSync(
    safePath.join(plugin, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: PLUGIN_NAME, description: 'A synthetic plugin fixture.', version: '1.0.0' }),
    'utf-8',
  );
  writeFileSync(safePath.join(plugin, 'CLAUDE.md'), '# repo-internal guidance\n', 'utf-8');
  return { root, plugin };
}

/** Agent-instruction findings `vat verify`'s packaged-content phase publishes for `root`. */
async function verifyFindings(root: string): Promise<string[]> {
  const config = loadConfig(root);
  const discovered = config?.skills ? await discoverSkillsFromConfig(config.skills, root) : [];
  return checkPackagedAgentInstructionFiles(root, discovered).map((i) => String(i.location));
}

/** Agent-instruction findings `vat audit <target>` publishes, AFTER severity filtering. */
async function auditFindings(target: string): Promise<string[]> {
  resetAuditCaches();
  const { results } = await buildAuditReport(target, {}, Date.now(), silentLogger);
  return results.flatMap((r) => r.issues).filter((i) => i.code === CODE).map((i) => String(i.location));
}

describe('severity escape hatch: PACKAGED_AGENT_INSTRUCTION_FILE (integration)', () => {
  afterEach(() => {
    cleanupTempDirs();
  });

  describe('vat audit, skill-bundle lane', () => {
    it(CONTROL_CASE,async () => {
      // The control. Without it a green assertion below could mean "the fixture
      // never produced a finding" rather than "the override suppressed one".
      const { bundle } = projectWithBundle('none');
      expect(await auditFindings(bundle)).toEqual(['CLAUDE.md']);
    });

    it('honours skills.defaults.validation.severity for a bundle path below the project root', async () => {
      const { bundle } = projectWithBundle('defaults');
      expect(await auditFindings(bundle)).toEqual([]);
    });

    it('honours skills.config.<name>.validation.severity for the same bundle', async () => {
      const { bundle } = projectWithBundle('per-skill');
      expect(await auditFindings(bundle)).toEqual([]);
    });
  });

  describe('vat audit, plugin lane', () => {
    // The population that JUSTIFIED shipping this code at `warning`: an official
    // plugin's intentional scaffold template is a finding on a `claude-plugin`
    // result, not on a skill. Filtering only skill-typed results left the escape
    // hatch inert for exactly the case it was written for.
    it(CONTROL_CASE,async () => {
      const { plugin } = projectWithPlugin('none');
      expect(await auditFindings(plugin)).toEqual(['CLAUDE.md']);
    });

    it('honours skills.defaults.validation.severity for a plugin tree', async () => {
      const { plugin } = projectWithPlugin('defaults');
      expect(await auditFindings(plugin)).toEqual([]);
    });
  });

  describe('vat verify, packaged-content phase', () => {
    it(CONTROL_CASE,async () => {
      const { root } = projectWithBundle('none');
      await expect(verifyFindings(root)).resolves.toEqual(['dist/skills/demo/CLAUDE.md']);
    });

    it('honours skills.defaults.validation.severity', async () => {
      const { root } = projectWithBundle('defaults');
      await expect(verifyFindings(root)).resolves.toEqual([]);
    });

    it('honours skills.config.<name>.validation.severity', async () => {
      const { root } = projectWithBundle('per-skill');
      await expect(verifyFindings(root)).resolves.toEqual([]);
    });
  });
});
