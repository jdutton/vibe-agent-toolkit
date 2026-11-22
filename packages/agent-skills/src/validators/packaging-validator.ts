/**
 * Enhanced skill validation for packaging
 *
 * Extends basic skill validation with:
 * - Size/complexity validation (SKILL.md lines, total lines, file count)
 * - Link depth analysis (prevent deep nesting)
 * - Navigation file detection (README.md, index.md patterns)
 * - Framework-based severity / allow config (validation.severity, validation.allow)
 *
 * Used by:
 * - vat skills validate (report errors, exit 1 on failure)
 * - vat skills build (block build on validation errors)
 * - vat skills audit --user (report issues, exit 0 always)
 */

import { basename, dirname } from 'node:path';

import {
  DeferredArtifacts,
  listingRefusalRemedy,
  type NotAdmittedRoots,
  partitionNotAdmitted,
  type ParseDispatcher,
  isParseLimitError,
  type ParseRefusedResource,
  type PopulationUnreadablePolicy,
  ResourceRegistry,
  type SkillExecutableEntry,
  type SkillTextFacts,
} from '@vibe-agent-toolkit/resources';
import {
  CODE_REGISTRY,
  runSingleUnitValidation,
  runValidationFramework,
  summarizeIssues,
  type AllowUsageLedger,
  type AllowRecord,
  type IssueCode,
  type SeverityCounts,
  type ValidationConfig,
  type ValidationIssue,
} from '@vibe-agent-toolkit/schema';
import {
  classifyFsFault,
  findProjectRoot,
  followedKindSync,
  type FsSide,
  isNotARegularFileError,
  issueLocation,
  mapWithConcurrency,
  normalizedTmpdir,
  toForwardSlash,
  toForwardSlashAnyPlatform,
  safePath,
  withFsFaultSync,
  appendAll,
  countWork,
} from '@vibe-agent-toolkit/utils';
import {
  BUILD_OUTPUT_GLOBS,
  crawlDirectory,
  crawlPathFilter,
} from '@vibe-agent-toolkit/utils/crawl';
import { readTextContent } from '@vibe-agent-toolkit/utils/fs';
import { type GitTracker } from '@vibe-agent-toolkit/utils/git';

import type { EvidenceRecord, Observation } from '../evidence/index.js';
import { collectPreBuildGlobFindings, preBuildGlobFindingsToIssues } from '../files-config.js';
import { isSkillPackagingInputError } from '../packaging-errors.js';
import { parseRefusalIssue, parseRefusedIssues } from '../parse-refusal-issues.js';
import { readSkillDocument, scannedSkillText, type SkillDocument, skillNameOf, storedSkillText, type SkillTextRun } from '../skill-text-lane.js';
import {
  conventionalSuiteProbe,
  partitionTestInputFileEntries,
  resolveTestInputDirs,
  testInputExcludeRules,
  testInputLinkIssues,
  type ConventionalSuiteProbe,
  type DeclaredEvalSuite,
} from '../test-input.js';
import { walkLinkGraph, type LinkResolution, type WalkableRegistry } from '../walk-link-graph.js';

import { observationToIssue, runCompatDetectors } from './compat-detectors.js';
import { detectUndeclaredCrossSkillAuth } from './cross-skill-dependency-detection.js';
import { validateFrontmatterRules, validateFrontmatterSchema } from './frontmatter-validation.js';
import { collectUnqualifiedMcpToolIssues } from './mcp-tool-qualification.js';
import {
  collectNonPortableAssetReferenceIssues,
  collectNonPortableCommandIssues,
  collectTimeSensitiveContentIssues,
} from './portability-issues.js';
import { materializeIssue } from './rule-engine/index.js';
import { REGISTRY_INCLUDE, type RunSkillRegistries } from './run-skill-registries.js';
import { SOURCE_ONLY_CODES } from './source-only-codes.js';
import {
  VALIDATION_RULES,
  VALIDATION_THRESHOLDS,
} from './validation-rules.js';
import { deferredAssetsToIssues, outsideSkillDirLinksToIssues, walkerExclusionsToIssues } from './walker-to-issues.js';

/** Exclude reason constants to avoid duplicate string literals */
const EXCLUDE_REASON_DIRECTORY = 'directory-target' as const;
const EXCLUDE_REASON_OUTSIDE_PROJECT = 'outside-project' as const;
const DETAIL_REASON_DEPTH: ExcludedReferenceDetail['reason'] = 'depth-exceeded';

/**
 * Packaging configuration for skill validation.
 * Replaces the old VatSkillMetadata parameter — accepts packaging options directly.
 */
export interface SkillPackagingConfig {
  linkFollowDepth?: number | 'full';
  resourceNaming?: 'basename' | 'resource-id' | 'preserve-path';
  stripPrefix?: string;
  excludeNavigationFiles?: boolean;
  excludeReferencesFromBundle?: {
    rules?: Array<{ patterns: string[]; template?: string }>;
    defaultTemplate?: string;
  };
  files?: Array<{ source: string; dest: string }>;
  /** Framework-based validation configuration (severity overrides and allow entries). */
  validation?: ValidationConfig | undefined;
  /**
   * Declared runtime targets for this skill. Used by the CLI verdict layer
   * to suppress non-applicable compat verdicts. The packaging validator
   * itself only stores the declaration; verdict computation lives in the
   * CLI (which can also bring in plugin / marketplace target layers).
   */
  targets?: ReadonlyArray<'claude-chat' | 'claude-cowork' | 'claude-code'>;
  /**
   * Declared executables the skill ships (name-stable references for eval
   * `toolExpectations` + launch-guidance linting). The
   * config merge (`mergeSkillPackagingConfig`) copies this through generically;
   * declaring it here lets consumers (e.g. `vat skill test run`) read it typed.
   */
  executables?: SkillExecutableEntry[];
  /**
   * The skill's `vat skill test` config. Only `evals` is load-bearing for packaging:
   * it declares where the skill's TEST INPUT lives, which packaging must exclude
   * from the shipped bundle (see test-input.ts). The rest of the block is carried
   * through generically by the config merge and read by `vat skill test`.
   */
  test?: { evals?: string | undefined } | undefined;
}

/** Excluded reference detail for verbose output */
export interface ExcludedReferenceDetail {
  path: string;
  reason: 'depth-exceeded' | 'pattern-matched' | 'outside-project' | 'navigation-file' | 'agent-instruction-file' | 'skill-definition' | 'gitignored' | 'non-routable-source';
  matchedPattern?: string | undefined;
}

/**
 * Enhanced validation result using the unified framework
 */
export interface PackagingValidationResult {
  /** Skill name */
  skillName: string;

  /**
   * `findings` when {@link PackagingValidationResult.allErrors} holds anything,
   * `ok` when it is empty — `resultStatus(allErrors)` from
   * `@vibe-agent-toolkit/schema`, the one derivation every library result and
   * `buildReport` share.
   *
   * It is NOT the build gate. "Does this fail a build?" is `summary.errors > 0`
   * — a warning does not fail a build, and an info-only result is `findings`.
   */
  status: 'ok' | 'findings';

