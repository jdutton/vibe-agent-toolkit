import { ValidationConfigSchema } from '@vibe-agent-toolkit/schema';
import { globMagicRemainder, hasParentTraversalSegment, isAbsoluteAnyPlatform } from '@vibe-agent-toolkit/utils';
import { z } from 'zod';

import { LinkAuthConfigSchema } from './link-auth.js';
import { ReferenceSyntacticFormSchema } from './projection-blobs.js';
import { JsonValueSchema } from './projection-shared.js';
import { ZoneKindSchema } from './projection-zones.js';

/**
 * Official semver regex from https://semver.org/ (anchored).
 *
 * Used as the JSON-Schema-friendly source of truth for plugin version
 * validation. A `.refine()` over `semver.valid()` would not survive
 * `zod-to-json-schema` export — external consumers validating against the
 * exported JSON Schema would silently accept invalid versions. A `.regex()`
 * round-trips into JSON Schema as `pattern`, preserving the constraint.
 */
// eslint-disable-next-line security/detect-unsafe-regex, sonarjs/regex-complexity -- Official semver regex from https://semver.org/; not user-controlled input.
const SEMVER_REGEX = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

// Re-export for downstream consumers (unicorn/prefer-export-from satisfied by the import above)
export { ValidationConfigSchema } from '@vibe-agent-toolkit/schema';

/**
 * Validation mode for frontmatter schema validation.
 *
 * - `strict`: Enforce schema exactly (respect additionalProperties: false)
 * - `permissive`: Allow extra fields (ignore additionalProperties: false)
 */
export const ValidationModeSchema = z.enum(['strict', 'permissive'])
  .describe('Validation mode for frontmatter schema validation');

export type ValidationMode = z.infer<typeof ValidationModeSchema>;

/**
 * External URL validation configuration.
 *
 * Controls how external URLs are validated:
 * - enabled: Whether to check external URLs
 * - timeout: Request timeout in milliseconds (default: 15000)
 * - retryOn429: Whether to retry on rate limit (default: true)
 * - ignorePatterns: Regex patterns for URLs to skip (e.g., '^https://localhost')
 */
export const ExternalUrlValidationSchema = z.object({
  enabled: z.boolean().optional()
    .describe('Whether to validate external URLs (default: false)'),
  timeout: z.number().int().positive().optional()
    .describe('Request timeout in milliseconds (default: 15000)'),
  retryOn429: z.boolean().optional()
    .describe('Whether to retry on rate limit (429) (default: true)'),
  ignorePatterns: z.array(z.string()).optional()
    .describe('Regex patterns for URLs to skip validation (e.g., "^https://localhost")'),
}).describe('External URL validation configuration');

export type ExternalUrlValidation = z.infer<typeof ExternalUrlValidationSchema>;

/**
 * Validation configuration for a collection.
 */
export const CollectionValidationSchema = z.object({
  frontmatterSchema: z.string().optional()
    .describe('Path to JSON Schema file for frontmatter validation (relative to config file or package reference like @vibe-agent-toolkit/schemas/skill.v1.json)'),
  mode: ValidationModeSchema.optional()
    .describe('Validation mode (default: strict)'),
  checkUrlLinks: z.boolean().optional()
    .describe('Whether to validate external URL links (default: false)'),
  checkGitIgnored: z.boolean().optional()
    .describe('Whether to check if non-ignored files link to git-ignored files (default: true)'),
  checkFrontmatterLinks: z.boolean().optional()
    .describe('Whether to validate frontmatter values at JSON Schema positions with a URI-family format (default: true). Set to false to disable for this collection.'),
  externalUrls: ExternalUrlValidationSchema.optional()
    .describe('External URL validation configuration'),
}).describe('Validation configuration for a collection');

export type CollectionValidation = z.infer<typeof CollectionValidationSchema>;

/**
 * Configuration for a named collection of resources.
 *
 * Collections define include/exclude patterns, validation rules, and — through
 * {@link CollectionConfigSchema.shape.mimeType} — what the files they match
 * ARE. A file can belong to multiple collections.
 *
 * ## The conflict rule, and why it is cheap
 *
 * Only a collection that **declares** a `mimeType` participates at all. One that
 * matches a file and declares nothing contributes nothing and can never
 * conflict, which is what keeps the rule from turning every overlapping
 * collection pair into a decision. Of the collections that do declare: one
 * distinct value (however many collections carry it) types the file; two or more
 * distinct values are a **config error**, collected per file and reported at the
 * end of the run rather than thrown on the first — a config authoring mistake
 * should read like a linter finding that names every offending file, not kill a
 * 9,000-file run on file 400 and hide the other six.
 *
 * Parsing one file with two parsers was considered and rejected: a blob has one
 * content key and one set of derived facts, so "both" is not a representable
 * answer.
 */
