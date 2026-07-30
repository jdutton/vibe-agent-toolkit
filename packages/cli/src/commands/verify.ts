/**
 * `vat verify` — top-level verification orchestration
 *
 * Validates everything in scope, in dependency order:
 *   1. vat resources validate  (link integrity, collection schemas)
 *   2. vat skills validate     (SKILL.md frontmatter validation)
 *   3. vat claude marketplace validate  (strict marketplace validation, when configured)
 *   4. consistency check  (skill distribution integrity — package.json, plugin assignment)
 */

import { existsSync } from 'node:fs';
import { basename } from 'node:path';

import {
  calculateValidationStatus,
  countBySeverity,
  type SeverityCounts,
  type ValidationIssue,
} from '@vibe-agent-toolkit/agent-schema';
import { computeTreeCopiedSkillLocations, mergeFilesConfig } from '@vibe-agent-toolkit/agent-skills';
import type { ProjectConfig } from '@vibe-agent-toolkit/resources';
import { safePath } from '@vibe-agent-toolkit/utils';
import { Command } from 'commander';

import { handleCommandError } from '../utils/command-error.js';
import { loadConfig } from '../utils/config-loader.js';
import type { createLogger } from '../utils/logger.js';
import { writeYamlOutput } from '../utils/output.js';
import { requireProjectRoot } from '../utils/project-root-policy.js';

import {
  runConsistencyChecks,
  type ConsistencyIssue,
  type ConsistencyIssueSeverity,
} from './consistency-check.js';
import {
  aggregatePhaseStatus,
  applyPhaseSelection,
  createPhaseContext,
  decidePhaseSelection,
  exitCodeForPhases,
  runPhase,
  type Phase,
  type PhaseResult,
  type PhaseSelection,
  type PhaseVocabulary,
} from './phase-utils.js';
import { discoverSkillsFromConfig } from './skills/skill-discovery.js';

export interface VerifyCommandOptions {
  only?: string;
  debug?: boolean;
}

export function createVerifyTopLevelCommand(): Command {
  const command = new Command('verify');

  command
    .description('Verify built artifacts (resources + skills + marketplace + consistency); marketplace/consistency read dist/ — run after vat build')
    .option('--only <phase>', 'Verify only a specific phase: resources, skills, marketplace, consistency')
    .option('--debug', 'Enable debug logging')
    .action(verifyTopLevelCommand)
    .addHelpText(
      'after',
      `
Description:
  Verifies all project artifacts. The marketplace and consistency phases
  read the built dist/ tree, so run this after 'vat build'.

  For source-only validation that needs no build (resources + skills,
  suitable for pre-commit and CI-before-build), use 'vat validate'.

  Config-driven, exactly like 'vat validate': a phase runs only when its
  config block is present. An explicit '--only <phase>' fails for a phase
  that is unrecognized or unconfigured, so a CI gate cannot silently lose
  coverage when a config key is renamed.

  Phases:
    resources    → link integrity, collection frontmatter schemas (when 'resources:' configured)
    skills       → SKILL.md frontmatter and packaging validation (when 'skills:' configured)
    marketplace  → strict marketplace validation (when 'claude.marketplaces:' configured)
    consistency  → skill distribution integrity (package.json, plugin assignment)

Output:
  ONE YAML document → stdout
    per phase: status (success | warning | error | system-error). A subprocess
    phase's own report is captured and nested under 'report', so the whole run
    is a single parseable document (a phase's stdout is never streamed
    through). A phase's status comes from the child's REPORTED status, not
    from its exit code — an exit code cannot express 'warning'. In-process
    phases (consistency, files-config-dests) also publish issueCounts
    {errors, warnings, info} and the findings themselves.
  Progress and validation errors → stderr (streamed live)

Exit Codes:
  0 - All phases passed (a warning does not fail the run — read status/issueCounts)
  1 - Validation errors found, or '--only' named a phase that is unrecognized
      or unconfigured (an explicit request for a phase that cannot run)
  2 - System error (this command's own, or propagated from a phase that could
      not run: exited 2, was killed by a signal, was never spawned, or wrote
      output that could not be parsed)

Requirements:
  projectRoot: required (errors if no vibe-agent-toolkit.config.yaml or .git/ ancestor)
  config:      required file (used to discover phases and outputs)

  See docs/concepts/roots-and-config.md for terminology.

Example:
  $ vat verify                         # Verify everything
  $ vat verify --only skills           # Verify skills only
  $ vat verify --only marketplace      # Verify marketplace only
`
    );

  return command;
}