  /**
   * Per-severity counts of {@link PackagingValidationResult.allErrors}
   * (`countBySeverity`). Anything that appends to `allErrors` after
   * construction (the CLI's `applyConfigVerdicts`) re-derives `status` and
   * `summary` in the same step, so the counts never go stale.
   */
  summary: SeverityCounts;

  /**
   * THE container: every emitted issue after severity resolution, stored once.
   *
   * This includes `info`, despite the name: severity resolution keeps info
   * issues in the framework's `emitted` set. Issues suppressed by `allow` are
   * NOT here — they live in {@link PackagingValidationResult.ignoredErrors}.
   *
   * There are deliberately no `activeErrors` / `activeWarnings` sibling arrays.
   * They were filtered views over this same array, and because every consumer
   * that serializes a result spreads the whole object, each issue record —
   * including its paragraph-length `fix` and `reference` prose — was written to
   * the output document twice. Derive the partition instead:
   * {@link activeErrorsOf} / {@link activeWarningsOf}, or read
   * {@link PackagingValidationResult.summary} for the counts.
   */
  allErrors: ValidationIssue[];

  /** Issues suppressed by allow entries */
  ignoredErrors: AllowRecord[];

  /**
   * Capability observations rolled up from compat detectors.
   * Carried alongside emitted issues so downstream verdict computation
   * (CLI layer) can recover observation payloads (e.g. EXTERNAL_CLI binary)
   * without re-parsing the skill.
   */
  observations: Observation[];

  /**
   * Raw evidence records collected by compat detectors. Surfaced so that
   * audit `--verbose` can render the underlying matches for each capability
   * observation without re-parsing the skill.
   */
  evidence: EvidenceRecord[];

  /** Metadata about the skill */
  metadata: {
    skillLines: number;
    totalLines: number;
    fileCount: number;
    directFileCount: number;
    maxLinkDepth: number;
    excludedReferenceCount: number;
    excludedReferences: ExcludedReferenceDetail[];
  };
}

/** Anything carrying the emitted-issue container — a result, or a partial of one. */
type WithAllErrors = Pick<PackagingValidationResult, 'allErrors'>;

/**
 * The active errors: emitted, resolved-severity `error`.
 *
 * Derived on read, never stored on the result — see the `allErrors` doc comment
 * for why. Equivalent to `result.summary.errors > 0` when all you need is the
 * gate bit; use this only when you need the issues themselves.
 */
export function activeErrorsOf(result: WithAllErrors): ValidationIssue[] {
  return result.allErrors.filter(i => i.severity === 'error');
}

/** The active warnings: emitted, resolved-severity `warning`. Derived on read. */
export function activeWarningsOf(result: WithAllErrors): ValidationIssue[] {
  return result.allErrors.filter(i => i.severity === 'warning');
}

/**
 * Validate files config entries for duplicate dest values and directory sources.
 *
 * A `files:` entry is a typed single-file slot: its source must resolve to a
 * file, not a directory. If the source path exists and is a directory, emit
 * LINK_TARGETS_DIRECTORY. Missing sources are not flagged here (deferred build
 * artifacts are handled by the skill-packager).
 */
function validateFilesConfig(
  files: Array<{ source: string; dest: string }> | undefined,
  projectRoot: string,
  locationRoot: string,
): ValidationIssue[] {
  if (!files?.length) return [];

  const issues: ValidationIssue[] = [];
  const destSet = new Set<string>();

  for (const entry of files) {
    const normalized = toForwardSlashAnyPlatform(entry.dest);
    if (destSet.has(normalized)) {
      issues.push({
        severity: 'error',
        code: 'DUPLICATE_FILES_DEST',
        message: `Duplicate dest '${entry.dest}' in files config. Each dest must be unique.`,
      });
    }
    destSet.add(normalized);

    // Check if an existing source resolves to a directory — a typed single-file
    // slot cannot be satisfied by a directory.
    const resolvedSource = safePath.resolve(safePath.join(projectRoot, entry.source));
    // Crawled beneath the project root: a refused probe or link chain is the source's fault, thrown.
    const sourceKind = withFsFaultSync(
      { side: 'source', origin: 'content', action: `examine files: source '${entry.source}'`, path: resolvedSource },
      () => followedKindSync(resolvedSource, projectRoot),
    );
    if (sourceKind === 'directory') {
      // Anchor at the resolved source, expressed in the run's ONE coordinate
      // system — not the raw config value, which is project-relative and so
      // unresolvable in a run that spans several projects.
      const location = issueLocation(resolvedSource, locationRoot);
      issues.push(registryIssueAt(
        'LINK_TARGETS_DIRECTORY',
        `files: source '${entry.source}' resolves to a directory; a typed single-file slot requires a file`,
        location,
      ));
    }
  }

  return issues;
}

/**
 * What to do about a bundled file the OS will not read: a named pipe, socket or
 * device has no permissions to fix — only a regular file to put in its place.
 */
function unreadableRemedy(error: unknown): string {
  return isNotARegularFileError(error)
    ? 'Link a regular file in its place (a named pipe, socket or device has no content to bundle), or remove the link.'
    : "Check the file's permissions and ownership, and that every directory above it is traversable.";
}

/**
 * A bundled markdown file's skill-text record — the store's when the run's
 * store serves it ({@link storedSkillText}), else the core over the file's text
 * ({@link scannedSkillText}) — or the finding that replaces it when the OS will not read it — `LINK_TARGET_UNREADABLE` at that file, the code the walker
 * gives a link target it cannot stat. The fault is classified once, on `side`:
 * one the skill's source owns (`isSkillPackagingInputError`) is a finding against
 * the skill; a capacity fault, or one on VAT's own output, is the run's — carried
 * as the failure. Read through `readTextContent`, which refuses a named pipe
 * unread (`EFTYPE`) — a bare `readFile` blocked on one until a writer appeared,
 * hanging the build. Only the read is classified here: a store that fails to
 * answer rejects as itself, the run's failure, never a fault of this file.
 */
async function readBundledMarkdown(
  file: string,
  location: string,
  side: FsSide,
  run: SkillTextRun,
): Promise<BundledMarkdownRead> {
  const stored = await storedSkillText(file, run);
  if (stored !== undefined) return { facts: stored };
  let text: string;
  try {
    text = await bundledText(file, run.dispatcher);
  } catch (error) {
    // Carried, not thrown: reads run in parallel, and the failure the caller
    // raises must be the first in bundle order, not the first to finish.
    const fault = classifyFsFault(error, { side, origin: 'content', action: `read linked file ${location}`, path: file });
    if (!isSkillPackagingInputError(fault)) return { failure: fault };
    return {
      issue: registryIssueAt(
        'LINK_TARGET_UNREADABLE',
        `Linked file ${location} is bundled, but it could not be read: ${(error as Error).message}. ${unreadableRemedy(error)}`,
        location,
      ),
    };
  }
  return { facts: scannedSkillText(file, text, run) };
}