export const CollectionConfigSchema = z.object({
  include: z.array(z.string()).min(1)
    .describe('Include patterns (paths or globs like docs/**/*.md)'),
  exclude: z.array(z.string()).optional()
    .describe('Exclude patterns (globs)'),
  // ⚠️ Deliberately unconstrained beyond "a non-empty string" — the vocabulary
  // is the AUTHOR'S, pinned by `project-config-flag.test.ts`. A corpus may
  // legitimately name its own type (`application/x-fraud-ingest`) to record what
  // its files are while running no document parser over them.
  //
  // 🚨 The cost of that openness, recorded because it is real and unfixed: a
  // TYPO is indistinguishable from a deliberate private type. `text/markdow`
  // validates, routes to no parser, and silently leaves unparsed exactly the
  // files the declaration was written to parse. Rejecting unknown types would
  // catch it but would also break the private-vocabulary case above, and no
  // structural test separates the two — `text/markdow` and
  // `application/x-fraud-ingest` are both "a string no table names". Recorded
  // here rather than papered over; deciding it needs a product call about
  // whether the vocabulary stays open, not a cleverer predicate.
  //
  // 🪤 Second sharp edge, pre-existing but NEWLY load-bearing: `include` is
  // matched against the file's ABSOLUTE path with a `**/` prefix, so a bare
  // `include: ['docs']` matches any file under any ANCESTOR named `docs` too.
  // Measured: a project at `/Users/j/docs/myproj` has `['docs']` match every
  // file in the whole tree, not just its own `docs/`. That was only a scoping
  // surprise before; now it decides which parser runs and lands in the content
  // key, so the same tree under a differently-named parent derives different
  // blob rows. Anchor the pattern (`docs/**`) when declaring a `mimeType`.
  mimeType: z.string().min(1).optional()
    .describe('MIME type every file this collection matches IS, overriding mime-type.ts\'s basename/extension tables — e.g. "text/markdown" for a corpus of prose files with an unhelpful extension. OPTIONAL, and omitting it is not the same as declaring a default: a collection that matches a file but declares nothing contributes nothing and can never conflict with another collection. Two collections that match one file and declare DIFFERENT values are a config error, reported per file and collected across the run. ⚠️ Declaring this makes the file\'s content key CONFIG-dependent: the parser kind is mixed into the key\'s digest preimage, so editing this value invalidates that file\'s cached parse facts automatically — which is the intended behaviour and needs no version constant.'),
  validation: CollectionValidationSchema.optional()
    .describe('Validation configuration for this collection'),
}).describe('Configuration for a named collection of resources');

export type CollectionConfig = z.infer<typeof CollectionConfigSchema>;

/**
 * Resources section of project configuration.
 */
export const ResourcesConfigSchema = z.object({
  include: z.array(z.string()).optional()
    .describe('Global default include patterns (not used by collections in Phase 2)'),
  exclude: z.array(z.string()).optional()
    .describe('Global default exclude patterns (not used by collections in Phase 2)'),
  collections: z.record(z.string(), CollectionConfigSchema).optional()
    .describe('Named collections of resources'),
  validation: ValidationConfigSchema.optional()
    .describe('Validation framework config: severity overrides and per-code allow entries (applied inside ResourceRegistry.validate)'),
  linkAuth: LinkAuthConfigSchema.optional()
    .describe('Authenticated external link resolution config (issue #113 / link-auth engine)'),
}).describe('Resources section of project configuration');

export type ResourcesConfig = z.infer<typeof ResourcesConfigSchema>;

// ---------------------------------------------------------------------------
// Skill packaging configuration (self-contained — no schema dependency)
// ---------------------------------------------------------------------------

/**
 * A rule for excluding references from a skill bundle.
 */
export const ExcludeReferenceRuleSchema = z.object({
  // ⚠️ Relative to the PROJECT root, not the skill root — this said "skill root" and was wrong.
  // `walk-link-graph.ts:650` matches against `safePath.relative(options.projectRoot, targetPath)`
  // and `skill-packager.ts:607` passes the project root, so a pattern written against the skill
  // root silently matches nothing.
  patterns: z.array(z.string()).describe('Glob patterns matched against path relative to project root'),
  template: z.string().optional().describe('Handlebars template for rewriting links to matched files'),
});

/**
 * Configuration for excluding references from a skill bundle.
 */
export const ExcludeReferencesFromBundleSchema = z.object({
  rules: z.array(ExcludeReferenceRuleSchema).optional().default([]),
  defaultTemplate: z.string().optional().describe('Handlebars template for non-bundled links that don\'t match any rule'),
});

/**
 * A file entry mapping a source path to a destination path in the skill output.
 *
 * Used for build artifacts, unlinked files, and routing overrides.
 * - source: path relative to project root (where vibe-agent-toolkit.config.yaml lives)
 * - dest: path relative to the skill's output directory (sibling to SKILL.md)
 * - integrity (optional): byte-verify the copied set against the matched source set at build time
 */
