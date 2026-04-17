/**
 * @vibe-agent-toolkit/agent-skills
 * Build, validate, and package agent skills in the Agent Skills format
 */

export { buildAgentSkill, type BuildOptions, type BuildResult } from './builder.js';

export {
  extractH1Title,
  packageSkill,
  packageSkills,
  ZipSizeLimitError,
  type PackageSkillOptions,
  type PackageSkillResult,
  type PackagingTarget,
  type SkillBuildSpec,
  type SkillMetadata,
} from './skill-packager.js';

export {
  walkLinkGraph,
  type ExcludeRule,
  type LinkGraphResult,
  type LinkResolution,
  type WalkableRegistry,
  type WalkLinkGraphOptions,
} from './walk-link-graph.js';

export {
  getTargetSubdir,
  CONTENT_TYPE_ROUTING_MAP,
  type TargetSubdirCategory,
} from './content-type-routing.js';

export {
  mergeFilesConfig,
  matchLinkToFiles,
  computeDeferredPaths,
  type FilesMatchResult,
} from './files-config.js';

export {
  AgentSkillFrontmatterJsonSchema,
  AgentSkillFrontmatterSchema,
  VATAgentSkillFrontmatterSchema,
  type AgentSkillFrontmatter,
  type VATAgentSkillFrontmatter,
} from './schemas/agent-skill-frontmatter.js';

export { ClaudePluginJsonSchema, ClaudePluginSchema, type ClaudePlugin } from './schemas/claude-plugin.js';

export { MarketplaceManifestJsonSchema, MarketplaceManifestSchema, type MarketplaceManifest } from './schemas/marketplace-manifest.js';

export { PluginJsonSchema, type PluginJson } from './schemas/plugin-json.js';

export {
  parseFrontmatter,
  type FrontmatterResult,
} from './parsers/frontmatter-parser.js';

export { runCompatDetectors } from './validators/compat-detectors.js';
export { validateMarketplace } from './validators/marketplace-validator.js';
export { validatePlugin } from './validators/plugin-validator.js';
export { validateSkill } from './validators/skill-validator.js';
export { validate } from './validators/unified-validator.js';
export { detectResourceFormat } from './validators/format-detection.js';
export {
  validateSkillForPackaging,
  type ExcludedReferenceDetail,
  type PackagingValidationResult,
  type SkillPackagingConfig,
} from './validators/packaging-validator.js';
export { type ValidationConfig } from './validators/validation-framework.js';
export {
  createIssue,
  NAVIGATION_FILE_PATTERNS,
  VALIDATION_RULES,
  VALIDATION_THRESHOLDS,
  type RuleCategory,
  type ValidationRule,
  type ValidationRuleCode,
} from './validators/validation-rules.js';
export type {
  ValidationResult,
  ValidationIssue,
  ValidateOptions,
  ResourceFormat,
} from './validators/types.js';

export {
  importSkillToAgent,
  type ImportOptions,
  type ImportResult,
} from './import.js';

