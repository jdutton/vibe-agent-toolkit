/**
 * Skill packaging - bundle SKILL.md with all linked resources
 *
 * This module provides the unified packaging logic used by all flows:
 * - Direct packaging of existing SKILL.md files
 * - Post-processing after generating SKILL.md from agent.yml
 *
 * Package formats supported:
 * - directory: Ready-to-use directory structure
 * - zip: Single file archive (preferred for Windows compatibility)
 * - npm: Standard npm package with package.json
 * - marketplace: JSON manifest for plugin registries
 *
 * Uses ResourceRegistry + transformContent() from @vibe-agent-toolkit/resources
 * for link resolution and rewriting (replacing the previous inline regex approach).
 */

import { existsSync, lstatSync, readdirSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

import {
  DeferredArtifacts,
  DuplicateResourceIdError,
  ResourceRegistry,
  loadConfig,
  openFrontmatter,
  resolveLocalHref,
  rewriteFrontmatterUriReferencesFromSchema,
  rewriteHtmlLinks,
  transformContent,
  type DuplicateIdCollision,
  type LinkRewriteRule,
  type ParseResult,
  type ProjectConfig,
  type ResourceLink,
  type ResourceMetadata,
  type ResourcePopulationSource,
  parseFileCached,
} from '@vibe-agent-toolkit/resources';
import {
  allowUnusedIssues,
  createAllowUsageLedger,
  runValidationFramework,
  type AllowUsageLedger,
  type FrameworkResult,
  type ValidationConfig,
  type ValidationIssue,
} from '@vibe-agent-toolkit/schema';
import {
  applyTreePlan,
  classifyFsFault,
  direntKindFollowingSync,
  findProjectRoot,
  forEachInOrder,
  isPathAbsentError,
  isGlob,
  isSingleFsSegment,
  issueLocation,
  mapInOrder,
  planTreeChanges,
  resolveAssetReference,
  safePath,
  toForwardSlash,
  toForwardSlashAnyPlatform,
  VatError,
  withFsFault,
  withFsFaultSync,
  type Ownership,
  type OwnershipVerdict,
  type TreeChange,
  type TreeChangeWarning,
} from '@vibe-agent-toolkit/utils';
import { readTextContent } from '@vibe-agent-toolkit/utils/fs';
import {
  type GitTracker,
} from '@vibe-agent-toolkit/utils/git';

import { copyIntoBundle } from './bundle-copy.js';
import { getResourceSubdirForFile, type PackagingTarget } from './content-type-routing.js';
import {
  applyFilesConfig,
  buildArtifactHint,
  droppedGlobMatchesToIssues,
  explicitFilesConfigDests,
  globEntryDest,
  skippedGlobMatchesToIssues,
  type SkillFileEntry,
} from './files-config.js';
import { LINK_GRAPH_MEMBER_GLOBS } from './link-graph-members.js';
import { packagingInputError, SKILL_NAME_NOT_A_SEGMENT_CODE, SkillPackageChecksFailedError } from './packaging-errors.js';
import { checkBrokenPackagedLinks, checkMissingReferencedPaths, checkUnreferencedFiles } from './post-build-checks.js';
import {
  checkPackagedTestInput,
  partitionTestInputFileEntries,
  resolveTestInputDirs,
  type ConventionalSuiteProbe,
  type DeclaredEvalSuite,
  testInputExcludeRules,
  testInputFileEntryIssues,
  testInputLinkIssues,
} from './test-input.js';
import { detectPackagedAgentInstructionFiles } from './validators/agent-instruction-presence.js';
import { checkPackagedSizeLimit } from './validators/packaged-size-limit.js';
import { validateSkillForPackaging, type PackagingValidationResult, type SkillPackagingConfig } from './validators/packaging-validator.js';
import { materializeIssue } from './validators/rule-engine/index.js';
import { deferredAssetsToIssues, outsideSkillDirLinksToIssues, walkerExclusionsToIssues } from './validators/walker-to-issues.js';
import { walkLinkGraph, type WalkableRegistry } from './walk-link-graph.js';

const PACKAGE_JSON_FILENAME = 'package.json';

/**
 * Default template for excluded links when no explicit template is configured —
 * renders just the link text.
 *
 * `{{link.rawText}}`, not `{{link.text}}`, for the same two reasons the rewrite
 * branch uses it (see `bundledLinkTemplate`):
 *
 *  - **Per-occurrence identity.** `link.text` is a property of the parsed link,
 *    and two occurrences sharing an href are two links whose text may differ.
 *    `rawText` is always the text of the occurrence actually being replaced, so
 *    it cannot swap one phrase for an unrelated one in shipped prose.
 *  - **Formatting.** `rawText` keeps the inline markup the author wrote, so
 *    ``[`foo.yaml`](…)`` strips to ``` `foo.yaml` ``` rather than bare `foo.yaml`.
 *
 * > This used to explain the first reason as a defence against `transformContent`
 * > keying parsed links by href and letting the FIRST occurrence win. That
 * > correlation is gone: `transformContent` now splices each parsed link at its
 * > own `[startOffset, endOffset)` span, so there is no shared-href map to collide
 * > in for any link the parser located. `rawText` remains correct and remains the
 * > right choice — the reasoning above no longer depends on a collision that the
 * > rewriter can still have.
 */
const DEFAULT_STRIP_TEMPLATE = '{{link.rawText}}';

/**
 * Template for a link the bundle is expected to carry: rewrite it to the target's
 * packaged location, or — when there IS no packaged location — strip it to plain
 * text with `stripTemplate`.
 *
 * The `else` branch is the whole point. `link.resource.relativePath` is undefined
 * for any target the OUTPUT registry does not hold, and three ordinary link shapes
 * land there:
 *
 *   - a non-markdown asset dropped from the bundle (`evals/evals.json`) — the
 *     registry indexes markdown, so a pattern exclude rule matching `filePath`
 *     never sees it and it falls through to here;
 *   - a link to a DIRECTORY, in either spelling (`refs/` or `refs`);
 *   - any other unresolved target.
 *
 * Rendering the rewrite branch anyway produced `[text]()` — a syntactically valid
 * markdown link to nowhere — or, for the slash spelling of a directory (which
 * matched no rule at all before this template took `local_directory` too), the
 * original href pointing at a path that does not exist in the output. The latter
 * then failed the build under `PACKAGED_BROKEN_LINK`, whose own remediation text
 * reads "Report the issue — this indicates a VAT bug."
 *
 * A directory link can never survive packaging: the packager FLATTENS every
 * bundled resource into `resources/`, so no authored directory exists in the
 * output to point at. Stripping to plain text keeps the author's prose and drops
 * the dead navigation — the same thing an excluded file link does.
 *
 * A SAME-DOCUMENT anchor (`[See below](#heading)`) is untouched by all of this: it
 * classifies as `anchor`, not a local target, so it matches none of these rules and
 * survives verbatim. Verified by test rather than assumed — an earlier draft carried
 * a special case for it that could never fire.
 */
function bundledLinkTemplate(stripTemplate: string): string {
  return (
    '{{#if link.resource.relativePath}}' +
    '[{{link.rawText}}]({{link.resource.relativePath}}{{link.fragment}})' +
    '{{else}}' +
    stripTemplate +
    '{{/if}}'
  );
}

/**
 * Resource naming strategy type
 */
export type ResourceNamingStrategy = 'basename' | 'resource-id' | 'preserve-path';

/** Default packaging target */
const DEFAULT_PACKAGING_TARGET: PackagingTarget = 'claude-code';

export interface PackageSkillOptions {
  /**
   * Output directory for packaged skill
   * Default: <skill-package-root>/dist/skills/<skill-name>
   */
  outputPath?: string;

  /**
   * Whether what is at `outputPath` is a previous package to replace (`--force`). Default
   * `false`: an explicit `outputPath` that already holds anything but an empty directory —
   * or a file where an archive a requested format writes beside it goes — is refused
   * (`TREE_DEST_NOT_OWNED`) and left exactly as it was. The default location (no
   * `outputPath`) is VAT's, and is always replaced. See {@link packageOwnership}.
   */
  replaceExistingOutput?: boolean;

  /**
   * Plan the package without writing it: run everything that can refuse the run
   * before a byte is written — the project crawl, the link walk, the output's plan
   * (its ownership and holding checks) — exactly as the real run does, then return
   * without writing anything. The result names the files the package would hold
   * (`plannedSources`) and the plan's lines (`plannedChanges`); it has no
   * `artifacts`, and the checks on the written bundle (`postBuildIssues`) do not run.
   */
  dryRun?: boolean;

  /**
   * Package format(s) to generate
   * Default: ['directory']
   */
  formats?: ('directory' | 'zip' | 'npm' | 'marketplace')[];

  /**
   * Whether to rewrite links to be relative to package root
   * Default: true
   */
  rewriteLinks?: boolean;

  /**
   * Base path for resolving relative links in SKILL.md
   * Default: dirname(skillPath)
   */
  basePath?: string;

  /**
   * Strategy for naming packaged resource files
   *
   * - 'basename': Use original filename only (default, may cause conflicts)
   * - 'resource-id': Flatten path to kebab-case filename (descriptive, unique)
   * - 'preserve-path': Preserve directory structure in output
   *
   * Default: 'basename'
   *
   * @example
   * // Original: knowledge-base/guides/topics/quickstart/overview.md
   * // basename:       overview.md (may conflict)
   * // resource-id:    guides-topics-quickstart-overview.md (with stripPrefix: 'knowledge-base-')
   * // preserve-path:  guides/topics/quickstart/overview.md (creates subdirectories)
   */
  resourceNaming?: ResourceNamingStrategy;

  /**
   * Path prefix to strip before applying naming strategy
   *
   * Removes a directory prefix from the relative path before the naming strategy is applied.
   * Works with both 'resource-id' and 'preserve-path' strategies.
   *
   * @example
   * // Original: knowledge-base/guides/topics/quickstart/overview.md
   * // stripPrefix: 'knowledge-base'
   * //
   * // resource-id:    guides-topics-quickstart-overview.md
   * // preserve-path:  guides/topics/quickstart/overview.md
   */
  stripPrefix?: string;

  /** How deep to follow markdown links (default: 2) */
  linkFollowDepth?: number | 'full' | undefined;

  /** Whether to exclude navigation files (README.md, index.md, etc.) from bundle (default: true) */
  excludeNavigationFiles?: boolean | undefined;

  /** Exclude patterns and rewrite templates for non-bundled links */
  excludeReferencesFromBundle?: {
    rules?: Array<{
      patterns: string[];
      template?: string | undefined;
    }> | undefined;
    defaultTemplate?: string | undefined;
  } | undefined;

  /**
   * Pre-built ResourceRegistry for the project.
   * When provided, packageSkill() skips creating its own registry.
   * Used by packageSkills() to share a single registry across multiple skill builds.
   */
  registry?: ResourceRegistry | undefined;

  /**
   * Pre-populated {@link GitTracker} for the containing repo.
   *
   * When supplied, gitignore checks during the link-graph walk become O(1)
   * active-set lookups instead of `git check-ignore` spawns. Used by batched
   * build paths (e.g. `vat skills build`) that already constructed a tracker
   * for discovery/scanning.
   */
  gitTracker?: GitTracker | undefined;

  /**
   * Packaging target — controls the ZIP directory structure produced.
   *
   * - 'claude-code' (default): Standard VAT layout, routed by extension into
   *   resources/, scripts/, templates/, assets/
   * - 'claude-web': Claude.ai web upload layout — every resource flattened into
   *   references/, extensions ignored (see `PackagingTarget`)
   *
   * Default: 'claude-code'
   */
  target?: PackagingTarget | undefined;

  /**
   * Explicit file mappings for build artifacts, unlinked files, or routing overrides.
   *
   * Each entry copies source to dest in the skill output. Links matching
   * files[].source are rewritten to dest. Links matching files[].dest are
   * left as-is (assumed to be build artifacts placed at dest during build).
   */
  files?: SkillFileEntry[] | undefined;

  /**
   * Validation framework configuration: severity overrides and per-path allow entries.
   * See docs/validation-codes.md for codes and defaults.
   */
  validation?: ValidationConfig | undefined;

  /**
   * Absolute directories holding this skill's DECLARED test input (its eval suite).
   * Links into them are excluded from the bundle, and anything that still reaches
   * the output emits `PACKAGED_TEST_INPUT`. Derived from the skill's `test.evals`
   * by {@link resolveTestInputDirs} — see test-input.ts for why test input must
   * never ship.
   */
  testInputDirs?: string[] | undefined;

  /**
   * The RUN's allow-entry usage ledger.
   *
   * `validation.allow` is declared once per package but evaluated once per
   * skill AND once per lane, so "this entry matched nothing" is a question only
   * the whole invocation can answer. A caller that builds more than one skill,
   * or that validates the SOURCE tree before packaging (`vat build` does both),
   * MUST supply one ledger for the whole invocation and drain it itself with
   * `allowUnusedIssues()` after the last skill.
   *
   * Omitting it is a positive claim that THIS `packageSkill` call is the whole
   * run — true for single-skill library callers, who get the run-level verdict
   * folded into `postBuildIssues` here. It is false for anything that loops.
   */
  allowLedger?: AllowUsageLedger | undefined;
}

/**
 * Map a merged {@link SkillPackagingConfig} onto {@link PackageSkillOptions}.
 *
 * The single canonical conversion used by BOTH `vat skills build` and
 * `vat skill test` (the pool build), so the dist a test exercises is byte-for-byte
 * what `vat skills build` would produce. `basePath` defaults to `dirname(skillPath)`.
 *
 * `projectSkills` is EVERY skill the project declares, with its effective packaging
 * config — assembled ONCE per invocation by the calling lane and passed down, never
 * recomputed per skill (a per-skill walk of the whole project config is an N+1 this
 * repo has been bitten by). It is required rather than defaulted because the test-input
 * rule is project-wide: omitting it silently packages another skill's eval answer key.
 * A lane with genuinely no project to enumerate passes `[]` explicitly.
 *
 * `hasConventionalSuite` is the RUN's conventional-suite probe, and travels with
 * `projectSkills` for the same reason and on the same schedule: this conversion runs
 * once per skill and asks the filesystem about every root in `projectSkills`, so a
 * per-call probe makes a build of S skills cost S² probes over S paths. Required, not
 * defaulted — a `probe?` would let every existing caller keep the quadratic silently,
 * which is precisely how the `projectSkills` rule above once shipped as a no-op. A
 * lane packaging a single skill calls `conventionalSuiteProbe()` at its own call site.
 */
export function packagingConfigToPackageOptions(
  config: SkillPackagingConfig,
  anchors: { skillPath: string; outputPath: string },
  projectSkills: readonly DeclaredEvalSuite[],
  hasConventionalSuite: ConventionalSuiteProbe,
): PackageSkillOptions & { outputPath: string } {
  return {
    outputPath: anchors.outputPath,
    // Every lane converting through here builds into a directory VAT manages —
    // `dist/skills/<name>`, its staging root, a marketplace tree it rebuilds — so
    // what is there is a previous build of this skill, and is replaced.
    replaceExistingOutput: true,
    formats: ['directory'],
    rewriteLinks: true,
    basePath: dirname(anchors.skillPath),
    ...(config.resourceNaming && { resourceNaming: config.resourceNaming }),
    ...(config.stripPrefix && { stripPrefix: config.stripPrefix }),
    ...(config.linkFollowDepth !== undefined && { linkFollowDepth: config.linkFollowDepth }),
    // `!== undefined`, not truthiness: `false` is the only value that carries
    // information here (the packager defaults to `true`), so a truthiness spread
    // would drop exactly the setting a user bothered to write. Dropping it made
    // this conversion disagree with `packaging-validator.ts`, which reads the same
    // key straight off the config — the gate predicted a README ships and the
    // build stripped it, from one config, inside the conversion that promises
    // byte-for-byte parity between lanes.
    ...(config.excludeNavigationFiles !== undefined && {
      excludeNavigationFiles: config.excludeNavigationFiles,
    }),
    ...(config.excludeReferencesFromBundle && { excludeReferencesFromBundle: config.excludeReferencesFromBundle }),
    ...(config.files && { files: config.files }),
    ...(config.validation && { validation: config.validation }),
    // Declared test input never ships. Derived here — the ONE conversion both
    // `vat skills build` and the plugin build go through — so no lane can package a
    // skill without the rule applied. PROJECT-WIDE: `projectSkills` carries every
    // other skill's declaration too, so a link into a SIBLING skill's suite is
    // excluded as well. Keyed to this skill alone, that sibling's answer key was
    // ordinary content and shipped.
    ...(() => {
      const testInputDirs = resolveTestInputDirs(
        config, dirname(anchors.skillPath), projectSkills, hasConventionalSuite,
      );
      return testInputDirs.length > 0 ? { testInputDirs } : {};
    })(),
  };
}

export interface SkillMetadata {
  name: string;
  description?: string;
  version?: string;
  license?: string;
  author?: string;
}

export interface PackageSkillResult {
  /**
   * Path to packaged skill directory
   */
  outputPath: string;

  /**
   * Skill metadata extracted from frontmatter
   */
  skill: SkillMetadata;

  /**
   * Files included in package
   */
  files: {
    root: string;           // SKILL.md
    dependencies: string[]; // All linked files (relative paths)
  };

  /**
   * Package artifacts generated
   */
  artifacts?: {
    directory?: string;     // dist/skills/cat-agents/
    zip?: string;          // dist/skills/cat-agents.zip
    npm?: string;          // dist/skills/cat-agents.tgz
    marketplace?: string;  // dist/skills/cat-agents.marketplace.json
  };

  /** References excluded from bundle */
  excludedReferences?: string[] | undefined;

  /** A dry run's plan: the absolute path of every file the package would copy, SKILL.md first. */
  plannedSources?: string[] | undefined;

  /** A dry run's plan: one line per change to the output (`TreePlan.describe()`), the real run's exactly. */
  plannedChanges?: readonly string[] | undefined;

  /**
   * What the package's plan left beside its output: a previous package, parked by the swap,
   * that the OS would not let VAT remove. The package itself is complete; each is a warning
   * naming the leftover. Empty for a dry run and for a package written into a staged tree.
   */
  residue: readonly TreeChangeWarning[];

  /**
   * Post-build integrity issues — issues that the override config did NOT suppress.
   * Empty (or omitted) means all post-build checks passed.
   */
  postBuildIssues?: ValidationIssue[] | undefined;

  /** Full validation result against the built output. */
  postBuildValidation?: PackagingValidationResult | undefined;

  /**
   * True when any emitted issue has resolved severity 'error'. Only ever true from an IN-PLACE
   * packager (`packageSkillInto`, `packageSkills`), whose caller owns the landing decision:
   * `packageSkill` throws `SkillPackageChecksFailedError` instead, and lands nothing.
   */
  hasErrors: boolean;
}

/**
 * Specification for building a single skill. Used with packageSkills().
 */
export interface SkillBuildSpec {
  /** Absolute path to the SKILL.md file */
  skillPath: string;
  /**
   * Packaging options for this skill. `outputPath` is required: it is the directory the
   * bundle is written into, in place — a directory inside the caller's own plan's staged
   * tree (see {@link packageSkills}).
   */
  options: PackageSkillOptions & { outputPath: string };
}

/**
 * What ONE skill in a `packageSkills` batch produced.
 *
 * A discriminated union rather than a nullable result, because a skill that
 * threw produced no output path, no metadata and no file list — a synthetic
 * `PackageSkillResult` for it would have to invent all three, and every
 * consumer reading `files.dependencies.length` would then report a file count
 * for a bundle that does not exist on disk.
 */
export type SkillPackageOutcome =
  | { status: 'built'; skillPath: string; result: PackageSkillResult }
  | { status: 'failed'; skillPath: string; error: Error };

/**
 * Package multiple skills with a shared ResourceRegistry.
 *
 * Each bundle is written IN PLACE into its spec's `outputPath` ({@link packageSkillInto}):
 * the batch's caller owns the tree-change plan those directories sit in (`vat skills build`
 * writes every bundle into its one staged `dist/skills`), so no bundle is staged twice.
 *
 * Creates one registry for the entire project (crawling all .md files once),
 * then packages each skill against the shared registry. This eliminates
 * redundant I/O when building multiple skills from the same project.
 *
 * **One skill's failure never discards the batch.** `packageSkill` reports most
 * problems by RETURNING a result whose `hasErrors` is set, which callers already
 * degrade gracefully on — but it also THROWS on structural packaging failures
 * (an absent or unreadable `files:` source). Letting that throw escape the loop
 * made the two failure paths behave in opposite ways through one contract:
 * measured on a 90-skill project, one such failure discarded 89 completed builds
 * and collapsed the whole report into a single string. Each iteration is
 * therefore contained and reported as a `failed` outcome instead.
 *
 * A filename collision is NOT one of the throwing paths — it is a returned
 * `FILENAME_COLLISION` finding. Do not reach for a collision as the fixture when
 * testing this containment: the loop completes normally either way, so such a
 * test passes whether or not the containment exists.
 *
 * The registry build is deliberately OUTSIDE the containment: it is the run's
 * shared prerequisite, so its failure really does doom every skill and must
 * still propagate. Only per-skill work is contained.
 *
 * @param skills - Array of skill build specifications
 * @param projectRoot - Absolute path to the project root directory
 * @param allowLedger - The RUN's allow-usage ledger. Required, not
 *   optional-with-a-default, for the same reason `runValidationFramework`'s is:
 *   this function loops, so it can never honestly conclude on its own that an
 *   allow entry matched nothing — an entry matched while building skill A is
 *   USED for the run. It is never drained here; the caller drains it once with
 *   `allowUnusedIssues()` after everything in the invocation has been seen
 *   (`vat build` also validates the SOURCE tree, whose matches count too).
 *   Containment does not change that: a skill that threw may still have matched
 *   allow entries before it threw, and those matches count for the run.
 * @param runOptions - Registry-build options for the RUN. Named apart from the
 *   per-skill `options` destructured in the loop below, which it is not: it
 *   configures the ONE shared registry {@link createProjectRegistry} builds here.
 *   It does NOT reach the per-skill post-build validation, which builds a private
 *   registry over the BUILT tree — see {@link runPostBuildValidation}
 * @returns One outcome per input spec, in input order
 *
 * @example
 * ```typescript
 * const specs: SkillBuildSpec[] = [
 *   { skillPath: '/project/skills/SKILL.md', options: { outputPath: '/out/skill-a' } },
 *   { skillPath: '/project/skills/SKILL2.md', options: { outputPath: '/out/skill-b' } },
 * ];
 * const ledger = createAllowUsageLedger();
 * const outcomes = await packageSkills(specs, '/project', ledger, { outputs: ['/out'] });
 * const runIssues = allowUnusedIssues(ledger);
 * ```
 */
export async function packageSkills(
  skills: SkillBuildSpec[],
  projectRoot: string,
  allowLedger: AllowUsageLedger,
  runOptions: ProjectRegistryOptions,
): Promise<SkillPackageOutcome[]> {
  // 1. Create one registry for the entire project. Through the shared builder:
  // this used to call `fromCrawl` directly and omit the config, so skills built
  // here belonged to no collection while a skill built through the single-skill
  // fallback did.
  //
  // `runOptions` is forwarded rather than absorbed: this is the ONLY registry the
  // run builds, so a caller that wants the run on the projection lane has no
  // other seam to reach. Dropping it here would leave `vat skills build`
  // reaching a store it opened and never used.
  // `runOptions.outputs` is the run's one declaration of what it writes (every skill's
  // output, and the staging around them): a crawl fault on it is the destination's.
  const registry = await createProjectRegistry(projectRoot, runOptions);

  // 2. Package each skill against the shared registry
  // In order: each build writes against the shared registry, and outcomes and logs follow input order.
  return mapInOrder(skills, async ({ skillPath, options }): Promise<SkillPackageOutcome> => {
    try {
      const { result, siblings } = await packageSkillInto(skillPath, options.outputPath, {
        ...options,
        registry,
        allowLedger,
      }, runOptions.outputs);
      // Nothing beside a bundle is written here: an archive a format asks for is a plan's to place.
      if (siblings.zip !== undefined || siblings.marketplace !== undefined) {
        throw new Error(`packageSkills writes each bundle in place; the ZIP or marketplace manifest ${skillPath} asked for belongs to a plan, so use packageSkill`);
      }
      return { status: 'built', skillPath, result };
    } catch (error) {
      // Not swallowed: the error is carried on the outcome so the caller reports
      // WHICH skill failed and why, and gates the run's exit code on it.
      return {
        status: 'failed',
        skillPath,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  });
}

/**
 * Package a skill with all its dependencies
 *
 * This is the unified packaging logic used by all flows.
 * Works with any SKILL.md file, whether generated or handwritten.
 *
 * The package is ONE tree-change plan: the output directory is a `replace` whose staged
 * tree the whole package is written into, and the ZIP and marketplace manifest a
 * requested format writes beside it are `replace-file` changes of the same plan — so a
 * run either lands every artifact or changes nothing ({@link packageOutputChanges}).
 * Who may lose what is at the output: {@link packageOwnership}. An output that is, or
 * holds, a file the package reads is refused whatever the ownership
 * (`TREE_DEST_HOLDS_SOURCE`).
 *
 * @param skillPath - Absolute path to SKILL.md file
 * @param options - Packaging options
 * @returns Package result with metadata and artifact paths
 *
 * @example
 * ```typescript
 * const result = await packageSkill(
 *   'vat-example-cat-agents/resources/skills/SKILL.md',
 *   { formats: ['directory', 'zip'] }
 * );
 * ```
 */
export async function packageSkill(
  skillPath: string,
  options: PackageSkillOptions = {}
): Promise<PackageSkillResult> {
  // The package's own output is the only thing this call writes.
  const prepared = await preparePackage(skillPath, options, 'source', []);
  const { outputPath, skillMetadata, formats, projectRoot } = prepared;
  const holder: { built?: PackagedInto } = {};
  const plan = await planTreeChanges(packageOutputChanges({
    outputPath,
    skillName: skillMetadata.name,
    formats,
    ownership: packageOwnership(options),
    reads: prepared.allFiles,
    write: async (staged) => {
      holder.built = await prepared.writeInto(staged);
      // A package its own checks failed does not replace the previous output: thrown from the fill,
      // the plan discards it (what it could not remove recorded beside the throw).
      refuseFailedChecks(holder.built.result, stagedPathMapper(projectRoot, staged, outputPath));
      return holder.built.siblings;
    },
  }));

  // A dry run stops here: every refusal that can come before a write has had its chance.
  if (options.dryRun === true) {
    return {
      outputPath,
      skill: skillMetadata,
      files: { root: 'SKILL.md', dependencies: prepared.relativeLinkedFiles },
      plannedSources: [...prepared.allFiles],
      plannedChanges: plan.describe(),
      hasErrors: false,
      residue: [],
    };
  }

  const { warnings: residue } = await applyTreePlan(plan);
  // The plan resolves only once its fill has run, so the package is there.
  if (holder.built === undefined) throw new Error('packageSkill: the plan resolved without writing the package');
  return landedPackageResult(holder.built, { outputPath, projectRoot, formats, residue });
}

/**
 * Refuse a package whose own post-build checks emitted an error: `packageSkill` never replaces a
 * previous output with one. The agent builder does not apply this (`docs/contributing/known-defects.md`).
 * Thrown from the plan's fill, so the plan discards what it staged.
 *
 * @param result - The package as written into the staged tree
 * @param landedPath - {@link stagedPathMapper} onto where it would have landed
 * @throws SkillPackageChecksFailedError carrying the re-anchored result
 */
function refuseFailedChecks(result: PackageSkillResult, landedPath: (value: string) => string): void {
  if (result.hasErrors) throw new SkillPackageChecksFailedError(reanchorStagedResult(result, landedPath));
}

/**
 * Package an author's skill IN PLACE into `dir`, a directory inside the caller's own plan's
 * staged tree (`vat skills build`'s `dist/skills`, `vat claude plugin build`'s marketplace):
 * the caller's plan already lands it whole or not at all, so a second plan per bundle would
 * only stage it twice. Nothing beside `dir` is written: the archives a format asks for come
 * back as {@link PackagedInto.siblings}. The result is anchored on `dir`.
 *
 * @param skillPath - The author's SKILL.md
 * @param dir - The directory the bundle is written into
 * @param options - Packaging options; the output is `dir`, and nothing is replaced
 * @param outputs - What the caller's run writes besides `dir` (its destination, its staged tree):
 *   the one declaration a crawl's side is derived from — a refusal on, in or above one is the
 *   destination's. Required: only the caller knows.
 */
export async function packageSkillInto(
  skillPath: string,
  dir: string,
  options: Omit<PackageSkillOptions, 'outputPath' | 'replaceExistingOutput' | 'dryRun'>,
  outputs: readonly string[],
): Promise<PackagedInto> {
  const prepared = await preparePackage(skillPath, { ...options, outputPath: dir }, 'source', outputs);
  return prepared.writeInto(dir);
}

/**
 * Package a SKILL.md that was GENERATED into `dir` — the staged tree of the caller's own
 * plan (the agent builder) — in place: `dir` is both the output and where the skill's
 * source lives, so a read of it is the destination's. Nothing beside `dir` is written:
 * the archives a format asks for come back as {@link PackagedInto.siblings}, for the
 * caller's plan to place ({@link packageOutputChanges}). The result is anchored on `dir`.
 *
 * @param skillPath - The generated SKILL.md, inside `dir`
 * @param dir - The staged output directory
 * @param options - Packaging options; the output is `dir`, and nothing is replaced
 * @param outputs - What the caller's run writes besides `dir` (the destination `dir` lands on), as
 *   for {@link packageSkillInto}
 */
export async function packageGeneratedSkillInto(
  skillPath: string,
  dir: string,
  options: Omit<PackageSkillOptions, 'outputPath' | 'replaceExistingOutput' | 'dryRun'>,
  outputs: readonly string[],
): Promise<PackagedInto> {
  const prepared = await preparePackage(skillPath, { ...options, outputPath: dir }, 'destination', outputs);
  return prepared.writeInto(dir);
}

/**
 * Everything a package is decided by, read before anything is written — steps 1–6: the
 * skill's metadata, the project registry, the link walk and the output path — and
 * {@link PreparedPackage.writeInto}, which writes the package (steps 8–14) into the
 * directory it is given: the staged tree of a plan, never the output itself.
 *
 * @param skillSide - The side of the run the SKILL.md is on: the author's input
 *   (`source`), or VAT's own output re-read (`destination`: a SKILL.md generated into it)
 * @param outputs - What the run writes besides this package's output (which is always
 *   declared): with the output, the one declaration every crawl here derives a side from
 */
async function preparePackage(
  skillPath: string,
  options: PackageSkillOptions,
  skillSide: 'source' | 'destination',
  outputs: readonly string[],
): Promise<PreparedPackage> {
  const {
    formats = ['directory'],
    rewriteLinks = true,
    resourceNaming = 'basename',
    stripPrefix,
    target = DEFAULT_PACKAGING_TARGET,
  } = options;

  // 1. Parse SKILL.md frontmatter and links
  const parseResult = await parseFileCached(skillPath, 'markdown', { side: skillSide });
  const skillMetadata = extractSkillMetadata(parseResult, skillPath);

  // 2. Find project boundary (config root -> git root -> skill dir).
  // Library callers fall back to the skill directory when canonical
  // findProjectRoot returns null. The CLI command boundary is responsible
  // for any user-facing warning about missing project roots.
  //
  // COORDINATE-SYSTEM ASSUMPTION, not an enforced invariant. This root is the base
  // every path this call REPORTS is stated in — `namingBasePath` at step 8, and the
  // `projectRoot` handed to `walkerExclusionsToIssues` / `testInputLinkIssues` /
  // `deferredAssetsToIssues` at step 13b. It is derived HERE, per skill, from the
  // skill's own path. It is NOT the `projectRoot` argument `packageSkills` was called
  // with (that one is used only for `createProjectRegistry`), and it is not the `cwd`
  // that `vat skills build` treats as the root of the document it emits.
  //
  // UNVERIFIED that these can actually diverge: in every path exercised so far the two
  // have coincided (`vat skills build` passes its `cwd`, and the skills it discovers
  // live under it), and no run has been observed where they differ. Nothing enforces
  // the equality, though — a caller packaging a skill from outside its own project
  // root would get issue locations in one coordinate system and a report header in
  // another, with no error anywhere.
  const projectRoot = findProjectRoot(dirname(skillPath)) ?? dirname(skillPath);
  const skillRoot = dirname(skillPath);

  // 2b. Determine output path (decided before any crawl: it is what the run writes).
  const outputPath = options.outputPath ??
    getDefaultSkillOutputPath(skillPath, skillMetadata.name);
  // What this run writes: the package's output, and whatever the caller's run writes besides —
  // the previous output beside a staged tree included. A crawl fault on, in or above one is the
  // destination's.
  const runOutputs = [outputPath, ...outputs];

  // 3. Get or create the resource registry.
  // The fallback crawls and parses EVERY markdown file in the project, so any
  // caller packaging more than one skill must build the registry once itself
  // (see createProjectRegistry) and pass it — otherwise the whole-project scan
  // is paid once PER SKILL.
  const registry = options.registry ?? await createProjectRegistry(projectRoot, { outputs: runOutputs });
  // The skill itself unread by the crawl is no skill to package: never a bundle of its SKILL.md alone.
  refuseUnreadableSkill(registry, skillPath, skillSide);

  // 3b. Load per-collection frontmatter schemas (Gap 3: packager rewrites frontmatter URI-refs
  // against the same schemas the validator uses, with body parity).
  const { schemas: collectionSchemas, issues: collectionSchemaIssues } = await loadCollectionSchemas(
    registry.config,
    projectRoot,
  );

  // 4. Walk the link graph using registry data
  const linkFollowDepth = options.linkFollowDepth ?? 2;
  const excludeConfig = options.excludeReferencesFromBundle;
  const excludeNavigationFiles = options.excludeNavigationFiles ?? true;
  const maxDepth = linkFollowDepth === 'full' ? Infinity : linkFollowDepth;

  // Find the skill resource in the registry
  const skillResource = registry.getResource(safePath.resolve(skillPath));
  const skillResourceId = skillResource?.id ?? '';

  const testInputDirs = options.testInputDirs ?? [];
  // Declaring a path under `test.evals` IS the instruction not to package it, so a
  // `files:` entry pointing into test input is dropped here rather than copied and
  // then complained about. The adopter never has to edit config to get the right
  // artifact; the dropped entries are reported below as warnings.
  const { kept: filesConfig, dropped: droppedTestInputFiles } = partitionTestInputFileEntries(
    options.files ?? [],
    projectRoot,
    testInputDirs,
  );
  const deferredArtifacts = DeferredArtifacts.from([{ files: filesConfig, skillDir: skillRoot }], projectRoot);

  const packagerWalkOptions: Parameters<typeof walkLinkGraph>[2] = {
    maxDepth,
    // Declared test input is dropped from the bundle before anything else decides
    // to include it — a link into the eval suite is not a packaging decision the
    // author gets to make (see test-input.ts).
    excludeRules: [...(excludeConfig?.rules ?? []), ...testInputExcludeRules(testInputDirs, projectRoot)],
    projectRoot,
    skillRootPath: safePath.resolve(skillPath),
    excludeNavigationFiles,
    deferredArtifacts,
  };
  if (options.gitTracker !== undefined) {
    packagerWalkOptions.gitTracker = options.gitTracker;
  }
  const { bundledResources, bundledAssets, excludedReferences, outsideSkillDirLinks, deferredAssets } = walkLinkGraph(
    skillResourceId,
    registry as WalkableRegistry,
    packagerWalkOptions,
  );

  // Register non-markdown bundled assets in the source registry so link rewriting
  // can resolve them (resolvedId must be set on links pointing to YAML, JSON, etc.).
  // For any asset whose id is already taken (a path-slug clash — `a-b/c.html`
  // and `a/b-c.html` both flatten to `a-b-c-html`), we set a synthetic
  // resolvedId on links pointing to it so link rewriting still works.
  const { collidedAssets, collisions: assetCollisions } = await registerBundledAssets(registry, bundledAssets, projectRoot);
  resolveCollidedAssetLinks(
    collectResourcesWithLinks(bundledResources, skillResource),
    collidedAssets,
  );

  // Combine bundled file paths: markdown resources + non-markdown assets
  const bundledFiles = [
    ...bundledResources.map(r => r.filePath),
    ...bundledAssets,
  ];

  // 5. Calculate common ancestor of all files (for proper relative path calculation)
  const allFiles = [skillPath, ...bundledFiles];
  const effectiveBasePath = findCommonAncestor(allFiles);

  // Get relative paths for result
  const relativeLinkedFiles = bundledFiles.map(f =>
    safePath.relative(effectiveBasePath, f)
  );

  // 7. The output belongs to a tree-change plan (see `packageSkill`): steps 8–14 write into
  // the directory they are given, that plan's staged tree.
  const writeInto = async (outputPath: string): Promise<PackagedInto> => {
    // What this write lands in, and what the run writes besides: a crawl fault on any is the destination's.
    const writing = [outputPath, ...runOutputs];
    // 8. Build path map for file copying and link rewriting
    const namingBasePath = projectRoot;
    const pathMapSkill = { path: skillPath, name: skillMetadata.name };
    const pathMap = buildPathMap(
      pathMapSkill,
      bundledFiles, outputPath, resourceNaming, namingBasePath, stripPrefix, target,
    );

    // 8b. Apply files config to the path map: single-file entries by name, and glob
    // entries by re-pointing the link-bundled files they claim at the declared dest.
    applyFilesEntriesToPathMap(
      filesConfig, projectRoot, outputPath, pathMap, skillMetadata.name, bundledFiles,
    );

    // 8c. Collisions are judged on the FINAL destination map, so a `files:` remap is
    // a real remedy and a `files:`-created collision is still caught. See
    // detectDestinationCollisions for why this cannot run inside buildPathMap.
    const collisionIssues = detectDestinationCollisions(
      pathMapSkill, pathMap, outputPath, resourceNaming, namingBasePath,
    );

    // 9. Build "to" registry for link rewriting (maps same resource IDs to output paths)
    const outputResources = bundledResources.map(resource => ({
      ...resource,
      filePath: pathMap.get(toForwardSlash(resource.filePath)) ?? resource.filePath,
    }));
    // Include the skill resource itself in the "to" registry
    if (skillResource) {
      outputResources.push({
        ...skillResource,
        filePath: safePath.join(outputPath, 'SKILL.md'),
      });
    }
    // Add non-markdown bundled files (assets) to output registry so link rewriting resolves them
    addBundledAssetsToOutputRegistry(outputResources, bundledAssets, pathMap, registry, collidedAssets);
    // Register files: deferred-dest links so the build preserves/rewrites them (mirrors
    // the collided-asset handling). Stamps resolvedId on dest links and adds a synthetic
    // output resource so the rewriter renders [text](dest) instead of stripping to ().
    outputResources.push(
      ...registerDeferredDestLinks(
        filesConfig,
        collectResourcesWithLinks(bundledResources, skillResource),
        skillPath,
        outputPath,
        outputResources,
      ),
    );
    // Include excluded resources (with source paths) for pattern-based rule matching
    for (const excl of excludedReferences) {
      if (excl.excludeReason === 'directory-target' || excl.excludeReason === 'outside-project') {
        continue;
      }
      const exclResource = (registry as WalkableRegistry).getResource(safePath.resolve(excl.path));
      if (exclResource && !outputResources.some(r => r.id === exclResource.id)) {
        outputResources.push(exclResource);
      }
    }
    const outputRegistry = ResourceRegistry.fromResources(outputPath, outputResources);

    // 10. Build excluded resource IDs for rule matching.
    // Excluded IDs should NOT include resources that are already bundled.
    // A resource can appear in both bundledResources (via short path) and
    // excludedReferences (via long path that exceeds depth). The bundled
    // status wins — links to it should be rewritten, not stripped.
    const bundledResourceIds = new Set(bundledResources.map(r => r.id));
    const excludedIds = [...new Set(
      excludedReferences
        .filter(r => r.excludeReason !== 'directory-target' && r.excludeReason !== 'outside-project')
        .map(r => {
          const res = (registry as WalkableRegistry).getResource(safePath.resolve(r.path));
          return res?.id;
        })
        .filter((id): id is string => id !== undefined && !bundledResourceIds.has(id)),
    )];

    // 11. Build unified rewrite rules (bundled + excluded, all via transformContent)
    const rewriteRules = buildRewriteRules(
      excludedIds,
      excludeConfig?.rules ?? [],
      excludeConfig?.defaultTemplate,
    );

    // 12. Copy and rewrite files
    // The build's own output directory. An unwritable `dist/` or a full disk failed
    // here with a bare errno naming an output path the author never typed — the
    // same shape as the copiers, at the step before any of them run.
    await withFsFault(
      { side: 'destination', action: `create skill '${skillMetadata.name}' output directory ${issueLocation(outputPath, projectRoot) || '.'}` },
      () => mkdir(outputPath, { recursive: true }),
    );

    await copyAndRewriteFiles(skillPath, bundledFiles, {
      pathMap,
      rewriteLinks,
      fromRegistry: registry as WalkableRegistry,
      // Both sources, because they record disjoint populations: the registry's
      // own log holds crawl-time drops made by `addResources`, while
      // `registerBundledAssets` holds the per-asset drops `addResource` only ever
      // signalled by throwing. An HTML file that collides with a same-named
      // markdown file appears ONLY in the second.
      duplicateIdDrops: new Map(
        [...registry.getDuplicateIdCollisions(), ...assetCollisions]
          .map(c => [toForwardSlash(c.conflictingPath), c.existingPath]),
      ),
      toRegistry: outputRegistry,
      rewriteRules,
      templateContext: { skill: { name: skillMetadata.name } },
      collectionSchemas,
      projectRoot,
      warn: (message) => process.stderr.write(`warning: ${message}\n`),
    });

    // 12b. Copy files config entries that were not auto-discovered via link traversal.
    // Keep the dests it reports: they are what makes the orphan check below able to
    // tell "the author forgot to document this" from "VAT put this here because the
    // config said to." Discarding them makes the build fail on its own payload.
    const appliedFiles = await applyFilesConfig({
      filesConfig, projectRoot, skillOutputDir: outputPath, bundledFiles,
    });
    const filesConfigDests = appliedFiles.dests;
    // Dests a glob matched and the never-package list refused. Two consumers, and
    // both are load-bearing: the broken-link check below needs them to tell a link
    // broken by policy from a link broken by the rewriter, and the finding channel
    // needs them or the structured report says `warnings: 0` about a build that
    // silently shipped less than the config asked for.
    const droppedGlobDests = appliedFiles.dropped.map((drop) => drop.dest);

    // 13. Post-build integrity check: no SKILL.md in subdirectories
    // A SKILL.md is a skill definition marker — it must only exist at the root.
    // If another skill's SKILL.md was bundled as a resource, it creates duplicate
    // skill definitions that break marketplace sync and confuse skill consumers.
    validateNoNestedSkillMd(outputPath, skillMetadata.name);

    // 13b. Post-build integrity checks (unreferenced files, broken packaged links).
    //
    // Runs BEFORE generatePackageArtifacts so the synthetic package.json from
    // createNpmPackage isn't flagged as unreferenced.
    //
    // Walker-exclusion issues (depth drops, missing targets, outside-project, etc.)
    // are combined with post-build checks and run through the validation framework.
    const rawPostBuildIssues = [
      // Found back at step 8, reported here: the path map is decided before any
      // file is written, but a collision is a packaging FINDING and rides the same
      // channel as every other one rather than aborting the run from inside a
      // helper.
      ...collisionIssues,
      ...await checkUnreferencedFiles(outputPath, filesConfigDests),
      ...await checkBrokenPackagedLinks(outputPath, droppedGlobDests),
      // The inverse of checkUnreferencedFiles: paths the docs NAME that the bundle
      // does not contain. Built phase only — a `files:` dest exists here and not in
      // the source tree, so the same check at source phase flags every injected
      // script.
      //
      // SKILL-LOCAL, and this is the ONLY caller. The packager knows its own output
      // directory, not the plugin the skill will be installed into, so there is no
      // wider root to give it — the sibling-search parameter that measured 1.9%
      // instead of 3.8% was deleted for having no caller. The shipped rate is 3.8%.
      ...await checkMissingReferencedPaths(outputPath, target),
      // The only byte measurement in the pipeline. Built phase for the same reason
      // as its neighbour above: a `files:` entry materializes files here that the
      // source tree does not have, so the bytes that ship are only knowable now.
      //
      // ⚠️ Runs before step 14, so it does not weigh what `generatePackageArtifacts`
      // adds. Measured, so the residue is not a guess: the `zip` and `npm` formats
      // write to `<outputPath>.zip` / `.tgz`, OUTSIDE the bundle and outside the
      // upload; only the `npm` format's synthetic package.json and the `marketplace`
      // format's manifest land inside, and both are a few hundred bytes. The order
      // is not free to change — checkUnreferencedFiles two lines up would flag that
      // same synthetic package.json — so the under-count is stated rather than
      // fixed. If an artifact step ever writes something LARGE into outputPath, this
      // call has to move after it and the framework run with it.
      ...checkPackagedSizeLimit(outputPath),
      // A receipt for every file a glob matched and the never-package list refused.
      // Reported as an issue, not written to stderr: a file vanishing from a bundle
      // has to be visible in the counts (`summary`), or CI reads a clean report for a build
      // that quietly shipped less than the config declared.
      // Anchored at the PROJECT root, not `outputPath` like its neighbours here: a
      // dropped file is a source file that never reached the output, so the only
      // path a reader can open is its source path.
      ...droppedGlobMatchesToIssues(appliedFiles.dropped, projectRoot),
      // The same receipt, for matches that are not copyable files at all. Anchored
      // identically and for the identical reason. Without a channel of its own this
      // population is invisible: the build used to die on the first one it met.
      ...skippedGlobMatchesToIssues(appliedFiles.skipped, projectRoot),
      // Presence-side backstop for agent-instruction files. The walker excludes
      // them from link-following, but a `files:` glob can still copy one in, and
      // a file that arrives without a link is invisible to the link lane.
      //
      // Explicitly-declared dests are exempt (§8.2 precedence): the build KNOWS the
      // config here, and an explicit `files:` entry is an instruction to ship that
      // exact file. Reporting it fired this warning on the very config the guide
      // prescribes as the escape hatch, with a remedy ("remove the file") that says
      // to undo what the author was told to write.
      ...detectPackagedAgentInstructionFiles(
        outputPath,
        outputPath,
        explicitFilesConfigDests(filesConfig),
        // The output this run just wrote: a fault on it is the destination's.
        writing,
      ),
      // A receipt for each `files:` entry that was dropped for pointing into declared
      // test input — the build already produced the right artifact; this just says so.
      ...testInputFileEntryIssues(droppedTestInputFiles),
      // A collection schema that could not be loaded, so its frontmatter was not
      // rewritten (see loadCollectionSchemas).
      ...collectionSchemaIssues,
      // Backstop: if declared test input reached the output despite both exclusions,
      // say so rather than shipping an answer key silently.
      ...checkPackagedTestInput({ pathMap, outputPath, testInputDirs }),
    ];
    const rawLinkIssues = [
      ...walkerExclusionsToIssues(excludedReferences, projectRoot),
      // The link half of the same receipt: a link INTO declared test input is dropped
      // and rewritten away, which the generic exclusion channel reports as nothing
      // (a pattern match is author-declared intent; this exclusion is VAT's).
      ...testInputLinkIssues(excludedReferences, testInputDirs, projectRoot),
      ...deferredAssetsToIssues(deferredAssets, projectRoot),
      ...outsideSkillDirLinksToIssues(outsideSkillDirLinks, projectRoot),
    ];

    // ONE ledger for BOTH lanes below. `options.validation.allow` governs the
    // build-receipt lane AND the built-SKILL.md lane, but the two see disjoint
    // issue populations — so a lane that drains its own ledger calls "unused" an
    // entry the OTHER lane matched. (Measured before the fix: an entry that
    // suppressed a real LINK_MISSING_TARGET error still emitted ALLOW_UNUSED from
    // the built-output lane, and a genuinely dead entry was reported twice.) Same
    // defect, same fix as the validate lane — see
    // `SkillValidationSharedContext.allowLedger`.
    //
    // Whose run it is comes from the caller. Given a ledger, this call is one unit
    // of a larger run (a batch, and/or a source-tree validation pass that matches
    // entries this build's two lanes structurally cannot) and must NOT drain —
    // draining here is what reported a package-scoped entry matched while building
    // skill A as unused while building skill B. Given none, the caller has claimed
    // this call IS the run, so the drain below is honest.
    const ownsRun = options.allowLedger === undefined;
    const buildRunLedger = options.allowLedger ?? createAllowUsageLedger();

    const framework = runValidationFramework(
      [...rawLinkIssues, ...rawPostBuildIssues],
      options.validation ?? {},
      buildRunLedger,
    );

    // 13c. Run full validation suite on built output
    const postBuildValidation = await runPostBuildValidation(
      outputPath,
      options.validation,
      buildRunLedger,
      writing,
    );

    // 14. Generate the distribution artifacts: the npm manifest into the bundle, and the
    // bytes of what lands BESIDE it, for the caller's plan to place.
    const siblings = await generatePackageArtifacts(outputPath, skillMetadata, formats, projectRoot, target);

    return {
      siblings,
      result: assemblePackageResult({
        outputPath,
        skillMetadata,
        relativeLinkedFiles,
        postBuildValidation,
        // Drain point — but only when this call owns the run. Both lanes have now
        // contributed; whether anything ELSE still will is the caller's claim.
        framework: ownsRun ? withRunAllowUnused(framework, buildRunLedger) : framework,
        excludedReferences,
        skillRoot,
      }),
    };
  };

  return { outputPath, skillMetadata, formats, projectRoot, allFiles, relativeLinkedFiles, writeInto };
}

/** What a package writes BESIDE its output directory, for the formats asked for: bytes for the caller's plan to place. */
export interface PackageSiblings {
  /** The ZIP of the bundle (`zip` format), for `<output>.zip`. */
  readonly zip?: Buffer;
  /** The marketplace manifest (`marketplace` format), for `<output dir>/<name>.marketplace.json`. */
  readonly marketplace?: string;
}

/** A package written into a directory: its result, anchored on that directory, and what goes beside it. */
export interface PackagedInto {
  readonly result: PackageSkillResult;
  readonly siblings: PackageSiblings;
}

/** {@link preparePackage}'s answer: what the package is, and how to write it. */
interface PreparedPackage {
  /** Where the package lands (the plan's destination). */
  readonly outputPath: string;
  readonly skillMetadata: SkillMetadata;
  readonly formats: readonly string[];
  /** The project root every reported path is relative to. */
  readonly projectRoot: string;
  /** Every file the package reads, SKILL.md first: the plan's holding check refuses an output that is or holds one. */
  readonly allFiles: readonly string[];
  readonly relativeLinkedFiles: string[];
  /** Write the package into `dir` (steps 8–14). */
  readonly writeInto: (dir: string) => Promise<PackagedInto>;
}

/** The output of one package, as a plan's changes see it. */
interface PackageOutput {
  /** The output directory. */
  readonly outputPath: string;
  /** The skill's name: it names the marketplace manifest beside the output. */
  readonly skillName: string;
  /** The formats asked for: which files land beside the output. */
  readonly formats: readonly string[];
  /** Who may lose what is at the output ({@link packageOwnership}). */
  readonly ownership: Ownership;
  /** Every input the package reads: an output that is, or holds, one is refused. */
  readonly reads: readonly string[];
  /** Fill the staged output directory; answers the bytes of what lands beside it. */
  readonly write: (staged: string) => Promise<PackageSiblings>;
}

/** Where a package's ZIP lands. */
const zipPathOf = (outputPath: string): string => `${outputPath}.zip`;

/** Where a package's marketplace manifest lands. */
const marketplaceManifestPathOf = (outputPath: string, skillName: string): string =>
  safePath.join(dirname(outputPath), `${skillName}.marketplace.json`);

/**
 * The ownership of a package's output — the ONE rule for `vat skills package` and
 * `vat agent build`. The default location is VAT's (`vat-state`): whatever is there is a
 * previous build. `--force` (`replaceExistingOutput`) says what is there is a previous
 * package, and it goes. An explicit output otherwise is `vat-made` by
 * {@link recognisePackageOutput}: only an empty directory is taken, never anything VAT
 * cannot prove it made, so it is refused, named, and left as it was.
 *
 * @param options - Whether an output was named, and whether `--force` was given
 */
export function packageOwnership(options: { readonly outputPath?: string | undefined; readonly replaceExistingOutput?: boolean | undefined }): Ownership {
  if (options.outputPath === undefined) return { kind: 'vat-state' };
  if (options.replaceExistingOutput === true) return { kind: 'force' };
  return { kind: 'vat-made', recognise: recognisePackageOutput };
}

const PACKAGE_OUTPUT_NOT_OURS = 'it already exists, and VAT never deletes or overwrites what it did not produce. If it is a previous '
  + 'package, pass --force to replace it (`replaceExistingOutput: true` in the library); otherwise remove it yourself, '
  + 'or choose an output path that does not exist yet (or is an empty directory).';

/**
 * Whether what is at an explicit package output is VAT's to replace without `--force`:
 * only an empty directory (the package lands where nothing is lost). A directory the OS
 * will not list is the destination's fault, never assumed occupied or free.
 */
function recognisePackageOutput(dest: string): OwnershipVerdict {
  const empty = withFsFaultSync({ side: 'destination', action: `list the package output ${dest}`, path: dest }, () => {
    if (!lstatSync(dest).isDirectory()) return false;
    return readdirSync(dest).length === 0;
  });
  return empty ? { owned: true } : { owned: false, reason: PACKAGE_OUTPUT_NOT_OURS };
}

/**
 * Whether what stands where a package's archive goes may be replaced under `--force`:
 * a previous archive (a file) is; a directory or anything else standing there is not a
 * previous package's, so it is refused and kept.
 */
function recognisePreviousArchive(dest: string): OwnershipVerdict {
  const isFile = withFsFaultSync({ side: 'destination', action: `examine ${dest}`, path: dest }, () => lstatSync(dest).isFile());
  return isFile ? { owned: true } : { owned: false, reason: 'it is not a file a previous package wrote, so --force does not replace it' };
}

/** The ownership of a file a package writes beside its output: `--force` replaces a previous archive, never a directory standing there. */
function siblingOwnership(ownership: Ownership): Ownership {
  return ownership.kind === 'force' ? { kind: 'vat-made', recognise: recognisePreviousArchive } : ownership;
}

/**
 * The changes ONE package makes, as one plan: the output directory (`replace`, its staged
 * tree filled by `output.write`) and the ZIP and marketplace manifest the formats ask for
 * (`replace-file`, after the directory in the plan, so their bytes are made from the
 * staged bundle). The holding check covers `output.reads`.
 *
 * @param output - The output, its ownership, and how to fill it
 */
export function packageOutputChanges(output: PackageOutput): TreeChange[] {
  const { outputPath, skillName, formats, ownership } = output;
  let siblings: PackageSiblings | undefined;
  const sibling = (format: 'zip' | 'marketplace') => (): string | Uint8Array => {
    const bytes = siblings?.[format];
    if (bytes === undefined) throw new Error(`packageOutputChanges: the package wrote no ${format} for ${outputPath}`);
    return bytes;
  };
  const changes: TreeChange[] = [{
    op: 'replace',
    dest: outputPath,
    ownership,
    label: `skill '${skillName}' output`,
    fill: {
      from: 'write',
      reads: output.reads,
      write: async (staged) => {
        siblings = await output.write(staged);
      },
    },
  }];
  if (formats.includes('zip')) {
    changes.push({ op: 'replace-file', dest: zipPathOf(outputPath), ownership: siblingOwnership(ownership), label: `skill '${skillName}' ZIP archive`, contents: sibling('zip') });
  }
  if (formats.includes('marketplace')) {
    changes.push({ op: 'replace-file', dest: marketplaceManifestPathOf(outputPath, skillName), ownership: siblingOwnership(ownership), label: `skill '${skillName}' marketplace manifest`, contents: sibling('marketplace') });
  }
  return changes;
}

/**
 * The paths a package's result names, for a package written into a staged tree that has
 * since landed at `outputPath`: every path on the staged tree re-anchored onto the output
 * ({@link stagedPathMapper}), the artifacts named where they landed, and the plan's
 * leftovers ({@link PackageSkillResult.residue}).
 */
export function landedPackageResult(
  built: PackagedInto,
  landed: { outputPath: string; projectRoot: string; formats: readonly string[]; residue: readonly TreeChangeWarning[] },
): PackageSkillResult {
  const { outputPath, projectRoot, formats } = landed;
  const reanchored = reanchorStagedResult(built.result, stagedPathMapper(projectRoot, built.result.outputPath, outputPath));
  return { ...reanchored, artifacts: artifactPaths(outputPath, built.result.skill.name, formats), residue: landed.residue };
}

/** Where each artifact a format asked for landed. */
function artifactPaths(outputPath: string, skillName: string, formats: readonly string[]): Record<string, string> {
  const artifacts: Record<string, string> = {};
  if (formats.includes('directory')) artifacts['directory'] = outputPath;
  if (formats.includes('zip')) artifacts['zip'] = zipPathOf(outputPath);
  // A placeholder: no tarball is written (a full npm pack would run `npm pack`).
  if (formats.includes('npm')) artifacts['npm'] = `${outputPath}.tgz`;
  if (formats.includes('marketplace')) artifacts['marketplace'] = marketplaceManifestPathOf(outputPath, skillName);
  return artifacts;
}

/**
 * Rewrite `value` when it names `from` or something inside it; otherwise
 * `undefined`, so a caller can fall through to the next candidate base.
 *
 * The separator in the prefix test is load-bearing: the swap parks the previous
 * output at `<staged>.previous`, a SIBLING whose string starts with the staged
 * tree's. A bare `startsWith` would rewrite it into the final tree and report a
 * finding against a path that never held the file.
 */
function replacePathPrefix(value: string, from: string, to: string): string | undefined {
  if (value === from) return to;
  return value.startsWith(`${from}/`) ? `${to}${value.slice(from.length)}` : undefined;
}

/**
 * Map any path anchored on a staged tree onto the tree the swap lands it on — the ONE
 * re-anchoring, applied to every path a result publishes.
 *
 * Staging is transient in BOTH outcomes: `.<name>.vat-staged-<rand>` is renamed into place
 * on success and deleted on failure, and the random suffix means a reader cannot even
 * reconstruct it. Any path that escapes this mapping is therefore unopenable by the time
 * anyone reads it (`Location: dist/.vat-skills-uxxJfu/demo/SKILL.md`, observed on a real
 * adopter before the mapping existed).
 *
 * Both spellings are handled because the two carriers use different coordinate systems:
 * a result's `outputPath` is absolute, while a finding's `location` is relative to the
 * root the validator anchored on (`base`). The mapping preserves whichever it was given.
 *
 * @param base - The root relative locations are expressed against
 * @param staged - The staged tree
 * @param dest - Where it landed
 */
export function stagedPathMapper(base: string, staged: string, dest: string): (value: string) => string {
  const absoluteFrom = toForwardSlash(staged);
  const absoluteTo = toForwardSlash(dest);
  const relativeFrom = toForwardSlash(safePath.relative(base, staged));
  const relativeTo = toForwardSlash(safePath.relative(base, dest));

  return (value: string): string => {
    const forward = toForwardSlash(value);
    return (
      replacePathPrefix(forward, absoluteFrom, absoluteTo)
      ?? replacePathPrefix(forward, relativeFrom, relativeTo)
      ?? value
    );
  };
}

/** Re-anchor the `location` of every issue that names a staged path. */
function reanchorIssueLocations(
  issues: readonly ValidationIssue[],
  mapPath: (value: string) => string,
): ValidationIssue[] {
  return issues.map((issue) => {
    if (issue.location === undefined) return issue;
    const location = mapPath(issue.location);
    return location === issue.location ? issue : { ...issue, location };
  });
}

/**
 * Re-anchor everything ONE skill's result says about where things are.
 *
 * Both post-build channels are rewritten, not just the one a summary reads: either can
 * carry a staged location (the built-output validation runs against the staged
 * `SKILL.md` itself), so a mapper applied to one of them leaves the report half-anchored.
 *
 * @param result - A result anchored on a staged tree
 * @param mapPath - {@link stagedPathMapper} for that tree
 */
export function reanchorStagedResult(
  result: PackageSkillResult,
  mapPath: (value: string) => string,
): PackageSkillResult {
  const reanchored: PackageSkillResult = { ...result, outputPath: mapPath(result.outputPath) };
  if (result.postBuildIssues) {
    reanchored.postBuildIssues = reanchorIssueLocations(result.postBuildIssues, mapPath);
  }
  if (result.postBuildValidation) {
    reanchored.postBuildValidation = {
      ...result.postBuildValidation,
      allErrors: reanchorIssueLocations(result.postBuildValidation.allErrors, mapPath),
    };
  }
  return reanchored;
}

/**
 * Fold the build run's ALLOW_UNUSED verdict into the build-issue lane.
 *
 * ALLOW_UNUSED belongs to the RUN, not to whichever lane happened to be looking
 * when an entry went unmatched — so it is drained once, here, and reported on
 * the single channel (`postBuildIssues`) rather than on both.
 */
function withRunAllowUnused(framework: FrameworkResult, ledger: AllowUsageLedger): FrameworkResult {
  const unused = allowUnusedIssues(ledger);
  if (unused.length === 0) return framework;
  const emitted = [...framework.emitted, ...unused];
  return { ...framework, emitted, hasErrors: emitted.some(i => i.severity === 'error') };
}

/**
 * Run full validation suite against built output (context = 'built').
 * Source-only codes are automatically filtered out by validateSkillForPackaging.
 *
 * `allowLedger` is required, not optional: this lane is one half of a build, so
 * it must never conclude on its own that an allow entry matched nothing.
 *
 * ⛔ This lane stays on the walk and is handed no `populationSource`. It validates
 * the BUILT tree under `outputPath` — a different tree from the one the run
 * enumerated, not tracked by git, and not covered by the packaging registry. A
 * source produced by `withResourcePopulationSource` is bound to the PROJECT root
 * and its git tree hash, so offering it a build-output directory asks it a
 * question about a tree it does not describe. Forwarding it here was tried and
 * reverted — the giveaway was a source offered `<root>/out/<skill>` instead of
 * the root.
 *
 * The store-poisoning half of that hazard is now closed at the seam rather than by
 * this comment: `ResourceRegistry.populationFrom` compares the source's own bound
 * root against the crawl's base and declines a mismatch back onto the walk. So a
 * future forward here would be a no-op that warns, not a corrupted extent key.
 * What it would still NOT be is a speed-up, which is why nothing is forwarded:
 * the built tree is a different tree, so there is no stored answer for it to hit.
 *
 * ## 🚨 This lane's link graph is EMPTY — and that is the NORMAL case
 *
 * Measured on a probe fixture (one skill, one `reference.md` reachable by
 * a single relative link from `SKILL.md`), run three ways with ONE variable —
 * where the packaged output lands:
 *
 * | lane | output location | `fileCount` | `directFileCount` | `maxLinkDepth` | `totalLines` |
 * |---|---|---:|---:|---:|---:|
 * | source | n/a | 2 | 1 | 1 | 13 |
 * | built | INSIDE the project (`<root>/dist/skills/<name>/`) | **1** | **0** | **0** | **10** |
 * | built | outside any project root (control) | 2 | 1 | 1 | 14 |
 *
 * The middle row is the defect; the third row PROVES the cause — the only
 * difference between them is whether the output falls under the crawl's
 * `**\/dist\/**` exclusion (`BUILD_OUTPUT_GLOBS`). `packageSkill`'s default output
 * IS the middle row, so this is the normal case, not an edge case. The result's
 * own `files.dependencies` still reads `["reference.md"]`: the packager copied it,
 * and the validator invoked here — immediately afterwards — cannot see it.
 *
 * ⚠️ It is not only a metrics hole. `collectNonPortableAssetReferenceIssues` and
 * `collectNonPortableCommandIssues` iterate `bundledFiles`, so in the built lane
 * they never open a single bundled reference file. A non-portable
 * `${CLAUDE_PLUGIN_ROOT}` invocation inside a bundled reference is caught at
 * source and CANNOT be caught in the built artifact.
 *
 * 🔑 Measured vs inferred. The three rows are MEASURED (that probe).
 * That the finding is still LIVE is inferred from this function's own body: it
 * passes only the built `SKILL.md` path, with no registry and no population
 * source rooted at the output tree, so `validateSkillForPackaging` resolves
 * `findProjectRoot` back to the SOURCE project and crawls it under the default
 * exclude — the built tree is never enumerated, `getResource` misses, and the
 * walk starts from nothing. The probe is no longer only a probe: it is pinned as
 * a committed regression test at
 * `packages/cli/test/integration/built-lane-link-graph.integration.test.ts`
 * (fixture `BUNDLING_SKILL_FILES`), asserting the middle row as today's
 * behaviour. When this is fixed, those assertions flip in the fixing change.
 *
 * ⛔ Do NOT fix it by widening the crawl. That same `**\/dist\/**` exclusion is
 * the stated correctness proof for `crawlAndResolveRegistry`'s process-lifetime
 * memo, which the audit lane, the validate lane AND this lane all share — see the
 * comment on `walkRegistryCache` in `validators/packaging-validator.ts`. Widening
 * it retracts that argument for every lane sharing the memo; this is not a
 * one-lane fix.
 */
function runPostBuildValidation(
  outputPath: string,
  validation: ValidationConfig | undefined,
  allowLedger: AllowUsageLedger,
  outputs: readonly string[],
): Promise<PackagingValidationResult> {
  const builtSkillPath = safePath.join(outputPath, 'SKILL.md');
  return validateSkillForPackaging(
    builtSkillPath,
    validation ? { validation } : undefined,
    'built',
    // The built skill IS this run's output, inside the project the check crawls — and so is
    // everything else the run writes (`outputs`, the previous output beside a staged one).
    { allowLedger, unreadable: 'refuse', outputs },
  );
}

/**
 * Refuse a skill whose own SKILL.md the registry's crawl could not read: the crawl records an
 * unreadable file and moves on, and a skill missing from the registry would be packaged as its
 * SKILL.md alone — every link of it silently gone. The read's own fault, on the SKILL.md's side.
 */
function refuseUnreadableSkill(registry: ResourceRegistry, skillPath: string, side: 'source' | 'destination'): void {
  const wanted = toForwardSlash(safePath.resolve(skillPath));
  const unread = registry.getUnreadableResources().find((entry) => toForwardSlash(safePath.resolve(entry.filePath)) === wanted);
  if (unread === undefined) return;
  const failure = Object.assign(new Error(unread.reason), { code: unread.code ?? 'UNKNOWN' });
  throw classifyFsFault(failure, { side, origin: 'content', action: `read the skill's SKILL.md ${skillPath}`, path: skillPath });
}

/** Input for assemblePackageResult — avoids a long parameter list. */
interface AssembleResultInput {
  outputPath: string;
  skillMetadata: SkillMetadata;
  relativeLinkedFiles: string[];
  postBuildValidation: PackagingValidationResult;
  framework: FrameworkResult;
  excludedReferences: Array<{ path: string }>;
  skillRoot: string;
}

/**
 * Assemble the final PackageSkillResult from intermediate data.
 * Extracted to keep packageSkill() within the cognitive-complexity budget.
 */
function assemblePackageResult(input: AssembleResultInput): PackageSkillResult {
  const result: PackageSkillResult = {
    outputPath: input.outputPath,
    skill: input.skillMetadata,
    files: {
      root: 'SKILL.md',
      dependencies: input.relativeLinkedFiles,
    },
    postBuildValidation: input.postBuildValidation,
    hasErrors: input.framework.hasErrors || input.postBuildValidation.summary.errors > 0,
    residue: [],
  };

  if (input.framework.emitted.length > 0) {
    result.postBuildIssues = input.framework.emitted;
  }

  if (input.excludedReferences.length > 0) {
    const uniqueExcludedPaths = [...new Set(
      input.excludedReferences.map(r => safePath.relative(input.skillRoot, r.path))
    )];
    result.excludedReferences = uniqueExcludedPaths;
  }

  return result;
}

// ============================================================================
// Registry Creation
// ============================================================================

/**
 * Options for {@link createProjectRegistry}.
 */
export interface ProjectRegistryOptions {
  /**
   * Where the file list comes from — omit for the incumbent walk, supply one to
   * source it from a projection instead.
   *
   * See {@link createProjectRegistry}'s docstring: the source answers
   * enumeration only, and this builder's markdown-only scoping survives it.
   */
  populationSource?: ResourcePopulationSource | undefined;
  /**
   * What the run writes — every output, and the staging it builds them in — or `[]` for a
   * run that writes nothing under the project: the crawl's one declaration of which side a
   * fault is on (on, in or holding an output: the destination's; anything else the
   * project's content). Required: only the caller knows.
   */
  outputs: readonly string[];
}

/**
 * Build THE project registry: every markdown file under `projectRoot`, parsed,
 * with links resolved and the project config attached.
 *
 * This is the one builder for "the registry a packaging run works against", and
 * every lane that packages skills must call it EXACTLY ONCE per run and pass the
 * result into each {@link packageSkill}. It crawls and parses the entire project
 * — on a large monorepo that is thousands of files and tens of seconds — so a
 * caller that lets `packageSkill` fall back to it per skill turns a fixed
 * project-sized cost into a per-skill one.
 *
 * It also carries the config, which decides collection membership: the packager
 * rewrites frontmatter URI-references per collection schema, mirroring the
 * validator. A registry built without config silently belongs to no collection,
 * so a lane that built its own config-less registry rewrote frontmatter
 * differently from the lane that used this one — which is why there is now only
 * one builder rather than two that happened to differ in one argument.
 *
 * ## Why the include set is markdown-only, unlike `crawlAndResolveRegistry`'s
 *
 * The difference is deliberate and is NOT a hole that leaves HTML unrewritten.
 * A bundled HTML file joins this registry later, on demand, via
 * {@link registerBundledAssets} — which parses it and resolves its links before
 * the copy step, so `rewriteHtmlLinks` reaches it. Crawling every `.html` under
 * the project up front would parse generated output the build never bundles,
 * and would move `page.md` vs `page.html` id collisions from the narrow
 * bundled-asset path onto the whole-project crawl.
 *
 * Widening this glob would NOT widen what the walker follows: routing is
 * markdown-only regardless — see `isRoutable` in `walk-link-graph.ts`.
 *
 * ## The optional population source, and why it cannot widen that glob
 *
 * `populationSource` replaces the ENUMERATION only. `ResourceRegistry.crawl`
 * re-applies this function's `include` — and the crawl's default `exclude` —
 * to whatever the source offers, through the same compiled matcher the walk
 * itself uses, so a source that enumerates a whole tree still yields exactly
 * the project's markdown here. That is what makes handing this builder a
 * projection a cost change rather than a scope change.
 *
 * Selecting the lane stays the CLI's job: this signature takes a source, never
 * an environment. A library caller that passes nothing keeps the walk.
 */
export async function createProjectRegistry(
  projectRoot: string,
  options: ProjectRegistryOptions,
): Promise<ResourceRegistry> {
  const config = await loadConfig(projectRoot);
  const registry = await ResourceRegistry.fromCrawl(
    {
      baseDir: projectRoot,
      include: [...LINK_GRAPH_MEMBER_GLOBS],
      // A build must not ship a shorter bundle: a directory this crawl cannot
      // list refuses the run by name — see `RegistryUnreadablePolicy`.
      unreadable: 'refuse',
      ...(options.populationSource !== undefined && { populationSource: options.populationSource }),
      outputs: options.outputs,
    },
    config === undefined ? undefined : { config },
  );
  registry.resolveLinks();
  return registry;
}

/**
 * Load frontmatter schemas for all configured collections, keyed by collection ID.
 *
 * Mirrors ResourceRegistry.validateAgainstCollectionSchema's loading flow so
 * the packager rewrites frontmatter URI-refs against the same schemas the
 * validator uses. Collections without a frontmatterSchema configured are
 * absent from the map.
 *
 * A schema that cannot be resolved, read or parsed is absent from the map too,
 * and that is REPORTED as a `FRONTMATTER_SCHEMA_ERROR` issue in the build's own
 * receipt — the same code `vat validate` gives the same config. It used to be
 * swallowed on the theory that "the validator will surface it elsewhere", which
 * left `vat build` shipping a bundle whose frontmatter URI-refs still pointed
 * at source-tree paths, with a clean report and nothing to say why.
 */
async function loadCollectionSchemas(
  config: ProjectConfig | undefined,
  baseDir: string,
): Promise<{ schemas: Map<string, object>; issues: ValidationIssue[] }> {
  const schemas = new Map<string, object>();
  const issues: ValidationIssue[] = [];
  const collections = config?.resources?.collections;
  if (!collections) return { schemas, issues };
  // Independent loads, each catching its own error; folded afterwards in collection order.
  const loaded = await Promise.all(Object.entries(collections).map(async ([collectionId, collectionConfig]) => {
    const schemaPath = collectionConfig.validation?.frontmatterSchema;
    if (schemaPath === undefined) return undefined;
    try {
      const resolvedPath = resolveAssetReference(schemaPath, baseDir);
      const content = await readFile(resolvedPath, 'utf-8');
      return { collectionId, schema: JSON.parse(content) as object };
    } catch (error) {
      return {
        issue: materializeIssue('FRONTMATTER_SCHEMA_ERROR', {
          location: schemaPath,
          message:
            `Collection "${collectionId}" declares frontmatterSchema "${schemaPath}", which could not ` +
            `be loaded: ${error instanceof Error ? error.message : String(error)}. Frontmatter ` +
            `URI-references in this collection were NOT rewritten for the packaged output.`,
        }),
      };
    }
  }));
  for (const entry of loaded) {
    if (entry === undefined) continue;
    if ('issue' in entry) issues.push(entry.issue);
    else schemas.set(entry.collectionId, entry.schema);
  }
  return { schemas, issues };
}

/**
 * Generate a synthetic resource ID for a non-markdown asset that collides with an
 * existing markdown resource. Uses the absolute asset path prefixed with `asset::`
 * to guarantee uniqueness — this id is used only for skill-packager internal
 * lookups (output registry + link rewriting), not for user-facing output.
 */
export function synthesizeAssetId(assetPath: string): string {
  return `asset::${toForwardSlash(safePath.resolve(assetPath))}`;
}

/**
 * Collect all resources whose links may need collided-asset resolution:
 * bundled markdown resources + the skill resource itself (if indexed).
 * Deduplicates in case the skill is also in bundledResources.
 */
function collectResourcesWithLinks(
  bundledResources: ResourceMetadata[],
  skillResource: ResourceMetadata | undefined,
): ResourceMetadata[] {
  if (skillResource === undefined || bundledResources.includes(skillResource)) {
    return bundledResources;
  }
  return [...bundledResources, skillResource];
}

/**
 * Register non-markdown bundled assets in the registry so their links get resolvedId.
 *
 * The registry only crawls *.md files by default. Non-markdown files (YAML, JSON, etc.)
 * discovered via link walking are not indexed, so links pointing to them won't have
 * `resolvedId` set. Link rewriting depends on `resolvedId` to look up the target resource
 * and compute the output `relativePath`. Without this, non-markdown links get stripped
 * to empty `()` parentheses.
 *
 * Collision handling: if an asset's generated id is already taken, `addResource`
 * throws. We catch this, skip source-registry indexing for the asset, and return
 * it so the caller can synthesize a unique ID for link rewriting.
 *
 * The clash is a **path-slug** one, not an extension one. This used to claim the
 * example was "paired `config.yaml` + `config.md`, both producing id
 * `resources-config`" — {@link generateIdFromPath} appends the extension, so
 * those are `config-yaml` and `config-md` and cannot collide. What does collide
 * is two paths that flatten to the same slug: `a-b/c.html` and `a/b-c.html` are
 * both `a-b-c-html`.
 *
 * @returns The colliding asset paths, and the collisions themselves. The caller
 *   must wire the paths up manually; the collisions are what let the
 *   verbatim-copy diagnostic name the file that actually won the id.
 */
async function registerBundledAssets(
  registry: ResourceRegistry,
  bundledAssets: string[],
  projectRoot: string,
): Promise<{ collidedAssets: string[]; collisions: DuplicateIdCollision[] }> {
  const collidedAssets: string[] = [];
  const collisions: DuplicateIdCollision[] = [];
  if (bundledAssets.length === 0) {
    return { collidedAssets, collisions };
  }
  // In order: `addResource` mutates the shared registry, and which asset collides depends on order.
  await forEachInOrder(bundledAssets, async (assetPath) => {
    try {
      // `addResource` parses the file, so it READS it — which makes this the first
      // place a build touches a linked asset, and the place an unreadable one
      // actually fails. It reported a bare `EACCES … open '/abs/path'` with no
      // skill named and no remedy: the same shape as the copiers, one step
      // earlier, and the step that fires first.
      await withFsFault(
        {
          side: 'source',
          origin: 'content',
          // The file is read to discover its links before anything is copied, so
          // naming the copy would point past the step that actually failed.
          action: `read linked file ${issueLocation(assetPath, projectRoot) || '.'} while collecting the files this skill links to`,
        },
        () => registry.addResource(assetPath),
      );
    } catch (error) {
      // `addResource` (singular) THROWS on a collision and — unlike
      // `addResources` — records nothing in the registry's collision log. So
      // this catch is the ONLY place a bundled-asset collision is ever
      // observable; drop the structured error here and the fact is gone.
      if (error instanceof DuplicateResourceIdError) {
        collidedAssets.push(assetPath);
        collisions.push({
          id: error.id,
          existingPath: error.existingPath,
          conflictingPath: error.conflictingPath,
        });
      } else {
        throw error;
      }
    }
  });
  registry.resolveLinks();
  return { collidedAssets, collisions };
}

/**
 * Manually set `resolvedId` on links pointing to collided assets.
 *
 * When a non-markdown asset collides with a markdown file (same stem, different
 * extension), it can't be indexed in the source registry. `resolveLinks()` won't
 * set `resolvedId` on links to these assets. We walk every bundled markdown
 * resource's links and assign a synthetic `resolvedId` to links whose target
 * path matches a collided asset.
 */
function resolveCollidedAssetLinks(
  resources: ResourceMetadata[],
  collidedAssets: string[],
): void {
  if (collidedAssets.length === 0) {
    return;
  }
  const collidedByPath = new Map<string, string>(
    collidedAssets.map(p => [safePath.resolve(p), synthesizeAssetId(p)]),
  );
  for (const resource of resources) {
    for (const link of resource.links) {
      if (link.type !== 'local_file' || link.resolvedId !== undefined) {
        continue;
      }
      const [hrefPath] = link.href.split('#');
      if (hrefPath === undefined) continue;
      const targetPath = safePath.resolve(dirname(resource.filePath), hrefPath);
      const syntheticId = collidedByPath.get(targetPath);
      if (syntheticId !== undefined) {
        link.resolvedId = syntheticId;
      }
    }
  }
}

/**
 * Add non-markdown bundled assets to the output registry so link rewriting can resolve them.
 *
 * Each asset's output path comes from `pathMap`. The source registry (populated by
 * `registerBundledAssets`) supplies the resource record for non-colliding assets.
 * For collided assets (ID clashes with a paired markdown file), we synthesize a
 * minimal resource record using the same synthetic ID set on links by
 * `resolveCollidedAssetLinks`. Assets already present in `outputResources` are skipped.
 */
function addBundledAssetsToOutputRegistry(
  outputResources: ResourceMetadata[],
  bundledAssets: string[],
  pathMap: Map<string, string>,
  registry: WalkableRegistry,
  collidedAssets: string[],
): void {
  const collidedSet = new Set(collidedAssets.map(p => toForwardSlash(p)));
  for (const assetPath of bundledAssets) {
    const outputFilePath = pathMap.get(toForwardSlash(assetPath));
    if (!outputFilePath) continue;
    if (outputResources.some(r => toForwardSlash(r.filePath) === toForwardSlash(outputFilePath))) {
      continue;
    }
    const sourceResource = registry.getResource(safePath.resolve(assetPath));
    if (sourceResource) {
      outputResources.push({
        ...sourceResource,
        filePath: outputFilePath,
      });
    } else if (collidedSet.has(toForwardSlash(assetPath))) {
      // Asset collided with a paired markdown file and isn't in the source registry.
      // Synthesize a minimal record — id matches what resolveCollidedAssetLinks set.
      outputResources.push(buildSyntheticAssetResource(assetPath, outputFilePath));
    }
  }
}

/**
 * Build a minimal ResourceMetadata record for a non-markdown asset that couldn't
 * be added to the source registry due to an ID collision with a paired markdown file.
 */
function buildSyntheticAssetResource(
  assetPath: string,
  outputFilePath: string,
): ResourceMetadata {
  return {
    id: synthesizeAssetId(assetPath),
    filePath: outputFilePath,
    links: [],
    headings: [],
    sizeBytes: 0,
    estimatedTokenCount: 0,
    modifiedAt: new Date(0),
    // Synthetic asset; no real content hash. Use all-zeros to satisfy the SHA256 brand.
    checksum: '0'.repeat(64) as ResourceMetadata['checksum'],
  };
}

/**
 * Re-point every LINK-BUNDLED file a GLOB `files:` entry also claims at the dest
 * that entry declares.
 *
 * A glob's expansion is late-bound to copy time, so its matches used to be absent
 * from the path map entirely — and a match that link traversal ALSO discovered was
 * therefore parked at its type-derived location (`resources/GUIDE.md`) while
 * `applyFilesConfig` copied the same bytes to the declared dest
 * (`packs/alpha/GUIDE.md`). Two identical files shipped, the rewritten link pointed
 * at traversal's copy, the declared `dest:` was dead, and nothing said so — a size
 * regression for anyone shipping multi-megabyte artifacts, and a `dest:` that lies
 * whenever the same file is also referenced from prose.
 *
 * Only files already in `bundledFiles` are considered: this is not a second
 * expansion of the glob (that stays with {@link copyGlobEntry}), it is the path map
 * — the authority on where a file ends up — learning what the config already said.
 */
function applyGlobEntryToPathMap(
  entry: SkillFileEntry,
  projectRoot: string,
  outputPath: string,
  pathMap: Map<string, string>,
  bundledFiles: string[],
): void {
  for (const bundled of bundledFiles) {
    const dest = globEntryDest(entry, projectRoot, bundled);
    if (dest === undefined) continue;
    // joinUnderRoot mirrors the non-glob branch's zip-slip guard below.
    pathMap.set(toForwardSlash(bundled), safePath.joinUnderRoot(outputPath, dest));
  }
}

/**
 * Register `files:` config entries in the path map.
 *
 * Two passes, GLOBS FIRST, and the order is the precedence rule: an explicit entry
 * naming a file outranks a glob that merely caught it, exactly as it does on the
 * copy side (see `partitionNeverPackaged` — a glob is a net, not a declaration).
 * Applying globs second would let one silently overwrite the dest an author spelled
 * out, and the explicit entry's own copy is then skipped as "already bundled at its
 * dest" — so the declared file would never be written at all.
 *
 * Called from step 8b of packageSkill to keep the main function under the
 * cognitive-complexity limit.
 */
function applyFilesEntriesToPathMap(
  filesConfig: SkillFileEntry[],
  projectRoot: string,
  outputPath: string,
  pathMap: Map<string, string>,
  skillName: string,
  bundledFiles: string[],
): void {
  for (const fileEntry of filesConfig) {
    if (isGlob(fileEntry.source)) {
      applyGlobEntryToPathMap(fileEntry, projectRoot, outputPath, pathMap, bundledFiles);
    }
  }

  for (const fileEntry of filesConfig) {
    // A glob source contains magic, never exists as a literal path, and would
    // wrongly throw the existence check below; its dests were handled above.
    if (isGlob(fileEntry.source)) continue;

    const absoluteSource = safePath.resolve(safePath.join(projectRoot, fileEntry.source));
    // joinUnderRoot guards against a dest escaping the output dir (zip-slip class),
    // defense-in-depth beyond the schema refine on SkillFileEntry.dest.
    const absoluteDest = safePath.joinUnderRoot(outputPath, fileEntry.dest);

    // Validate source exists at build time.
    //
    // `statSync` in a guard, not `existsSync`: `existsSync` swallows EACCES and
    // answers FALSE, so a source the process cannot REACH — one under a directory
    // it may not traverse — was reported as "does not exist", and for a `dist/`
    // path `buildArtifactHint` then told the author to run a build that would not
    // have helped. A wrong diagnosis with a confident wrong remedy attached.
    // Only ENOENT is absence; a refusal is reported as itself, naming the entry.
    try {
      statSync(absoluteSource);
    } catch (error) {
      if (!isPathAbsentError(error)) {
        throw classifyFsFault(error, { side: 'source', origin: 'content', action: `read files entry for skill '${skillName}': source '${fileEntry.source}'` });
      }
      throw packagingInputError(
        `files entry for skill '${skillName}': source '${fileEntry.source}' does not exist.${buildArtifactHint(fileEntry.source)}`,
      );
    }

    // If this source was auto-discovered, override its destination; otherwise add it
    pathMap.set(toForwardSlash(absoluteSource), absoluteDest);
  }
}

/**
 * Register `files:` deferred-dest links so the build preserves and rewrites them.
 *
 * A deferred dest (e.g. `dist/bin/cli.mjs → scripts/cli.mjs`) does not exist at
 * source-walk time, so it is neither a bundled resource nor a bundled asset: its
 * link gets no `resolvedId` and the dest is absent from the output registry. The
 * bundled-link template then renders an empty `relativePath` and strips the href
 * to `()` — leaving the shipped artifact unreferenced (`PACKAGED_UNREFERENCED_FILE`).
 *
 * This mirrors the collided-asset handling: for each `files:` entry we synthesize
 * a stable id (`synthesizeAssetId(absDestTarget)`), stamp it as `resolvedId` on
 * any local_file link that resolves to the dest, and return a synthetic output
 * resource (`buildSyntheticAssetResource`) whose `filePath` is the dest's output
 * path so the output registry computes `relativePath = entry.dest`.
 *
 * For GLOB entries, the dest is a DIRECTORY. We scan each unresolved local_file
 * link across all resources; any link whose resolved target T falls under the dest
 * dir gets an individual synthetic resource stamped per-file (see registerGlobDestLinks).
 *
 * Scope: dest links only. A SKILL.md link to a deferred *source* path that is
 * copied to a different dest is an exotic case with ambiguous output mapping and
 * is intentionally left to its existing behavior.
 *
 * @returns Synthetic output resources to push into `outputResources` (deduped by
 *   filePath against the existing set) BEFORE the output registry is built.
 */
function registerDeferredDestLinks(
  filesConfig: SkillFileEntry[],
  resources: ResourceMetadata[],
  skillPath: string,
  outputPath: string,
  existingOutputResources: ResourceMetadata[],
): ResourceMetadata[] {
  const syntheticResources: ResourceMetadata[] = [];
  const skillDir = dirname(skillPath);
  for (const entry of filesConfig) {
    if (isGlob(entry.source)) {
      // Glob entry: dest is a directory. Synthesize per-linked-file.
      registerGlobDestLinks(entry, resources, skillDir, outputPath, existingOutputResources, syntheticResources);
    } else {
      // Single-file entry: UNCHANGED — exact dest match (resolved against skillDir).
      const absDestTarget = safePath.resolve(skillDir, entry.dest);
      // joinUnderRoot keeps the synthesized output path inside the skill output dir.
      const absDestOutput = safePath.joinUnderRoot(outputPath, entry.dest);
      const id = synthesizeAssetId(absDestTarget);

      if (!stampDeferredDestResolvedId(resources, absDestTarget, id)) continue;

      // Dedup: skip if an output resource already targets this dest output path.
      const alreadyPresent =
        existingOutputResources.some(r => toForwardSlash(r.filePath) === toForwardSlash(absDestOutput)) ||
        syntheticResources.some(r => toForwardSlash(r.filePath) === toForwardSlash(absDestOutput));
      if (alreadyPresent) continue;

      // buildSyntheticAssetResource derives the id via synthesizeAssetId(absDestTarget),
      // matching the resolvedId stamped above.
      syntheticResources.push(buildSyntheticAssetResource(absDestTarget, absDestOutput));
    }
  }
  return syntheticResources;
}

/**
 * For a GLOB files entry whose dest is a DIRECTORY, walk every unresolved
 * local_file link across `resources`. If a link's resolved target T falls under
 * the entry's dest dir, synthesize a per-file entry: stamp `resolvedId` on the
 * link and push a synthetic output resource so the output registry can compute
 * `relativePath = skillDir-relative(T)`.
 *
 * Prefix test (T is "under" absDestDir):
 *   T === absDestDir  OR  toForwardSlash(T).startsWith(toForwardSlash(absDestDir) + '/')
 */
interface GlobDestLinkContext {
  absDestDir: string;
  absDestDirFwd: string;
  skillDir: string;
  outputPath: string;
  existingOutputResources: ResourceMetadata[];
  syntheticResources: ResourceMetadata[];
}

function registerGlobDestLinks(
  entry: SkillFileEntry,
  resources: ResourceMetadata[],
  skillDir: string,
  outputPath: string,
  existingOutputResources: ResourceMetadata[],
  syntheticResources: ResourceMetadata[],
): void {
  const absDestDir = safePath.resolve(skillDir, entry.dest);
  const ctx: GlobDestLinkContext = {
    absDestDir,
    absDestDirFwd: toForwardSlash(absDestDir),
    skillDir,
    outputPath,
    existingOutputResources,
    syntheticResources,
  };

  for (const resource of resources) {
    for (const link of resource.links) {
      synthesizeGlobLinkResource(link, resource.filePath, ctx);
    }
  }
}

/**
 * Attempt to synthesize a glob-dest output resource for a single link.
 *
 * Stamps `link.resolvedId` and pushes a synthetic resource if the link target
 * falls under the glob entry's dest dir and has not been synthesized yet.
 * No-ops for already-resolved links, non-local-file links, and links outside
 * the dest dir.
 */
function synthesizeGlobLinkResource(
  link: ResourceMetadata['links'][number],
  resourceFilePath: string,
  ctx: GlobDestLinkContext,
): void {
  if (link.type !== 'local_file' || link.resolvedId !== undefined) return;

  const [hrefPath] = link.href.split('#');
  if (hrefPath === undefined) return;

  const T = safePath.resolve(dirname(resourceFilePath), hrefPath);
  const Tfwd = toForwardSlash(T);

  // Prefix test: T must be equal to or under absDestDir
  if (T !== ctx.absDestDir && !Tfwd.startsWith(ctx.absDestDirFwd + '/')) return;

  // Stamp resolvedId per-linked-file
  link.resolvedId = synthesizeAssetId(T);

  // absDestOutput: preserve T's path relative to skillDir under outputPath.
  // joinUnderRoot keeps it inside the output dir (T is verified under absDestDir,
  // itself under skillDir once the dest schema rejects '..'/absolute).
  const absDestOutput = safePath.joinUnderRoot(ctx.outputPath, safePath.relative(ctx.skillDir, T));

  // Dedup against existing + already-synthesized
  const alreadyPresent =
    ctx.existingOutputResources.some(r => toForwardSlash(r.filePath) === toForwardSlash(absDestOutput)) ||
    ctx.syntheticResources.some(r => toForwardSlash(r.filePath) === toForwardSlash(absDestOutput));
  if (!alreadyPresent) {
    ctx.syntheticResources.push(buildSyntheticAssetResource(T, absDestOutput));
  }
}

/**
 * Stamp `resolvedId` on every unresolved local_file link that resolves to the
 * deferred dest target. Mirrors the link-walk in `resolveCollidedAssetLinks`.
 *
 * @returns true if at least one link was stamped (the dest is referenced).
 */
function stampDeferredDestResolvedId(
  resources: ResourceMetadata[],
  absDestTarget: string,
  id: string,
): boolean {
  let linked = false;
  for (const resource of resources) {
    for (const link of resource.links) {
      if (link.type !== 'local_file' || link.resolvedId !== undefined) {
        continue;
      }
      const [hrefPath] = link.href.split('#');
      if (hrefPath === undefined) continue;
      if (safePath.resolve(dirname(resource.filePath), hrefPath) === absDestTarget) {
        link.resolvedId = id;
        linked = true;
      }
    }
  }
  return linked;
}

// ============================================================================
// Path Map Building
// ============================================================================

/**
 * The skill a path map is being built for: where it lives, and what it is called.
 *
 * Both, in one parameter, because the two answer different questions and the
 * function needs both: the PATH is the map's key (an identity, kept absolute),
 * while the NAME is what a failure REPORTS (an identifier, safe to publish —
 * `vat skills build` publishes packaging findings verbatim on stdout, where an
 * absolute path would name the machine that ran the build).
 */
interface PathMapSkill {
  path: string;
  name: string;
}

/**
 * The FILENAME_COLLISION finding for one pair of sources that package to one dest.
 *
 * Naming the skill is the whole point of the first line: neither colliding file
 * need be referenced by SKILL.md directly (both are commonly reached by deep
 * link traversal), so without it the only way to find the owner in a large
 * batch is to bisect it one skill at a time.
 *
 * By NAME, not by absolute path: this message is published verbatim in
 * `vat skills build`'s stdout payload, the name is what that payload's per-skill
 * rows already key on, and a `/Users/<someone>/…` prefix answers no question the
 * reader has while naming the machine the build ran on. The colliding files
 * follow the same rule — stated in the project's coordinates, like every other
 * "where" this package renders (`issueLocation`).
 *
 * `location` is the SECOND file: of the two, it is the one whose packaging the
 * first pre-empted, so it is the one an author renames. The remedy that is not
 * a rename (switch `resourceNaming`) comes from the registry `fix`.
 */
function filenameCollisionIssue(
  skill: PathMapSkill,
  existingSource: string,
  linkedFile: string,
  targetRelPath: string,
  resourceNaming: ResourceNamingStrategy,
  namingBasePath: string,
): ValidationIssue {
  const location = issueLocation(linkedFile, namingBasePath);
  return materializeIssue('FILENAME_COLLISION', {
    location,
    message:
      `Filename collision detected when packaging skill: ${skill.name} — ` +
      `File 1: ${issueLocation(existingSource, namingBasePath)}, ` +
      `File 2: ${location}; both would be packaged as ${targetRelPath} ` +
      `(current resourceNaming strategy: ${resourceNaming})`,
  });
}

/**
 * Build a map of source paths (forward-slash normalized) to output paths, plus
 * a FILENAME_COLLISION finding for every pair of sources that land on one dest.
 *
 * A collision is REPORTED, not thrown. It used to throw a raw `Error`, which
 * escaped the contract every other packaging finding honours — the caller got a
 * bare string instead of a coded, located, fixable `ValidationIssue`, and the
 * batch lane had to special-case it. The build still fails: the finding's
 * registry severity is `error`, so it flips `hasErrors`.
 *
 * The colliding source keeps its path-map entry rather than being dropped. The
 * build is failing either way, and keeping it means the link rewriter still
 * resolves both links to a file that exists in the output — dropping it would
 * add a second, derived PACKAGED_BROKEN_LINK on top of the real finding and
 * point the surviving link at an unrewritable source path.
 *
 * @param namingBasePath - The project root. Resource names are generated
 *   relative to it AND every path this function REPORTS is stated in its
 *   coordinates, so no message leaves here in machine-specific terms.
 */
function buildPathMap(
  skill: PathMapSkill,
  bundledFiles: string[],
  outputPath: string,
  resourceNaming: ResourceNamingStrategy,
  namingBasePath: string,
  stripPrefix?: string,
  target: PackagingTarget = DEFAULT_PACKAGING_TARGET,
): Map<string, string> {
  const pathMap = new Map<string, string>();
  pathMap.set(toForwardSlash(skill.path), safePath.join(outputPath, 'SKILL.md'));

  for (const linkedFile of bundledFiles) {
    const targetRelPath = generateTargetPath(
      linkedFile,
      namingBasePath,
      resourceNaming,
      stripPrefix
    );
    const fileSubdir = getResourceSubdirForFile(linkedFile, target);
    pathMap.set(toForwardSlash(linkedFile), safePath.join(outputPath, fileSubdir, targetRelPath));
  }

  return pathMap;
}

/**
 * Report a FILENAME_COLLISION for every destination claimed by more than one source.
 *
 * MUST run against the FINAL destination map — after `files:` single-file entries
 * have overridden the naming-strategy destinations. Detecting collisions while
 * building the map (where this logic used to live) answers the question one step
 * too early: `files:` is a legitimate remedy for a basename collision, and an
 * adopter who remapped both sides to distinct dests still had the build failed at
 * `error` severity for a collision that no longer physically occurred. It also
 * could not see the inverse — two `files:` entries pointing at ONE dest is a real
 * collision the naming-strategy map contains no trace of.
 *
 * Scope: glob `files:` entries expand later (`applyFilesConfig`) and so are not in
 * this map; their destinations are directories, which cannot collide this way.
 */
function detectDestinationCollisions(
  skill: PathMapSkill,
  pathMap: Map<string, string>,
  outputPath: string,
  resourceNaming: ResourceNamingStrategy,
  namingBasePath: string,
): ValidationIssue[] {
  const sourcesByDest = new Map<string, string[]>();
  for (const [source, dest] of pathMap) {
    const existing = sourcesByDest.get(dest);
    if (existing) existing.push(source);
    else sourcesByDest.set(dest, [source]);
  }

  const issues: ValidationIssue[] = [];
  for (const [dest, sources] of sourcesByDest) {
    // Map iteration is insertion-ordered, so sources[0] is the entry that "won"
    // the destination — the same File 1 / File 2 framing the message always used.
    const [winner, ...losers] = sources;
    if (winner === undefined || losers.length === 0) continue;
    const targetRelPath = toForwardSlash(safePath.relative(outputPath, dest));
    for (const loser of losers) {
      issues.push(filenameCollisionIssue(
        skill, winner, loser, targetRelPath, resourceNaming, namingBasePath,
      ));
    }
  }
  return issues;
}

// ============================================================================
// Rewrite Rules
// ============================================================================

/**
 * Build unified link rewrite rules for transformContent().
 *
 * Rules are ordered for first-match-wins semantics:
 * 1. Per-pattern excludes: local_file links matching specific patterns → custom template
 * 2. Bundled links: local_file links minus excluded IDs → rewrite to output path
 * 3. Catch-all excludes: remaining local_file links (depth-exceeded, navigation) → strip
 *
 * Per-pattern excludes run first so that terminal links to non-markdown assets
 * (YAML, JSON, images) match against the link's href via `matchesPattern`'s
 * href fallback — such links have no resolvedId and would otherwise be caught
 * by the bundled-link rule and rendered with an undefined `link.resource.*`.
 *
 * External, anchor, and email links match no rule and are left untouched.
 */
function buildRewriteRules(
  excludedIds: string[],
  excludeRules: Array<{ patterns: string[]; template?: string | undefined }>,
  defaultExcludeTemplate: string | undefined,
): LinkRewriteRule[] {
  const rules: LinkRewriteRule[] = [];
  const stripTemplate = defaultExcludeTemplate ?? DEFAULT_STRIP_TEMPLATE;
  // Both spellings of a local target. A link to a directory is `local_directory`
  // when the href ends in `/` and `local_file` when it does not; neither has a
  // packaged counterpart, and leaving the slash form out of every rule is what let
  // it survive rewrite verbatim and then fail the build as a broken packaged link.
  const LOCAL_TYPES = ['local_file', 'local_directory'] as const;

  // Rules 1+: Per-pattern exclude rules (if any)
  for (const rule of excludeRules) {
    rules.push({
      match: { type: [...LOCAL_TYPES], pattern: rule.patterns },
      template: rule.template ?? stripTemplate,
    });
  }

  // Rule N: Bundled links — match local targets, skip excluded IDs.
  // Using {{link.rawText}} instead of {{link.text}} preserves inline formatting
  // the author wrote in the link text (backticks, emphasis, etc.), so a source
  // link like [`foo.yaml`](…) still reads as [`foo.yaml`](new/path) after rewrite.
  // Targets with no packaged location strip instead — see bundledLinkTemplate.
  rules.push({
    match: {
      type: [...LOCAL_TYPES],
      ...(excludedIds.length > 0 ? { excludeResourceIds: excludedIds } : {}),
    },
    template: bundledLinkTemplate(stripTemplate),
  });

  // Final catch-all: local links excluded BY ID, which the rule above skips.
  if (excludedIds.length > 0) {
    rules.push({
      match: { type: [...LOCAL_TYPES] },
      template: stripTemplate,
    });
  }

  return rules;
}


// ============================================================================
// File Copy + Rewrite
// ============================================================================

/** Shared context for copying and rewriting files during packaging */
interface CopyRewriteContext {
  pathMap: Map<string, string>;
  rewriteLinks: boolean;
  fromRegistry: WalkableRegistry;
  /**
   * Files the source registry DROPPED on a first-added-wins id collision:
   * forward-slash path of the loser → absolute path of the winner.
   *
   * Passed in rather than read off `fromRegistry`, which is deliberately the
   * narrow {@link WalkableRegistry}. It exists so the verbatim-copy diagnostic
   * can state an OBSERVED cause instead of guessing one.
   */
  duplicateIdDrops: ReadonlyMap<string, string>;
  toRegistry: ResourceRegistry;
  rewriteRules: LinkRewriteRule[];
  templateContext?: Record<string, unknown>;
  /** Per-collection frontmatter JSON Schemas, keyed by collection ID. Drives Gap 3 frontmatter URI-ref rewriting. */
  collectionSchemas: Map<string, object>;
  /** Absolute path to the project root — required for RFC 3986 §4.2 leading-`/` href resolution in frontmatter. */
  projectRoot: string;
  /** Sink for non-fatal copy/rewrite diagnostics (verbatim copies, un-appliable rewrites). */
  warn: (message: string) => void;
}

/**
 * Copy SKILL.md and all linked files to the output directory,
 * rewriting links using transformContent().
 */
async function copyAndRewriteFiles(
  skillPath: string,
  bundledFiles: string[],
  ctx: CopyRewriteContext,
): Promise<void> {
  // Copy SKILL.md
  const skillTargetPath = ctx.pathMap.get(toForwardSlash(skillPath));
  if (skillTargetPath) {
    await copyAndRewriteFile(skillPath, skillTargetPath, ctx, 'entry file');
  }

  // Copy all linked files, in order: bundle writes, where the first failure stops the build.
  await forEachInOrder(bundledFiles, async (linkedFile) => {
    const targetPath = ctx.pathMap.get(toForwardSlash(linkedFile));
    if (targetPath === undefined) {
      return;
    }

    await copyAndRewriteFile(linkedFile, targetPath, ctx, 'linked file');
  });
}

/**
 * Copy a single file, optionally rewriting markdown links using transformContent().
 *
 * For markdown files with rewriteLinks enabled:
 * 1. Reads the source file
 * 2. Finds the corresponding resource in the "from" registry
 * 3. Calls transformContent() with the resource's links, unified rules, and "to" registry
 * 4. Writes the result
 *
 * All link rewriting (bundled, excluded, inline, reference-style definitions)
 * is handled by a single transformContent() call with ordered rules.
 *
 * For non-markdown files, performs a plain binary copy.
 */
/**
 * Re-base a resource's link spans onto the frontmatter-stripped body.
 *
 * ## 🚨 Why this exists: the span rewrite was INERT here, and could mis-splice
 *
 * `transformContent` identifies each link by its parsed `[startOffset,
 * endOffset)` span rather than by replaying a regex and correlating on href —
 * which is the whole point, because the two grammars disagree about what the
 * href IS. Its docstring states the precondition outright: *links must come from
 * the same bytes as content*.
 *
 * This call site violated it. `resource.links` are parsed from the WHOLE FILE,
 * and `editor.body` has the frontmatter block removed — so every offset was off
 * by the frontmatter's length. Measured on a four-line skill: span `[45, 77)`
 * against a body shifted by 40, where `body.slice(45, 81)` is `"ails.\n"`. Every
 * splice declined and every link fell back to the pre-fix regex path, so the
 * headline defect (`[![alt](img)](url)` silently not rewritten) was still
 * shipping. Worse, a stale span can land on a *different*, structurally valid
 * link and rewrite ITS href to the first link's target.
 *
 * ## The re-base is VERIFIED, not assumed
 *
 * Subtracting `content.length - body.length` is correct if and only if `body` is
 * a literal SUFFIX of `content` — that is exactly the statement "every body index
 * `i` is content index `i + offset`". `String.endsWith` decides it outright, so
 * the arithmetic is checked rather than argued, and a body that is not a suffix
 * comes back with its spans REMOVED instead of with coordinates nothing verified.
 * `openFrontmatter` does yield a suffix today, across CRLF, a commented block, an
 * absent block and empty input; the check is what keeps that a fact rather than a
 * comment that outlives the code it describes.
 *
 * ⛔ **This used to claim `splicableFrom` as its backstop, and that claim was
 * false.** The words were: "`splicableFrom` refuses any span whose destination is
 * not exactly the parser's href, so a misalignment that survives this degrades to
 * *no rewrite* rather than to a wrong one." It does not. That comparison is keyed
 * on the HREF, which two links in one document routinely share, so a stale span
 * landing on a same-href neighbour passes it and the neighbour is rewritten
 * through the first link's metadata. Constructed and pinned in
 * `packages/resources/test/content-transform.test.ts` › *two links sharing an
 * href defeat the destination comparison*, where a tuned frontmatter length makes
 * two labels swap places. A mitigation keyed on a value the two candidates have
 * in common cannot be a guarantee, and a guard resting on one is resting on
 * nothing.
 *
 * 🔑 What holds instead, in full, because the precondition has two halves:
 *
 * 1. *The spans address `content`* — discharged by the reader, not by this
 *    function. `resource.links` and `content` must come from the same decode of
 *    the same file, which is why the caller's read is pinned to
 *    `readTextContent` with a 🚨 of its own. A second reader is the one way this
 *    half fails, and it fails invisibly.
 * 2. *The subtraction maps `content` onto `body`* — discharged here, by
 *    `endsWith`.
 *
 * `splicableFrom`'s destination check remains a useful mitigation for the
 * residue. It is not counted on, and nothing here degrades gracefully because of
 * it.
 *
 * @param content - The file as read, which the links were parsed from
 * @param body - The frontmatter-stripped body the rewrite will run over
 * @param links - The resource's links, carrying whole-file offsets
 * @param onUnverifiable - Called when `body` is not a suffix of `content`, so the
 *   caller can say which file lost its span-driven rewrite. Never called on the
 *   normal path.
 * @returns The same links with offsets stated against `body`, or with no offsets
 *   at all when the re-base could not be verified
 */
export function bodyRelativeLinks(
  content: string,
  body: string,
  links: readonly ResourceLink[],
  onUnverifiable: () => void,
): ResourceLink[] {
  if (!content.endsWith(body)) {
    onUnverifiable();
    return links.map(withoutSpan);
  }
  const offset = content.length - body.length;
  if (offset === 0) return [...links];
  return links.map((link) => ({
    ...link,
    ...(link.startOffset === undefined ? {} : { startOffset: link.startOffset - offset }),
    ...(link.endOffset === undefined ? {} : { endOffset: link.endOffset - offset }),
  }));
}

/**
 * The link with its coordinates dropped and everything else kept.
 *
 * ⚠️ Dropping them is the point, and returning the link unchanged would be the
 * bug: an unrebased whole-file span still ADDRESSES the body's bytes, just the
 * wrong ones, so `splicableFrom` would happily splice at it. Without a span the
 * link is `UNRECOGNISED`, which routes it to the pre-span regex replay — the
 * behaviour this call site had before spans existed. A documented degrade, not a
 * silent one; the caller warns.
 *
 * @param link - A link whose offsets could not be re-based
 * @returns The same link with no `startOffset` and no `endOffset` key
 */
function withoutSpan(link: ResourceLink): ResourceLink {
  const stripped = { ...link };
  delete stripped.startOffset;
  delete stripped.endOffset;
  return stripped;
}

async function copyAndRewriteFile(
  sourcePath: string,
  targetPath: string,
  ctx: CopyRewriteContext,
  role: 'entry file' | 'linked file',
): Promise<void> {
  // Through the SAME attribution point as the `files:` lanes. This is the default
  // path for every ordinary markdown-linked file in a build — the most-travelled
  // copier in the packager — and it was the last one still letting a raw errno be
  // the build's whole explanation: `EACCES: permission denied, open '/abs/path'`,
  // with no skill named and no remedy. Easy to believe it was covered because the
  // `files:` fix landed in this same file; it is a different function.
  // `role` names what the file IS to the skill: calling the entry SKILL.md a
  // "linked file" sends the author looking for a link that does not exist.
  const subject = `${role} ${issueLocation(sourcePath, ctx.projectRoot) || '.'}`;

  const lower = sourcePath.toLowerCase();
  const isMarkdown = lower.endsWith('.md');
  const isHtml = lower.endsWith('.html') || lower.endsWith('.htm');

  // Non-rewritable files or rewriting disabled: plain binary copy
  if ((!isMarkdown && !isHtml) || !ctx.rewriteLinks) {
    await copyIntoBundle(subject, sourcePath, targetPath);
    return;
  }

  // Read source file.
  //
  // 🚨 `readTextContent`, never `readFile(path, 'utf-8')` — and here the reason
  // is sharper than the general one `link-parser.ts:149` gives. THE LINKS WERE
  // PARSED FROM THIS FILE BY THAT READER, and `bodyRelativeLinks` below
  // re-bases their offsets by differencing two string lengths. Two different
  // readers make that subtraction meaningless: `readTextContent` strips a BOM
  // and decodes UTF-16/32, so on a BOM-bearing file `readFile` returned a
  // string one character longer, `OPENING_FENCE` (`/^---\r?\n/`) then failed to
  // match, `openFrontmatter` reported no frontmatter, the offset came out 0,
  // and every span stayed whole-file — silently reverting the fix this call
  // site exists to deliver.
  //
  // ⛔ This comment used to add "it failed CLOSED rather than corrupting, only
  // because `splicableFrom` compares the destination to the href." That is not
  // a guarantee and must not be read as one: the destination check is keyed on
  // the href, which two links in one document routinely share, so a stale span
  // landing on a same-href neighbour passes it (constructed in
  // `content-transform.test.ts` › *two links sharing an href defeat the
  // destination comparison*). The BOM shift also survives
  // `bodyRelativeLinks`'s own `endsWith` check, because a body equal to the
  // content IS a suffix of it — nothing downstream can see that the links came
  // from a different decode. **One reader is the only thing standing between
  // this lane and a wrong rewrite.** Do not swap it.
  //
  // It also stops a UTF-16 source being written back as mojibake, which the
  // `utf-8` read did on the copy as well as the rewrite.
  // Not "copy": the read is the step that failed, and this lane reads before
  // it rewrites, so naming the copy would point past the actual failure.
  const { text: content } = await withFsFault(
    { side: 'source', origin: 'content', action: `read ${subject} for link rewriting` },
    () => readTextContent(sourcePath),
  );
  // Never "copy": the bytes are rewritten first. The bundle's layout is the skill's own,
  // so a shape fault on the write is the skill's (`shapeFromSource`); a full disk is not.
  const writeIntoBundle = (text: string): Promise<void> => withFsFault(
    { side: 'destination', shapeFromSource: true, action: `write ${subject} into the bundle` },
    async () => {
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(targetPath, text, 'utf-8');
    },
  );

  // Look up the resource in the "from" registry
  const resource = ctx.fromRegistry.getResource(safePath.resolve(sourcePath));

  if (!resource) {
    // Resource not in registry — write content as-is, links unrewritten.
    //
    // The cause used to be guessed from the basename ("typically an ID
    // collision with a same-named markdown file"), which is a plausible
    // hypothesis this function had no way to check, and which named no file the
    // author could go look at. The collision is now looked up, so the message
    // either names the winning file as an observed fact or says nothing about
    // cause at all.
    const winner = ctx.duplicateIdDrops.get(toForwardSlash(sourcePath));
    ctx.warn(
      winner === undefined
        ? `Copied '${sourcePath}' verbatim without link rewriting: it is not in the resource registry. ` +
            `Source-relative links inside it are not rewritten.`
        : `Copied '${sourcePath}' verbatim without link rewriting: it lost a resource-id collision to ` +
            `'${winner}', which was registered first and holds the id. Source-relative links inside it are not rewritten.`,
    );
    await writeIntoBundle(content);
    return;
  }

  // HTML: offset-splice link rewrite (no frontmatter, no template body rewrite).
  if (isHtml) {
    const rewriteHref = buildHrefRewriter(
      ctx.fromRegistry,
      ctx.toRegistry,
      sourcePath,
      targetPath,
      ctx.projectRoot,
    );
    const rewritten = rewriteHtmlLinks(content, rewriteHref, (info) => {
      ctx.warn(
        `Could not rewrite <${info.tagName} ${info.attr}="${info.from}"> in '${sourcePath}' (${info.reason}); ` +
          `the original value was kept.`,
      );
    });
    await writeIntoBundle(rewritten);
    return;
  }

  // Parse once via FrontmatterEditor so comments survive any frontmatter
  // rewrites. The body is held verbatim; we run it through transformContent
  // for the existing rule/template body-link rewrite contract (unchanged).
  const editor = openFrontmatter(content);

  // Body rewrite (existing behavior, unchanged contract).
  const rebased = bodyRelativeLinks(content, editor.body, resource.links, () => {
    ctx.warn(
      `Rewrote links in '${sourcePath}' without parsed spans: the frontmatter-stripped body is not a ` +
        `suffix of the file as read, so the offsets the parser reported cannot be moved onto it. ` +
        `Links are matched by href instead, which is the pre-span behaviour — a link the two grammars ` +
        `disagree about (an image inside a link, most often) may go unrewritten.`,
    );
  });
  editor.body = transformContent(editor.body, rebased, {
    linkRewriteRules: ctx.rewriteRules,
    resourceRegistry: ctx.toRegistry,
    sourceFilePath: targetPath, // Output path so relativePath is computed from output location
    ...(ctx.templateContext === undefined ? {} : { context: ctx.templateContext }),
  });

  // Frontmatter URI-ref rewrite (Gap 3) — parity with body. Apply every
  // collection schema that matches this resource. The rewrite policy reuses
  // the same path-map lookups that body rewriting consumes, so frontmatter
  // and body agree on target paths.
  const matchingCollections = (resource.collections ?? []).filter(
    (id) => ctx.collectionSchemas.has(id),
  );
  if (matchingCollections.length > 0) {
    const rewriteHref = buildHrefRewriter(
      ctx.fromRegistry,
      ctx.toRegistry,
      sourcePath,
      targetPath,
      ctx.projectRoot,
    );
    for (const collectionId of matchingCollections) {
      const schema = ctx.collectionSchemas.get(collectionId);
      if (schema) {
        rewriteFrontmatterUriReferencesFromSchema(editor, schema, rewriteHref);
      }
    }
  }

  await writeIntoBundle(editor.toString());
}

/**
 * Build the per-href rewrite callback used for frontmatter URI-refs and HTML attributes.
 *
 * Mirrors the body-rewrite path so frontmatter and body link rewriting agree
 * on target paths:
 *   1. Resolve the href against `sourcePath` (RFC 3986 — leading `/` =
 *      project-root-relative; bare relative = source-dir-relative).
 *   2. Look up the resolved file in the `fromRegistry` by absolute path.
 *   3. If found, look up its output entry in `toRegistry` by ID and return
 *      a path relative to the OUTPUT file location (`dirname(targetPath)`),
 *      preserving any anchor fragment from the original href.
 *   4. Anchor-only, unresolved-absolute, or unknown hrefs pass through
 *      unchanged.
 *
 * Returns the original href when no rewrite applies.
 */
function buildHrefRewriter(
  fromRegistry: WalkableRegistry,
  toRegistry: ResourceRegistry,
  sourcePath: string,
  targetPath: string,
  projectRoot: string,
): (href: string) => string {
  const targetDir = dirname(targetPath);
  return (href) => {
    const resolution = resolveLocalHref(href, sourcePath, projectRoot);
    if (resolution.kind !== 'resolved') {
      // anchor_only | absolute_no_root | absolute_escapes_root — leave unchanged.
      return href;
    }
    const fromResource = fromRegistry.getResource(resolution.resolvedPath);
    if (!fromResource) {
      return href;
    }
    const toResource = toRegistry.getResourceById(fromResource.id);
    if (!toResource) {
      return href;
    }
    const relative = toForwardSlash(safePath.relative(targetDir, toResource.filePath));
    return resolution.anchor === undefined ? relative : `${relative}#${resolution.anchor}`;
  };
}


// ============================================================================
// Post-Build Integrity Checks
// ============================================================================

/**
 * Verify no SKILL.md files exist in subdirectories of the skill output.
 *
 * A SKILL.md is a skill definition marker — it declares the existence and identity
 * of a skill. If another skill's SKILL.md is bundled as a resource, it creates
 * duplicate skill definitions that cause:
 * - Marketplace sync rejection ("Duplicate skill name")
 * - Consumers discovering phantom skills in subdirectories
 *
 * This should never happen because the link graph walker excludes SKILL.md targets,
 * but this check acts as a safety net in case files are introduced through other means.
 */
function validateNoNestedSkillMd(outputPath: string, skillName: string): void {
  const entries = readdirSync(outputPath, { recursive: true, withFileTypes: true });
  const nestedSkillMds = entries
    // Followed: a symlinked nested SKILL.md is a nested skill marker all the same.
    .filter(entry => entry.name === 'SKILL.md' && direntKindFollowingSync(entry.parentPath, entry) === 'file')
    .map(entry => safePath.relative(outputPath, safePath.join(entry.parentPath, entry.name)))
    .filter(relativePath => relativePath !== 'SKILL.md'); // Exclude the root SKILL.md

  if (nestedSkillMds.length > 0) {
    throw packagingInputError(
      `SKILL.md found inside skill "${skillName}" at: ${nestedSkillMds.join(', ')}\n` +
      `A SKILL.md was bundled as a resource — this creates a duplicate skill definition\n` +
      `in the build output, which breaks marketplace sync and confuses skill consumers.\n\n` +
      `Fix: Replace the markdown link to the other skill's SKILL.md with a text reference:\n` +
      `  Instead of: [other skill](../other-skill/SKILL.md)\n` +
      `  Use:        For details, load the \`other-skill\` skill.`,
    );
  }
}

// ============================================================================
// Metadata Extraction
// ============================================================================

/**
 * Extract skill metadata from SKILL.md frontmatter or content
 */
function extractSkillMetadata(
  parseResult: ParseResult,
  skillPath: string
): SkillMetadata {
  const frontmatter = parseResult.frontmatter ?? {};

  // Extract name from frontmatter (with validation)
  const frontmatterName = frontmatter['name'];
  const validFrontmatterName = typeof frontmatterName === 'string' && frontmatterName.trim() !== ''
    ? frontmatterName
    : undefined;

  // Try: frontmatter → H1 title → filename
  const name =
    validFrontmatterName ??
    extractH1Title(parseResult.content) ??
    basename(skillPath).replace(/\.md$/i, '');

  // Extract optional fields using bracket notation
  const description = frontmatter['description'];
  const version = frontmatter['version'];
  const license = frontmatter['license'];
  const author = frontmatter['author'];

  // Build result object with conditional properties (exactOptionalPropertyTypes)
  const result: SkillMetadata = {
    name: name.trim(),
  };

  if (typeof description === 'string') {
    result.description = description;
  }
  if (typeof version === 'string') {
    result.version = version;
  }
  if (typeof license === 'string') {
    result.license = license;
  }
  if (typeof author === 'string') {
    result.author = author;
  }

  return result;
}

/**
 * Extract H1 title from markdown content
 *
 * @param content - Markdown content
 * @returns The H1 title text, or undefined if not found
 */
export function extractH1Title(content: string): string | undefined {
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('# ')) {
      return trimmed.slice(2).trim();
    }
  }
  return undefined;
}

// ============================================================================
// Path Utilities
// ============================================================================

/**
 * Find the common ancestor directory of all file paths
 *
 * @param filePaths - Array of absolute file paths
 * @returns Common ancestor directory path
 */
export function findCommonAncestor(filePaths: string[]): string {
  if (filePaths.length === 0) {
    return process.cwd();
  }

  if (filePaths.length === 1) {
    return dirname(filePaths[0] ?? process.cwd());
  }

  // Normalize all paths
  const normalizedPaths = filePaths.map(p => safePath.resolve(p));

  // Split into path segments
  // eslint-disable-next-line local/no-hardcoded-path-split -- Paths are normalized to forward slashes by toForwardSlash()
  const pathSegments = normalizedPaths.map(p => p.split('/'));

  // Find common prefix
  const firstPath = pathSegments[0] ?? [];
  let commonDepth = 0;

  for (const [i, segment] of firstPath.entries()) {
    const allMatch = pathSegments.every(segments => segments[i] === segment);

    if (!allMatch) {
      break;
    }

    commonDepth = i + 1;
  }

  // If no common directory (different roots), use first file's directory
  if (commonDepth === 0) {
    return dirname(filePaths[0] ?? process.cwd());
  }

  // Reconstruct common ancestor path
  const commonSegments = firstPath.slice(0, commonDepth);
  return commonSegments.join('/');
}

/**
 * Generate target path based on naming strategy
 *
 * @param filePath - Absolute path to the source file
 * @param basePath - Base path to calculate relative path from
 * @param strategy - Naming strategy to use
 * @param stripPrefix - Path prefix to remove before applying strategy (works for all strategies)
 * @returns Target path (relative) for the packaged resource
 */
export function generateTargetPath(
  filePath: string,
  basePath: string,
  strategy: ResourceNamingStrategy = 'basename',
  stripPrefix?: string
): string {
  if (strategy === 'basename') {
    // Default: just use the filename (flat structure)
    return basename(filePath);
  }

  const ext = filePath.substring(filePath.lastIndexOf('.'));
  let relPath = safePath.relative(basePath, filePath);

  // Strip prefix from relative path (if specified)
  // Works for both resource-id and preserve-path strategies
  if (stripPrefix) {
    // `relPath` is already forward-slashed by `safePath.relative`; `stripPrefix`
    // is author-written config, so its backslashes read as separators anywhere.
    const normalizedRelPath = relPath;
    const normalizedPrefix = toForwardSlashAnyPlatform(stripPrefix).replace(/\/$/, ''); // Remove trailing slash

    if (normalizedRelPath.startsWith(normalizedPrefix + '/')) {
      // Strip the prefix and leading slash
      relPath = normalizedRelPath.substring(normalizedPrefix.length + 1);
    } else if (normalizedRelPath.startsWith(normalizedPrefix)) {
      // Prefix without trailing slash
      relPath = normalizedRelPath.substring(normalizedPrefix.length);
      // Clean up any leading slash
      relPath = relPath.replace(/^\//, '');
    }
  }

  if (strategy === 'preserve-path') {
    // Preserve directory structure (creates subdirectories)
    return relPath;
  }

  // strategy === 'resource-id': Flatten path to kebab-case filename
  // Convert path to kebab-case identifier (all in one filename)
  const pathWithoutExt = relPath.substring(0, relPath.length - ext.length);
  const resourceId = pathWithoutExt
    .replaceAll(/[/\\]+/g, '-')     // Path separators to hyphens
    .replaceAll(/[_\s]+/g, '-')     // Underscores and spaces to hyphens
    .toLowerCase()
    .replaceAll(/[^\da-z-]/g, '')   // Remove non-alphanumeric except hyphens
    .replaceAll(/-{2,}/g, '-')      // Collapse multiple hyphens
    .replace(/^-/, '')               // Trim leading hyphen
    .replace(/-$/, '');              // Trim trailing hyphen

  return resourceId + ext;
}

// ============================================================================
// Artifact Generation
// ============================================================================

/** ZIP size threshold for warning (4 MB in bytes) */
const ZIP_SIZE_WARN_BYTES = 4 * 1024 * 1024;
/** ZIP size threshold for error (8 MB in bytes) */
const ZIP_SIZE_ERROR_BYTES = 8 * 1024 * 1024;

/**
 * Thrown when a claude-web ZIP exceeds the 8MB Claude.ai upload limit.
 * The CLI catches this and exits with code 1.
 */
export class ZipSizeLimitError extends VatError {
  readonly sizeBytes: number;
  readonly limitBytes: number;

  constructor(sizeBytes: number, limitBytes: number) {
    const mb = (sizeBytes / 1024 / 1024).toFixed(1);
    super(
      'ZIP_SIZE_LIMIT',
      `ZIP size ${mb}MB exceeds 8MB limit for Claude.ai upload. ` +
      `Reduce the number of linked resources or use --target claude-code.`
    );
    this.sizeBytes = sizeBytes;
    this.limitBytes = limitBytes;
  }
}

/**
 * Validate ZIP size and warn/error as appropriate.
 * Warns to stderr at 4MB, throws ZipSizeLimitError at 8MB.
 *
 * @param bytes - The archive's size
 */
function validateZipSize(bytes: number): void {
  if (bytes >= ZIP_SIZE_ERROR_BYTES) {
    throw new ZipSizeLimitError(bytes, ZIP_SIZE_ERROR_BYTES);
  }

  if (bytes >= ZIP_SIZE_WARN_BYTES) {
    const mb = (bytes / 1024 / 1024).toFixed(1);
    process.stderr.write(
      `warning: ZIP size ${mb}MB is approaching the 8MB Claude.ai upload limit.\n`
    );
  }
}

/**
 * Generate the package artifacts in the requested formats: the npm manifest is written
 * INTO the bundle; what lands BESIDE it — the ZIP, the marketplace manifest — is
 * returned as bytes, for the plan that owns the output to place
 * ({@link packageOutputChanges}).
 *
 * @param outputPath - The directory the package was written into (a staged tree)
 * @param metadata - Skill metadata
 * @param formats - Formats to generate
 * @param projectRoot - The project root, so a refused write names its path relative to it
 * @param target - Packaging target (for ZIP size validation on claude-web)
 */
async function generatePackageArtifacts(
  outputPath: string,
  metadata: SkillMetadata,
  formats: readonly string[],
  projectRoot: string,
  target: PackagingTarget = DEFAULT_PACKAGING_TARGET
): Promise<PackageSiblings> {
  // The ZIP first: it archives the bundle without the npm manifest written below.
  const zip = formats.includes('zip') ? await createZipArchive(outputPath, projectRoot) : undefined;
  // Validate ZIP size for claude-web target (Anthropic upload limit)
  if (zip !== undefined && target === 'claude-web') {
    validateZipSize(zip.length);
  }
  if (formats.includes('npm')) {
    await createNpmPackage(outputPath, metadata, projectRoot);
  }
  return {
    ...(zip !== undefined && { zip }),
    ...(formats.includes('marketplace') && { marketplace: marketplaceManifest(metadata) }),
  };
}

/**
 * The ZIP archive of a packaged skill, in memory.
 *
 * Uses adm-zip for fast, cross-platform ZIP creation.
 * ZIP format preferred over TAR for Windows compatibility.
 *
 * @param sourceDir - Directory to archive
 * @param projectRoot - The project root, so a refused read names the package relative to it
 */
async function createZipArchive(sourceDir: string, projectRoot: string): Promise<Buffer> {
  const AdmZip = (await import('adm-zip')).default;

  const zip = new AdmZip();

  // Add directory contents to ZIP. adm-zip reads the output back from disk: what it
  // lists and reads is the package this run just wrote, so a refusal is the output's.
  withFsFaultSync(
    { side: 'destination', action: `read back the package ${issueLocation(sourceDir, projectRoot) || '.'} to archive it` },
    () => zip.addLocalFolder(sourceDir),
  );

  return zip.toBuffer();
}

/**
 * Create npm package (package.json + tarball)
 *
 * @param outputPath - Directory containing packaged skill
 * @param metadata - Skill metadata
 * @param projectRoot - The project root, so a refused write names its path relative to it
 */
async function createNpmPackage(
  outputPath: string,
  metadata: SkillMetadata,
  projectRoot: string
): Promise<void> {
  // Generate package.json
  const packageJson = {
    name: `@vat-skills/${metadata.name}`,
    version: metadata.version ?? '1.0.0',
    description: metadata.description ?? `${metadata.name} skill`,
    license: metadata.license ?? 'MIT',
    author: metadata.author,
    keywords: ['vat', 'skill', 'claude', 'agent'],
    files: ['**/*.md'],
  };

  const packageJsonPath = safePath.join(outputPath, PACKAGE_JSON_FILENAME);
  // A write the OS refuses (a full disk, an unwritable directory) is the run not finishing.
  await withFsFault(
    { side: 'destination', action: `write npm package manifest ${issueLocation(packageJsonPath, projectRoot)}` },
    () => writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2)),
  );
}

