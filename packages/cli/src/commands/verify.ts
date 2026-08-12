/**
 * `vat verify` — top-level verification orchestration
 *
 * Validates everything in scope, in dependency order:
 *   1. vat resources validate  (link integrity, collection schemas)
 *   2. vat skills validate     (SKILL.md frontmatter validation)
 *   3. vat claude marketplace validate  (strict marketplace validation, when configured)
 *   4. files-config-dests  (in-process; every `files:` dest exists in the built output)
 *   5. packaged-content  (in-process; built bundles carry nothing that must not ship)
 *   6. consistency check  (in-process; skill distribution integrity — package.json, plugin assignment)
 *
 * 1–3 are subprocess phases chosen by {@link selectVerifyPhases}; 4–6 run here and
 * are chosen by `selectInProcessVerifyPhases`. Both sets are config-gated, and both
 * are announced on startup.
 */

import { existsSync } from 'node:fs';
import { basename } from 'node:path';

import {
  calculateValidationStatus,
  countBySeverity,
  type SeverityCounts,
  type ValidationIssue,
} from '@vibe-agent-toolkit/agent-schema';
import {
  computeTreeCopiedSkillLocations,
  detectPackagedAgentInstructionFiles,
  explicitFilesConfigDests,
  type SkillPackagingConfig,
} from '@vibe-agent-toolkit/agent-skills';
import type { ProjectConfig } from '@vibe-agent-toolkit/resources';
import { safePath } from '@vibe-agent-toolkit/utils';
import { Command } from 'commander';

import { handleCommandError } from '../utils/command-error.js';
import { loadConfig } from '../utils/config-loader.js';
import { formatIssueLines } from '../utils/issue-rendering.js';
import { resolveIssueSeverity } from '../utils/issue-severity.js';
import type { createLogger } from '../utils/logger.js';
import { writeYamlOutput } from '../utils/output.js';
import { requireProjectRoot } from '../utils/project-root-policy.js';
import { mergeSkillPackagingConfig } from '../utils/skill-packaging-config.js';

import {
  runConsistencyChecks,
  type ConsistencyIssue,
  type ConsistencyIssueSeverity,
} from './consistency-check.js';
import {
  addRetiredOnlyOption,
  aggregatePhaseStatus,
  applyPhaseSelection,
  createPhaseContext,
  decidePhaseSelection,
  exitCodeForPhases,
  rejectRetiredOnly,
  runPhase,
  type Phase,
  type PhaseResult,
  type PhaseSelection,
  type PhaseVocabulary,
} from './phase-utils.js';
import { rejectPositionalArguments } from './positional-args.js';
import type { DiscoveredSkill } from './skills/command-helpers.js';
import { discoverSkillsFromConfig } from './skills/skill-discovery.js';

export interface VerifyCommandOptions {
  /** Retired; declared only so {@link rejectRetiredOnly} can explain the removal. */
  only?: string;
  verbose?: boolean;
  debug?: boolean;
}

/**
 * Measured full-run duration on the 90-skill / 1,041-document adopter, cited by
 * the retired-`--only` message: resources 12.5s + skills 15.6s + marketplace
 * 1.0s + consistency under a second.
 */
const VERIFY_FULL_RUN_SECONDS = 32;

/** How this command names itself in every user-facing diagnostic. */
const COMMAND_NAME = 'vat verify';