export const SkillFileEntrySchema = z.object({
  source: z.string().min(1)
    // A `..` segment AFTER a glob's static base is a malformed PATTERN, not a
    // path. `glob` honors it and climbs above the base the pattern is resolved
    // against, so `expandGlobEntry` cannot expand it safely at any phase and
    // throws — killing the build. The pre-build gate has no bucket for that
    // verdict (its three buckets cover dropped / all-refused / unmatched), so a
    // config that could never build passed `vat skills validate` silently and
    // died at copy time. Rejecting it here makes the config unloadable, which
    // every lane already surfaces through the existing config-error path — no
    // new validation code, and the runtime throw becomes unreachable
    // defense-in-depth rather than the only guard.
    //
    // Only the MAGIC REMAINDER is constrained. The static base may legitimately
    // begin with `..` — that is the deliberate sibling-base monorepo feature —
    // and a non-glob source is an ordinary path, so neither is touched here.
    .refine(
      (s) => !hasParentTraversalSegment(globMagicRemainder(s)),
      {
        message:
          "source must not contain a '..' segment after its static base: parent-directory " +
          'traversal inside the glob portion escapes the base the pattern is resolved against',
      },
    )
    .describe('Source path relative to project root'),
  dest: z.string().min(1)
    // Containment guard (zip-slip class): dest is OUR config output and is joined
    // onto the skill output directory at build time, so it must stay inside it.
    // Reject absolute paths (POSIX `/…`, Windows `C:\…`, UNC) and any `..`
    // traversal segment. Defense-in-depth: copy sites also route through
    // safePath.joinUnderRoot().
    .refine(
      (d) => !isAbsoluteAnyPlatform(d) && !hasParentTraversalSegment(d),
      {
        message:
          'dest must be a relative path contained in the skill output directory: ' +
          'no absolute paths (e.g. "/etc/x" or a Windows drive path) and no ".." traversal segments',
      },
    )
    .describe('Destination path relative to skill output directory'),
  integrity: z.boolean().optional().describe('When true, the build asserts the copied dest set exactly matches the matched source set and each file is byte-identical (a future copy-time check; late-bound)'),
});

export type SkillFileEntry = z.infer<typeof SkillFileEntrySchema>;

/**
 * A single declared executable a skill ships.
 *
 * Populates two downstream consumers (issue #145 Phase T/L):
 * - `toolExpectations.mustRun: ["csvsum"]` (eval grading) references an executable
 *   by a stable NAME. Name resolution (defined here, implemented in a later
 *   task): the referenced name matches either (a) this entry's `path` basename
 *   with its extension stripped (e.g. `path: "scripts/csvsum.py"` → name `"csvsum"`),
 *   or (b) the exact `path` string. Callers should try (a) then fall back to (b).
 * - Phase L launch-guidance linting uses `kind` + `howInvoked` to statically
 *   check that a skill's documented invocation matches its declared executable
 *   kind (e.g. flagging a `python` executable documented as run via `node`).
 */
export const SkillExecutableEntrySchema = z.object({
  path: z.string().min(1).describe('Path to the executable, relative to the skill root'),
  kind: z.enum(['node', 'python', 'shell', 'pwsh', 'binary'])
    .describe('Executable kind (informs launch-guidance linting)'),
  howInvoked: z.string().min(1)
    .describe('Canonical human invocation, e.g. "uv run csvsum.py" or "node dist/csvsum.mjs"'),
}).strict();

export type SkillExecutableEntry = z.infer<typeof SkillExecutableEntrySchema>;

/**
 * A typed "skill source" descriptor as it appears in vibe-agent-toolkit.config.yaml.
 *
 * This is the CONFIG representation. Task 13's staging maps it onto Plan 1's
 * runtime `SkillSource` union before calling `resolveSkillSource`. Kept here so
 * `configure`/`run` parse a single strict source of truth.
 */
export const SkillSourceDescriptorSchema = z.union([
  z.object({ workspace: z.string().min(1) }).strict(),
  z.object({ npm: z.string().min(1) }).strict(),
  z.object({ url: z.string().min(1), sha256: z.string().min(1).optional() }).strict(),
  z.object({ path: z.string().min(1) }).strict(),
  z.object({ vendored: z.literal(true) }).strict(),
]).describe('Typed skill source: workspace | npm | url(+sha256) | path | vendored');

export type SkillSourceDescriptor = z.infer<typeof SkillSourceDescriptorSchema>;

/**
 * Per-skill `test:` block for `vat skill test`. Strict — unknown keys are a
 * config error (Postel: this is vat-produced/validated data, §schema strategy).
 * Every field is optional; omitted knobs fall back to built-in defaults.
 */
export const TestConfigSchema = z.object({
  model: z.string().min(1).optional()
    .describe('Pinned model for reproducibility (default: a fixed model, not "whatever the caller has")'),
  maxTurns: z.number().int().positive().optional()
    .describe('Per-spawn cap on executor/grader turns'),
  maxBudgetUsd: z.number().positive().optional()
    .describe('Hard USD budget cap passed to the CLI'),
  timeout: z.number().int().positive().optional()
    .describe('Wall-clock timeout in seconds'),
  stall: z.number().int().positive().optional()
    .describe('Stall-watchdog seconds (kill on no stream output)'),
  evals: z.string().min(1).optional()
    .describe('Which evals.json to grade against: a path relative to the skill source, an absolute path, or an npm bare specifier (resolved via the target package\'s exports map). A suite outside the skill tree is the normal case when the skill is not the one you authored. The CLI flag --evals resolves against the current directory instead.'),
  auth: z.enum(['inherit', 'subscription', 'api-key', 'auto']).optional()
    .describe('Auth-mechanism selection (default: inherit)'),
  requireAuth: z.enum(['subscription', 'api-key']).optional()
    .describe('Fail-fast guard: preflight exits 2 if effective mechanism is not this'),
  baseline: z.boolean().optional()
    .describe('Run the opt-in with/without A/B baseline (default: false)'),
  skillCreator: SkillSourceDescriptorSchema.optional()
    .describe('Source for skill-creator (default: { vendored: true })'),
  with: z.array(SkillSourceDescriptorSchema).optional()
    .describe('Required companion skills to stage alongside the subject (invocable by it); the run fails if a source cannot be resolved.'),
  optional: z.array(SkillSourceDescriptorSchema).optional()
    .describe('Optional companion skills; staged if resolvable, skipped with a warning otherwise.'),
  /**
   * Shell command to run once, before staging, to generate build artifacts.
   * Runs with cwd = config root (directory containing vibe-agent-toolkit.config.yaml).
   * Useful when a skill references a generated file (e.g. `node scripts/report.mjs`)
   * that is produced by a bundler step and not committed to source.
   * A non-zero exit code aborts the run (preflight failure, exit 2).
   */
  env: z.record(z.string(), z.string()).optional()
    .describe('Feature B: explicit env var injections for the executor spawn. Values support ${fixturesDir}, ${stagedSkillDir}, ${harnessRoot}, ${resultsDir} interpolation. ${fixturesDir} is PER-EVAL: it names the staged workspace for that one eval (a fixtures/ dir beneath the executor working directory), so the eval must declare input files; the other tokens are run-scoped. Protected names (PATH, auth, model, admin) cannot be overridden.'),
  passEnv: z.array(z.string().min(1)).optional()
    .describe('Feature A: names of host env vars to forward to the executor spawn if present. Protected names are ignored with a warning.'),
  build: z.string().min(1).optional()
    .describe('Shell command run once, before staging, to generate build artifacts (cwd = config root)'),
}).strict().describe('Per-skill vat skill test configuration');

