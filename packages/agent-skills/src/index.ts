/**
 * @vibe-agent-toolkit/agent-skills
 * Build, validate, and package agent skills in the Agent Skills format
 */

export { buildAgentSkill, type BuildOptions, type BuildResult } from './builder.js';

export {
  createProjectRegistry,
  extractH1Title,
  packageSkill,
  packageSkills,
  packagingConfigToPackageOptions,
  ZipSizeLimitError,
  type PackageSkillOptions,
  type PackageSkillResult,
  type PackagingTarget,
  type ProjectRegistryOptions,
  type SkillBuildSpec,
  type SkillMetadata,
  type SkillPackageOutcome,
} from './skill-packager.js';

export {
  walkLinkGraph,
  type ExcludeRule,
  type LinkGraphResult,
  type LinkResolution,
  type WalkableRegistry,
  type WalkLinkGraphOptions,
} from './walk-link-graph.js';

// The skill extent (zones §7.3): the closure primitive under a skill's name,
// plus the translation of `SkillPackagingConfig` into the declaration that
// shapes it. Deliberately NOT a second walker — see the module note for the
// measured boundary between what the declaration expresses and what only
// `walkLinkGraph`'s ordered cascade can.
export {
  SKILL_EXTENT_CONTRIBUTOR_ID_PREFIX,
  skillExtentContributorId,
  SKILL_EXTENT_KIND,
  SKILL_REFUSED_AGENT_INSTRUCTION_FILE,
  SKILL_REFUSED_DIRECTORY_TARGET,
  SKILL_REFUSED_GITIGNORED,
  SKILL_REFUSED_NAVIGATION_FILE,
  SKILL_REFUSED_PATTERN_MATCHED,
  SKILL_REFUSED_SKILL_DEFINITION,
  SkillExtentContributor,
  skillExtentDeclaration,
} from './projection/skill-extent.js';

export {
  getTargetSubdir,
  CONTENT_TYPE_ROUTING_MAP,
  type TargetSubdirCategory,
} from './content-type-routing.js';

export {
  applyFilesConfig,
  collectPreBuildGlobFindings,
  droppedGlobMatchesToIssues,
  explicitFilesConfigDests,
  mergeFilesConfig,
  preBuildGlobFindingsToIssues,
  skippedGlobMatchesToIssues,
  type AllRefusedGlobEntry,
  type AppliedFilesConfig,
  type ApplyFilesConfigOptions,
  type DroppedGlobMatch,
  type PreBuildGlobFindings,
  type UnmatchedGlobEntry,
} from './files-config.js';

export {
  AgentSkillFrontmatterJsonSchema,
  AgentSkillFrontmatterSchema,
  VATAgentSkillFrontmatterSchema,
  type AgentSkillFrontmatter,
  type VATAgentSkillFrontmatter,
} from './schemas/agent-skill-frontmatter.js';

export { MarketplaceManifestJsonSchema, MarketplaceManifestSchema, type MarketplaceManifest } from './schemas/marketplace-manifest.js';

export {
  parseFrontmatter,
  type FrontmatterResult,
} from './parsers/frontmatter-parser.js';

export { readDeclaredSkillName } from './skill-identity.js';

