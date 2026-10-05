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
 * 1–3 delegate to a whole `vat` command, whose report is held to that command's
 * registered schema and folded into `data.phases`; they are chosen by
 * {@link selectVerifyPhases}. 4–6 exist only here, hold their reports to their own
 * schemas, and are chosen by `selectInProcessVerifyPhases`. Every phase runs in
 * this process.
 * Both sets are config-gated, and both are announced on startup.
 */

import { existsSync, statSync } from 'node:fs';

import {
  detectPackagedAgentInstructionFiles,
  explicitFilesConfigDests,
  indexPluginLocalSkills,
  type PluginLocalSkillIndex,
  type SkillPackagingConfig,
} from '@vibe-agent-toolkit/agent-skills';
import type { ProjectConfig } from '@vibe-agent-toolkit/resources';
import {
  buildReport,
  toFindings,
  type Finding,
  type Report,
  type ValidationIssue,
} from '@vibe-agent-toolkit/schema';
import { isPathAbsentError, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { Command } from 'commander';

import { marksOperandRefusalByHand } from '../command-tree.js';
import { loadConfig } from '../utils/config-loader.js';
import { endWithReport } from '../utils/document-writer.js';
import { formatIssueLines } from '../utils/issue-rendering.js';
import { resolveIssueSeverity } from '../utils/issue-severity.js';
import type { createLogger } from '../utils/logger.js';
import { requireProjectRoot } from '../utils/project-root-policy.js';
import { runIntegrityFinding } from '../utils/run-integrity.js';
import { isSkillPublished, mergeSkillPackagingConfig, pluginLocalSkillConfigEntry, publishScope } from '../utils/skill-packaging-config.js';

import { MARKETPLACE_VALIDATE_REPORT_SCHEMA } from './claude/marketplace/validate-schema.js';
import { runMarketplaceValidatePhase } from './claude/marketplace/validate.js';
import {
  runConsistencyChecks,
  type ConsistencyIssue,
} from './consistency-check.js';
import { PACKAGED_CONTENT_REPORT_SCHEMA, type PackagedContentData } from './orchestrator-schema.js';
import {
  addRetiredOnlyOption,
  applyPhaseSelection,
  createPhaseContext,
  DATALESS_PHASE_REPORT_SCHEMA,
  decidePhaseSelection,
  orchestrate,
  ORCHESTRATOR_FORMAT,
  ORCHESTRATOR_GATE,
  rejectRetiredOnly,
  runPhase,
  type Phase,
  type PhaseReportSchema,
  type PhaseResult,
  type PhaseSelection,
  type PhaseVocabulary,
} from './phase-utils.js';
import { rejectPositionalArguments } from './positional-args.js';
import { RESOURCES_VALIDATE_REPORT_SCHEMA } from './resources/validate-schema.js';
import { runResourcesValidatePhase } from './resources/validate.js';
import type { DiscoveredSkill } from './skills/command-helpers.js';
import { discoverSkillsFromConfig, readPluginLocalSkillNames, type PluginLocalSkillNames } from './skills/skill-discovery.js';
import { SKILLS_VALIDATE_REPORT_SCHEMA } from './skills/validate-schema.js';
import { runSkillsValidatePhase } from './skills/validate.js';

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
  // Refuses operands in its action, with a better message than commander's.
  const command = marksOperandRefusalByHand(new Command('verify'));

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

  Phases (delegated to a whole vat command):
    resources    → link integrity, collection frontmatter schemas (when 'resources:' configured)
    skills       → SKILL.md frontmatter and packaging validation (when 'skills:' configured)
    marketplace  → strict marketplace validation (when 'claude.marketplaces:' configured)

  Phases (verify's own, run after the above, when 'skills:' is configured):
    files-config-dests → every 'files:' dest exists in the built output; one
                         FILES_CONFIG_DEST_MISSING error per missing dest.
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
  ONE report envelope (YAML) → stdout: status (ok | findings | error),
  examined (the sum over every phase), summary {errors, warnings, info},
  findings (every phase's, flat), and data.phases — one entry per phase with
  its own status, examined, summary, error (when it did not finish) and the
  phase's own data. Schema: packages/cli/schemas/orchestrator.json.
    'packaged-content': examined is the built bundles it crawled; its data is
    bundlesExpected (the bundles 'vat build' produces for the skills this run
    discovered), bundlesInPlace, and bundlesMissing (expected bundles absent
    from dist/, by path). Zero inspected, or any missing, is refused as
    RESOURCE_CHECK_BROKEN at error (exit 1): a run that found none of the build
    (dist/ not built, or a skills.include glob that matched nothing) or only
    part of it is not a verdict on what ships. A skill whose merged config says
    publish: false is IN-PLACE — never bundled by 'vat build', so no pool bundle
    is expected for it; a run whose every discovered skill is in place passes
    with nothing to inspect. A plugin-local skill (a git-tracked skill dir under
    a plugin's skills/) is never in place: it is expected in its plugin tree.
    'marketplace:<name>': a plugin.json, a skills/ directory or a SKILL.md the
    OS will not read is refused as RESOURCE_CHECK_BROKEN at error (exit 1),
    naming it — a file this run could not read is not a verdict on what ships.
  Progress and validation errors → stderr (streamed live)

  By default each delegated phase reports a per-asset summary plus the assets
  that have findings. '--verbose' is forwarded to every delegated phase, which
  then also lists the assets it inspected and found nothing to report.

Exit Codes:
  0 - Every phase finished and no finding is an error (warnings never fail)
  1 - An error finding, or nothing was examined at all (RESOURCE_CHECK_BROKEN)
  2 - The run could not do its job: a phase did not finish (RUN_INCOMPLETE,
      the finished phases still in data.phases), a path argument or the
      retired '--only' (USAGE_INVALID), no project root, a population it
      could not see

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

/** The `files:` dests one built bundle lacks: a single (skill, outputDir) pair. */
interface MissingDests {
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
 * What {@link collectBuiltSkillOutputs} enumerates: the bundles that exist, and
 * the coverage of what `vat build` should have produced.
 *
 * `expected` and `missing` are what let the `packaged-content` phase tell a
 * whole build from part of one. `built.length` alone could not: it counted the
 * bundles that EXIST, so two discovered skills with one bundle deleted read as
 * "1 inspected, clean" — a verdict published over half the tree.
 */
interface BuiltSkillOutputs {
  /** Candidates whose output dir exists on disk — the ones any phase can inspect. */
  built: CheckEntry[];
  /**
   * Candidates `vat build` produces for THIS run's inputs: one pool bundle per
   * discovered PUBLISHED skill, one plugin-tree bundle per plugin-local skill.
   * A `publish: false` skill is in-place (see `isSkillPublished`): never built,
   * so demanding its pool bundle would fail every `vat build --only claude`
   * project. A `skills.config` key discovery does not reach is NOT counted
   * either — nothing builds it, and the consistency phase already reports the
   * stale key — so demanding its bundle would make a typo'd config line a
   * non-overridable error a second time.
   */
  expected: number;
  /** Discovered skills left out of `expected` because they are in-place — never a plugin-local one, which ships with its plugin. */
  inPlace: number;
  /** Expected candidates whose output dir is absent — `cwd`-relative, so a reader can open where it should be. */
  missing: string[];
}

/**
 * Whether `dir` is a directory — `false` for a file and for nothing. Both are
 * "no bundle here": a bundle is a tree, and a regular FILE sitting where one
 * should be passed `existsSync`, was counted as built, and the packaged-content
 * crawl then threw `Base path is not a directory: /abs/…` out of the whole
 * command — exit 2, no document, an absolute path on stderr — where the
 * missing-bundle lane names it at exit 1.
 *
 * A path the process cannot stat is NOT "no bundle here" and throws: reading a
 * refused `dist/skills/x` as missing would name it under `missing` with a
 * remedy ("run vat build") that cannot help.
 */
function isDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch (error) {
    if (isPathAbsentError(error)) return false;
    throw error;
  }
}

/**
 * Register a (skillName, outputDir, packaging) candidate.
 *
 * A candidate whose output dir IS A DIRECTORY lands in `built` (deduplicated by
 * key). An `expected` candidate is counted whether or not it exists, and one
 * that is not a directory is named in `missing` — that absence is the finding,
 * not a skip (see {@link isDirectory} for why "exists" is not enough).
 *
 * An EMPTY `files:` block is registered, not skipped: {@link runFilesConfigDestsPhase}
 * has nothing to verify for such a skill and filters it out itself, but
 * {@link checkPackagedAgentInstructionFiles} must still crawl that bundle — a skill
 * with no `files:` block is exactly the one whose agent-instruction file arrived by
 * some other route, and dropping it here would make the crawl blind to it.
 */
function addCheckCandidate(
  outputs: BuiltSkillOutputs,
  seen: Set<string>,
  cwd: string,
  candidate: CheckEntry,
  expected: boolean,
): void {
  const key = `${candidate.skillName}\0${candidate.outputDir}`;
  if (seen.has(key)) return;
  seen.add(key);
  const exists = isDirectory(candidate.outputDir);
  if (exists) outputs.built.push(candidate);
  if (!expected) return;
  outputs.expected += 1;
  if (!exists) outputs.missing.push(toForwardSlash(safePath.relative(cwd, candidate.outputDir)));
}

/**
 * Every built skill bundle this project's config accounts for, with the `files:`
 * entries that govern it — those that EXIST on disk, and the coverage of those
 * the build should have produced (see {@link BuiltSkillOutputs}).
 *
 * ONE enumeration of "where did `vat build` write this skill", shared by every
 * in-process verify phase, in the two locations the build actually uses:
 *   - Pool skills: `dist/skills/<fsName>/`
 *   - Tree-copy skills: `dist/.claude/plugins/.../skills/<name>/`
 *
 * Returns an empty enumeration (never throws) for an unreadable config: `vat
 * verify`'s delegated phases report the real config error, and one of verify's
 * own phases must not race them with a second, worse diagnosis.
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
 * `pluginLocal` is required for the same reason: listing plugin-local skills crawls
 * every plugin, and `vat verify` builds that index ONCE for all three in-process phases.
 * `pluginLocalNames` — every location's declared name, read once per run by
 * `readPluginLocalSkillNames` — is required too: without it a plugin-local skill's config
 * would be looked up by something other than the name the plugin build packaged it under.
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
  pluginLocal: PluginLocalSkillIndex,
  pluginLocalNames: PluginLocalSkillNames,
): BuiltSkillOutputs {
  const outputs: BuiltSkillOutputs = { built: [], expected: 0, inPlace: 0, missing: [] };
  // No `try`, deliberately. The config was already loaded by the command (see
  // `loadConfigTolerant`) and the in-process phases run only when it loaded, so
  // `loadConfig` here answers from cache. The `catch { return outputs }` that
  // used to wrap this whole body could only ever absorb a DEFECT — and it
  // absorbed it into an empty candidate list, which every phase below then
  // verified against: zero bundles, zero findings, exit 0.
  const config = loadConfig(cwd);
  if (!config) return outputs;

  const skillsConfig = config.skills;
  const defaults = skillsConfig?.defaults as Record<string, unknown> | undefined;

  // Dedup guard: key = `skillName\0outputDir`
  const seen = new Set<string>();
  const packagingOf = (skillName: string): SkillPackagingConfig =>
    mergeSkillPackagingConfig(defaults, skillsConfig?.config?.[skillName] as Record<string, unknown> | undefined);

  // A plugin-local skill is never in place, whatever `publish` says: its plugin copy
  // is expected below. Counted per discovered SKILL, not per name — a repo-only skill
  // may share its declared name with a plugin-local one.
  outputs.inPlace = discovered.filter(
    (skill) => publishScope(skill, packagingOf(skill.name), pluginLocal) === 'in-place',
  ).length;

  // --- Pool skills: candidate dir is dist/skills/<fsName> ---
  // Expected only when discovered AND published (see BuiltSkillOutputs.expected).
  // An in-place skill's stale bundle in dist/ is still inspected, just not demanded.
  const discoveredNames = new Set(discovered.map((skill) => skill.name));
  const poolNames = new Set<string>([...discoveredNames, ...Object.keys(skillsConfig?.config ?? {})]);
  for (const skillName of poolNames) {
    const outputDir = safePath.resolve(cwd, 'dist', 'skills', skillNameToFsPath(skillName));
    const packaging = packagingOf(skillName);
    addCheckCandidate(outputs, seen, cwd, { skillName, outputDir, packaging }, discoveredNames.has(skillName) && isSkillPublished(packaging));
  }

  // --- Tree-copy skills: candidate dirs are plugin output skill dirs ---
  // Always expected, whatever `publish` says: every location here is a
  // plugin-local skill the claude build phase packages into the plugin tree —
  // `publish` scopes the pool only (see `isSkillPublished`).
  // Per-skill config goes through `pluginLocalSkillConfigEntry` — the plugin build's own
  // lookup — under the declared name the build reads (`pluginLocalNames`).
  for (const loc of pluginLocal.locations) {
    const declaredName = pluginLocalNames.get(safePath.resolve(loc.skillSourceDir));
    if (declaredName === undefined) {
      throw new Error(`vat verify defect: no declared name was read for the plugin-local skill at ${loc.skillSourceDir}`);
    }
    const perSkill = pluginLocalSkillConfigEntry(skillsConfig?.config, { skillName: declaredName, skillDirPath: loc.skillDirPath });
    addCheckCandidate(
      outputs,
      seen,
      cwd,
      {
        skillName: loc.skillDirPath,
        outputDir: loc.skillOutputDir,
        packaging: mergeSkillPackagingConfig(defaults, perSkill as Record<string, unknown> | undefined),
      },
      true,
    );
  }

  return outputs;
}

/**
 * The `files:` dests of every built bundle that declares some: how many bundles
 * were checked, and which dests are absent.
 *
 * A dest is "missing" ONLY when absent from a candidate dir that exists. A skill
 * with no existing candidate dir is not reported (the build did not run for that
 * mode) — the packaged-content phase names the unbuilt bundles.
 */
function checkFilesConfigDestsOf(built: readonly CheckEntry[]): { checked: number; missing: MissingDests[] } {
  const results: MissingDests[] = [];
  let checked = 0;
  for (const check of built) {
    const { skillName, outputDir } = check;
    const mergedFiles = filesOf(check);
    if (mergedFiles.length === 0) continue;
    checked += 1;
    const missing: string[] = [];
    for (const entry of mergedFiles) {
      const destPath = safePath.resolve(outputDir, entry.dest);
      if (!existsSync(destPath)) {
        missing.push(entry.dest);
      }
    }
    if (missing.length > 0) {
      results.push({ skillName, outputDir, missing });
    }
  }
  return { checked, missing: results };
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
 * is not. See `AllowUsageLedger` in `@vibe-agent-toolkit/schema`.
 *
 * Locations anchor at `cwd`, the run's stated root, so a reader can open them.
 *
 * Returns the count of bundles crawled beside the findings, because the phase
 * that publishes them needs the denominator: zero findings over zero bundles is
 * not a pass — see {@link buildPackagedContentPhase}.
 *
 * @param discovered - The skills this run discovered from `skills.include`. See
 *   {@link collectBuiltSkillOutputs} for why it is required rather than optional.
 * @param pluginLocal - The run's plugin-local index — required for the same reason.
 * @param pluginLocalNames - The declared name of every location in `pluginLocal` — required for the same reason.
 */
export function checkPackagedAgentInstructionFiles(
  cwd: string,
  discovered: readonly DiscoveredSkill[],
  pluginLocal: PluginLocalSkillIndex,
  pluginLocalNames: PluginLocalSkillNames,
): PackagedContentCrawl {
  const issues: ValidationIssue[] = [];
  const outputs = collectBuiltSkillOutputs(cwd, discovered, pluginLocal, pluginLocalNames);
  for (const check of outputs.built) {
    const raw = detectPackagedAgentInstructionFiles(
      check.outputDir,
      cwd,
      explicitFilesConfigDests(filesOf(check)),
    );
    issues.push(...resolveIssueSeverity(raw, check.packaging.validation));
  }
  return {
    bundlesInspected: outputs.built.length,
    bundlesExpected: outputs.expected,
    bundlesInPlace: outputs.inPlace,
    bundlesMissing: outputs.missing,
    issues,
  };
}

/**
 * What the packaged-content crawl found, over how many bundles, and how many
 * it should have found.
 *
 * `bundlesInspected` can exceed `bundlesExpected`: a bundle sitting in `dist/`
 * for a `skills.config` key discovery no longer reaches is inspected (it is
 * distributed output) but not expected (nothing in this run builds it). It can
 * fall short of it only by the bundles named in `bundlesMissing`.
 */
export interface PackagedContentCrawl {
  /** Built bundles that EXIST on disk and were crawled — the phase's denominator. */
  bundlesInspected: number;
  /** Bundles `vat build` produces for this run's discovered skills — what the denominator should be. */
  bundlesExpected: number;
  /** Discovered skills declared `publish: false` and not plugin-local — used in place, so no bundle is expected for them. */
  bundlesInPlace: number;
  /** Expected bundles absent from disk, as `cwd`-relative paths. Non-empty means the phase is not a verdict. */
  bundlesMissing: string[];
  issues: ValidationIssue[];
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
  results: readonly MissingDests[],
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
 * Log packaged-content findings to stderr — a companion to the report, never a
 * substitute for it.
 *
 * Rendered through the SHARED {@link formatIssueLines}, which `vat skills build`
 * and `vat skills validate` already use: a second renderer for the same shape is
 * how one command's findings end up spelled differently from every other's.
 */
function reportPackagedContentIssues(
  findings: readonly Finding[],
  logger: ReturnType<typeof createLogger>
): void {
  logger.error(`\n▶ Phase: ${PACKAGED_CONTENT}`);
  for (const finding of findings) {
    for (const line of formatIssueLines(finding, '  ')) logger.error(line);
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
 *   read. Every delegated phase still runs so THE PHASE reports the real config
 *   error (exit 2) instead of this command guessing.
 * @param verbose - Forwarded to each delegated phase. Each phase owns its own
 *   summarization; this command only relays the request.
 */
export function selectVerifyPhases(
  config: ProjectConfig | undefined,
  configError?: string,
  verbose?: boolean,
): PhaseSelection {
  const phases: Phase[] = [];
  const unreadable = configError !== undefined;
  const detail = verbose === true;

  if (unreadable || config?.resources) {
    phases.push({
      name: 'resources',
      schema: RESOURCES_VALIDATE_REPORT_SCHEMA,
      run: () => runResourcesValidatePhase(undefined, { verbose: detail }),
    });
  }

  if (unreadable || config?.skills) {
    phases.push({
      name: 'skills',
      schema: SKILLS_VALIDATE_REPORT_SCHEMA,
      run: () => runSkillsValidatePhase(undefined, { verbose: detail }),
    });
  }

  for (const name of Object.keys(config?.claude?.marketplaces ?? {})) {
    // Bound per marketplace, so each phase closes over its OWN name. This is a
    // loop over the adopter's config, which is why verify's phase count is
    // `2 + n` and never the constant four its help text once implied.
    const marketplacePath = `dist/.claude/plugins/marketplaces/${name}`;
    phases.push({
      name: `marketplace:${name}`,
      schema: MARKETPLACE_VALIDATE_REPORT_SCHEMA,
      run: () => runMarketplaceValidatePhase(marketplacePath, { verbose: detail }),
    });
  }

  return decidePhaseSelection(undefined, phases, VERIFY_VOCABULARY, {
    unreadableConfig: configError,
  });
}

/** The in-process phase that crawls built skill bundles for what must not ship. */
const PACKAGED_CONTENT = 'packaged-content';

/** Phases that exist only in this command, run after the delegated ones, in execution order. */
type InProcessPhaseName = typeof FILES_CONFIG_DESTS | typeof PACKAGED_CONTENT | 'consistency';

/**
 * Which in-process phases this run performs, given the config.
 *
 * The SINGLE source for that question: {@link verifyTopLevelCommand} gates
 * execution on this list and {@link formatVerifyAnnouncement} announces the same
 * list, so the printed phase list cannot drift from the phases that run. It used
 * to be announced from the delegated phases alone while these two were gated by
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
 * the same input, the `skills:` block — without it {@link runFilesConfigDestsPhase}
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
  delegatedPhaseNames: readonly string[],
  config: ProjectConfig | undefined,
): string {
  const all = [...delegatedPhaseNames, ...selectInProcessVerifyPhases(config)];
  return `🔍 vat verify (phases: ${all.join(' → ')})`;
}

/** The `packaged-content` phase: its name and its report. */
export interface PackagedContentPhaseResult extends PhaseResult {
  report: Report<PackagedContentData>;
}

/**
 * The refusal for a crawl that found only PART of the build.
 *
 * Mirrors `unresolvedLocalPluginsFinding` in `claude/marketplace/validate.ts`:
 * the count declared, the count checked, and the missing ones BY NAME — the
 * operator's next move is to look at those paths, so the message carries them.
 * ONE finding however many are missing (run-integrity invariant 4).
 *
 * @param crawl - What the crawl found, over what
 * @returns The one finding, or nothing when every expected bundle was inspected
 */
function missingBundlesFinding(crawl: PackagedContentCrawl): readonly ValidationIssue[] {
  if (crawl.bundlesMissing.length === 0) return [];
  const named = crawl.bundlesMissing.map((dir) => `\`${dir}\``).join(', ');
  return [runIntegrityFinding(
    `This run discovered skills that \`vat build\` produces ${crawl.bundlesExpected} bundle(s) for and`
    + ` the packaged-content phase inspected ${crawl.bundlesInspected}, so this phase is not a verdict`
    + ' on the build: a bundle that was never crawled reads the same as a clean one. Expected'
    + ` bundle(s) not found on disk: ${named}. Usually \`vat build\` has not run since a skill was`
    + ' added, failed part-way, or wrote somewhere other than dist/ — or the bundle was deleted.'
    + ' Run `vat build` first, then re-run `vat verify`.',
  )];
}

/** The refusal for a crawl that found no bundle at all where one was expected. */
function noBundleFinding(): ValidationIssue {
  return runIntegrityFinding(
    'The packaged-content phase inspected 0 built skill bundles, so this phase is not a'
    + ' verdict: nothing was crawled for files that must not ship, and the document reads'
    + ' the same as a run over clean bundles. Either `vat build` has not run (or wrote'
    + ' somewhere other than dist/), or `skills.include` in vibe-agent-toolkit.config.yaml'
    + ' matched no SKILL.md — usually a typo in the glob. Run `vat build` first; `vat skills'
    + ' validate` lists what the globs discover.',
  );
}

/**
 * Build the `packaged-content` phase from what the crawl found.
 *
 * 🚨 **Zero bundles is an ERROR, not a clean phase — and so is a MISSING one.**
 * `vat verify` exists to check the BUILT tree; a run that found none of it is
 * not a verdict on it, and neither is a run that found half of it. This phase
 * refuses both itself, with the specific cause, rather than leaving it to the
 * writer's zero-examined pass — which judges the whole run's sum, and the skills
 * phase beside this one always examined something. One `RESOURCE_CHECK_BROKEN`
 * at `error`, never two: the missing-bundle refusal names paths, so it wins.
 *
 * One zero IS a verdict: nothing expected because every discovered skill is in
 * place (`bundlesInPlace > 0`). Zero discovered skills stays refused.
 *
 * Pure, and exported so the refusal is pinned without a project on disk.
 */
export function buildPackagedContentPhase(crawl: PackagedContentCrawl): PackagedContentPhaseResult {
  const { issues: found, bundlesInspected, ...data } = crawl;
  const missing = missingBundlesFinding(crawl);
  const accountedFor = data.bundlesExpected === 0 ? bundlesInspected + data.bundlesInPlace : bundlesInspected;
  const nothing = accountedFor === 0 && missing.length === 0 ? [noBundleFinding()] : [];
  return {
    name: PACKAGED_CONTENT,
    report: buildReport({
      examined: bundlesInspected,
      findings: toFindings([...missing, ...nothing, ...found]),
      data,
      gate: ORCHESTRATOR_GATE,
    }),
  };
}

/**
 * Run the `packaged-content` phase: crawl, derive the phase, and report THAT
 * phase's findings on stderr — so what stderr says and what the exit code is
 * computed from are one list (`run-integrity.ts` invariant 6).
 */
export function runPackagedContentPhase(
  projectRoot: string,
  discoveredSkills: readonly DiscoveredSkill[],
  pluginLocal: PluginLocalSkillIndex,
  pluginLocalNames: PluginLocalSkillNames,
  logger: ReturnType<typeof createLogger>,
): PackagedContentPhaseResult {
  const phase = buildPackagedContentPhase(checkPackagedAgentInstructionFiles(projectRoot, discoveredSkills, pluginLocal, pluginLocalNames));
  reportPackagedContentPhase(phase, logger);
  return phase;
}

export function reportPackagedContentPhase(
  phase: PackagedContentPhaseResult,
  logger: ReturnType<typeof createLogger>,
): void {
  const { findings, data, examined } = phase.report;
  if (findings.length > 0) {
    reportPackagedContentIssues(findings, logger);
  } else if (data !== null && data.bundlesExpected === 0 && examined === 0) {
    logger.info(`\n▶ Phase: ${PACKAGED_CONTENT} — nothing to inspect: all ${data.bundlesInPlace} discovered skill(s) are in place (publish: false)`);
  }
}

/** One finding per `files:` dest absent from the built output, located at the path it should be. */
function filesDestFindings(projectRoot: string, missing: readonly MissingDests[]): Finding[] {
  return missing.flatMap(({ skillName, outputDir, missing: dests }) => dests.map((dest): Finding => ({
    code: 'FILES_CONFIG_DEST_MISSING',
    severity: 'error',
    message: `Skill '${skillName}' declares the files: dest '${dest}', and the built output does not hold it.`,
    location: toForwardSlash(safePath.relative(projectRoot, safePath.resolve(outputDir, dest))),
    fix: 'Run `vat build` so the files: entry is applied, or correct the entry\'s dest in vibe-agent-toolkit.config.yaml.',
  })));
}

/**
 * The `files-config-dests` phase: every built bundle declaring `files:` dests,
 * checked. `examined` is the bundles checked — those that exist and declare at
 * least one dest — and each missing dest is one `FILES_CONFIG_DEST_MISSING`
 * error at the path it should be, relative to `projectRoot`. Always `error`: the
 * code is a `NonOverridableCode`, so no `validation.severity` is read for it.
 *
 * @param discovered - The skills this run discovered from `skills.include`. See
 *   {@link collectBuiltSkillOutputs} for why it is required rather than optional.
 * @param pluginLocal - The run's plugin-local index — required for the same reason.
 * @param pluginLocalNames - The declared name of every location in `pluginLocal` — required for the same reason.
 */
export function runFilesConfigDestsPhase(
  projectRoot: string,
  discovered: readonly DiscoveredSkill[],
  pluginLocal: PluginLocalSkillIndex,
  pluginLocalNames: PluginLocalSkillNames,
  logger: ReturnType<typeof createLogger>,
): PhaseResult {
  const built = collectBuiltSkillOutputs(projectRoot, discovered, pluginLocal, pluginLocalNames).built;
  const { checked, missing } = checkFilesConfigDestsOf(built);
  if (missing.length > 0) reportFilesDestErrors(missing, logger);
  return {
    name: FILES_CONFIG_DESTS,
    report: buildReport({ examined: checked, findings: filesDestFindings(projectRoot, missing), data: null, gate: ORCHESTRATOR_GATE }),
  };
}

/**
 * The in-process consistency check phase, its findings published into the
 * report, not merely logged: they used to go to stderr only, so the archived
 * YAML — the artifact of record — said nothing happened.
 *
 * Discovery is handed in rather than performed here: it crawls the whole project,
 * and the packaged-content and files-config-dests phases need the same list. One
 * crawl per run, one answer to "which skills does this project have".
 */
function runConsistencyPhase(
  logger: ReturnType<typeof createLogger>,
  config: ProjectConfig,
  projectRoot: string,
  discoveredSkills: readonly DiscoveredSkill[],
  pluginLocal: PluginLocalSkillIndex,
): PhaseResult {
  const { issues } = runConsistencyChecks([...discoveredSkills], config, projectRoot, pluginLocal);
  if (issues.length > 0) reportConsistencyIssues(issues, logger);
  return {
    name: 'consistency',
    report: buildReport({ examined: discoveredSkills.length, findings: issues, data: null, gate: ORCHESTRATOR_GATE }),
  };
}

/**
 * Run one in-process phase as a {@link Phase}, so a throw inside it — a
 * `package.json` the OS will not read, coded `INPUT_UNREADABLE` — becomes THAT
 * phase's refusal with its own code, and the phases that finished still publish.
 */
async function inProcess(name: string, schema: PhaseReportSchema, run: () => PhaseResult): Promise<PhaseResult> {
  return runPhase({ name, schema, run: () => Promise.resolve({ report: run().report }) });
}

/**
 * The in-process half of `vat verify`: `files-config-dests`, `packaged-content` and
 * `consistency`, each where `inProcess` names it, each recorded as it finishes.
 */
async function runInProcessPhases(run: {
  phases: readonly InProcessPhaseName[];
  config: ProjectConfig;
  skills: NonNullable<ProjectConfig['skills']>;
  projectRoot: string;
  logger: ReturnType<typeof createLogger>;
  results: PhaseResult[];
}): Promise<void> {
  const { phases, config, projectRoot, logger, results } = run;
  // ONE discovery for the whole in-process half of the run: every phase below
  // asks "which skills does this project have", and each used to answer it
  // differently. `'refuse'`: a verify over a population it could not see is the
  // green-without-checking shape this command exists to refuse — the throw is
  // the run's refusal, published with the phases that already finished.
  const discoveredSkills = await discoverSkillsFromConfig(run.skills, projectRoot, 'refuse');
  // ONE plugin-local index likewise, and the declared name of each plugin-local
  // skill, which keys its config exactly as the plugin build keyed it.
  const pluginLocal = indexPluginLocalSkills(config, projectRoot);
  const pluginLocalNames = await readPluginLocalSkillNames(pluginLocal);

  if (phases.includes(FILES_CONFIG_DESTS)) {
    results.push(await inProcess(FILES_CONFIG_DESTS, DATALESS_PHASE_REPORT_SCHEMA, () =>
      runFilesConfigDestsPhase(projectRoot, discoveredSkills, pluginLocal, pluginLocalNames, logger)));
  }
  if (phases.includes(PACKAGED_CONTENT)) {
    results.push(await inProcess(PACKAGED_CONTENT, PACKAGED_CONTENT_REPORT_SCHEMA, () =>
      runPackagedContentPhase(projectRoot, discoveredSkills, pluginLocal, pluginLocalNames, logger)));
  }
  if (phases.includes('consistency')) {
    results.push(await inProcess('consistency', DATALESS_PHASE_REPORT_SCHEMA, () =>
      runConsistencyPhase(logger, config, projectRoot, discoveredSkills, pluginLocal)));
  }
}

async function verifyTopLevelCommand(
  options: VerifyCommandOptions,
  command: Command,
): Promise<void> {
  const { logger } = createPhaseContext(options.debug);

  const report = await orchestrate(async (results) => {
    // First, and before requireProjectRoot: `vat verify dist/skills/demo` used to
    // be accepted, have its path discarded, run wide over the whole project and
    // report success.
    rejectPositionalArguments(
      command.args,
      COMMAND_NAME,
      'verifies every phase vibe-agent-toolkit.config.yaml declares, against the built dist/ tree',
    );
    // Before requireProjectRoot: a retired flag is a usage error, and answering it
    // with "no vibe-agent-toolkit.config.yaml found" would diagnose the wrong problem.
    rejectRetiredOnly(options.only, COMMAND_NAME, VERIFY_FULL_RUN_SECONDS);

    // Spec §7: `vat verify` requires a projectRoot.
    const projectRoot = requireProjectRoot(process.cwd(), COMMAND_NAME);
    const { config, error: configError } = loadConfigTolerant(projectRoot);
    const phases = applyPhaseSelection(selectVerifyPhases(config, configError, options.verbose), logger);

    // Announced from the same list the in-process gates below read, so the
    // printed phases and the executed phases cannot disagree.
    const inProcessPhases = selectInProcessVerifyPhases(config);
    logger.info(formatVerifyAnnouncement(phases.map((p) => p.name), config));

    for (const phase of phases) {
      logger.info(`\n▶ Phase: ${phase.name}`);
      // Awaited in the loop, deliberately: phases are announced in a fixed order
      // and their stderr streams live, so overlapping them would interleave two
      // running reports into one unreadable channel.
      results.push(await runPhase(phase));
    }

    if (inProcessPhases.length > 0 && config?.skills) {
      await runInProcessPhases({ phases: inProcessPhases, config, skills: config.skills, projectRoot, logger, results });
    }
  });
  endWithReport('verify', report, ORCHESTRATOR_FORMAT);
}
