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
import { collectMarketplaceFindings } from '../../src/commands/claude/marketplace/validate.js';
import { discoverSkillsFromConfig } from '../../src/commands/skills/skill-discovery.js';
import { checkPackagedAgentInstructionFiles } from '../../src/commands/verify.js';
import { loadConfig } from '../../src/utils/config-loader.js';
import { createTempDirTracker } from '../system/test-common.js';
import { commitTestFixture, silentLogger } from '../test-helpers.js';

const CODE = 'PACKAGED_AGENT_INSTRUCTION_FILE';
const SKILL_NAME = 'demo';
const PLUGIN_NAME = 'demo-plugin';
const MARKETPLACE_NAME = 'demo-mp';
const PLUGIN_DESCRIPTION = 'A synthetic plugin fixture.';

const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-severity-hatch-');

/**
 * Every lane gets one. A suppression test that passes because the fixture never
 * produced a finding is worthless, and only this case can tell the two apart.
 */
const CONTROL_CASE = 'reports the file when nothing overrides it';

/** Where a severity override is written in the project config. */
type OverrideScope = 'none' | 'defaults' | 'per-skill';

/**
 * The severities an override can name. `ignore` is the documented opt-out;
 * `error` is the direction an adopter reaches for to make a code fail their
 * build, and the one a suppression-only filter silently discards.
 */
type OverrideSeverity = 'ignore' | 'error';

/** The repo-internal guidance body every fixture's agent-instruction file carries. */
const AGENT_INSTRUCTION_BODY = '# repo-internal guidance\n';

/** Write `<dir>/.claude-plugin/<name>` as JSON, creating the manifest directory. */
function writeManifest(dir: string, name: string, value: unknown): void {
  const manifestDir = safePath.join(dir, '.claude-plugin');
  mkdirSyncReal(manifestDir, { recursive: true });
  writeFileSync(safePath.join(manifestDir, name), JSON.stringify(value), 'utf-8');
}

/** Plant an agent-instruction file at a tree's root — the thing that must not ship. */
function writeAgentInstructionFile(dir: string): void {
  writeFileSync(safePath.join(dir, 'CLAUDE.md'), AGENT_INSTRUCTION_BODY, 'utf-8');
}

function severityBlock(indent: string, severity: OverrideSeverity): string {
  return `${indent}validation:\n${indent}  severity:\n${indent}    ${CODE}: ${severity}\n`;
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
function configYaml(scope: OverrideScope, severity: OverrideSeverity = 'ignore'): string {
  const base = `version: 1\nskills:\n  include:\n    - "skills/**/SKILL.md"\n`;
  const defaults = scope === 'defaults' ? `  defaults:\n${severityBlock('    ', severity)}` : '';
  const perSkillBody =
    scope === 'per-skill' ? severityBlock('      ', severity) : '      publish: true\n';
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
    writeFileSync(safePath.join(dir, rel), AGENT_INSTRUCTION_BODY, 'utf-8');
  }
}

/**
 * A committed repo with a gitignored `dist/skills/<name>/` bundle carrying a
 * `CLAUDE.md`, and the project config at the ROOT — several levels above the
 * bundle. The distance is the point: the config root has to be found by walking
 * up, not by resolving the audit target.
 */
function projectWithBundle(
  scope: OverrideScope,
  severity: OverrideSeverity = 'ignore',
): { root: string; bundle: string } {
  const root = createTempDir();
  writeFileSync(safePath.join(root, '.gitignore'), 'dist/\n', 'utf-8');
  writeFileSync(
    safePath.join(root, 'vibe-agent-toolkit.config.yaml'),
    configYaml(scope, severity),
    'utf-8',
  );
  writeSkill(safePath.join(root, 'skills', SKILL_NAME), []);
  commitTestFixture(root);
  const bundle = safePath.join(root, 'dist', 'skills', SKILL_NAME);
  writeSkill(bundle, ['CLAUDE.md']);
  return { root, bundle };
}

/** The same project, with a built plugin tree carrying a `CLAUDE.md` at its root. */
function projectWithPlugin(
  scope: OverrideScope,
  severity: OverrideSeverity = 'ignore',
): { root: string; plugin: string } {
  const { root } = projectWithBundle(scope, severity);
  const plugin = safePath.join(root, 'dist', '.claude', 'plugins', PLUGIN_NAME);
  writeManifest(plugin, 'plugin.json', {
    name: PLUGIN_NAME,
    description: PLUGIN_DESCRIPTION,
    version: '1.0.0',
  });
  writeAgentInstructionFile(plugin);
  return { root, plugin };
}

