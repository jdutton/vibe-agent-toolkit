/**
 * `vat build` — top-level build orchestration
 *
 * Builds everything the project describes, in dependency order:
 *   1. vat skills build       (portable dist/skills/ output)
 *   2. vat claude plugin build (Claude plugin tree, skipped if no claude config)
 */

import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';

import { checkBrokenPackagedLinks } from '@vibe-agent-toolkit/agent-skills';
import {
  buildReport,
  ExitCode,
  exitCodeForReport,
  toFindings,
  type Report,
  type ValidationIssue,
} from '@vibe-agent-toolkit/schema';
import { direntKindFollowing, safePath } from '@vibe-agent-toolkit/utils';
import { Command } from 'commander';

import { loadConfig } from '../utils/config-loader.js';
import { endWithReport } from '../utils/document-writer.js';
import { formatIssueLines } from '../utils/issue-rendering.js';
import { requireProjectRoot } from '../utils/project-root-policy.js';

import { PLUGIN_BUILD_REPORT_SCHEMA } from './claude/plugin/build-schema.js';
import { runClaudePluginBuildPhase } from './claude/plugin/build.js';
import {
  applyPhaseSelection,
  createPhaseContext,
  DATALESS_PHASE_REPORT_SCHEMA,
  decidePhaseSelection,
  orchestrate,
  ORCHESTRATOR_FORMAT,
  ORCHESTRATOR_GATE,
  runPhase,
  type Phase,
  type PhaseResult,
  type PhaseSelection,
  type PhaseVocabulary,
} from './phase-utils.js';
import { rejectPositionalArguments } from './positional-args.js';
import { SKILLS_BUILD_REPORT_SCHEMA } from './skills/build-schema.js';
import { runSkillsBuildPhase } from './skills/build.js';

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
Arguments:
  None. 'vat build' builds what the config declares; it takes no path and
  rejects one (exit 2) rather than discarding it and building everything.
  To inspect a single skill or bundle by path, use 'vat skill review <path>'.

