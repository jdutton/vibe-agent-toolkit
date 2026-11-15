/**
 * @vibe-agent-toolkit/schema
 *
 * The shared contracts every VAT package speaks: validation codes, issues and
 * reports, severities, the exit-code contract, the project validation config,
 * and the package.json `vat` metadata — as Zod schemas, TypeScript types and
 * generated JSON Schema.
 */

// JSON Schema utilities
export { presenceImplies, toJsonSchema, type JsonSchemaOptions } from './schema-utils.js';

// Canonical validation code registry
export * from './validation-codes.js';

// The one severity vocabulary, the one finding, the one report envelope
export * from './severity.js';
export * from './report.js';

// Unified validation issue + framework
export * from './validation-issue.js';
export * from './validation-framework.js';

// The one exit-code contract every VAT process ends on
export * from './exit-code.js';

// Which refusal a classified filesystem fault is (side × class)
export * from './fs-fault-refusals.js';

// package.json `vat` metadata
export {
  SKILL_NAME_REGEX,
  SKILL_NAME_REGEX_MESSAGE,
  VatPackageMetadataSchema,
  VatSkillMetadataSchema,
  type VatPackageMetadata,
  type VatSkillMetadata,
} from './package-metadata.js';

export {
  AllowEntrySchema,
  ValidationConfigSchema,
  type AllowEntry,
  type ValidationConfig,
} from './validation-config.js';
// `ValidationConfig` is the single canonical config type: the hand-written type
// from validation-config.ts. validation-framework.ts re-exports the same type
// (and derives SeverityConfig/AllowConfig from it), so there is no collision —
// `export *` from validation-framework.js surfaces the identical symbol.