export type TestConfig = z.infer<typeof TestConfigSchema>;

/**
 * Skill packaging configuration.
 *
 * Controls how a skill is bundled: link-follow depth, resource naming,
 * reference exclusion rules, and validation overrides.
 */
export const SkillPackagingConfigSchema = z.object({
  publish: z.boolean().optional()
    .describe('Whether this skill is published for distribution (default: true). Set to false for in-development skills.'),
  linkFollowDepth: z.union([z.number().int().min(0), z.literal('full')]).optional(),
  resourceNaming: z.enum(['basename', 'resource-id', 'preserve-path']).optional(),
  stripPrefix: z.string().optional(),
  excludeNavigationFiles: z.boolean().optional(),
  excludeReferencesFromBundle: ExcludeReferencesFromBundleSchema.optional(),
  validation: ValidationConfigSchema.optional()
    .describe('Validation framework config: severity overrides and per-path allow entries'),
  targets: z.array(z.enum(['claude-chat', 'claude-cowork', 'claude-code'])).optional()
    .describe('Declared runtime targets for this skill. Suppresses non-applicable compat verdicts.'),
  files: z.array(SkillFileEntrySchema).optional().describe('Explicit source→dest file mappings for build artifacts, unlinked files, or routing overrides'),
  test: TestConfigSchema.optional()
    .describe('vat skill test configuration for this skill'),
  executables: z.array(SkillExecutableEntrySchema).optional()
    .describe('Declared executables the skill ships — stable names for eval toolExpectations + launch-guidance linting'),
}).strict().describe('Skill packaging configuration');

export type SkillPackagingConfig = z.infer<typeof SkillPackagingConfigSchema>;

// NOTE: project-config has no generated JSON Schema generator (unlike packages with generate:schemas script); Zod schema is the tracked source of truth.

/**
 * Skills discovery and packaging configuration.
 *
 * Defines how to find SKILL.md files and how to package them.
 */
export const SkillsConfigSchema = z.object({
  include: z.array(z.string()).min(1).describe('Glob patterns to find SKILL.md files (e.g., "skills/**/SKILL.md")'),
  exclude: z.array(z.string()).optional().describe('Glob patterns to exclude'),
  defaults: SkillPackagingConfigSchema.optional().describe('Default packaging config for all skills'),
  config: z.record(z.string(), SkillPackagingConfigSchema).optional().describe('Per-skill packaging config overrides (keyed by skill name)'),
}).strict().describe('Skills discovery and packaging configuration');

export type SkillsConfig = z.infer<typeof SkillsConfigSchema>;

// ---------------------------------------------------------------------------
// Closure-defined extents (zones.md §7.3)
// ---------------------------------------------------------------------------

