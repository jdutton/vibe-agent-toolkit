/**
 * JSON Schema utilities
 *
 * Provides convenience functions for converting Zod schemas to JSON Schema
 * with vibe-agent-toolkit conventions and enhancements.
 */

import type { ZodSchema } from 'zod';
import { zodToJsonSchema, type Options } from 'zod-to-json-schema';

/**
 * Options for JSON Schema generation
 *
 * Extends zod-to-json-schema options with toolkit-specific enhancements
 */
export interface JsonSchemaOptions extends Partial<Options> {
  /**
   * Include toolkit version metadata in the generated schema
   * Adds x-vat-version field to the schema root
   *
   * @default false
   */
  includeToolkitMetadata?: boolean;

  /**
   * Override the JSON Schema draft version
   *
   * @default "https://json-schema.org/draft/2020-12/schema"
   */
  $schema?: string;
}

/**
 * Convert Zod schema to JSON Schema with vibe-agent-toolkit conventions
 *
 * This function wraps zod-to-json-schema with sensible defaults and
 * toolkit-specific enhancements:
 *
 * - Sets $schema to JSON Schema Draft 2020-12 by default
 * - Uses inline refs (no $ref strategy) for simpler schemas
 * - Optionally injects toolkit version metadata
 * - Provides a stable interface for future enhancements
 *
 * @example
 * ```typescript
 * import { z } from 'zod';
 * import { toJsonSchema } from '@vibe-agent-toolkit/agent-schema';
 *
 * const MySchema = z.object({
 *   name: z.string().describe('User name'),
 *   age: z.number().min(0),
 * });
 *
 * const jsonSchema = toJsonSchema(MySchema, {
 *   name: 'my-schema',
 *   includeToolkitMetadata: true,
 * });
 * ```
 *
 * @param schema - Zod schema to convert
 * @param options - Conversion options
 * @returns JSON Schema object
 */
export function toJsonSchema(schema: ZodSchema, options?: JsonSchemaOptions): object {
  const {
    includeToolkitMetadata = false,
    $schema: schemaVersion = 'https://json-schema.org/draft/2020-12/schema',
    ...zodOptions
  } = options ?? {};

  // Convert with default strategy: inline refs for simplicity
  const jsonSchema = zodToJsonSchema(schema, {
    $refStrategy: 'none',
    ...zodOptions,
  }) as Record<string, unknown>;

  // Override $schema to ensure our standard version
  jsonSchema['$schema'] = schemaVersion;

  // Optional: Add toolkit metadata
  if (includeToolkitMetadata) {
    // NOTE: Version hardcoded until it becomes meaningful for adopters
    jsonSchema['x-vat-version'] = '0.1.1';
  }

  return jsonSchema;
}