export { type AnchorRootOptions, resolveAnchorRoot } from './validators/anchor-root.js';
export { generateFixSuggestion } from './validators/validation-utils.js';
export { detectKebabCaseViolation, type KebabCaseSurface } from './validators/kebab-case-detection.js';
export { detectMissingRecommendedFields } from './validators/plugin-recommended-fields.js';
export { detectPackagedAgentInstructionFiles } from './validators/agent-instruction-presence.js';
// The single construction site for a coded finding. Exported so a CLI lane that
// discovers a finding of its own builds it from CODE_REGISTRY like every other
// producer — a hand-rolled `{severity, code, message, fix, reference}` literal is
// how docs, runtime, and tests come to disagree.
export { materializeIssue, type MaterializeOpts } from './validators/rule-engine/index.js';
export { detectHostedIncompatibleShape } from './validators/plugin-hosted-shape.js';
export {
  deriveObservations,
  observationToIssue,
  runCompatDetectors,
  type DetectorOutput,
} from './validators/compat-detectors.js';
export { validateMarketplace } from './validators/marketplace-validator.js';
export { validateSkill } from './validators/skill-validator.js';
export { validate, type UnifiedValidateOptions } from './validators/unified-validator.js';
export { detectResourceFormat, enumerateSurfaces } from './validators/format-detection.js';
export {
  activeErrorsOf,
  activeWarningsOf,
  crawlAndResolveRegistry,
  resetPackagingRegistryCache,
  validateSkillForPackaging,
  type CrawlRegistryOptions,
  type ExcludedReferenceDetail,
  type PackagingValidationResult,
  type SkillPackagingConfig,
  type SkillValidationSharedContext,
} from './validators/packaging-validator.js';
export {
  AGENT_INSTRUCTION_FILE_PATTERNS,
  createIssue,
  isAgentInstructionBasename,
  isNavigationBasename,
  isNeverPackagedBasename,
  NAVIGATION_FILE_PATTERNS,
  NEVER_PACKAGE_IN_SKILL_BUNDLE,
  toAnyDepthGlobs,
  VALIDATION_RULES,
  VALIDATION_THRESHOLDS,
  type RuleCategory,
  type ValidationRule,
  type ValidationRuleCode,
} from './validators/validation-rules.js';
export type {
  ValidationResult,
  ValidateOptions,
  ResourceFormat,
  Surface,
} from './validators/types.js';

export {
  importSkillToAgent,
  type ImportOptions,
  type ImportResult,
} from './import.js';

// Skill source primitives
export { cloneGitSource, type GitCloneResult } from './skill-source/git-clone.js';

// Unified skill-source resolution (spec §11c)
export { resolveSkillSource, type ResolveSkillSourceOptions } from './skill-source/resolve-skill-source.js';
export type {
  SkillSource,
  ResolvedSkillSource,
  ResolveSkillSourceContext,
} from './skill-source/types.js';

// Evidence substrate
export type {
  EvidenceRecord,
  EvidenceSource,
  EvidenceConfidence,
  EvidenceLocation,
  PatternDefinition,
  Observation,
} from './evidence/index.js';
export {
  PATTERN_REGISTRY,
  anchorEvidencePath,
  buildEvidence,
  getPatternDefinition,
  assertPatternRegistered,
  deriveObservationsFromEvidence,
} from './evidence/index.js';
export type { DeriveObservationsOptions, DerivationSubject } from './evidence/index.js';

// Inventory
export type {
  AnyInventory,
  BaseInventory,
  ComponentRef,
  DeclaredList,
  HookRef,
  InstallInventory,
  LspRef,
  MarketplaceInventory,
  McpRef,
  ParseError as InventoryParseError,
  PluginInventory,
  PluginRef,
  ResolvedReference,
  SkillInventory,
} from './inventory/index.js';
export {
  isInstallInventory,
  isMarketplaceInventory,
  isPluginInventory,
  isSkillInventory,
  serializeInventory,
  serializeInventoryShallow,
  detectDeclaredButMissing,
  detectMarketplacePluginSourceMissing,
  detectPresentButUndeclared,
  detectReferenceTargetMissing,
} from './inventory/index.js';

export * from './skill-test/index.js';

export { checkBrokenPackagedLinks } from './post-build-checks.js';
export {
  checkPackagedTestInput,
  conventionalSuiteProbe,
  packagedFileEntries,
  resolveTestInputDirs,
  testInputExcludeRules,
  type CheckPackagedTestInputInput,
  type ConventionalSuiteProbe,
  type DeclaredEvalSuite,
} from './test-input.js';

export {
  computeTreeCopiedSkillLocations,
  findDistributedSkillLocationBySource,
  getPluginOutputDir,
  getPluginSourceDir,
  listPluginSourceSkillDirs,
  listUntrackedPluginSkillDirs,
  skillNameToFsPath,
  type DistributedSkillLocation,
} from './plugin-distribution-layout.js';