/**
 * A **closure-defined extent**: everything reachable from one root document by
 * following declared reference forms, bounded by a depth and narrowed by globs.
 *
 * ## Why this is config data rather than a plugin API
 *
 * zones.md §7.3's adequacy test is that a built-in extent must be expressible
 * the way a config-declared one would be. Without this primitive, closure-shaped
 * extents — which is what a *skill bundle* is — would need privileged code, and
 * that test and the declarative-only rule could not both hold.
 *
 * The primitive is not new behaviour: `SkillPackagingConfigSchema`'s
 * {@link SkillPackagingConfigSchema} `linkFollowDepth` and
 * `excludeReferencesFromBundle` already *are* a closure declaration, spelled
 * once for one privileged walker. The union of {@link maxDepth} and
 * {@link refusals} here is the same pair, generalized and named — including the
 * `excludeReferencesFromBundle` property that made it a *list of rules* rather
 * than one flat pattern set: first match wins, and the winner is named.
 *
 * ## Declarative data only — never project-supplied code
 *
 * Patterns, bindings, metadata, a named resolver, and this primitive. A resolver
 * *function* from config would be a code-execution surface and would break the
 * promise that extensible tagging adds no plugin API. Every field below is inert
 * data a contributor interprets.
 *
 * ```yaml
 * extents:
 *   my-skill-bundle:
 *     kind: skill
 *     closureFrom: skills/foo/SKILL.md
 *     follow: [markdown-link, markdown-link-reference]
 *     maxDepth: 3
 *     refusals:
 *       - label: DIRECTORY_TARGET          # opaque to the primitive; it only reports it
 *         kinds: ['directory']
 *       - label: NAVIGATION_FILE
 *         basenames: ['README.md']
 *       - label: EXCLUDED_BY_PATTERN
 *         patterns: ['*.test.md']
 *     admitPaths: ['notes/CLAUDE.md']
 * ```
 *
 * ## An ORDERED refusal cascade, and one override that outranks all of it
 *
 * ⚠️ **{@link refusals} is a cascade, not a set of independent filters: the order
 * IS the behaviour.** Each rule carries a {@link ExtentRefusalRuleSchema.label},
 * the first rule that matches wins, and that winner's label is what the closure
 * reports as the refusal's `realization_conditions.code`. A candidate that
 * matches two rules is therefore attributed to the EARLIER one, exactly as
 * `walk-link-graph.ts`'s `classifyExclusion` attributes a directory that is also
 * pattern-matched to `directory-target`. Reordering the array repicks which
 * label a refusal reports, so this array must never be rewritten as a set, a
 * record, or anything else whose iteration order is incidental.
 *
 * {@link admitPaths} is not part of the cascade: it outranks every rule in it,
 * for the same reason `closureFrom` does. A refusal is not merely "not a member":
 * the closure does not traverse THROUGH a refused candidate, so the subtree
 * reachable only via that candidate is refused with it.
 *
 * ## Four matchers per rule, because no one predicate expresses the other three
 *
 * A basename set is not a path glob (case-insensitive filesystems generate
 * spellings no alternation enumerates), an entity kind is not a path at all
 * (a directory's path is shaped exactly like a file's), and a boolean column of
 * the realization row — `gitignored`, `exists`, `isSymlink` — is not derivable
 * from any of the three. WITHIN one rule the four are unordered — they all yield
 * that rule's single label — so a caller that needs two matchers distinguished
 * writes two rules.
 *
 * {@link ExtentRefusalRuleSchema.flags} is the generic one: it names a COLUMN,
 * not a concept, so `{ gitignored: true }` and `{ isSymlink: true }` are the same
 * feature and neither is privileged in the primitive. That is deliberate — the
 * closure knows nothing about git, and a `refuseGitignored: true` knob would have
 * hardcoded one caller's vocabulary into a primitive whose whole premise is that
 * the vocabulary belongs to the declaration.
 *
 * ⚠️ **A column matcher can only be as good as its producer.** `flags` is what
 * turned "the walker consults a git oracle and the closure cannot" into a plain
 * column read — but `resource_realizations.gitignored` is filled only when the
 * population was given a USABLE `GitTracker`, and `exists` is never `false` for a
 * link target at all (a path that is not on disk is never enumerated, so no
 * realization exists to match). A rule keyed on a column its producer never
 * varies is a rule that cannot fire, and it fails SILENTLY — unlike a rule naming
 * a column that does not exist, which the closure throws on. Check the producer
 * before believing a matcher expresses something.
 *
 * {@link ExtentRefusalRuleSchema.payload} is the other half of that premise. A
 * label names a refusal in the caller's vocabulary; a payload carries the rest of
 * it — anything about the rule the caller will want back at the refusal and the
 * primitive has no column for. It rides through to
 * `realization_conditions.matchedPayload` verbatim, uninterpreted, so extending a
 * caller's rule vocabulary never becomes a change to this schema.
 *
 * ## Every optional field carries a default, deliberately
 *
 * The parsed shape is handed to a contributor through `PopulateOptions.parameters`,
 * which is `JsonValue`-typed, and under `exactOptionalPropertyTypes` an optional
 * property admits `undefined` — which `JsonValue` excludes. Defaulting rather
 * than leaving fields optional makes the *output* type total, so a parsed
 * declaration is assignable to `JsonValue` with no cast at the seam that records
 * it verbatim on `zone_provenance.parameterSet`.
 */
