/**
 * `vat build` — top-level build orchestration
 *
 * Builds everything the project describes, in dependency order:
 *   1. vat skills build       (portable dist/skills/ output)
 *   2. vat claude plugin build (Claude plugin tree, skipped if no claude config)
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';

import { type ValidationIssue } from '@vibe-agent-toolkit/agent-schema';
import { checkBrokenPackagedLinks } from '@vibe-agent-toolkit/agent-skills';
import { safePath } from '@vibe-agent-toolkit/utils';
import { Command } from 'commander';

import { handleCommandError } from '../utils/command-error.js';
import { loadConfig } from '../utils/config-loader.js';
import { writeYamlOutput } from '../utils/output.js';
import { requireProjectRoot } from '../utils/project-root-policy.js';

import { createPhaseContext, type Phase } from './phase-utils.js';

export interface BuildCommandOptions {
  only?: string;
  debug?: boolean;
}

export function createBuildTopLevelCommand(): Command {
  const command = new Command('build');

  command
    .description('Build all project artifacts in dependency order (skills → claude plugin tree)')
    .option('--only <phase>', 'Build only a specific phase: skills, claude')
    .option('--debug', 'Enable debug logging')
    .action(buildTopLevelCommand)
    .addHelpText(
      'after',
      `
Description:
  Builds all project artifacts in dependency order.

  Phases:
    skills  → builds dist/skills/ from vibe-agent-toolkit.config.yaml (platform-agnostic)
    claude  → builds dist/.claude/plugins/ from dist/skills/ + config (skipped if no claude config)

Output:
  YAML summary for each phase → stdout
  Build progress → stderr

Exit Codes:
  0 - All phases completed successfully
  1 - Build error
  2 - System error

Requirements:
  projectRoot: required (errors if no vibe-agent-toolkit.config.yaml or .git/ ancestor)
  config:      required file with required fields per orchestrated phase

  See docs/concepts/roots-and-config.md for terminology.

Example:
  $ vat build                         # Build everything
  $ vat build --only skills           # Build portable skills only
  $ vat build --only claude           # Build Claude plugin tree only
`
    );

  return command;
}

/**
 * Check whether the current project has a claude.marketplaces config.
 * Returns false if no config file found or no claude section.
 */
function hasClaudeMarketplacesConfig(cwd: string): boolean {
  try {
    const config = loadConfig(cwd);
    return Boolean(config?.claude?.marketplaces && Object.keys(config.claude.marketplaces).length > 0);
  } catch {
    return false;
  }
}

// Skill directories shipped inside a built plugin tree — every
// dist/.claude/plugins/marketplaces/{marketplace}/plugins/{plugin}/skills/{skill}
// directory that contains a SKILL.md, regardless of whether it arrived via
// pool import or verbatim tree-copy.
async function collectShippedSkillDirs(marketplacesDir: string): Promise<string[]> {
  const skillDirs: string[] = [];
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- marketplacesDir is derived from cwd
  if (!existsSync(marketplacesDir)) {
    return skillDirs;
  }

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- marketplacesDir is derived from cwd
  const marketplaceEntries = await readdir(marketplacesDir, { withFileTypes: true });
  for (const marketplaceEntry of marketplaceEntries) {
    if (!marketplaceEntry.isDirectory()) continue;
    const pluginsDir = safePath.join(marketplacesDir, marketplaceEntry.name, 'plugins');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- pluginsDir derived from marketplacesDir listing
    if (!existsSync(pluginsDir)) continue;
    skillDirs.push(...await collectPluginSkillDirs(pluginsDir));
  }

  return skillDirs;
}

async function collectPluginSkillDirs(pluginsDir: string): Promise<string[]> {
  const skillDirs: string[] = [];
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- pluginsDir derived from marketplacesDir listing
  const pluginEntries = await readdir(pluginsDir, { withFileTypes: true });
  for (const pluginEntry of pluginEntries) {
    if (!pluginEntry.isDirectory()) continue;
    const skillsDir = safePath.join(pluginsDir, pluginEntry.name, 'skills');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- skillsDir derived from pluginsDir listing
    if (!existsSync(skillsDir)) continue;
    skillDirs.push(...await collectSkillsInDir(skillsDir));
  }

  return skillDirs;
}