Description:
  Builds all project artifacts in dependency order.

  Phases:
    skills  → builds dist/skills/ from vibe-agent-toolkit.config.yaml (platform-agnostic)
    claude  → builds dist/.claude/plugins/ from dist/skills/ + config (skipped if no claude config)

  '--only claude' in a project with no claude.marketplaces config is refused
  (USAGE_INVALID, exit 2): the phase is recognized, it is simply not configured.

  publish: false (skills.defaults or skills.config.<name>) marks an IN-PLACE
  skill: validated at source, never bundled into dist/skills/, never expected
  by 'vat verify'. Plugin-local skills (git-tracked, outermost skill dirs
  under a plugin's skills/) ship with their plugin regardless.

  A phase whose report would exit non-zero — an error finding, or a phase that
  did not finish — stops the run: later phases do not execute. So a skills
  phase with an error (e.g. FILENAME_COLLISION) leaves dist/skills/ written but
  NO dist/.claude/ at all. Use '--only claude' to rebuild just the marketplace
  from an existing dist/skills/. Warnings never stop a run. After the claude
  phase, 'shipped-links' checks every skill in the built plugin tree for a
  broken relative link.

Output:
  ONE report envelope (YAML) → stdout: status (ok | findings | error),
  examined (the sum over every phase), summary {errors, warnings, info},
  findings (every phase's, flat), and data.phases — one entry per phase that
  ran, with its own status, examined, summary, error (when it did not finish)
  and the phase's own data. Schema: packages/cli/schemas/orchestrator.json.
  Build progress → stderr (streamed live)

Exit Codes:
  0 - Every phase finished and no finding is an error (warnings never fail)
  1 - An error finding, or nothing was examined at all (RESOURCE_CHECK_BROKEN)
  2 - The run could not do its job: a phase did not finish (RUN_INCOMPLETE,
      the finished phases still in data.phases), '--only' naming an unknown or
      unconfigured phase, a path argument (USAGE_INVALID), no project root

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
 *
 * A config that EXISTS and cannot be loaded throws (`ConfigLoadError`), and
 * that is left to `buildCommand`'s own catch, which publishes it as the
 * build's answer. It used to be absorbed here as "no marketplaces" — so an
 * unreadable config announced a build with no claude phase, and `--only claude`
 * on it was refused as "not configured", which was not the problem.
 */
function hasClaudeMarketplacesConfig(cwd: string): boolean {
  const config = loadConfig(cwd);
  return Boolean(config?.claude?.marketplaces && Object.keys(config.claude.marketplaces).length > 0);
}

// Skill directories shipped inside a built plugin tree — every
// dist/.claude/plugins/marketplaces/{marketplace}/plugins/{plugin}/skills/{skill}
// directory that contains a SKILL.md, regardless of whether it arrived via
// pool import or verbatim tree-copy.
async function collectShippedSkillDirs(marketplacesDir: string): Promise<string[]> {
  const skillDirs: string[] = [];
  if (!existsSync(marketplacesDir)) {
    return skillDirs;
  }

  const marketplaceEntries = await readdir(marketplacesDir, { withFileTypes: true });
  for (const marketplaceEntry of marketplaceEntries) {
    if ((await direntKindFollowing(marketplacesDir, marketplaceEntry)) !== 'directory') continue;
    const pluginsDir = safePath.join(marketplacesDir, marketplaceEntry.name, 'plugins');
    if (!existsSync(pluginsDir)) continue;
    skillDirs.push(...await collectPluginSkillDirs(pluginsDir));
  }

  return skillDirs;
}

async function collectPluginSkillDirs(pluginsDir: string): Promise<string[]> {
  const skillDirs: string[] = [];
  const pluginEntries = await readdir(pluginsDir, { withFileTypes: true });
  for (const pluginEntry of pluginEntries) {
    if ((await direntKindFollowing(pluginsDir, pluginEntry)) !== 'directory') continue;
    const skillsDir = safePath.join(pluginsDir, pluginEntry.name, 'skills');
    if (!existsSync(skillsDir)) continue;
    skillDirs.push(...await collectSkillsInDir(skillsDir));
  }

  return skillDirs;
}

async function collectSkillsInDir(skillsDir: string): Promise<string[]> {
  const skillDirs: string[] = [];
  const skillEntries = await readdir(skillsDir, { withFileTypes: true });
  for (const skillEntry of skillEntries) {
    // Followed: a symlinked skill directory (a dev install) ships like any other.
    if ((await direntKindFollowing(skillsDir, skillEntry)) !== 'directory') continue;
    const skillDir = safePath.join(skillsDir, skillEntry.name);
    if (existsSync(safePath.join(skillDir, 'SKILL.md'))) {
      skillDirs.push(skillDir);
    }
  }

  return skillDirs;
}

/** The phase `vat build` runs after `claude`: the shipped plugin tree's links. */
const SHIPPED_LINKS = 'shipped-links';

/**
 * Run the depth-free packaged-link check (checkBrokenPackagedLinks) against
 * every shipped skill dir inside the built plugin tree(s) at
 * <cwd>/dist/.claude/plugins/marketplaces/, as a report over the skill dirs it
 * inspected. Each finding's `location` is relative to its skill dir.
 *
 * Scoped per skill dir — the skill directory IS the validation boundary. VAT's
 * stance is that a skill is a self-contained, portable unit (it may be mounted
 * standalone — claude.ai upload, API container — where sibling skills do not
 * exist), so a link that escapes the skill's own directory (e.g.
 * `../other-skill/references/foo.md`) is a broken shipped link even when that
 * sibling happens to co-ship in the same plugin. The only correct way for a
 * skill to use another skill's file is to bundle its own copy in and link it as
 * `./foo.md`. This matches how the pool packager already scopes the same check
 * on dist/skills/<name>/.
 */
export async function checkShippedPluginSkillLinks(cwd: string): Promise<Report<null>> {
  const marketplacesDir = safePath.join(cwd, 'dist', '.claude', 'plugins', 'marketplaces');
  const skillDirs = await collectShippedSkillDirs(marketplacesDir);

  const issues: ValidationIssue[] = [];
  for (const skillDir of skillDirs) {
    issues.push(...await checkBrokenPackagedLinks(skillDir));
  }
  return buildReport({ examined: skillDirs.length, findings: toFindings(issues), data: null, gate: ORCHESTRATOR_GATE });
}

/**
 * The `shipped-links` phase over `cwd`'s built plugin tree — run through
 * `runPhase` like every other, so a throw from the crawl is THIS phase's
 * refusal with the finished phases still published, and its report is held to
 * its schema.
 */
function shippedLinksPhase(cwd: string): Phase {
  return {
    name: SHIPPED_LINKS,
    schema: DATALESS_PHASE_REPORT_SCHEMA,
    run: async () => ({ report: await checkShippedPluginSkillLinks(cwd) }),
  };
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
  // A flag not forwarded here is a flag the composite command silently cannot
  // express: `vat build` would always get the collapsed report with no way to
  // ask for the full one.
  if (!only || only === 'skills') {
    phases.push({ name: 'skills', schema: SKILLS_BUILD_REPORT_SCHEMA, run: () => runSkillsBuildPhase(undefined, { verbose }) });
  }

  if ((!only || only === 'claude') && hasClaudeMarketplaces) {
    phases.push({ name: 'claude', schema: PLUGIN_BUILD_REPORT_SCHEMA, run: () => runClaudePluginBuildPhase({ verbose }) });
  }

  return decidePhaseSelection(only, phases, BUILD_VOCABULARY);
}

/** Whether a phase's report stops the build: it would end the run on a non-zero exit. */
function stopsTheBuild(result: PhaseResult): boolean {
  return exitCodeForReport(result.report) !== ExitCode.OK;
}

/** Test seam: which phase report stops the build. */
export const __internal = { stopsTheBuild };

async function buildTopLevelCommand(
  options: BuildCommandOptions,
  command: Command,
): Promise<void> {
  const cwd = process.cwd();
  const { logger } = createPhaseContext(options.debug);

  const report = await orchestrate(async (results) => {
    // First, and before requireProjectRoot: `vat build dist/skills/demo` used to be
    // accepted, have its path discarded, and build the WHOLE project.
    rejectPositionalArguments(
      command.args,
      'vat build',
      'builds every artifact vibe-agent-toolkit.config.yaml declares, in dependency order',
    );
    // Spec §7: `vat build` requires a projectRoot.
    requireProjectRoot(cwd, 'vat build');
    const phases = applyPhaseSelection(
      selectBuildPhases(options.only, hasClaudeMarketplacesConfig(cwd), options.verbose === true),
      logger,
    );

    logger.info(`🔨 vat build (phases: ${phases.map((p) => p.name).join(' → ')})`);

    for (const phase of phases) {
      logger.info(`\n▶ Phase: ${phase.name}`);
      // Awaited in the loop, deliberately, and here it is a DEPENDENCY rather
      // than a presentation choice: `claude` packages what `skills` just wrote
      // into dist/, so overlapping the two would read a half-built tree.
      const result = await runPhase(phase);
      results.push(result);
      // Only a report that would fail the run stops it: a warning never does.
      if (stopsTheBuild(result)) return;

      if (phase.name === 'claude') {
        const shipped = await runPhase(shippedLinksPhase(cwd));
        results.push(shipped);
        for (const finding of shipped.report.findings) {
          for (const line of formatIssueLines(finding, '  ')) logger.error(line);
        }
        if (stopsTheBuild(shipped)) return;
      }
    }
    logger.info(`\n✅ Build complete`);
  });
  endWithReport('build', report, ORCHESTRATOR_FORMAT);
}