export const ExtentRefusalRuleSchema = z.object({
  label: z.string().min(1)
    .describe('OPAQUE name for this refusal, reported verbatim as the realization_conditions.code of every candidate this rule refuses. The primitive never interprets it: a caller that wants the shipped skill walker\'s vocabulary supplies that vocabulary here, and a caller with its own supplies its own. Required, because a refusal with no label is the payload-free verdict this rule shape exists to replace.'),
  patterns: z.array(z.string().min(1)).default([])
    .describe('Globs (picomatch, dot: true) matched against a candidate member\'s root-relative path. A refused file is neither admitted nor traversed through.'),
  basenames: z.array(z.string().min(1)).default([])
    .describe('Basenames matched CASE-INSENSITIVELY against a candidate member\'s basename, e.g. "README.md". Deliberately NOT a glob: patterns matches a root-relative PATH, and a brace alternation over that path cannot enumerate the spellings a case-insensitive filesystem generates freely (Readme.md, README.MD, ReadMe.md), so the glob approximation silently under-matches exactly the spellings that occur in the wild. Folding is toLowerCase(), never toLocaleLowerCase() — see basenameMatcher in agent-skills/src/validators/validation-rules.ts.'),
  kinds: z.array(z.string().min(1)).default([])
    .describe('resources.kind values refused, e.g. "directory". This is the only way a declaration can refuse a DIRECTORY target: a directory\'s path is shaped like any other path, so no glob over the path can express the distinction — the entity kind can.'),
  flags: z.record(z.string().min(1), z.boolean()).default({})
    .describe('BOOLEAN COLUMNS of the candidate\'s resource_realizations row, as column name → the value that refuses, e.g. { "gitignored": true } or { "gitignored": true, "exists": true }. CONJUNCTIVE within the record — every named column must equal its declared value — which is the only way to state a guarded rule such as walk-link-graph.ts\'s existence-gated gitignore branch; an empty record never matches. The column name is NOT an open vocabulary the way kinds is: a realization row has a fixed shape, so a name no boolean column carries is a rule that could never fire and the closure THROWS on it rather than silently refusing nothing.'),
  payload: JsonValueSchema.default(null)
    .describe('OPAQUE caller data about this rule, copied verbatim onto realization_conditions.matchedPayload for every candidate it refuses and NEVER interpreted by the primitive — the same contract label has, for facts that are not a name. It exists because a caller\'s rule carries vocabulary the primitive has no column for: the skill translation puts an excludeReferencesFromBundle rule\'s index and its template here, neither of which a closure could be taught without hardcoding one caller\'s domain. Null when the caller declares none.'),
}).strict().describe('One labelled refusal rule of a closure extent\'s ordered cascade. The four matchers are unordered WITHIN a rule (they share the one label); ACROSS rules the array order is behaviour.');

export type ExtentRefusalRule = z.infer<typeof ExtentRefusalRuleSchema>;

/**
 * How a closure INTERPRETS the reference tokens it follows.
 *
 * A `blob_references` row carries the token *exactly as authored*, so
 * interpretation is a property of the reader — and different readers genuinely
 * disagree. `href` is VAT's general RFC 3986 reading, through
 * `resolveLocalHref`. `claude-import` is Claude Code's `@`-import dialect, in
 * which three of those rules are different: a leading `@` is stripped, `~/`
 * expands to the home directory, and a leading `/` is filesystem-absolute rather
 * than root-relative.
 *
 * The vocabulary lives here, beside the declaration that carries it; the
 * BEHAVIOUR lives in `projection/contributors/reference-dialect.ts`, which
 * delegates to `resolveLocalHref` rather than reimplementing it.
 */
export const ReferenceDialectSchema = z.enum(['href', 'claude-import'])
  .describe('How reference tokens are interpreted — RFC 3986 ("href") or Claude Code\'s @-import dialect ("claude-import")');

export type ReferenceDialect = z.infer<typeof ReferenceDialectSchema>;

export const ExtentDeclarationSchema = z.object({
  kind: ZoneKindSchema
    .describe('The resolution_contexts.kind this extent has, e.g. "skill". Open vocabulary; must match the kind the contributor is registered under.'),
  closureFrom: z.string().min(1)
    .describe('Root-relative path of the extent root — the one member admitted unconditionally, before any traversal. A reference that resolves BACK to it is skipped in silence: the root is a member by declaration, so a self-link has nothing left to refuse and nothing for the hop budget to hold back, and a row about it would contradict the admission. That is the same verdict walk-link-graph.ts gives a link back to its own skillRootPath.'),
  follow: z.array(ReferenceSyntacticFormSchema).default(['markdown-link', 'markdown-link-reference', 'markdown-definition'])
    .describe('Which blob_references syntactic forms the closure traverses. Defaults to the three markdown forms; an @-prefixed or bare token is ambiguous at the blob layer, so following one is an explicit choice.'),
  referenceDialect: ReferenceDialectSchema.default('href')
    .describe('How this closure INTERPRETS the tokens it follows. Defaults to "href" — RFC 3986 through resolveLocalHref — so every declaration written before this field existed is unchanged. "claude-import" is the only correct reading of an at-prefixed token in a CLAUDE.md or .claude/rules file: a leading @ is stripped, ~/ expands to the home directory (landing OUTSIDE the corpus, which is the healthy state the vendor recommends for sharing instructions across worktrees), and a leading / is filesystem-absolute rather than root-relative. Inert data, so it rides onto zone_provenance.parameterSet verbatim and the store correctly treats two runs over one tree under different dialects as two different questions.'),
  maxDepth: z.union([z.number().int().min(0), z.literal('full')]).default('full')
    .describe('Reference hops from the root, or "full" for an unbounded closure. Same union as skills packaging linkFollowDepth, so one concept has one spelling.'),
  refusals: z.array(ExtentRefusalRuleSchema).default([])
    .describe('ORDERED refusal cascade — FIRST MATCH WINS, and the winning rule\'s label is what the refusal reports as its condition code. THE ORDER IS BEHAVIOUR: a candidate matching two rules is attributed to the earlier one, the same way walk-link-graph.ts\'s classifyExclusion attributes a directory that is also pattern-matched to "directory-target" rather than to "pattern-matched". Never rewrite this as a set or a record. A refused candidate is neither admitted nor traversed through, so the subtree reachable only through it is refused with it.'),
  admitPaths: z.array(z.string().min(1)).default([])
    .describe('Exact root-relative paths admitted even when a refusals rule matches them. The same rule closureFrom already gets: an explicit declaration outranks a net, because a glob never named the file it caught. Checked BEFORE the cascade, so an admitted path never reports a refusal label. Matched by exact string equality against the root-relative, forward-slashed path — never a prefix or glob test, since the explicit-vs-glob distinction is the whole point of the field.'),
}).strict().describe('A closure-defined extent declaration (zones.md §7.3)');