export function createVerifyTopLevelCommand(): Command {
  const command = new Command('verify');

  addRetiredOnlyOption(command)
    .description('Verify built artifacts (resources + skills + marketplace + consistency); marketplace/consistency read dist/ — run after vat build')
    .option('-v, --verbose', 'Show all inspected resources, including those without issues')
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
  config block is present. There is no phase filter — the whole run takes
  about as long as its slowest two phases, so a CI gate cannot lose coverage
  by naming a phase whose config key was renamed out from under it.

  Phases (subprocess):
    resources    → link integrity, collection frontmatter schemas (when 'resources:' configured)
    skills       → SKILL.md frontmatter and packaging validation (when 'skills:' configured)
    marketplace  → strict marketplace validation (when 'claude.marketplaces:' configured)

  Phases (in-process, run after the above, when 'skills:' is configured):
    files-config-dests → every 'files:' dest exists in the built output. Appears
                         in the document only when a dest is missing.
    packaged-content   → built skill bundles carry no repo-internal agent-instruction
                         file (CLAUDE.md, AGENTS.md, GEMINI.md). A dest an explicit
                         'files:' entry names is honoured, not reported.
    consistency        → skill distribution integrity (package.json, plugin assignment)

  A run with a 'skills:' block runs all four of skills, files-config-dests,
  packaged-content and consistency: they read that same config block. Without it
  no in-process phase has anything to read, so none run.

  The startup line on stderr names, in order, the phases that will inspect
  something. A phase that would consult nothing is not listed; a phase that does
  inspect its inputs is listed even when it finds nothing to report.

Output:
  ONE YAML document → stdout
    per phase: status (success | warning | error | system-error). A subprocess
    phase's own report is captured and nested under 'report', so the whole run
    is a single parseable document (a phase's stdout is never streamed
    through). A phase's status comes from the child's REPORTED status, not
    from its exit code — an exit code cannot express 'warning'. In-process
    phases also publish issueCounts {errors, warnings, info}; 'consistency' and
    'packaged-content' carry their findings into the document too, while
    'files-config-dests' publishes counts only and lists the missing dests on
    stderr.
  Progress and validation errors → stderr (streamed live)

  By default each subprocess phase reports a per-asset summary plus the assets
  that have findings. '--verbose' is forwarded to every subprocess phase, which
  then also lists the assets it inspected and found nothing to report.

Exit Codes:
  0 - All phases passed (a warning does not fail the run — read status/issueCounts)
  1 - Validation errors found
  2 - System error (this command's own, or propagated from a phase that could
      not run: exited 2, was killed by a signal, was never spawned, or wrote
      output that could not be parsed), or a usage error such as passing a path

Arguments:
  None. Scope comes from vibe-agent-toolkit.config.yaml, never from the command
  line — a path argument is rejected (exit 2) rather than discarded. To inspect
  ONE skill or bundle by path, use 'vat skill review <path>'.

Requirements:
  projectRoot: required (errors if no vibe-agent-toolkit.config.yaml or .git/ ancestor)
  config:      required file (used to discover phases and outputs)

  See docs/concepts/roots-and-config.md for terminology.

Example:
  $ vat verify                         # Verify every configured phase
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
  /** The skill's effective packaging config — `files:` AND `validation:`. */
  packaging: SkillPackagingConfig;
};

/** The `files:` entries governing a candidate, `[]` when the skill declares none. */
function filesOf(entry: CheckEntry): NonNullable<SkillPackagingConfig['files']> {
  return entry.packaging.files ?? [];
}

/**
 * Register a check for (skillName, outputDir, packaging) in the dedup map.
 *
 * Skips silently if:
 *   - outputDir does not exist on disk (not a candidate)
 *   - the key was already added (dedup guard)
 *
 * An EMPTY `files:` block is registered, not skipped: {@link checkFilesConfigDests}
 * has nothing to verify for such a skill and filters it out itself, but
 * {@link checkPackagedAgentInstructionFiles} must still crawl that bundle — a skill
 * with no `files:` block is exactly the one whose agent-instruction file arrived by
 * some other route, and dropping it here would make the crawl blind to it.
 */
function tryAddCheckEntry(
  checks: Map<string, CheckEntry>,
  skillName: string,
  outputDir: string,
  packaging: SkillPackagingConfig,
): void {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- outputDir is resolved from config, not user input
  if (!existsSync(outputDir)) return;
  const key = `${skillName}\0${outputDir}`;
  if (!checks.has(key)) {
    checks.set(key, { skillName, outputDir, packaging });
  }
}