/**
 * A bundled file's text: the run's read of it when the dispatcher serves a run
 * (one read per file per run, content-keying-and-git.md rule 4), else a read of
 * its own. A file past the run's parse input cap is still read whole here, as it
 * always was: this lane scans text, it does not parse it. That read is counted as
 * `content.read`, as the run's read is: the run's read refused it before reading,
 * so this is the one read of its bytes, and an uncounted one would hide it from
 * every work-counter check. It is never keyed, so it adds no `content.hashed`.
 */
async function bundledText(file: string, dispatcher: ParseDispatcher): Promise<string> {
  const content = dispatcher.content;
  if (content === undefined) return (await readTextContent(file)).text;
  try {
    return (await content.read(file, 'markdown')).content;
  } catch (error) {
    if (!isParseLimitError(error)) throw error;
    const { text } = await readTextContent(file);
    countWork('content.read', 1);
    return text;
  }
}

/** One bundled markdown read: its record, the finding that replaces it, or a failure that refuses the run. */
type BundledMarkdownRead = { facts: SkillTextFacts } | { issue: ValidationIssue } | { failure: unknown };

/**
 * Create a validation issue from a code-registry code with a bespoke message,
 * anchored at a project-relative `location`.
 *
 * Thin wrapper over the shared {@link materializeIssue} so severity / fix /
 * reference come from the single CODE_REGISTRY source; the
 * caller supplies a fully-formed `message`.
 *
 * Deliberately NOT named `createRegistryIssue`: `@vibe-agent-toolkit/schema`
 * exports a function by that name whose third parameter is an EXTRAS OBJECT, not
 * a location string. Two same-named functions with incompatible third arguments
 * is a trap for anyone reading a call site.
 */
function registryIssueAt(
  code: IssueCode,
  message: string,
  location?: string,
): ValidationIssue {
  return materializeIssue(code, { message, location });
}

/**
 * The registry a skill is validated against: the run's view of the skill's
 * project root (or, for a skill with no project root, of its own directory),
 * crawled once per run under the caller's ruling.
 *
 * @param skillPath - Path to SKILL.md
 * @param projectRoot - The root the view covers
 * @param shared - The run's context
 * @param context - `built` for output this run wrote, which the view never holds — see {@link withOwnBundle}
 * @returns A registry whose links are resolved and that covers `skillPath`, and
 *   every parse refusal behind it — the view's and, when a built bundle is
 *   layered over it, the bundle's (the layered copy carries only its own log)
 */
async function registryForSkill(
  skillPath: string,
  projectRoot: string,
  shared: SkillValidationSharedContext,
  context: 'source' | 'built',
): Promise<{ registry: ResourceRegistry; parseRefused: ParseRefusedResource[] }> {
  const { unreadable, outputs } = shared;
  const base = await shared.registries.forRoot(projectRoot, { unreadable, outputs });
  // The view "covers" the skill by directory alone — one crawled before a build wrote
  // the bundle covers it and holds none of it — so it takes the layering.
  const registry = context === 'built' && base.getResource(safePath.resolve(skillPath)) === undefined
    ? await withOwnBundle(base, dirname(skillPath), unreadable, outputs)
    : base;
  const parseRefused = registry === base
    ? base.getParseRefusedResources()
    : [...base.getParseRefusedResources(), ...registry.getParseRefusedResources()];
  return { registry, parseRefused };
}

/** Whether a root-relative path lies OUTSIDE build output (`dist/`), which a crawl of the root never admits. */
const outsideBuildOutput = crawlPathFilter(['**/*'], BUILD_OUTPUT_GLOBS);

/**
 * The project's view with a bundle it does not hold layered over it:
 * the project's resources, plus the bundle's own files read now: none under
 * `dist/` (the defect `runPostBuildValidation` documents, unchanged here), and
 * every other one, ignored or not — it is this run's own output, so no ignore
 * rule decides what the check sees.
 *
 * The view — crawled once per run — never holds the bundle: it is written after
 * the crawl, at a staging name (`.<name>.vat-staged-*`) the crawl excludes as
 * residue. Only the bundle is read; the root is not crawled again. The project's
 * resources are COPIED, links and all, before links are resolved, so the view
 * never learns of the bundle.
 *
 * @param registry - The project root's view
 * @param bundleDir - The directory holding the built SKILL.md
 * @param unreadable - The caller's ruling, for a bundle directory that cannot be listed
 * @param outputs - What the run writes: the bundle's side of any fault
 * @returns A registry that holds the bundle, links resolved
 */
async function withOwnBundle(
  registry: ResourceRegistry,
  bundleDir: string,
  unreadable: PopulationUnreadablePolicy,
  outputs: readonly string[],
): Promise<ResourceRegistry> {
  const root = registry.baseDir ?? bundleDir;
  if (!outsideBuildOutput(toForwardSlash(safePath.relative(root, safePath.join(bundleDir, 'SKILL.md'))))) return registry;
  const bundle = await crawlDirectory({
    baseDir: bundleDir,
    include: [...REGISTRY_INCLUDE],
    exclude: [],
    respectGitignore: false,
    unreadable: unreadable === 'refuse'
      ? { refuse: { root: bundleDir, remedy: listingRefusalRemedy(bundleDir), side: 'destination' } }
      : unreadable,
    outputs,
  });
  const copies = registry.getAllResources().map((resource) => ({ ...resource, links: resource.links.map((link) => ({ ...link })) }));
  const layered = ResourceRegistry.fromResources(root, copies, registry.config === undefined ? undefined : { config: registry.config });
  await layered.addResources(bundle);
  layered.resolveLinks();
  return layered;
}

/**
 * Shared context for batched skill validation runs.
 *
 * Populated once by the caller (e.g. `vat skills validate`) and threaded into
 * every per-skill validation so common setup is paid for exactly once:
 *   - `registry`: a pre-crawled + `.resolveLinks()`-completed ResourceRegistry
 *     covering the project root. Eliminates the per-skill markdown reparse.
 *   - `gitTracker`: a pre-populated {@link GitTracker} (from
 *     `GitTracker.initialize({ includeUntracked: true })`). Turns gitignore
 *     checks during the link-graph walk into O(1) set lookups instead of
 *     `git check-ignore` spawns.
 *
 * Both fields are optional — when omitted, the validator falls back to the
 * legacy per-skill behavior so one-off callers keep working.
 */