/**
 * The same project, plus a BUILT marketplace tree under
 * `dist/.claude/plugins/marketplaces/<name>/` whose one plugin carries a
 * `CLAUDE.md` at its root.
 *
 * `LICENSE`, `README.md` and `CHANGELOG.md` are all present on purpose: each of
 * their absences is itself a finding (`MARKETPLACE_MISSING_*`), and this lane's
 * assertions are about the run's overall `status`. A fixture missing them could
 * never reach `success`, so the suppression direction would be unprovable.
 *
 * The project config does NOT declare `claude.marketplaces` — nothing in this
 * lane reads it. The point of the lane is that a marketplace tree's findings are
 * governed by the project-wide `skills.defaults` switch, which is the only scope
 * available: both marketplace config schemas are `.strict()` and neither has a
 * `validation` key, so there is no per-plugin door to knock on.
 */
function projectWithMarketplace(
  scope: OverrideScope,
  severity: OverrideSeverity = 'ignore',
): { root: string; marketplace: string } {
  const { root } = projectWithBundle(scope, severity);
  const marketplace = safePath.join(
    root, 'dist', '.claude', 'plugins', 'marketplaces', MARKETPLACE_NAME,
  );
  const owner = { name: 'Fixture Owner' };
  writeManifest(marketplace, 'marketplace.json', {
    name: MARKETPLACE_NAME,
    owner,
    plugins: [{ name: PLUGIN_NAME, source: `./plugins/${PLUGIN_NAME}` }],
  });
  for (const file of ['LICENSE', 'README.md', 'CHANGELOG.md']) {
    writeFileSync(safePath.join(marketplace, file), 'fixture\n', 'utf-8');
  }

  const plugin = safePath.join(marketplace, 'plugins', PLUGIN_NAME);
  // `author` and `license` are present so the only finding is the CLAUDE.md:
  // strict plugin validation reports missing recommended metadata too.
  writeManifest(plugin, 'plugin.json', {
    name: PLUGIN_NAME,
    description: PLUGIN_DESCRIPTION,
    version: '1.0.0',
    author: owner,
    license: 'MIT',
  });
  writeAgentInstructionFile(plugin);
  return { root, marketplace };
}

/**
 * What `vat verify`'s `marketplace:<name>` phase publishes for a marketplace tree.
 *
 * `status` is taken from the findings themselves, not recomputed here: it is the
 * value the command turns into its exit code (`status === 'error' ? 1 : 0`), and
 * `vat verify` reads that reported status as the phase's status. Asserting it is
 * how the promote direction is shown to reach the exit code rather than merely
 * relabelling a warning.
 */
async function marketplaceOutcome(
  marketplace: string,
): Promise<{ findings: { location: string; severity: string }[]; status: string }> {
  const { issues, status } = await collectMarketplaceFindings(marketplace, silentLogger);
  return {
    findings: issues
      .filter((i) => i.code === CODE)
      .map((i) => ({ location: String(i.location), severity: String(i.severity) })),
    status,
  };
}

/** Agent-instruction findings `vat verify`'s packaged-content phase publishes for `root`. */
async function verifyFindings(root: string): Promise<string[]> {
  const config = loadConfig(root);
  const discovered = config?.skills ? await discoverSkillsFromConfig(config.skills, root) : [];
  return checkPackagedAgentInstructionFiles(root, discovered).map((i) => String(i.location));
}

/** Every agent-instruction issue `vat audit <target>` publishes, AFTER severity resolution. */
async function auditIssues(target: string): Promise<{ location: string; severity: string }[]> {
  resetAuditCaches();
  const { results } = await buildAuditReport(target, {}, Date.now(), silentLogger);
  return results
    .flatMap((r) => r.issues)
    .filter((i) => i.code === CODE)
    .map((i) => ({ location: String(i.location), severity: String(i.severity) }));
}

/** Agent-instruction findings `vat audit <target>` publishes, AFTER severity resolution. */
async function auditFindings(target: string): Promise<string[]> {
  return (await auditIssues(target)).map((i) => i.location);
}