/**
 * Every built skill bundle this project's config accounts for that EXISTS on disk,
 * with the `files:` entries that govern it.
 *
 * ONE enumeration of "where did `vat build` write this skill", shared by every
 * in-process verify phase, in the two locations the build actually uses:
 *   - Pool skills: `dist/skills/<fsName>/`
 *   - Tree-copy skills: `dist/.claude/plugins/.../skills/<name>/`
 *
 * Returns `[]` (never throws) for an unreadable config: `vat verify`'s subprocess
 * phases report the real config error, and an in-process phase must not race them
 * with a second, worse diagnosis.
 *
 * The pool arm enumerates the skills the run DISCOVERED, unioned with the keys of
 * `skills.config`. It used to be the config keys alone, which made both in-process
 * phases blind to the common case: a per-skill `config:` block is optional, so a
 * skill discovered only by `skills.include` had no key and its bundle was never
 * looked at. Measured on a two-skill fixture with an identical `CLAUDE.md` planted
 * in each built bundle, `packaged-content` reported ONE finding and exit 0 — the
 * phase was structurally blind to the population its own doc comment cites as the
 * motivating incident. The same line made `files-config-dests` a total no-op for a
 * project whose `files:` entries live only under `skills.defaults`, while the
 * startup banner still announced that the phase ran.
 *
 * The config keys stay in the union rather than being replaced by discovery: a key
 * naming a skill discovery does not reach (a renamed glob, a stale entry) still
 * points at a bundle that may be sitting in `dist/`, and dropping it would trade
 * one blindness for another.
 *
 * `discovered` is a REQUIRED parameter, not an optional convenience: discovery
 * crawls the whole project, `vat verify` already needs the same list for its
 * consistency phase, and an optional parameter here would let a call site quietly
 * re-crawl (or, worse, skip discovery and reinstate the blindness above).
 *
 * The merge goes through {@link mergeSkillPackagingConfig} — the ONE helper every
 * lane uses — so `vat verify` and `vat build` cannot disagree about a skill's
 * effective config. Doing the `files:` half by hand here and leaving `validation:`
 * unread is what made `severity.PACKAGED_AGENT_INSTRUCTION_FILE: ignore` a no-op in
 * this command.
 */
function collectBuiltSkillOutputs(
  cwd: string,
  discovered: readonly DiscoveredSkill[],
): CheckEntry[] {
  try {
    const config = loadConfig(cwd);
    if (!config) return [];

    const skillsConfig = config.skills;
    const defaults = skillsConfig?.defaults as Record<string, unknown> | undefined;

    // Dedup map: key = `skillName\0outputDir` → check entry
    const checks = new Map<string, CheckEntry>();

    // --- Pool skills: candidate dir is dist/skills/<fsName> ---
    const poolNames = new Set<string>([
      ...discovered.map((skill) => skill.name),
      ...Object.keys(skillsConfig?.config ?? {}),
    ]);
    for (const skillName of poolNames) {
      const perSkill = skillsConfig?.config?.[skillName] as Record<string, unknown> | undefined;
      const outputDir = safePath.resolve(cwd, 'dist', 'skills', skillNameToFsPath(skillName));
      tryAddCheckEntry(checks, skillName, outputDir, mergeSkillPackagingConfig(defaults, perSkill));
    }

    // --- Tree-copy skills: candidate dirs are plugin output skill dirs ---
    for (const loc of computeTreeCopiedSkillLocations(config, cwd)) {
      // Per-skill config is keyed by the skill's declared NAME. `skillDirPath` is a
      // path (`group/nested-skill` for a nested skill), so try its trailing segment
      // too — the spelling that matches for every skill whose dir is named after it.
      const dirLeaf = basename(loc.skillDirPath);
      const perSkill = (skillsConfig?.config?.[loc.skillDirPath] ?? skillsConfig?.config?.[dirLeaf]) as
        Record<string, unknown> | undefined;
      tryAddCheckEntry(
        checks,
        loc.skillDirPath,
        loc.skillOutputDir,
        mergeSkillPackagingConfig(defaults, perSkill),
      );
    }

    return [...checks.values()];
  } catch {
    return [];
  }
}

/**
 * Check that all dest paths from the merged files config exist in the built output.
 *
 * A dest is "missing" ONLY when absent from a candidate dir that exists. If a skill
 * has no existing candidate dir, it is not reported (build didn't run for that mode).
 *
 * @param discovered - The skills this run discovered from `skills.include`. See
 *   {@link collectBuiltSkillOutputs} for why it is required rather than optional.
 * @returns One result per (skill, outputDir) pair where dests are absent.
 */