/** Result of checking files config dests for a single (skill, outputDir) pair */
export interface FilesDestCheckResult {
  skillName: string;
  /** The actual output directory that was checked (pool dir or plugin-tree dir). */
  outputDir: string;
  missing: string[];
}

/**
 * Sanitize skill names with colon namespaces for filesystem paths.
 * Mirrors the logic in build.ts.
 */
function skillNameToFsPath(name: string): string {
  return name.replaceAll(':', '__');
}

/** Internal pending-check record: one per (skillName, outputDir) candidate. */
type CheckEntry = {
  skillName: string;
  outputDir: string;
  mergedFiles: ReturnType<typeof mergeFilesConfig>;
};

/**
 * Register a check for (skillName, outputDir, mergedFiles) in the dedup map.
 *
 * Skips silently if:
 *   - mergedFiles is empty (no entries to verify)
 *   - outputDir does not exist on disk (not a candidate)
 *   - the key was already added (dedup guard)
 */
function tryAddCheckEntry(
  checks: Map<string, CheckEntry>,
  skillName: string,
  outputDir: string,
  mergedFiles: ReturnType<typeof mergeFilesConfig>,
): void {
  if (mergedFiles.length === 0) return;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- outputDir is resolved from config, not user input
  if (!existsSync(outputDir)) return;
  const key = `${skillName}\0${outputDir}`;
  if (!checks.has(key)) {
    checks.set(key, { skillName, outputDir, mergedFiles });
  }
}

/**
 * Check that all dest paths from the merged files config exist in the built output.
 *
 * Checks each skill's dests in the location(s) where `vat build` actually wrote them:
 *   - Pool skills: `dist/skills/<fsName>/`            (only when that dir exists)
 *   - Tree-copy skills: `dist/.claude/plugins/.../skills/<name>/` (only when that dir exists)
 *
 * A dest is "missing" ONLY when absent from a candidate dir that exists. If a skill
 * has no existing candidate dir, it is not reported (build didn't run for that mode).
 *
 * @returns One result per (skill, outputDir) pair where dests are absent.
 */
export function checkFilesConfigDests(cwd: string): FilesDestCheckResult[] {
  try {
    const config = loadConfig(cwd);
    if (!config) return [];

    const skillsConfig = config.skills;
    const defaults = skillsConfig?.defaults;

    // Dedup map: key = `skillName\0outputDir` → check entry
    const checks = new Map<string, CheckEntry>();

    // --- Pool/config skills: candidate dir is dist/skills/<fsName> ---
    for (const skillName of Object.keys(skillsConfig?.config ?? {})) {
      const perSkill = skillsConfig?.config?.[skillName];
      const mergedFiles = mergeFilesConfig(defaults?.files, perSkill?.files);
      const outputDir = safePath.resolve(cwd, 'dist', 'skills', skillNameToFsPath(skillName));
      tryAddCheckEntry(checks, skillName, outputDir, mergedFiles);
    }

    // --- Tree-copy skills: candidate dirs are plugin output skill dirs ---
    for (const loc of computeTreeCopiedSkillLocations(config, cwd)) {
      // Per-skill config is keyed by the skill's declared NAME. `skillDirPath` is a
      // path (`group/nested-skill` for a nested skill), so try its trailing segment
      // too — the spelling that matches for every skill whose dir is named after it.
      const dirLeaf = basename(loc.skillDirPath);
      const perSkill = skillsConfig?.config?.[loc.skillDirPath] ?? skillsConfig?.config?.[dirLeaf];
      const mergedFiles = mergeFilesConfig(defaults?.files, perSkill?.files);
      tryAddCheckEntry(checks, loc.skillDirPath, loc.skillOutputDir, mergedFiles);
    }

    // --- Run each pending check and collect results ---
    const results: FilesDestCheckResult[] = [];
    for (const { skillName, outputDir, mergedFiles } of checks.values()) {
      const missing: string[] = [];
      for (const entry of mergedFiles) {
        const destPath = safePath.resolve(outputDir, entry.dest);
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- destPath resolved from config
        if (!existsSync(destPath)) {
          missing.push(entry.dest);
        }
      }
      if (missing.length > 0) {
        results.push({ skillName, outputDir, missing });
      }
    }

    return results;
  } catch {
    return [];
  }
}

/**
 * Load the project config without letting a broken one abort the command.
 *
 * A config that exists but does not parse is reported as `error` rather than
 * swallowed as "no config": `vat verify` must not answer "that phase is not
 * configured" when it could not read the configuration at all.
 */
