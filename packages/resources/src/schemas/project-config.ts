import { ValidationConfigSchema } from '@vibe-agent-toolkit/agent-schema';
import { hasParentTraversalSegment, isAbsoluteAnyPlatform } from '@vibe-agent-toolkit/utils';
import { z } from 'zod';

import { LinkAuthConfigSchema } from './link-auth.js';

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
export { ValidationConfigSchema } from '@vibe-agent-toolkit/agent-schema';

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
 * Collections define include/exclude patterns and validation rules.
 * A file can belong to multiple collections.
 */
export const CollectionConfigSchema = z.object({
  include: z.array(z.string()).min(1)
    .describe('Include patterns (paths or globs like docs/**/*.md)'),
  exclude: z.array(z.string()).optional()
    .describe('Exclude patterns (globs)'),
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
// Skill packaging configuration (self-contained — no agent-schema dependency)
// ---------------------------------------------------------------------------

/**
 * A rule for excluding references from a skill bundle.
 */
export const ExcludeReferenceRuleSchema = z.object({
  patterns: z.array(z.string()).describe('Glob patterns matched against path relative to skill root'),
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
  source: z.string().min(1).describe('Source path relative to project root'),
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
// Claude marketplace configuration
// ---------------------------------------------------------------------------

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
 */
export const ClaudeMarketplacePluginEntrySchema = z.object({
  name: z.string()
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'Plugin name must be lowercase alphanumeric with hyphens (regex: ^[a-z0-9][a-z0-9-]*$)')
    .describe('Plugin name (lowercase alphanumeric with hyphens)'),
  description: z.string().optional()
    .describe('Plugin description'),
  skills: z.union([z.literal('*'), z.array(z.string())])
    .describe('Skills to include: "*" for all, or array of skill name selectors'),
  source: z.string().optional()
    .describe('Path to plugin directory (default: plugins/<name>)'),
  files: z.array(SkillFileEntrySchema).optional()
    .describe('Explicit source→dest file mappings for compiled artifacts outside the plugin directory'),
  exclude: z.array(z.string()).optional()
    .describe('Patterns (relative to the plugin source dir) to leave out of the verbatim tree-copy: a glob ("scratch/**"), or a directory name with or without a trailing slash ("scratch", "scratch/") which covers that directory and everything under it'),
  version: z.string().regex(SEMVER_REGEX, {
    message: 'version must be a valid semver string (e.g., "1.2.3" or "1.0.0-rc.1")',
  }).optional()
    .describe('Per-plugin semver version (overrides root package.json:version for this plugin)'),
  changelog: z.string().optional()
    .describe('Path to per-plugin CHANGELOG (relative to plugin source dir; default: <source>/CHANGELOG.md if it exists)'),
}).strict().describe('Plugin entry within a marketplace configuration');

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
  test: SkillTestGlobalConfigSchema.optional()
    .describe('Global vat skill test configuration (graderModel, concurrency)'),
}).strict().describe('vibe-agent-toolkit project configuration');

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