export interface SkillValidationSharedContext {
  /**
   * What the crawl of a skill's project root does with a directory it cannot
   * list — the caller's ruling: `'refuse'` for `vat skills validate`/`build`,
   * `vat skill review` and the packager's post-build check, `{ degrade }` for
   * `vat audit`. See {@link PopulationUnreadablePolicy}.
   */
  unreadable: PopulationUnreadablePolicy;
  /**
   * The run's skill registries: each skill is validated against the run's view of
   * its project root, crawled once per run. Required: there is no registry a
   * validation builds beside its run's.
   */
  registries: RunSkillRegistries;
  /**
   * What the CALLING VERB writes, for the crawl of a skill's root: `vat skills build` its
   * `dist/skills` and staging, the packager's post-build check the bundle it wrote, so a
   * fault on them is the run's (`RUN_INCOMPLETE`); `[]` for a verb that only reads
   * (`vat skills validate`, `vat audit`). Required: only the calling verb knows.
   */
  outputs: readonly string[];
  /** Pre-populated tracker for the repo that contains the skill. */
  gitTracker?: GitTracker;
  /**
   * Root every emitted `ValidationIssue.location` is expressed relative to.
   *
   * This is the ANCHOR base and it is a DIFFERENT concern from the project
   * root below: the project root is a validation-POLICY boundary (what counts
   * as "outside the project", where `files:` sources resolve from, what the
   * registry crawls), while the anchor base only answers "relative to what is
   * this location written?". Conflating the two is what let `vat audit` — which
   * spans many governing configs in a single run — emit one report in many
   * coordinate systems, with two distinct files sharing one `location`.
   *
   * A batching caller MUST pass its invocation scan root. Omitted, it falls
   * back to the project root, which is correct exactly when a run covers one
   * project (`vat skills validate`, `vat skills build`, `vat skill review`).
   */
  locationRoot?: string;
  /**
   * The RUN's allow-entry usage ledger.
   *
   * `validation.allow` is declared once per package but validated once per
   * skill, so "this entry matched nothing" is a question only the whole run can
   * answer — a batching caller MUST supply one ledger for the batch and drain it
   * with `allowUnusedIssues()` after the last skill. Without it, an entry scoped
   * to one skill's files is reported unused by every OTHER skill in the package
   * (measured: 78 ALLOW_UNUSED warnings from 3 legitimate entries).
   *
   * Omitting it is a positive claim that THIS call is the whole run — correct for
   * the single-skill callers (`vat skill review`, `vat audit`, whose shared
   * context is built per skill), where the per-skill and run-level answers
   * coincide. `vat skills build` supplies one: its pre-build source check is the
   * ONLY lane in that run that can match an entry scoped to a source filename
   * (packaging renames the file to `SKILL.md`), so withholding its matches
   * reported live entries as dead on every skill in the package.
   *
   * KNOWN GAP, worth fixing if you are already in this area: the plugin-local
   * skill loop in `packages/cli/src/commands/claude/plugin/build.ts` still omits
   * a ledger while looping, so it makes that positive claim falsely. It measures
   * zero on VAT only because VAT's plugins are assembled by copy-in. See the
   * comment at that call site for why it was left and what fixing it needs.
   */
  allowLedger?: AllowUsageLedger;
  /**
   * EVERY skill the project declares, with its effective packaging config.
   *
   * Read only for `test.evals`, and the rule it feeds is PROJECT-WIDE: a file any
   * skill declares as its eval suite is test input, and this lane must predict a
   * bundle without it — the same bundle `vat skills build` produces. Without this,
   * the lane counts a sibling skill's answer key as an ordinary bundled file, and
   * `vat skills validate` and `vat skills build` disagree about what ships.
   *
   * Assemble it ONCE per invocation from the lane's own skill discovery and pass the
   * same array to every skill; do not rebuild it per skill (that is a whole-project
   * config walk inside a per-skill loop). Omitting it is a positive claim that the
   * caller has no project to enumerate — true for a config-free single-skill audit,
   * false for anything that loops over discovered skills.
   */
  projectSkills?: readonly DeclaredEvalSuite[];
  /**
   * The RUN's conventional-suite probe — the memo behind "does `<skill-root>/evals/
   * evals.json` exist?" for every root in {@link projectSkills}.
   *
   * Scoped to the run for the same reason `projectSkills` is assembled once: the two
   * are the same question asked of the same S paths, and this lane asks it for the
   * SUBJECT and for every entry in `projectSkills`. A probe created per call answers
   * S questions per skill and S² per run — measured at 10,815 filesystem probes over
   * 103 distinct paths on a 103-skill adopter, half of that command's entire fs
   * traffic. Supply the SAME probe for every skill in the run.
   *
   * Omitting it is a positive claim that THIS call is the whole run — true for the
   * single-skill callers (`vat skill review`, `vat audit`, whose shared context is
   * built per skill), where the per-call and run-level answers coincide. False for
   * anything that loops, which is why the fallback below is written at the call site
   * rather than defaulted inside `resolveTestInputDirs`.
   */
  suiteProbe?: ConventionalSuiteProbe;
}

/**
 * The refusal for a matched file that has no frontmatter object — either no
 * `---` block at all, or one whose YAML did not parse (`frontmatterError`).
 *
 * Either way the file is not a skill, and it is refused with the SAME
 * non-overridable code `validateSkill` in skill-validator.ts emits for it:
 * `SKILL_MISSING_FRONTMATTER` has no CODE_REGISTRY entry, so the framework's
 * `finalize()` passes it through and `validation.severity` cannot name it.
 *
 * This refusal used to be absent from the packaging lane — its frontmatter
 * checks ran only `if (parseResult.frontmatter)` — so a plain `# Readme` a
 * `skills.include` glob drifted onto, or a SKILL.md that lost its fence, ran
 * zero frontmatter checks and came back `success` under its H1 as a name:
 * `vat skills validate`, `vat validate` and `vat verify` were green on a
 * project that shipped no skill.
 */
function missingFrontmatterIssue(frontmatterError: string | undefined, location: string): ValidationIssue {
  return {
    severity: 'error',
    code: 'SKILL_MISSING_FRONTMATTER',
    message: frontmatterError === undefined
      ? 'No YAML frontmatter found — a skill starts with a `---` block that names and describes it'
      : `Frontmatter did not parse as YAML: ${frontmatterError}`,
    location,
    line: 1,
    fix: 'Add YAML frontmatter with name and description fields, or narrow `skills.include` so it no longer matches this file',
  };
}

/**
 * Validate a skill for packaging
 *
 * Performs comprehensive validation including:
 * - Size/complexity checks
 * - Link depth analysis
 * - Navigation file detection
 * - Framework-based severity / allow config
 *
 * @param skillPath - Path to SKILL.md
 * @param resourcesValidation - The project's `resources.validation`, as the verb resolved it: the
 *   one config that settles a file not admitted — never `packagingConfig.validation`. Required:
 *   only the verb knows which config governs the run; `{}` when none does, or when the caller
 *   resolves those codes itself (`vat audit`)
 * @param packagingConfig - The skill's packaging configuration (depth, excludes, validation), if any
 * @param context - Whether the skill is being validated from source or built output
 * @param shared - The run's context: its skill registries, ruling and run-wide memos. Every
 *   parse this validator makes runs on the run's one dispatcher (`shared.registries.dispatcher`)
 * @returns Validation result with active errors, warnings, and allowed issues
 */