/** The report-level status `vat audit <target>` publishes for the result carrying the finding. */
async function auditStatuses(target: string): Promise<string[]> {
  resetAuditCaches();
  const { results } = await buildAuditReport(target, {}, Date.now(), silentLogger);
  return results.filter((r) => r.issues.some((i) => i.code === CODE)).map((r) => String(r.status));
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

    // The PROMOTE direction. Everything above asks "can I silence this?"; nothing
    // asked "can I enforce this?" — so the audit lane shipped a filter that only
    // knew how to delete (`filter(i => sev[i.code] !== 'ignore')`), and `error`
    // was a silent no-op while `vat verify` on the identical config promoted
    // correctly. One config key, two lanes, opposite answers.
    it('promotes the code to error at skills.defaults, not just suppressing at ignore', async () => {
      const { bundle } = projectWithBundle('defaults', 'error');

      // The issue must still be REPORTED — a promotion that drops the finding is
      // indistinguishable from `ignore` on the location assertions above.
      expect(await auditIssues(bundle)).toEqual([{ location: 'CLAUDE.md', severity: 'error' }]);
    });

    it('promotes the code to error at skills.config.<name> too', async () => {
      const { bundle } = projectWithBundle('per-skill', 'error');
      expect(await auditIssues(bundle)).toEqual([{ location: 'CLAUDE.md', severity: 'error' }]);
    });

    it('re-derives the result status from the promoted severity', async () => {
      // The severity moving without the status moving would leave the report
      // internally contradictory: an `error` issue under `status: warning`.
      await expect(auditStatuses(projectWithBundle('defaults', 'error').bundle)).resolves.toEqual(['error']);
      await expect(auditStatuses(projectWithBundle('none').bundle)).resolves.toEqual(['warning']);
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

    it('promotes to error on a plugin tree, where no per-skill key can name the finding', async () => {
      const { plugin } = projectWithPlugin('defaults', 'error');
      expect(await auditIssues(plugin)).toEqual([{ location: 'CLAUDE.md', severity: 'error' }]);
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

  describe('vat verify, marketplace:<name> phase', () => {
    // The fourth lane, and the one with no other door. `packaged-content` above
    // honoured the override in both directions while this phase honoured it in
    // NEITHER — measured: 2 warnings survived `ignore` at `skills.defaults`, at
    // every per-skill key, and at the plugin's own name. It is a different
    // producer (the marketplace/plugin validators) whose findings reached the
    // report without ever meeting the severity resolver.
    //
    // A project that intends to ship a plugin-root CLAUDE.md — the exact
    // exception this code was kept at `warning` for — therefore could not get
    // `vat verify` to stop reporting it, nor get the run to `status: success`.
    it(CONTROL_CASE,async () => {
      const { marketplace } = projectWithMarketplace('none');
      await expect(marketplaceOutcome(marketplace)).resolves.toEqual({
        findings: [{ location: `plugins/${PLUGIN_NAME}/CLAUDE.md`, severity: 'warning' }],
        status: 'warning',
      });
    });

    it('honours skills.defaults.validation.severity, and the run reaches success', async () => {
      const { marketplace } = projectWithMarketplace('defaults');
      await expect(marketplaceOutcome(marketplace)).resolves.toEqual({
        findings: [],
        status: 'success',
      });
    });

    it('promotes the code to error at skills.defaults, and the run fails', async () => {
      const { marketplace } = projectWithMarketplace('defaults', 'error');
      await expect(marketplaceOutcome(marketplace)).resolves.toEqual({
        findings: [{ location: `plugins/${PLUGIN_NAME}/CLAUDE.md`, severity: 'error' }],
        status: 'error',
      });
    });

    it('resolves the per-plugin issue list the report publishes, not just the flat one', async () => {
      // `plugins[].issues` is a second copy of the same findings in the emitted
      // document. Resolving only the flat list would publish a suppressed warning
      // under `plugins[]` while `issues` omitted it, and leave `plugins[].status`
      // contradicting the run's.
      const { marketplace } = projectWithMarketplace('defaults');
      const { pluginResults } = await collectMarketplaceFindings(marketplace, silentLogger);
      expect(pluginResults.map((r) => ({
        status: r.status,
        codes: r.issues.filter((i) => i.code === CODE).length,
      }))).toEqual([{ status: 'success', codes: 0 }]);
    });
  });
});
