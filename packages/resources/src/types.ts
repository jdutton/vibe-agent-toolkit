/**
 * Type definitions for the resources package.
 *
 * This module re-exports all types from the Zod schemas for convenient imports.
 * All types are automatically inferred from their corresponding Zod schemas,
 * ensuring TypeScript types and runtime validation remain synchronized.
 *
 * @example
 * ```typescript
 * import type { ResourceMetadata, ValidationResult } from '@vibe-agent-toolkit/resources';
 * ```
 */

// Checksum types
export type { SHA256 } from './schemas/checksum.js';
export { SHA256Schema } from './schemas/checksum.js';

// Resource metadata types
export type {
  LinkType,
  HeadingNode,
  ResourceLink,
  ResourceMetadata,
} from './schemas/resource-metadata.js';

// Validation result types
export type {
  ValidationSeverity,
  ValidationIssue,
  ValidationResult,
} from './schemas/validation-result.js';