export async function validateSkillForPackaging(
  skillPath: string,
  resourcesValidation: ValidationConfig,
  packagingConfig: SkillPackagingConfig | undefined,
  context: 'source' | 'built',
  shared: SkillValidationSharedContext,
): Promise<PackagingValidationResult> {
  const run: SkillTextRun = shared.registries;
  const rawIssues: ValidationIssue[] = [];

  // Validation-POLICY boundary (config root -> git root -> skill dir): what is
  // "outside the project", where `files:` sources resolve from, what the
  // registry crawls. Library fallback to skill dir keeps callers null-safe; CLI
  // command boundary owns any user-facing warning.
  const projectRoot = findProjectRoot(dirname(skillPath)) ?? dirname(skillPath);
  // ANCHOR base — deliberately a separate variable from projectRoot above.
  // Every emitted location is relative to this ONE root, computed once before
  // the first producer runs so no collector can pick a different base. A
  // batching caller supplies it; alone in a project the two coincide.
  const locationRoot = shared.locationRoot ?? projectRoot;
  const skillLocation = issueLocation(skillPath, locationRoot);

  // A `built` skill is VAT's own output re-read: every read of its tree the OS refuses is the
  // destination's, never the user's input. The ONE mapping; every read below takes `side`.
  const side: FsSide = context === 'built' ? 'destination' : 'source';
  const parsed = await parseSkillMarkdown(skillPath, side, locationRoot, run);
  const notAdmitted: NotAdmittedPolicy = { resourcesValidation, roots: { locationRoot, projectRoot } };
  if ('limit' in parsed) return parseLimitResult(skillPath, parsed.limit, packagingConfig, shared, notAdmitted);
  // The SKILL.md as the store holds it, or as its parse decoded it: every
  // detector below reads its skill-text record, never the file again.
  const { document } = parsed;
  const { frontmatter, skillText } = document;
  const skillLines = skillText.lineCount;

  // Validate frontmatter schema (name format, required fields, etc.)
  if (frontmatter) {
    appendAll(rawIssues, [
      ...validateFrontmatterSchema(frontmatter, skillLocation),
      ...validateFrontmatterRules(frontmatter, skillLocation),
    ]);
  } else {
    rawIssues.push(missingFrontmatterIssue(document.frontmatterError, skillLocation));
  }

  // Compat capability detection: collect observations from SKILL.md and
  // surface each as a CAPABILITY_* issue. Observations are also returned
  // on the result so downstream verdict computation (CLI layer) can recover
  // payloads such as EXTERNAL_CLI binary names.
  const { evidence, observations } = runCompatDetectors(skillText, skillPath, locationRoot, frontmatter);
  for (const obs of observations) {
    rawIssues.push(observationToIssue(obs, skillLocation));
  }

  // Read packaging options for depth/exclude configuration
  const linkFollowDepth = packagingConfig?.linkFollowDepth ?? 2;
  const excludeConfig = packagingConfig?.excludeReferencesFromBundle;
  const excludeNavigationFiles = packagingConfig?.excludeNavigationFiles ?? true;
  const maxDepth = linkFollowDepth === 'full' ? Infinity : linkFollowDepth;

  // Validate files config (requires projectRoot to resolve source paths for
  // directory-source detection — must run after projectRoot is computed).
  appendAll(rawIssues, validateFilesConfig(packagingConfig?.files, projectRoot, locationRoot));

  // Build resource registry and walk the link graph.
  // Prefer the caller-supplied shared registry (when `vat skills validate` or
  // similar batches multiple skills under the same project root) so the
  // per-file markdown parse is paid for exactly once across the batch. Only
  // reuse when the shared registry covers this skill's projectRoot; otherwise
  // fall back to a fresh crawl to avoid leaking resources across roots.
  // A `built` skill sits in output this run wrote inside the project: the project root is then a destination.
  const { registry, parseRefused } = await registryForSkill(skillPath, projectRoot, shared, context);

  const skillResource = registry.getResource(safePath.resolve(skillPath));
  // Only the entries the PACKAGER will actually copy defer a link: an entry pointing
  // into declared test input is dropped at build time, so its dest never appears and
  // a link to it is a genuine broken link — the same verdict `vat skills build`
  // reaches. Same derivation `packagedFileEntries` performs for the lanes that have
  // no second use for the dirs — see test-input.ts.
  //
  // `projectSkills` is the PROJECT's declared eval suites, assembled once by the
  // calling lane (see SkillValidationSharedContext.projectSkills). Empty when the
  // caller has no project to enumerate — a single-skill audit of a tree with no
  // config — which narrows this lane to the subject's own suite and nothing else.
  const projectSkills = shared.projectSkills ?? [];
  // ONE resolution per skill, shared by both consumers below (the `files:` filter and
  // the walker's exclude rules), and ONE conventional-suite probe per RUN behind it.
  //
  // Two multipliers on the same filesystem question, both now closed. Resolving it
  // once per CONSUMER doubled the term for no new information (the two call sites took
  // identical arguments) — 6,844 probes on a 58-skill adopter declaring no `test:`
  // block, of which 3,422 re-asked a question already answered. That fix removed the
  // second call site and left the QUADRATIC standing: the resolution still probes the
  // subject AND every entry in `projectSkills`, so a lane looping over S skills asked
  // S^2 questions about S paths. Measured with the lab on a 103-skill adopter,
  // `vat resources validate`: 10,815 probes over 103 distinct paths (~105 repeats
  // each) — exactly 50% of that command's 21,648 user filesystem calls. With the run's
  // probe threaded here it is ~103 probes and ~10,900 calls on the same tree.
  //
  // A caller that omits `suiteProbe` is claiming this call IS the run (see the field's
  // docstring); the narrowing is written here, at the call site, so it cannot happen by
  // omission inside `resolveTestInputDirs`.
  const suiteProbe = shared.suiteProbe ?? conventionalSuiteProbe();
  const testInputDirs = resolveTestInputDirs(
    packagingConfig ?? {}, dirname(skillPath), projectSkills, suiteProbe,
  );
  const packagedFiles = partitionTestInputFileEntries(
    packagingConfig?.files ?? [], projectRoot, testInputDirs,
  ).kept;
  const deferred = DeferredArtifacts.from(
    [{ files: packagedFiles, skillDir: dirname(skillPath) }],
    projectRoot,
  );

  // What the `files:` GLOBs will do to this build, reported HERE — before any
  // build — because this is where it is still cheap to act on: `vat skills
  // validate` and `vat audit` can expand the same globs the packager expands
  // without writing anything. Same expansion as the copy — see
  // collectPreBuildGlobFindings — so the two lanes cannot disagree about what
  // ships. Two populations, both load-bearing:
  //   - a never-package DROP is the only signal standing between a
  //     documentation-bearing glob base and a silent content loss the day someone
  //     adds a README.md to it;
  //   - a glob matching NOTHING is the input `vat skills build` dies on, and this
  //     gate is what adopters run before that build. Reporting the harmless drop
  //     while staying silent about the fatal zero-match was the asymmetry that
  //     let `vat skills validate` return success on a config that cannot build.
  appendAll(rawIssues, 
    preBuildGlobFindingsToIssues(
      await collectPreBuildGlobFindings(packagedFiles, projectRoot),
      locationRoot,
    ),
  );

  const walkOptions: Parameters<typeof walkLinkGraph>[2] = {
    maxDepth,
    // The SAME test-input exclusion the packager applies. Without it this lane
    // predicts a bundle containing the eval suite while the build produces one
    // without it — same input, two answers about what ships, from the two commands
    // that exist to agree.
    excludeRules: [
      ...(excludeConfig?.rules ?? []),
      ...testInputExcludeRules(testInputDirs, projectRoot),
    ],
    projectRoot,
    skillRootPath: safePath.resolve(skillPath),
    excludeNavigationFiles,
    deferredArtifacts: deferred,
    // A built skill is this run's output: an ignore rule over it (a gitignored `out/`) hides nothing.
    ownOutputDir: context === 'built' ? dirname(skillPath) : undefined,
  };
  if (shared.gitTracker !== undefined) {
    walkOptions.gitTracker = shared.gitTracker;
  }
  const { bundledResources, bundledAssets, excludedReferences, outsideSkillDirLinks, maxBundledDepth, deferredAssets } = walkLinkGraph(
    skillResource?.id ?? '',
    registry as WalkableRegistry,
    walkOptions,
  );
  const bundledFiles = [...bundledResources.map(r => r.filePath), ...bundledAssets];

  // Count direct links that actually made it into the bundle
  const directLinks = getResolvedMarkdownLinks(document.links, skillPath, projectRoot, side);
  const bundledFileSet = new Set(bundledFiles);
  const directFileCount = directLinks.filter(p => bundledFileSet.has(p)).length;

  // Five producers, one append, order significant, all anchored on `locationRoot`:
  //  1. walker exclusions (LINK_OUTSIDE_PROJECT, LINK_TARGETS_DIRECTORY, etc.)
  //  2. links dropped for pointing into declared test input — the same issue, at
  //     the same location, the packager emits for it. `projectRoot` scopes WHICH
  //     dirs count as declared test input; `locationRoot` only anchors.
  //  3. one info issue per deferred asset declared in files: config
  //  4. followed links bundled from outside the skill directory (LINK_OUTSIDE_SKILL_DIR)
  //  5. every file the skill reaches whose parse the crawl refused: absent from the
  //     registry, the walk found it on disk and bundled it as an opaque asset, its
  //     links unwalked and nothing in it checked
  appendAll(rawIssues, [
    ...parseRefusedIssues(parseRefused, [skillPath, ...bundledAssets], locationRoot),
    ...walkerExclusionsToIssues(excludedReferences, locationRoot),
    ...testInputLinkIssues(excludedReferences, testInputDirs, projectRoot, locationRoot),
    ...deferredAssetsToIssues(deferredAssets, locationRoot),
    ...outsideSkillDirLinksToIssues(outsideSkillDirLinks, locationRoot),
  ]);

  const fileCount = bundledFiles.length + 1; // +1 for SKILL.md itself
  const maxLinkDepth = maxBundledDepth;

  // Calculate total lines from bundled markdown files only, and scan each
  // reachable bundled doc for non-portable asset references (the agent reads
  // and copies invocations from reference files too, not just SKILL.md).
  let totalLines = skillLines;
  const bundledMarkdown = bundledFiles.filter((file) => file.endsWith('.md'));
  // Anchor contract: never hand a producer an absolute path as `location`.
  const bundledLocations = bundledMarkdown.map((file) => issueLocation(file, locationRoot));
  // Independent reads, folded below in bundle order.
  const bundledReads = await mapWithConcurrency(bundledMarkdown, (file, index) =>
    readBundledMarkdown(file, bundledLocations[index] ?? '', side, run));
  for (const [index, read] of bundledReads.entries()) {
    const bundledLocation = bundledLocations[index] ?? '';
    if ('failure' in read) throw read.failure;
    if ('issue' in read) {
      rawIssues.push(read.issue);
      continue;
    }
    const { facts } = read;
    totalLines += facts.lineCount;
    collectNonPortableAssetReferenceIssues(facts, bundledLocation, rawIssues);
    collectNonPortableCommandIssues(facts, bundledLocation, rawIssues);
    // The record of the whole file, frontmatter included — safe because the
    // core strips leading frontmatter itself. It did not always, and this lane was
    // the half of the invariant nobody was enforcing: a bundled file carrying
    // `allowed-tools: [mcp__x__do_thing]` seeded the vocabulary the SKILL.md
    // lane's comment (below) says must come from prose, then fired on its own
    // body. Pinned by "does not let a bundled file's allowed-tools frontmatter
    // supply the vocabulary" in packaging-validator.test.ts.
    collectUnqualifiedMcpToolIssues(facts, bundledLocation, rawIssues);
  }

  const excludedDetails = deduplicateExcludedReferences(excludedReferences, skillPath);

  // Run quality / best-practice checks
  collectSizeIssues(skillLines, totalLines, fileCount, maxLinkDepth, skillLocation, rawIssues);
  collectDescriptionIssue(frontmatter, skillLocation, rawIssues);
  collectProgressiveDisclosureIssue(skillLines, bundledFiles.length, skillLocation, rawIssues);
  collectNameMismatchIssue(frontmatter, skillPath, skillLocation, rawIssues);
  collectTimeSensitiveContentIssues(skillText, skillLocation, rawIssues);
  collectNonPortableAssetReferenceIssues(skillText, skillLocation, rawIssues);
  collectNonPortableCommandIssues(skillText, skillLocation, rawIssues);
  // An `allowed-tools:` list of `mcp__…` names does not by itself supply the
  // vocabulary: the qualified spelling has to appear in the prose an agent
  // reads, or "the document contradicts itself" is not the finding. That holds
  // because the core strips frontmatter. ⛔ It was NEVER true that this call
  // site passed a post-frontmatter slice — the record is of the raw file
  // verbatim — so before the detector stripped, this lane did read
  // `allowed-tools:` as prose and did ship the findings that came of it.
  collectUnqualifiedMcpToolIssues(skillText, skillLocation, rawIssues);

  // Cross-skill dependency smell: body declares a requires/depends token the
  // description does not mention. Reads the RAW file's record (`crossSkillAuth`),
  // frontmatter included — which is what this detector wants, since the
  // declaration it looks for can be written either side of the fence.
  if (frontmatter) {
    appendAll(rawIssues, detectUndeclaredCrossSkillAuth(frontmatter, skillText, 'crossSkillAuth', skillLocation));
  }

  // Filter out source-only codes when validating built output
  const filteredIssues = context === 'built'
    ? rawIssues.filter(issue => !SOURCE_ONLY_CODES.has(issue.code))
    : rawIssues;

  // Run through the unified validation framework.
  //
  // Two lanes, one question: a batching caller supplies the RUN's ledger and
  // owns the drain (ALLOW_UNUSED belongs to the run, not to whichever skill
  // happened to be validated when the entry went unmatched); a caller that
  // supplied none is claiming its run is this one skill, and gets the run-level
  // answer folded in here.
  const framework = runFrameworkFor(filteredIssues, packagingConfig, shared, notAdmitted);

  const skillName = skillNameOf(document, skillPath);

  return {
    skillName,
    ...summarizeIssues(framework.emitted),
    allErrors: framework.emitted,
    ignoredErrors: framework.allowed,
    observations,
    evidence,
    metadata: {
      skillLines,
      totalLines,
      fileCount,
      directFileCount,
      maxLinkDepth,
      excludedReferenceCount: excludedDetails.length,
      excludedReferences: excludedDetails,
    },
  };
}