/**
 * The marketplace manifest (JSON descriptor) of a packaged skill.
 *
 * @param metadata - Skill metadata
 */
function marketplaceManifest(metadata: SkillMetadata): string {
  const manifest = {
    name: metadata.name,
    version: metadata.version ?? '1.0.0',
    description: metadata.description,
    license: metadata.license ?? 'MIT',
    author: metadata.author,
    type: 'skill',
    entrypoint: 'SKILL.md',
    created: new Date().toISOString(),
  };
  return JSON.stringify(manifest, null, 2);
}

/**
 * Get default output path for packaged skill
 *
 * Returns <skill-package-root>/dist/skills/<skill-name>
 *
 * @param skillPath - Path to SKILL.md
 * @param skillName - Name from frontmatter
 * @returns Default output path
 */
function getDefaultSkillOutputPath(skillPath: string, skillName: string): string {
  // The name may have come from the H1 title when frontmatter carries none,
  // and the directory this returns is `rm -rf`'d before the package is
  // written: a SKILL.md headed `# ../../../canary` used to delete `<root>/canary`
  // through the public `packageSkill` export, issues empty, `hasErrors` false.
  if (!isSingleFsSegment(skillName)) {
    throw new VatError(
      SKILL_NAME_NOT_A_SEGMENT_CODE,
      `Cannot derive an output directory from skill name "${skillName}": a name must be a single ` +
        `path segment (no separators, not "." or ".."). Declare \`name:\` in the SKILL.md frontmatter ` +
        `or pass an explicit outputPath.`,
    );
  }
  const skillPackageRoot = findPackageRoot(skillPath);
  return safePath.join(skillPackageRoot, 'dist', 'skills', skillName);
}

/**
 * Find the package root that contains the skill
 *
 * Walks up from the skill directory to find the nearest package.json
 *
 * @param skillPath - Path to SKILL.md
 * @param fallbackToSkillDir - If true, falls back to skill's directory instead of throwing
 * @returns Package root directory (or skill's directory if fallback enabled)
 */
function findPackageRoot(skillPath: string, fallbackToSkillDir = false): string {
  let currentDir = dirname(safePath.resolve(skillPath));
  const skillDir = currentDir;

  // Walk up until we find a package.json or hit the filesystem root
  while (currentDir !== dirname(currentDir)) {
    const packageJsonPath = safePath.join(currentDir, PACKAGE_JSON_FILENAME);
    if (existsSync(packageJsonPath)) {
      return currentDir;
    }
    currentDir = dirname(currentDir);
  }

  // Not found - either throw or fallback
  if (fallbackToSkillDir) {
    return skillDir;
  }

  throw new Error(
    `Could not find package.json for skill at ${skillPath}. ` +
      `Skill must be within an npm package to generate default output path.`
  );
}