export type ExtentDeclaration = z.infer<typeof ExtentDeclarationSchema>;

/**
 * Closure-defined extents, keyed by extent name.
 *
 * The key is the extent's within-root discriminator — it becomes the
 * `resolution_contexts.contextId` suffix — so two declarations under one root
 * cannot collide, and the same name under two federated roots stays distinct.
 */
export const ExtentsConfigSchema = z.record(z.string().min(1), ExtentDeclarationSchema)
  .describe('Closure-defined extents, keyed by extent name');

export type ExtentsConfig = z.infer<typeof ExtentsConfigSchema>;

// ---------------------------------------------------------------------------
// Claude marketplace configuration
// ---------------------------------------------------------------------------

/**
 * A plugin entry's `externalSource` — a reference to a plugin published in
 * ANOTHER marketplace/repo, never built or copied by VAT. Emitted verbatim as
 * the `source` object in the generated marketplace.json, matching the official
 * Claude Code marketplace source shapes (see
 * `packages/agent-skills/src/schemas/marketplace-manifest.ts`, the reading
 * side of this same union, confirmed against real entries from
 * `anthropics/claude-plugins-official`).
 *
 * This is how one marketplace cherry-picks a plugin out of another without
 * vendoring its files: Claude Code resolves `source` at install time, so the
 * referenced plugin stays a single source of truth wherever it is actually
 * maintained.
 */
export const ExternalPluginSourceSchema = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('github'),
    repo: z.string().min(1).describe('owner/repo'),
    ref: z.string().optional().describe('Branch or tag (default: the repo default branch)'),
    sha: z.string().optional().describe('Pin to an exact commit (overrides ref for reproducibility)'),
  }).strict(),
  z.object({
    source: z.literal('url'),
    url: z.string().url(),
    ref: z.string().optional(),
    sha: z.string().optional(),
  }).strict(),
  z.object({
    source: z.literal('npm'),
    package: z.string().min(1),
    version: z.string().optional(),
    registry: z.string().optional(),
  }).strict(),
  z.object({
    source: z.literal('pip'),
    package: z.string().min(1),
    version: z.string().optional(),
    registry: z.string().optional(),
  }).strict(),
]).describe('External plugin source, passed through verbatim to marketplace.json');

export type ExternalPluginSource = z.infer<typeof ExternalPluginSourceSchema>;

/**
 * A plugin entry within a Claude marketplace configuration.
 *
 * Supports full Claude plugin bundling:
 * - `skills`: pool-to-plugin selector (`"*"` or array of skill name selectors). Imports
 *   pool skills (built by `vat skills build`) into the plugin bundle.
 * - `source` (optional): path to plugin dir (default: plugins/<name>). Tree-copied verbatim.
 * - `files` (optional): explicit source->dest mappings for artifacts built outside the plugin dir.
 * - `exclude` (optional): patterns the verbatim tree-copy must skip — a glob, or a bare
 *   directory name (with or without a trailing slash), which covers its whole subtree in
 *   both crawl lanes. Additive to the built-in exclusions (`.claude-plugin/`,
 *   agent-instruction files); for project-specific junk only. A pattern that matches
 *   nothing is warned about, never silently ignored.
 * - `externalSource` (optional): reference a plugin published in another marketplace/repo
 *   instead of building one locally. Mutually exclusive with `source`/`files`/`exclude`/
 *   `changelog`, and `skills` must be `[]` — an external plugin is never built or copied by
 *   VAT, only referenced.
 */
export const ClaudeMarketplacePluginEntrySchema = z.object({
  name: z.string()
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'Plugin name must be lowercase alphanumeric with hyphens (regex: ^[a-z0-9][a-z0-9-]*$)')
    .describe('Plugin name (lowercase alphanumeric with hyphens)'),
  description: z.string().optional()
    .describe('Plugin description'),
  skills: z.union([z.literal('*'), z.array(z.string())])
    .describe('Skills to include: "*" for all, or array of skill name selectors. Must be [] when externalSource is set'),
  source: z.string().optional()
    .describe('Path to plugin directory (default: plugins/<name>). Incompatible with externalSource'),
  files: z.array(SkillFileEntrySchema).optional()
    .describe('Explicit source→dest file mappings for compiled artifacts outside the plugin directory. Incompatible with externalSource'),
  exclude: z.array(z.string()).optional()
    .describe('Patterns (relative to the plugin source dir) to leave out of the verbatim tree-copy: a glob ("scratch/**"), or a directory name with or without a trailing slash ("scratch", "scratch/") which covers that directory and everything under it. Incompatible with externalSource'),
  version: z.string().regex(SEMVER_REGEX, {
    message: 'version must be a valid semver string (e.g., "1.2.3" or "1.0.0-rc.1")',
  }).optional()
    .describe('Per-plugin semver version (overrides root package.json:version for this plugin)'),
  changelog: z.string().optional()
    .describe('Path to per-plugin CHANGELOG (relative to plugin source dir; default: <source>/CHANGELOG.md if it exists). Incompatible with externalSource'),
  externalSource: ExternalPluginSourceSchema.optional()
    .describe('Reference a plugin published in another marketplace/repo. VAT never builds or copies it — the source object is emitted verbatim into marketplace.json. See ExternalPluginSourceSchema'),
}).strict().superRefine((entry, ctx) => {
  if (entry.externalSource === undefined) return;
  const skillsIsEmpty = entry.skills !== '*' && entry.skills.length === 0;
  if (!skillsIsEmpty) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['skills'],
      message: 'skills must be [] when externalSource is set — an external plugin is never built locally',
    });
  }
  for (const field of ['source', 'exclude', 'changelog'] as const) {
    if (entry[field] !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `${field} is incompatible with externalSource — an external plugin is never built locally`,
      });
    }
  }
  if (entry.files !== undefined && entry.files.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['files'],
      message: 'files is incompatible with externalSource — an external plugin is never built locally',
    });
  }
}).describe('Plugin entry within a marketplace configuration');

