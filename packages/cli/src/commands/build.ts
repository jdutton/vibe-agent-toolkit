/**
 * `vat build` — top-level build orchestration
 *
 * Builds everything the project describes, in dependency order:
 *   1. vat skills build       (portable dist/skills/ output)
 *   2. vat claude plugin build (Claude plugin tree, skipped if no claude config)
 */

import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';

import {
  calculateValidationStatus,
  countBySeverity,
  type ValidationIssue,
} from '@vibe-agent-toolkit/agent-schema';
import { checkBrokenPackagedLinks } from '@vibe-agent-toolkit/agent-skills';
import { safePath } from '@vibe-agent-toolkit/utils';
import { Command } from 'commander';

import { handleCommandError } from '../utils/command-error.js';
import { loadConfig } from '../utils/config-loader.js';
import { sumSeverityCounts } from '../utils/issue-rendering.js';
import { writeYamlOutput } from '../utils/output.js';
import { requireProjectRoot } from '../utils/project-root-policy.js';

import {
  aggregatePhaseIssueCounts,
  aggregatePhaseStatus,
  applyPhaseSelection,
  createPhaseContext,
  decidePhaseSelection,
  exitCodeForPhases,
  runPhase,
  SYSTEM_ERROR,
  worseOf,
  type Phase,
  type PhaseResult,
  type PhaseSelection,
  type PhaseVocabulary,
} from './phase-utils.js';

export interface BuildCommandOptions {
  only?: string;
  debug?: boolean;
  verbose?: boolean;
}