/** How a file not admitted is resolved: by the project's `resources.validation`, matched at its project-relative path. */
interface NotAdmittedPolicy {
  readonly resourcesValidation: ValidationConfig;
  readonly roots: NotAdmittedRoots;
}

/**
 * One skill's issues through the validation framework: the batching caller's
 * ledger when it supplied one, else this skill as the whole run. A file not
 * admitted is split out first (`partitionNotAdmitted`) and resolved by
 * `resources.validation` alone; the framework sees only the remainder.
 */
function runFrameworkFor(
  issues: ValidationIssue[],
  packagingConfig: SkillPackagingConfig | undefined,
  shared: SkillValidationSharedContext,
  policy: NotAdmittedPolicy,
): ReturnType<typeof runSingleUnitValidation> {
  const { rest, notAdmitted } = partitionNotAdmitted(issues, policy.resourcesValidation, policy.roots);
  const validationConfig = packagingConfig?.validation ?? {};
  const framework = shared.allowLedger === undefined
    ? runSingleUnitValidation(rest, validationConfig)
    : runValidationFramework(rest, validationConfig, shared.allowLedger);
  const emitted = [...framework.emitted, ...notAdmitted];
  return { ...framework, emitted, hasErrors: emitted.some((issue) => issue.severity === 'error') };
}