export type ClaudeMarketplacePluginEntry = z.infer<typeof ClaudeMarketplacePluginEntrySchema>;

/**
 * Publish configuration for a Claude marketplace.
 * Controls where and how the marketplace is published to a Git branch or repo.
 */
export const ClaudeMarketplacePublishSchema = z.object({
  branch: z.string().optional()
    .describe('Target branch name (default: claude-marketplace)'),
  remote: z.string().optional()
    .describe('Git remote name (e.g., "origin") or full URL (e.g., "https://github.com/org/marketplace-repo.git") for cross-repo publishing (default: origin)'),
  changelog: z.string().optional()
    .describe('Path to marketplace changelog (Keep a Changelog format; used during both build and publish, overriding project root CHANGELOG.md)'),
  readme: z.string().optional()
    .describe('Path to marketplace README (used during both build and publish, overriding project root README.md)'),
  license: z.string().optional()
    .describe('SPDX license identifier (e.g., "mit") or file path (e.g., "./LICENSE")'),
  sourceRepo: z.union([z.boolean(), z.string()]).optional()
    .describe('Source repo URL for commit metadata (false to disable, string to override)'),
}).strict().describe('Publish configuration for marketplace distribution');

export type ClaudeMarketplacePublish = z.infer<typeof ClaudeMarketplacePublishSchema>;

/**
 * Configuration for a single Claude marketplace.
 */
export const ClaudeMarketplaceSchema = z.object({
  owner: z.object({
    name: z.string(),
    email: z.string().optional(),
  }).strict().describe('Marketplace owner information'),

  skills: z.union([z.literal('*'), z.array(z.string())]).optional()
    .describe('Default skill filter for the marketplace — restricts which skills are available when plugins use skills: "*". Omit to allow all skills. This does NOT add skills directly; skills are always selected per-plugin.'),

  publish: ClaudeMarketplacePublishSchema.optional()
    .describe('Publish configuration for marketplace distribution'),

  plugins: z.array(ClaudeMarketplacePluginEntrySchema).min(1)
    .describe('Plugin groupings within this marketplace'),
}).strict().describe('Configuration for a Claude plugin marketplace');

export type ClaudeMarketplaceConfig = z.infer<typeof ClaudeMarketplaceSchema>;

/**
 * Claude-specific section of project configuration.
 */
export const ClaudeConfigSchema = z.object({
  managedSettings: z.string().optional()
    .describe('Path to managed-settings.json for schema validation (relative to config file)'),
  marketplaces: z.record(z.string(), ClaudeMarketplaceSchema).optional()
    .describe('Named map of Claude plugin marketplaces (never singleton)'),
}).strict().describe('Claude-specific project configuration');

export type ClaudeConfig = z.infer<typeof ClaudeConfigSchema>;

/**
 * Global `vat skill test` configuration (top-level, NOT per-skill).
 *
 * Deliberately separate from the per-skill {@link TestConfigSchema}: `graderModel`
 * is a global grader/judge selection that applies across all skills' test runs,
 * whereas `TestConfigSchema` configures the model/harness under test for a single
 * skill. Mixing the two would let a per-skill override silently change the judge,
 * undermining cross-skill eval comparability (issue #145).
 */
export const SkillTestGlobalConfigSchema = z.object({
  graderModel: z.string().min(1).optional()
    .describe('Pinned grader/judge model for `vat skill test` grading (default: DEFAULT_GRADER_MODEL)'),
  concurrency: z.number().int().positive().optional()
    .describe('Bounded-parallel executor→grader pipeline width (default: DEFAULT_CONCURRENCY)'),
}).strict().describe('Global vat skill test configuration (graderModel, concurrency)');

export type SkillTestGlobalConfig = z.infer<typeof SkillTestGlobalConfigSchema>;

/**
 * Complete project configuration schema.
 */
export const ProjectConfigSchema = z.object({
  version: z.literal(1)
    .describe('Config file version (must be 1)'),
  skills: SkillsConfigSchema.optional()
    .describe('Skills discovery and packaging configuration'),
  resources: ResourcesConfigSchema.optional()
    .describe('Resources configuration'),
  claude: ClaudeConfigSchema.optional()
    .describe('Claude-specific configuration (marketplaces, managed-settings)'),
  extents: ExtentsConfigSchema.optional()
    .describe('Closure-defined extents (zones.md §7.3), keyed by extent name'),
  test: SkillTestGlobalConfigSchema.optional()
    .describe('Global vat skill test configuration (graderModel, concurrency)'),
}).strict().describe('vibe-agent-toolkit project configuration');

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