export function createBuildTopLevelCommand(): Command {
  const command = new Command('build');

  command
    .description('Build all project artifacts in dependency order (skills → claude plugin tree)')
    .option('--only <phase>', 'Build only a specific phase: skills, claude')
    .option('-v, --verbose', 'Show every individual finding, not just the errors')
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

  '--only claude' in a project with no claude.marketplaces config fails with
  exit 1: the phase is recognized, it is simply not configured.

  A phase that ERRORS stops the run: later phases do not execute. So a skills
  phase that exits 1 (e.g. on FILENAME_COLLISION) leaves dist/skills/ written
  but NO dist/.claude/ at all — a per-skill finding is reported rather than
  thrown, but the phase's non-zero exit still gates the marketplace artifact
  behind a skill tree that built cleanly. Use '--only claude' to rebuild just
  the marketplace from an existing dist/skills/. Warnings never stop a run.

Output:
  ONE YAML document → stdout
    status (success | warning | error | system-error) plus issueCounts
    {errors, warnings, info} summed across EVERY phase and the shipped-plugin-
    tree link check, and the findings themselves when there are any — a
    warning-only build reports 'warning' with counts, not a bare 'success'.
    The total reconciles against the phases printed beneath it; a header that
    counted only the link check reported {0,0,0} over children that had just
    reported 12 warnings. Each phase's own report is captured and nested under
    'report' rather than streamed through.
  Build progress → stderr (streamed live)

Exit Codes:
  0 - All phases completed successfully (warnings do not fail a build)
  1 - Build error, or '--only' named a phase that is unrecognized or unconfigured
  2 - System error (this command's own, or propagated from a phase that could
      not run: exited 2, was killed by a signal, was never spawned, or wrote
      output that could not be parsed)

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

/** Phases `vat build` knows how to run, in dependency order. */
const VALID_PHASES = ['skills', 'claude'] as const;

const BUILD_VOCABULARY: PhaseVocabulary = {
  noun: 'Phase',
  verb: 'build',
  validNames: VALID_PHASES,
};

/**
 * Decide which build phases to run.
 *
 * `--only claude` in a project with no `claude.marketplaces` used to produce an
 * empty phase list, which the old `createPhaseContext` reported by THROWING
 * "Unknown phase: claude. Valid phases: skills, claude." — a message that
 * refutes itself in its own second sentence, thrown from outside the try block
 * so it reached the user as a Node stack trace with no structured output at all.
 * The phase is recognized; it is simply not configured, which is a different
 * fact and now says so.
 */
export function selectBuildPhases(
  only: string | undefined,
  hasClaudeMarketplaces: boolean,
  verbose = false,
): PhaseSelection {
  const phases: Phase[] = [];
  // Each phase is a separate spawned process, so a flag not forwarded here is a
  // flag the composite command silently cannot express: `vat build` would always
  // get the collapsed report with no way to ask for the full one.
  const verboseArgs = verbose ? ['--verbose'] : [];

  if (!only || only === 'skills') {
    phases.push({ name: 'skills', args: ['skills', 'build', ...verboseArgs] });
  }

  if ((!only || only === 'claude') && hasClaudeMarketplaces) {
    phases.push({ name: 'claude', args: ['claude', 'plugin', 'build', ...verboseArgs] });
  }

  return decidePhaseSelection(only, phases, BUILD_VOCABULARY);
}

async function buildTopLevelCommand(options: BuildCommandOptions): Promise<void> {
  const cwd = process.cwd();
  // Spec §7: `vat build` requires a projectRoot.
  requireProjectRoot(cwd, 'vat build');

  const { logger, startTime, binPath } = createPhaseContext(options.debug);

  try {
    // Inside the try, deliberately: this used to throw from outside it, so an
    // unroutable `--only` produced a raw stack trace and zero bytes of stdout.
    const phases = applyPhaseSelection(
      selectBuildPhases(options.only, hasClaudeMarketplacesConfig(cwd), options.verbose === true),
      logger,
      startTime,
    );

    logger.info(`🔨 vat build (phases: ${phases.map((p) => p.name).join(' → ')})`);

    const phaseResults: PhaseResult[] = [];
    // Shipped-link findings survive the loop so the final payload can publish
    // their distribution. They used to be filtered to errors and the rest
    // dropped on the floor: a build that emitted warnings said `success` with
    // nothing beside it.
    let shippedLinkIssues: ValidationIssue[] = [];

    for (const phase of phases) {
      logger.info(`\n▶ Phase: ${phase.name}`);
      const result = runPhase(binPath, phase);
      phaseResults.push(result);

      // Only a real failure stops the build. A `warning` phase must NOT abort:
      // warnings are non-blocking everywhere else in VAT, and phase status only
      // became able to say `warning` when it started being read from the child's
      // report instead of its exit code — so treating "not success" as fatal
      // silently turned every warning into a halt. It halted *and* claimed
      // "Phase 'skills' failed with exit code 0" while exiting 0, so a caller
      // checking the exit code saw a pass with the later phases never run.
      if (result.status === 'error' || result.status === SYSTEM_ERROR) {
        const duration = Date.now() - startTime;
        // `error` vs `system-error` is the difference between "the build failed"
        // and "the build never ran" — exit 1 vs the documented exit 2.
        writeYamlOutput({
          status: result.status,
          error: result.error ?? `Phase '${phase.name}' failed with exit code ${result.exitCode ?? 'unknown'}`,
          phase: phase.name,
          phases: phaseResults,
          // The failing phase's OWN counts are the point of this document — a
          // header of `{0, 0, 0}` on the abort path told a reader the build had
          // nothing to act on, on the one path where it certainly did.
          issueCounts: sumSeverityCounts([
            aggregatePhaseIssueCounts(phaseResults),
            countBySeverity(shippedLinkIssues),
          ]),
          duration: `${duration}ms`,
        });
        process.exit(exitCodeForPhases(phaseResults));
      }

      if (phase.name === 'claude') {
        shippedLinkIssues = await validateShippedPluginSkillLinks(cwd);
        const issueCounts = countBySeverity(shippedLinkIssues);
        if (issueCounts.errors > 0) {
          const duration = Date.now() - startTime;
          writeYamlOutput({
            status: 'error',
            error: `Shipped plugin skill tree has ${issueCounts.errors} broken link(s)`,
            phase: phase.name,
            issueCounts,
            issues: shippedLinkIssues,
            duration: `${duration}ms`,
          });
          process.exit(1);
        }
      }
    }

    const duration = Date.now() - startTime;
    // Both sources, for the same reason `status` below reads both: a header that
    // counts only the shipped-link pass reported `{0, 0, 0}` over phases that had
    // just published 12 warnings, so a CI job reading the machine total saw a
    // clean build while `status` beside it said `warning`.
    const issueCounts = sumSeverityCounts([
      aggregatePhaseIssueCounts(phaseResults),
      countBySeverity(shippedLinkIssues),
    ]);
    // The shipped-link tally alone drives the human line below — it names what is
    // wrong with THIS tree, and the phases already printed their own.
    const shippedCounts = countBySeverity(shippedLinkIssues);
    if (shippedLinkIssues.length === 0) {
      logger.info(`\n✅ Build complete`);
    } else {
      logger.info(
        `\n✅ Build complete — ${shippedCounts.warnings} warning(s), ${shippedCounts.info} info in the shipped plugin tree`,
      );
      for (const issue of shippedLinkIssues) {
        logger.error(`  ${issue.severity.toUpperCase()} [${issue.code}] ${issue.message}`);
      }
    }
    // Warnings and info findings do not fail a build, but they are published:
    // `success` must mean "nothing you must act on", never "there was nothing
    // to see".
    // Worst-wins across BOTH sources. Reading only the shipped-link issues made
    // a run whose child phase reported `warning` publish `success`, which is the
    // same blindness `vat verify` had: a status that cannot see what the child
    // already said.
    writeYamlOutput({
      status: worseOf(
        aggregatePhaseStatus(phaseResults),
        calculateValidationStatus(shippedLinkIssues),
      ),
      phasesCompleted: phases.map((p) => p.name),
      phases: phaseResults,
      issueCounts,
      ...(shippedLinkIssues.length === 0 ? {} : { issues: shippedLinkIssues }),
      duration: `${duration}ms`,
    });

    process.exit(0);
  } catch (error) {
    handleCommandError(error, logger, startTime, 'Build');
  }
}