async function collectSkillsInDir(skillsDir: string): Promise<string[]> {
  const skillDirs: string[] = [];
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- skillsDir derived from pluginsDir listing
  const skillEntries = await readdir(skillsDir, { withFileTypes: true });
  for (const skillEntry of skillEntries) {
    if (!skillEntry.isDirectory()) continue;
    const skillDir = safePath.join(skillsDir, skillEntry.name);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- skillDir derived from skillsDir listing
    if (existsSync(safePath.join(skillDir, 'SKILL.md'))) {
      skillDirs.push(skillDir);
    }
  }

  return skillDirs;
}

// Run the depth-free packaged-link check (checkBrokenPackagedLinks) against
// every shipped skill dir inside the built plugin tree(s) at
// <cwd>/dist/.claude/plugins/marketplaces/. Scoped per skill dir — the skill
// directory IS the validation boundary. VAT's stance is that a skill is a
// self-contained, portable unit (it may be mounted standalone — claude.ai
// upload, API container — where sibling skills do not exist), so a link that
// escapes the skill's own directory (e.g. `../other-skill/references/foo.md`)
// is a broken shipped link even when that sibling happens to co-ship in the
// same plugin. The only correct way for a skill to use another skill's file
// is to bundle its own copy in and link it as `./foo.md`. This matches how
// the pool packager already scopes the same check on dist/skills/<name>/.
export async function validateShippedPluginSkillLinks(cwd: string): Promise<ValidationIssue[]> {
  const marketplacesDir = safePath.join(cwd, 'dist', '.claude', 'plugins', 'marketplaces');
  const skillDirs = await collectShippedSkillDirs(marketplacesDir);

  const issues: ValidationIssue[] = [];
  for (const skillDir of skillDirs) {
    issues.push(...await checkBrokenPackagedLinks(skillDir));
  }
  return issues;
}

function buildPhaseList(options: BuildCommandOptions, cwd: string): Phase[] {
  const { only } = options;
  const phases: Phase[] = [];

  if (!only || only === 'skills') {
    phases.push({ name: 'skills', args: ['skills', 'build'] });
  }

  if (!only || only === 'claude') {
    // Only include the claude phase when a marketplace config is present
    if (hasClaudeMarketplacesConfig(cwd)) {
      phases.push({ name: 'claude', args: ['claude', 'plugin', 'build'] });
    }
  }

  return phases;
}

async function buildTopLevelCommand(options: BuildCommandOptions): Promise<void> {
  const cwd = process.cwd();
  // Spec §7: `vat build` requires a projectRoot.
  requireProjectRoot(cwd, 'vat build');

  const phases = buildPhaseList(options, cwd);
  const { logger, startTime, binPath } = createPhaseContext(options.debug, phases, options.only, 'skills, claude');

  try {
    logger.info(`🔨 vat build (phases: ${phases.map((p) => p.name).join(' → ')})`);

    for (const phase of phases) {
      logger.info(`\n▶ Phase: ${phase.name}`);
      const result = spawnSync(process.execPath, [binPath, ...phase.args], {
        stdio: ['inherit', 'inherit', 'inherit'],
      });

      if (result.status !== 0) {
        const duration = Date.now() - startTime;
        writeYamlOutput({
          status: 'error',
          error: `Phase '${phase.name}' failed with exit code ${result.status ?? 'unknown'}`,
          phase: phase.name,
          duration: `${duration}ms`,
        });
        process.exit(result.status ?? 1);
      }

      if (phase.name === 'claude') {
        const shippedLinkIssues = await validateShippedPluginSkillLinks(cwd);
        const brokenLinkErrors = shippedLinkIssues.filter((issue) => issue.severity === 'error');
        if (brokenLinkErrors.length > 0) {
          const duration = Date.now() - startTime;
          writeYamlOutput({
            status: 'error',
            error: `Shipped plugin skill tree has ${brokenLinkErrors.length} broken link(s)`,
            phase: phase.name,
            issues: brokenLinkErrors,
            duration: `${duration}ms`,
          });
          process.exit(1);
        }
      }
    }

    const duration = Date.now() - startTime;
    logger.info(`\n✅ Build complete`);
    writeYamlOutput({
      status: 'success',
      phasesCompleted: phases.map((p) => p.name),
      duration: `${duration}ms`,
    });

    process.exit(0);
  } catch (error) {
    handleCommandError(error, logger, startTime, 'Build');
  }
}