/**
 * The skill's SKILL.md: the run's store's facts when it serves the file, else
 * parsed on the bounded route (`parseFileCached`, in the worker) — or the
 * finding that replaces the parse when the worker refuses it. Any other failure
 * propagates as it always did.
 *
 * @param skillPath - The SKILL.md
 * @param side - Whose fault a refused read is
 * @param locationRoot - The base issues are located against
 * @param run - The run: its store, and where a parse runs
 * @returns The document, or the refusal's issue
 */
async function parseSkillMarkdown(
  skillPath: string,
  side: FsSide,
  locationRoot: string,
  run: SkillTextRun,
): Promise<{ document: SkillDocument } | { limit: ValidationIssue }> {
  try {
    return { document: await readSkillDocument(skillPath, run, side) };
  } catch (error) {
    const limit = parseRefusalIssue(error, skillPath, locationRoot);
    if (limit === undefined) throw error;
    return { limit };
  }
}

/**
 * The result for a skill whose SKILL.md could not be parsed at all: the one
 * finding, resolved as every not-admitted finding is (`resources.validation`),
 * and nothing else — no frontmatter, links or bundle to check.
 *
 * @param skillPath - The SKILL.md
 * @param limit - Its `RESOURCE_PARSE_LIMIT_EXCEEDED` issue
 * @param packagingConfig - The skill's packaging config, for its validation block
 * @param shared - The batching caller's context, for its ledger
 * @param policy - How a file not admitted is resolved
 * @returns A result whose only finding is `limit`
 */
function parseLimitResult(
  skillPath: string,
  limit: ValidationIssue,
  packagingConfig: SkillPackagingConfig | undefined,
  shared: SkillValidationSharedContext,
  policy: NotAdmittedPolicy,
): PackagingValidationResult {
  const framework = runFrameworkFor([limit], packagingConfig, shared, policy);
  return {
    // Named by its directory: there is no frontmatter or H1 to read a name from.
    skillName: basename(dirname(skillPath)),
    ...summarizeIssues(framework.emitted),
    allErrors: framework.emitted,
    ignoredErrors: framework.allowed,
    observations: [],
    evidence: [],
    metadata: {
      skillLines: 0,
      totalLines: 0,
      fileCount: 1,
      directFileCount: 0,
      maxLinkDepth: 0,
      excludedReferenceCount: 0,
      excludedReferences: [],
    },
  };
}

/**
 * Collect size and depth validation issues
 */
function collectSizeIssues(
  skillLines: number,
  totalLines: number,
  fileCount: number,
  maxLinkDepth: number,
  skillLocation: string,
  issues: ValidationIssue[],
): void {
  if (skillLines > VALIDATION_THRESHOLDS.RECOMMENDED_SKILL_LINES) {
    const rule = VALIDATION_RULES.SKILL_LENGTH_EXCEEDS_RECOMMENDED;
    issues.push(registryIssueAt(
      rule.code as IssueCode,
      rule.message({ lines: skillLines }),
      skillLocation,
    ));
  }

  if (totalLines > VALIDATION_THRESHOLDS.MAX_TOTAL_LINES) {
    const rule = VALIDATION_RULES.SKILL_TOTAL_SIZE_LARGE;
    issues.push(registryIssueAt(
      rule.code as IssueCode,
      rule.message({ totalLines }),
      skillLocation,
    ));
  }

  if (fileCount > VALIDATION_THRESHOLDS.MAX_FILE_COUNT) {
    const rule = VALIDATION_RULES.SKILL_TOO_MANY_FILES;
    issues.push(registryIssueAt(
      rule.code as IssueCode,
      rule.message({ fileCount }),
      skillLocation,
    ));
  }

  if (maxLinkDepth > VALIDATION_THRESHOLDS.MAX_REFERENCE_DEPTH) {
    const rule = VALIDATION_RULES.REFERENCE_TOO_DEEP;
    issues.push(registryIssueAt(
      rule.code as IssueCode,
      rule.message({ depth: maxLinkDepth }),
      skillLocation,
    ));
  }
}

/**
 * Collect description quality issue (DESCRIPTION_TOO_VAGUE)
 */
function collectDescriptionIssue(
  frontmatter: Record<string, unknown> | undefined,
  skillLocation: string,
  issues: ValidationIssue[],
): void {
  const description = frontmatter?.['description'];

  if (!description || typeof description !== 'string') {
    return; // Missing description is handled by existing validator
  }

  if (description.length < VALIDATION_THRESHOLDS.MIN_DESCRIPTION_LENGTH) {
    const rule = VALIDATION_RULES.DESCRIPTION_TOO_VAGUE;
    issues.push(registryIssueAt(
      rule.code as IssueCode,
      rule.message({ length: description.length }),
      skillLocation,
    ));
  }
}

/**
 * Kebab-case pattern used by the Agent Skill schema for `name`. The check
 * only fires when the parent directory itself looks like a skill directory
 * (same kebab-case shape). This avoids false positives when SKILL.md lives
 * at a repo root or inside an unrelated container.
 */
const SKILL_DIR_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

/**
 * Generic container directory names that hold multiple skills in a flat layout.
 * When SKILL.md lives directly inside one of these, the parent dir name carries
 * no signal about what the skill is named — skip the mismatch check entirely.
 */
const GENERIC_CONTAINER_DIRS = new Set<string>(['skills', 'resources']);

/**
 * Detect SKILL_NAME_MISMATCHES_DIR issue from a frontmatter `name` and a
 * parent directory name. Returns null when no mismatch should be reported.
 *
 * Exported for direct unit testing — the packaging validator wires it up
 * with values derived from the skill path.
 */