export function checkFilesConfigDests(
  cwd: string,
  discovered: readonly DiscoveredSkill[],
): FilesDestCheckResult[] {
  const results: FilesDestCheckResult[] = [];
  for (const check of collectBuiltSkillOutputs(cwd, discovered)) {
    const { skillName, outputDir } = check;
    const mergedFiles = filesOf(check);
    if (mergedFiles.length === 0) continue;
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
}

/**
 * Crawl every built skill bundle for repo-internal agent-instruction files.
 *
 * The built-skill-bundle arm of `PACKAGED_AGENT_INSTRUCTION_FILE`. Its description
 * has always claimed three surfaces — a built skill bundle, an installed plugin, a
 * plugin source directory — but only the two plugin arms had a producer: the skill
 * lanes inspect SKILL.md plus what links reach from it, so a file that arrives in a
 * bundle with no link at all was invisible to every command. Measured on an adopter
 * bundle carrying two of them: `vat audit` reported `filesScanned: 1`, zero issues,
 * and `vat verify` reported `warnings: 0`.
 *
 * UNCONDITIONAL here, with no provenance test: `vat verify` reads the built `dist/`
 * tree by definition, so every tree this enumerates is distributed output. (`vat
 * audit` takes an arbitrary path and therefore must answer the provenance question
 * first — see `appendDistributedTreeFindings` in audit.ts.)
 *
 * Explicit `files:` dests are exempt (§8.2): here the config is knowable, and
 * naming a dest is an instruction to ship that file. A glob match never earns the
 * exemption — a glob is a net, not a declaration — which is why the exempt set
 * comes from {@link explicitFilesConfigDests} rather than from every `files:` entry.
 *
 * Each bundle's findings are then resolved against that skill's effective
 * `validation.severity` (see {@link resolveIssueSeverity}), so the opt-out the
 * code's own `fix` text prescribes actually works here. It did not: this phase
 * published `detectPackagedAgentInstructionFiles`' raw output straight into the
 * document, so `severity.PACKAGED_AGENT_INSTRUCTION_FILE: ignore` changed nothing
 * — measured `warnings: 1` with the override at `skills.defaults`, at
 * `skills.config.<name>`, and with no override at all.
 *
 * `validation.allow` is deliberately NOT applied. Allow is a per-PATH suppression
 * whose usage is only answerable across a whole run, and this phase would have to
 * drain a ledger it is not the run of — reporting ALLOW_UNUSED for every entry the
 * project declares for other lanes. Severity is answerable per unit of work; allow
 * is not. See `AllowUsageLedger` in `@vibe-agent-toolkit/agent-schema`.
 *
 * Locations anchor at `cwd`, the run's stated root, so a reader can open them.
 *
 * @param discovered - The skills this run discovered from `skills.include`. See
 *   {@link collectBuiltSkillOutputs} for why it is required rather than optional.
 */
export function checkPackagedAgentInstructionFiles(
  cwd: string,
  discovered: readonly DiscoveredSkill[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const check of collectBuiltSkillOutputs(cwd, discovered)) {
    const raw = detectPackagedAgentInstructionFiles(
      check.outputDir,
      cwd,
      explicitFilesConfigDests(filesOf(check)),
    );
    issues.push(...resolveIssueSeverity(raw, check.packaging.validation));
  }
  return issues;
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

/** The in-process phase that checks `files:` dests against the built output. */
const FILES_CONFIG_DESTS = 'files-config-dests';

/**
 * Log files-config-dests errors to stderr.
 */
function reportFilesDestErrors(
  results: FilesDestCheckResult[],
  logger: ReturnType<typeof createLogger>
): void {
  logger.error(`\n▶ Phase: ${FILES_CONFIG_DESTS}`);
  for (const { skillName, outputDir, missing } of results) {
    logger.error(`  Skill '${skillName}': missing dest file(s) in ${outputDir}/:`);
    for (const dest of missing) {
      logger.error(`    - ${dest}`);
    }
  }
}

/**
 * Log packaged-content findings to stderr.
 *
 * A companion to the document entry, never a substitute for it: this phase's
 * findings are published into the YAML too (see {@link FindingsPhaseResult}).
 *
 * Rendered through the SHARED {@link formatIssueLines}, which `vat skills build`
 * and `vat skills validate` already use. The hand-rolled renderer this replaces
 * printed severity, code, location and fix — and dropped `message`, the only part
 * of a finding that says what is wrong. A second renderer for the same shape is
 * how one command's findings end up spelled differently from every other's.
 */
function reportPackagedContentIssues(
  issues: readonly ValidationIssue[],
  logger: ReturnType<typeof createLogger>
): void {
  logger.error(`\n▶ Phase: ${PACKAGED_CONTENT}`);
  for (const issue of issues) {
    for (const line of formatIssueLines(issue, '  ')) logger.error(line);
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

/**
 * Phases `vat verify` knows how to run, in stable execution order.
 *
 * `PhaseVocabulary.validNames` is what `--only` was checked against; with
 * `--only` retired from this command it is documentation only — the arm that
 * reads it in {@link decidePhaseSelection} is unreachable from here.
 */
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
 * `--only` is gone from this command entirely. Measured on a 90-skill project a
 * full `vat verify` is ~32s, of which the two slowest phases are ~28s — the
 * filter bought at most ~18s and repeatedly bought a wrong answer with it. Every
 * run is now a whole run, and `only` is passed to {@link decidePhaseSelection}
 * as `undefined` (that helper still routes `--only` for `vat validate` and
 * `vat build`).
 *
 * @param configError - The config-load failure, when the config could not be
 *   read. Every subprocess phase still runs so the CHILD reports the real
 *   config error (exit 2) instead of this command guessing.
 * @param verbose - Forwarded to each subprocess phase as `--verbose`. The
 *   children own their own summarization; this command only relays the request.
 */
export function selectVerifyPhases(
  config: ProjectConfig | undefined,
  configError?: string,
  verbose?: boolean,
): PhaseSelection {
  const phases: Phase[] = [];
  const unreadable = configError !== undefined;
  const detail = verbose === true ? ['--verbose'] : [];

  if (unreadable || config?.resources) {
    phases.push({ name: 'resources', args: ['resources', 'validate', ...detail] });
  }

  if (unreadable || config?.skills) {
    phases.push({ name: 'skills', args: ['skills', 'validate', ...detail] });
  }

  for (const name of Object.keys(config?.claude?.marketplaces ?? {})) {
    phases.push({
      name: `marketplace:${name}`,
      args: [
        'claude',
        'marketplace',
        'validate',
        `dist/.claude/plugins/marketplaces/${name}`,
        ...detail,
      ],
    });
  }

  return decidePhaseSelection(undefined, phases, VERIFY_VOCABULARY, {
    unreadableConfig: configError,
  });
}

/** The in-process phase that crawls built skill bundles for what must not ship. */
const PACKAGED_CONTENT = 'packaged-content';

/** Phases that run in this process, after the subprocess phases, in execution order. */
type InProcessPhaseName = typeof FILES_CONFIG_DESTS | typeof PACKAGED_CONTENT | 'consistency';

/**
 * Which in-process phases this run performs, given the config.
 *
 * The SINGLE source for that question: {@link verifyTopLevelCommand} gates
 * execution on this list and {@link formatVerifyAnnouncement} announces the same
 * list, so the printed phase list cannot drift from the phases that run. It used
 * to be announced from the subprocess phases alone while these two were gated by
 * hand-written conditions further down, so a run printed '(phases: skills)' and
 * then also ran `consistency`, which put a second entry in the emitted document.
 * A status that under-reports what it did is the same defect class as
 * {@link selectVerifyPhases}' silent exit-0 pass.
 *
 * The contract is **the phases that will inspect something** — not "code paths
 * this run enters". An earlier fix traded the under-reporting for
 * over-reporting: on a project with `resources:` and no `skills:`, a run
 * announced 'resources → files-config-dests → consistency' and emitted a
 * document holding `resources` and nothing else, so an operator read a claim
 * that distribution consistency had been checked. Both in-process phases read
 * the same input, the `skills:` block — without it {@link checkFilesConfigDests}
 * has no `files:` entry to resolve (both `defaults.files` and
 * `config.<skill>.files` live under `skills:`, so every merge is empty) and
 * {@link runConsistencyPhase} returns before its first lookup. Neither can
 * produce a finding, so neither is named.
 *
 * This is a truthfulness change, not a behaviour change: the condition here is
 * the one the phases already applied internally, hoisted so the announcement can
 * see it.
 *
 * Note "will inspect something" is not a prediction of the findings:
 * `files-config-dests` is named whenever a `skills:` block engages it, even
 * though a clean run reports nothing.
 */
function selectInProcessVerifyPhases(config: ProjectConfig | undefined): InProcessPhaseName[] {
  return config?.skills === undefined ? [] : [FILES_CONFIG_DESTS, PACKAGED_CONTENT, 'consistency'];
}

/**
 * The startup announcement: every phase this run will inspect something with,
 * in order. A phase that would consult nothing is not named.
 */
export function formatVerifyAnnouncement(
  subprocessPhaseNames: readonly string[],
  config: ProjectConfig | undefined,
): string {
  const all = [...subprocessPhaseNames, ...selectInProcessVerifyPhases(config)];
  return `🔍 vat verify (phases: ${all.join(' → ')})`;
}

/** An in-process phase's finding as it appears in the archived YAML. */
interface PublishedIssue {
  // Widened from ConsistencyIssueSeverity: `packaged-content` publishes real
  // ValidationIssues, whose severity vocabulary also carries 'ignore'.
  severity: ValidationIssue['severity'] | ConsistencyIssueSeverity;
  code: string;
  message: string;
  fix: string;
  /** Project-relative path of the file to open. Absent when the finding has none. */
  location?: string;
  /** 1-based line within {@link PublishedIssue.location}. */
  line?: number;
  /** Doc link the code's registry entry carries. */
  reference?: string;
}

/**
 * Project ONE finding into the archived YAML.
 *
 * The whole anchor rides along. This shape used to be `{severity, code, message,
 * fix}` and the projection destructured exactly those four, so every
 * `packaged-content` finding reached the document with no `location` — the same
 * defect this PR fixed one command over in `vat skills build`, where a published
 * count carried "no `code`, no location and no fix string at ANY verbosity". It
 * looked survivable only because `materializeIssue` happens to interpolate the
 * detail into `message` for this one code; that is a coincidence, not a contract,
 * and stderr is not the document a CI consumer parses.
 */
export function toPublishedIssue(issue: ValidationIssue): PublishedIssue {
  return {
    severity: issue.severity,
    code: issue.code,
    message: issue.message,
    fix: issue.fix ?? '',
    // Conditional rather than `location: issue.location`: `exactOptionalPropertyTypes`
    // distinguishes an absent key from an explicit `undefined`, and a YAML document
    // carrying `location: null` claims something the finding never said.
    ...(issue.location === undefined ? {} : { location: issue.location }),
    ...(issue.line === undefined ? {} : { line: issue.line }),
    ...(issue.reference === undefined ? {} : { reference: issue.reference }),
  };
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
  issues: PublishedIssue[];
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
 *
 * Discovery is handed in rather than performed here: it crawls the whole project,
 * and the packaged-content and files-config-dests phases need the same list. One
 * crawl per run, one answer to "which skills does this project have".
 */
function runConsistencyPhase(
  logger: ReturnType<typeof createLogger>,
  phaseResults: PhaseResult[],
  config: ProjectConfig | undefined,
  projectRoot: string,
  discoveredSkills: readonly DiscoveredSkill[],
): void {
  if (!config?.skills) {
    // Nothing to cross-reference, so nothing to report: a run without a
    // `skills:` block is a genuine no-op, and {@link selectInProcessVerifyPhases}
    // has already decided not to name this phase. There used to be a second arm
    // here that pushed an ERROR result instead — because `--only consistency`
    // had asked for THIS phase specifically, and answering an explicit request
    // with an empty phase list and `success` is the same silent pass
    // `vat validate --only <unconfigured surface>` refuses to give. With
    // `--only` retired from `vat verify` there is no way to ask for this phase
    // specifically, so that arm went with it. This guard remains reachable only
    // defensively (and narrows `config.skills` for the call below).
    return;
  }

  const consistencyResult = runConsistencyChecks([...discoveredSkills], config, projectRoot);
  const issues = consistencyResult.issues;

  if (issues.length > 0) {
    reportConsistencyIssues(issues, logger);
  }

  const asValidation = asValidationIssues(issues);
  const result: FindingsPhaseResult = {
    name: 'consistency',
    status: calculateValidationStatus(asValidation),
    issueCounts: countBySeverity(asValidation),
    issues: asValidation.map(toPublishedIssue),
  };
  phaseResults.push(result);
}

async function verifyTopLevelCommand(
  options: VerifyCommandOptions,
  command: Command,
): Promise<void> {
  // First, and before requireProjectRoot: `vat verify dist/skills/demo` used to
  // be accepted, have its path discarded, run wide over the whole project and
  // report success. Nothing below can un-tell that lie, so the run ends here.
  rejectPositionalArguments(
    command.args,
    COMMAND_NAME,
    'verifies every phase vibe-agent-toolkit.config.yaml declares, against the built dist/ tree',
  );

  // Before requireProjectRoot: a retired flag is a usage error, and answering it
  // with "no vibe-agent-toolkit.config.yaml found" would diagnose the wrong
  // problem for anyone running the old invocation outside a project.
  rejectRetiredOnly(options.only, COMMAND_NAME, VERIFY_FULL_RUN_SECONDS);

  // Spec §7: `vat verify` requires a projectRoot.
  const projectRoot = requireProjectRoot(process.cwd(), COMMAND_NAME);

  const { logger, startTime, binPath } = createPhaseContext(options.debug);

  try {
    // Inside the try, deliberately: phase selection used to throw from out here
    // (on an unroutable `--only`), so the user got a raw Node stack trace and
    // zero bytes of the structured document a scripted caller parses.
    const { config, error: configError } = loadConfigTolerant(projectRoot);
    const phases = applyPhaseSelection(
      selectVerifyPhases(config, configError, options.verbose),
      logger,
      startTime,
    );

    // Announced from the same list the in-process gates below read, so the
    // printed phases and the executed phases cannot disagree.
    const inProcess = selectInProcessVerifyPhases(config);
    logger.info(formatVerifyAnnouncement(phases.map((p) => p.name), config));

    const phaseResults: PhaseResult[] = [];
    for (const phase of phases) {
      logger.info(`\n▶ Phase: ${phase.name}`);
      phaseResults.push(runPhase(binPath, phase));
    }

    // ONE discovery for the whole in-process half of the run. Every phase below
    // asks the same question — "which skills does this project have" — and each
    // answer used to be a different one: `consistency` crawled, while
    // `files-config-dests` and `packaged-content` read `skills.config` keys and
    // were therefore blind to every skill discovered by a glob.
    const discoveredSkills = inProcess.length > 0 && config?.skills
      ? await discoverSkillsFromConfig(config.skills, projectRoot)
      : [];

    // Post-build files config check: verify all dest paths exist in built output
    if (inProcess.includes(FILES_CONFIG_DESTS)) {
      const filesDestResults = checkFilesConfigDests(projectRoot, discoveredSkills);
      if (filesDestResults.length > 0) {
        reportFilesDestErrors(filesDestResults, logger);
        phaseResults.push({
          name: FILES_CONFIG_DESTS,
          status: 'error',
          issueCounts: { errors: filesDestResults.length, warnings: 0, info: 0 },
        });
      }
    }

    // Packaged-content check: crawl each built skill bundle for repo-internal
    // agent-instruction files. Publishes its findings INTO the document rather
    // than only logging them — a file that must not ship has to be visible in
    // `issueCounts`, or a CI consumer reads a clean report for a bundle carrying
    // one. Warnings do not fail the run; the exit code still comes from errors.
    if (inProcess.includes(PACKAGED_CONTENT)) {
      const packagedIssues = checkPackagedAgentInstructionFiles(projectRoot, discoveredSkills);
      if (packagedIssues.length > 0) {
        reportPackagedContentIssues(packagedIssues, logger);
      }
      const packagedResult: FindingsPhaseResult = {
        name: PACKAGED_CONTENT,
        status: calculateValidationStatus(packagedIssues),
        issueCounts: countBySeverity(packagedIssues),
        issues: packagedIssues.map(toPublishedIssue),
      };
      phaseResults.push(packagedResult);
    }

    // Consistency check: cross-reference discovered skills vs package.json and plugin assignments
    if (inProcess.includes('consistency')) {
      runConsistencyPhase(logger, phaseResults, config, projectRoot, discoveredSkills);
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