function loadConfigTolerant(cwd: string): { config: ProjectConfig | undefined; error?: string } {
  try {
    return { config: loadConfig(cwd) };
  } catch (error) {
    return { config: undefined, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Log files-config-dests errors to stderr.
 */
function reportFilesDestErrors(
  results: FilesDestCheckResult[],
  logger: ReturnType<typeof createLogger>
): void {
  logger.error('\n▶ Phase: files-config-dests');
  for (const { skillName, outputDir, missing } of results) {
    logger.error(`  Skill '${skillName}': missing dest file(s) in ${outputDir}/:`);
    for (const dest of missing) {
      logger.error(`    - ${dest}`);
    }
  }
}

/**
 * Log consistency check issues to stderr.
 */
function reportConsistencyIssues(
  issues: ConsistencyIssue[],
  logger: ReturnType<typeof createLogger>
): void {
  logger.error('\n▶ Phase: consistency');

  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  const infos = issues.filter((i) => i.severity === 'info');

  for (const issue of errors) {
    logger.error(`  ERROR [${issue.code}]: ${issue.message}`);
    logger.error(`    Fix: ${issue.fix}`);
  }
  for (const issue of warnings) {
    logger.error(`  WARN [${issue.code}]: ${issue.message}`);
    logger.error(`    Fix: ${issue.fix}`);
  }
  for (const issue of infos) {
    logger.info(`  INFO [${issue.code}]: ${issue.message}`);
  }
}

/** Phases `vat verify` knows how to run, in stable execution order. */
const VALID_PHASES = ['resources', 'skills', 'marketplace', 'consistency'] as const;

const VERIFY_VOCABULARY: PhaseVocabulary = {
  noun: 'Phase',
  verb: 'verify',
  validNames: VALID_PHASES,
  noop: {
    warning:
      'No resources:, skills: or claude.marketplaces: block found in vibe-agent-toolkit.config.yaml — nothing to verify. If this is unexpected, check your config.',
    note: 'No configured phases (no resources, skills or claude.marketplaces block in vibe-agent-toolkit.config.yaml).',
  },
};

/**
 * Decide which verification phases to run.
 *
 * Config-gated, exactly as `vat validate` is. It used to push `resources` and
 * `skills` unconditionally, so `vat verify --only skills` in a project with no
 * `skills:` block exited 0 while `vat validate --only skills` on the same
 * project exited 1 — same question, opposite verdicts, and a CI gate pinned to
 * the verify form stayed green forever the moment the config key was renamed.
 *
 * `consistency` runs in-process (see {@link runConsistencyPhase}), so an empty
 * subprocess list is a legitimate outcome for `--only consistency` only.
 *
 * @param configError - The config-load failure, when the config could not be
 *   read. The requested subprocess phases still run so the CHILD reports the
 *   real config error (exit 2) instead of this command guessing.
 */
export function selectVerifyPhases(
  only: string | undefined,
  config: ProjectConfig | undefined,
  configError?: string,
): PhaseSelection {
  const phases: Phase[] = [];
  const unreadable = configError !== undefined;

  if ((!only || only === 'resources') && (unreadable || config?.resources)) {
    phases.push({ name: 'resources', args: ['resources', 'validate'] });
  }

  if ((!only || only === 'skills') && (unreadable || config?.skills)) {
    phases.push({ name: 'skills', args: ['skills', 'validate'] });
  }

  if (!only || only === 'marketplace') {
    for (const name of Object.keys(config?.claude?.marketplaces ?? {})) {
      phases.push({
        name: `marketplace:${name}`,
        args: ['claude', 'marketplace', 'validate', `dist/.claude/plugins/marketplaces/${name}`],
      });
    }
  }

  return decidePhaseSelection(only, phases, VERIFY_VOCABULARY, {
    emptyIsValid: only === 'consistency',
    unreadableConfig: configError,
  });
}

/** A consistency finding as it appears in the archived YAML. */
interface PublishedConsistencyIssue {
  severity: ConsistencyIssueSeverity;
  code: string;
  message: string;
  fix: string;
}

/**
 * A phase result that carries its own findings into the archived YAML.
 *
 * Extends {@link PhaseResult} rather than widening it: only in-process phases
 * hold findings — a subprocess phase's findings belong to (and are printed by)
 * the child.
 */
interface FindingsPhaseResult extends PhaseResult {
  issueCounts: SeverityCounts;
  issues: PublishedConsistencyIssue[];
}

/**
 * `ConsistencyIssue` speaks the same severity vocabulary as `ValidationIssue`
 * but carries a free-form `code`, so it is counted through this projection —
 * there must be exactly ONE issues→status/counts collapse in the codebase, and
 * it lives in `@vibe-agent-toolkit/agent-schema`.
 */
function asValidationIssues(issues: readonly ConsistencyIssue[]): ValidationIssue[] {
  return issues.map((issue) => ({
    code: issue.code as ValidationIssue['code'],
    severity: issue.severity,
    message: issue.message,
    fix: issue.fix,
  }));
}

/**
 * Run the in-process consistency check phase and record its outcome.
 *
 * The findings are published INTO the phase result, not merely logged: they used
 * to go to stderr only, so the archived YAML — the artifact of record — said
 * nothing happened. And a warning-only run reported `passed`, which is the
 * reassuring answer to a question it could not represent.
 */
async function runConsistencyPhase(
  logger: ReturnType<typeof createLogger>,
  phaseResults: PhaseResult[],
  explicitlyRequested: boolean,
  config: ProjectConfig | undefined,
  projectRoot: string,
): Promise<void> {
  if (!config?.skills) {
    // Nothing to cross-reference. Inside a full `vat verify` that is a genuine
    // no-op; but `--only consistency` asked for THIS phase specifically, and
    // answering an explicit request with an empty phase list and `success` is
    // the same silent pass `vat validate --only <unconfigured surface>`
    // deliberately refuses to give.
    if (explicitlyRequested) {
      logger.error(
        "Phase 'consistency' needs a skills: block in vibe-agent-toolkit.config.yaml — there is nothing to cross-reference.",
      );
      phaseResults.push({
        name: 'consistency',
        status: 'error',
        error: "No skills: block in vibe-agent-toolkit.config.yaml — 'consistency' has nothing to check.",
      });
    }
    return;
  }

  const discoveredSkills = await discoverSkillsFromConfig(config.skills, projectRoot);
  const consistencyResult = runConsistencyChecks(discoveredSkills, config, projectRoot);
  const issues = consistencyResult.issues;

  if (issues.length > 0) {
    reportConsistencyIssues(issues, logger);
  }

  const asValidation = asValidationIssues(issues);
  const result: FindingsPhaseResult = {
    name: 'consistency',
    status: calculateValidationStatus(asValidation),
    issueCounts: countBySeverity(asValidation),
    issues: issues.map(({ severity, code, message, fix }) => ({ severity, code, message, fix })),
  };
  phaseResults.push(result);
}

async function verifyTopLevelCommand(options: VerifyCommandOptions): Promise<void> {
  // Spec §7: `vat verify` requires a projectRoot.
  const projectRoot = requireProjectRoot(process.cwd(), 'vat verify');

  const { logger, startTime, binPath } = createPhaseContext(options.debug);

  try {
    // Inside the try, deliberately: an unroutable `--only` used to throw from
    // out here, so the user got a raw Node stack trace and zero bytes of the
    // structured document a scripted caller parses.
    const { config, error: configError } = loadConfigTolerant(projectRoot);
    const phases = applyPhaseSelection(
      selectVerifyPhases(options.only, config, configError),
      logger,
      startTime,
    );

    logger.info(`🔍 vat verify (phases: ${phases.map((p) => p.name).join(' → ')})`);

    const phaseResults: PhaseResult[] = [];
    for (const phase of phases) {
      logger.info(`\n▶ Phase: ${phase.name}`);
      phaseResults.push(runPhase(binPath, phase));
    }

    // Post-build files config check: verify all dest paths exist in built output
    if (!options.only || options.only === 'skills') {
      const filesDestResults = checkFilesConfigDests(projectRoot);
      if (filesDestResults.length > 0) {
        reportFilesDestErrors(filesDestResults, logger);
        phaseResults.push({
          name: 'files-config-dests',
          status: 'error',
          issueCounts: { errors: filesDestResults.length, warnings: 0, info: 0 },
        });
      }
    }

    // Consistency check: cross-reference discovered skills vs package.json and plugin assignments
    if (!options.only || options.only === 'consistency' || options.only === 'skills') {
      await runConsistencyPhase(
        logger,
        phaseResults,
        options.only === 'consistency',
        config,
        projectRoot,
      );
    }

    const duration = Date.now() - startTime;

    // Worst-wins across phases, with `system-error` outranking `error`: a phase
    // that could not run exits 2, so a CI script can tell a broken config from
    // a broken artifact.
    writeYamlOutput({
      status: aggregatePhaseStatus(phaseResults),
      phases: phaseResults,
      duration: `${duration}ms`,
    });

    process.exit(exitCodeForPhases(phaseResults));
  } catch (error) {
    handleCommandError(error, logger, startTime, 'Verify');
  }
}