export function detectNameMismatchIssue(
  frontmatterName: unknown,
  parentDir: string,
  skillLocation: string,
): ValidationIssue | null {
  if (typeof frontmatterName !== 'string' || frontmatterName.trim() === '') {
    return null;
  }
  if (parentDir === '' || parentDir === '.' || parentDir === 'SKILL.md') {
    return null;
  }
  if (!SKILL_DIR_NAME_PATTERN.test(parentDir)) {
    return null;
  }
  if (GENERIC_CONTAINER_DIRS.has(parentDir.toLowerCase())) {
    return null;
  }

  const normalize = (s: string): string => s.trim().toLowerCase();
  if (normalize(frontmatterName) === normalize(parentDir)) {
    return null;
  }

  const registryEntry = CODE_REGISTRY.SKILL_NAME_MISMATCHES_DIR;
  return {
    severity: registryEntry.defaultSeverity,
    code: 'SKILL_NAME_MISMATCHES_DIR',
    message: `Frontmatter name "${frontmatterName}" does not match parent directory "${parentDir}"`,
    location: skillLocation,
    fix: registryEntry.fix,
    reference: registryEntry.reference,
  };
}

/**
 * Collect SKILL_NAME_MISMATCHES_DIR issue. Skips when the skill lives in an
 * OS temp directory — unit tests and ad-hoc scratch runs don't have
 * meaningful parent-directory names.
 */
function collectNameMismatchIssue(
  frontmatter: Record<string, unknown> | undefined,
  skillPath: string,
  skillLocation: string,
  issues: ValidationIssue[],
): void {
  const resolvedSkillPath = toForwardSlash(safePath.resolve(skillPath));
  const resolvedTmpdir = toForwardSlash(safePath.resolve(normalizedTmpdir()));
  // eslint-disable-next-line local/no-path-startswith -- both operands are already toForwardSlash-normalized
  if (resolvedSkillPath.startsWith(`${resolvedTmpdir}/`)) {
    return;
  }

  const parentDir = basename(dirname(skillPath));
  const issue = detectNameMismatchIssue(frontmatter?.['name'], parentDir, skillLocation);
  if (issue !== null) {
    issues.push(issue);
  }
}

/**
 * Collect progressive disclosure issue (NO_PROGRESSIVE_DISCLOSURE)
 */
function collectProgressiveDisclosureIssue(
  skillLines: number,
  referenceFileCount: number,
  skillLocation: string,
  issues: ValidationIssue[],
): void {
  if (skillLines > VALIDATION_THRESHOLDS.RECOMMENDED_SKILL_LINES && referenceFileCount === 0) {
    const rule = VALIDATION_RULES.NO_PROGRESSIVE_DISCLOSURE;
    issues.push(registryIssueAt(
      rule.code as IssueCode,
      rule.message({ lines: skillLines }),
      skillLocation,
    ));
  }
}

/**
 * Process links from parsed markdown and return resolved .md file paths.
 *
 * Exported for unit test: the deduplication contract (one entry, and one existence
 * probe, per DISTINCT target however many times it is linked) is not observable
 * through `validateSkillForPackaging`'s result alone.
 */
export function getResolvedMarkdownLinks(
  links: ReadonlyArray<{ readonly href: string; readonly type: string }>,
  markdownPath: string,
  within: string,
  side: FsSide,
): string[] {
  const markdownDir = dirname(markdownPath);

  // Collapse to DISTINCT targets before touching the filesystem. `links` is one
  // entry per link OCCURRENCE, and documents routinely point many occurrences at
  // one file (a routing table linking every row to the same sub-skill). Two
  // consequences, both fixed here rather than downstream:
  //   - the caller derives `directFileCount` from this list, so occurrences made
  //     it report more direct files than the whole bundle holds;
  //   - the existence probe below ran once per occurrence, not once per path.
  // A Set preserves insertion order, so the surviving order is unchanged.
  const candidates = new Set<string>();
  for (const link of links) {
    if (link.type !== 'local_file') {
      continue;
    }

    // Remove anchor
    const hrefWithoutAnchor = link.href.split('#')[0] ?? link.href;
    if (hrefWithoutAnchor === '') {
      continue;
    }

    const resolvedPath = safePath.resolve(markdownDir, hrefWithoutAnchor);

    // Only .md targets are candidates; existence is settled once, below.
    if (resolvedPath.endsWith('.md')) {
      candidates.add(resolvedPath);
    }
  }

  // Each target is crawled beneath the project: its link chain is read by text before the kernel
  // follows it, and a refused probe or chain is the skill tree's side's fault, thrown — never "not linked".
  return [...candidates].filter(candidate => withFsFaultSync(
    { side, origin: 'content', action: `examine the linked document ${candidate}`, path: candidate },
    () => followedKindSync(candidate, within),
  ) !== 'absent');
}

/**
 * Reasons that are reported as validation errors instead of excluded references.
 * These are filtered out of the excluded references list.
 */
const EXCLUDE_REASON_UNREADABLE = 'unreadable-target' as const;
const VALIDATION_ERROR_REASONS: ReadonlySet<string> = new Set([
  EXCLUDE_REASON_DIRECTORY,
  EXCLUDE_REASON_OUTSIDE_PROJECT,
  EXCLUDE_REASON_UNREADABLE,
]);

/**
 * Deduplicate excluded references by path, preserving detail from first occurrence.
 * Filters out entries reported as validation errors (directory-target, outside-project).
 */
function deduplicateExcludedReferences(
  excludedReferences: LinkResolution[],
  skillPath: string,
): ExcludedReferenceDetail[] {
  const seenPaths = new Set<string>();
  const details: ExcludedReferenceDetail[] = [];

  for (const ref of excludedReferences) {
    if (VALIDATION_ERROR_REASONS.has(ref.excludeReason ?? '')) {
      continue;
    }
    if (seenPaths.has(ref.path)) {
      continue;
    }
    seenPaths.add(ref.path);
    const matchedPattern = ref.matchedRule?.patterns[0];
    const reason = mapExcludeReason(ref.excludeReason);
    details.push({
      path: toForwardSlash(safePath.relative(dirname(skillPath), ref.path)),
      reason,
      ...(matchedPattern === undefined ? {} : { matchedPattern }),
    });
  }

  return details;
}

/** Map walk-link-graph exclude reasons to detail reasons */
function mapExcludeReason(
  excludeReason: LinkResolution['excludeReason'],
): ExcludedReferenceDetail['reason'] {
  switch (excludeReason) {
    case 'pattern-matched': return 'pattern-matched';
    case 'navigation-file': return 'navigation-file';
    case 'agent-instruction-file': return 'agent-instruction-file';
    case 'skill-definition': return 'skill-definition';
    case 'gitignored': return 'gitignored';
    // Reported under its own name rather than falling into the default arm.
    // The default answers `depth-exceeded`, which for this reason would be
    // false: the walk never reached the edge at all, because the file holding
    // it is not one VAT routes through.
    case 'non-routable-source': return 'non-routable-source';
    case 'depth-exceeded':
    case EXCLUDE_REASON_DIRECTORY:
    case EXCLUDE_REASON_OUTSIDE_PROJECT:
    case EXCLUDE_REASON_UNREADABLE:
    case 'missing-target':
    case undefined:
    default:
      return DETAIL_REASON_DEPTH;
  }
}
