/**
 * Zod type introspection utilities
 *
 * Provides version-agnostic type detection using duck typing instead of
 * instanceof checks, which fail across Zod v3/v4 boundaries.
 *
 * @module zod-introspection
 */

/**
 * Zod type names from _def.typeName
 *
 * These internal type names are stable across Zod v3 and v4.
 * Using these constants instead of instanceof checks ensures
 * compatibility when user's Zod version differs from library's.
 *
 * @see https://github.com/colinhacks/zod/issues/2543
 */
export const ZodTypeNames = {
  STRING: 'ZodString',
  NUMBER: 'ZodNumber',
  BOOLEAN: 'ZodBoolean',
  ARRAY: 'ZodArray',
  OBJECT: 'ZodObject',
  ENUM: 'ZodEnum',
  OPTIONAL: 'ZodOptional',
  NULLABLE: 'ZodNullable',
  DATE: 'ZodDate',
  LITERAL: 'ZodLiteral',
  UNION: 'ZodUnion',
  INTERSECTION: 'ZodIntersection',
  TUPLE: 'ZodTuple',
  RECORD: 'ZodRecord',
  MAP: 'ZodMap',
  SET: 'ZodSet',
  FUNCTION: 'ZodFunction',
  LAZY: 'ZodLazy',
  PROMISE: 'ZodPromise',
  BRANDED: 'ZodBranded',
  PIPELINE: 'ZodPipeline',
  READONLY: 'ZodReadonly',
  SYMBOL: 'ZodSymbol',
  UNDEFINED: 'ZodUndefined',
  NULL: 'ZodNull',
  ANY: 'ZodAny',
  UNKNOWN: 'ZodUnknown',
  NEVER: 'ZodNever',
  VOID: 'ZodVoid',
  BIGINT: 'ZodBigInt',
  EFFECTS: 'ZodEffects',
  NATIVENUM: 'ZodNativeEnum',
  DISCRIMINATED_UNION: 'ZodDiscriminatedUnion',
  DEFAULT: 'ZodDefault',
  CATCH: 'ZodCatch',
  NAN: 'ZodNaN',
} as const;

/**
 * Type representing valid Zod type names
 */
export type ZodTypeName = (typeof ZodTypeNames)[keyof typeof ZodTypeNames];

/**
 * Convert Zod v4 lowercase type to v3 PascalCase format
 *
 * Zod v4 changed from _def.typeName ('ZodString') to _def.type ('string').
 * This function normalizes v4 types to match v3 format for consistency.
 *
 * @param v4Type - Lowercase type from Zod v4 _def.type
 * @returns PascalCase type name with 'Zod' prefix
 * @internal
 *
 * @example
 * ```typescript
 * zodV4TypeToV3Name('string')  // 'ZodString'
 * zodV4TypeToV3Name('array')   // 'ZodArray'
 * zodV4TypeToV3Name('optional') // 'ZodOptional'
 * ```
 */
function zodV4TypeToV3Name(v4Type: string): string {
  // Handle special cases with different naming
  const specialCases: Record<string, string> = {
    nativeenum: 'ZodNativeEnum',
    bigint: 'ZodBigInt',
  };

  if (specialCases[v4Type]) {
    return specialCases[v4Type];
  }

  // Convert: 'string' → 'ZodString', 'array' → 'ZodArray'
  return 'Zod' + v4Type.charAt(0).toUpperCase() + v4Type.slice(1);
}

/**
 * Get Zod type name in version-agnostic way
 *
 * Supports both Zod v3 and v4:
 * - Zod v3: Uses _def.typeName (e.g., 'ZodString')
 * - Zod v4: Uses _def.type (e.g., 'string'), converts to v3 format
 *
 * Uses duck typing instead of instanceof checks, which fail when
 * user's Zod version differs from library's Zod version.
 *
 * @param zodType - Zod type to introspect
 * @returns Type name string (e.g., 'ZodString') or undefined if not a Zod type
 *
 * @example
 * ```typescript
 * import { z } from 'zod';
 * import { getZodTypeName, ZodTypeNames } from '@vibe-agent-toolkit/utils';
 *
 * const schema = z.string();
 * const typeName = getZodTypeName(schema);
 * console.log(typeName); // 'ZodString' (both v3 and v4)
 *
 * if (typeName === ZodTypeNames.STRING) {
 *   console.log('It\'s a string schema!');
 * }
 * ```
 */
export function getZodTypeName(zodType: unknown): string | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const def = (zodType as any)?._def;
  if (!def) return undefined;

  // Zod v3: uses _def.typeName (e.g., 'ZodString')
  if (def.typeName) {
    return def.typeName;
  }

  // Zod v4: uses _def.type (e.g., 'string')
  // Convert to Zod v3 format for consistency
  if (def.type) {
    return zodV4TypeToV3Name(def.type);
  }

  return undefined;
}

/**
 * Check if Zod type matches expected type name
 *
 * Version-agnostic type checking using duck typing.
 * Safer than instanceof when Zod versions may differ.
 *
 * @param zodType - Zod type to check
 * @param typeName - Expected type name constant from ZodTypeNames
 * @returns True if type matches, false otherwise
 *
 * @example
 * ```typescript
 * import { z } from 'zod';
 * import { isZodType, ZodTypeNames } from '@vibe-agent-toolkit/utils';
 *
 * const schema = z.array(z.string());
 *
 * if (isZodType(schema, ZodTypeNames.ARRAY)) {
 *   console.log('It\'s an array schema!');
 * }
 * ```
 */
export function isZodType(zodType: unknown, typeName: ZodTypeName): boolean {
  return getZodTypeName(zodType) === typeName;
}

/**
 * Unwrap optional/nullable Zod types to get inner type
 *
 * Recursively unwraps ZodOptional and ZodNullable to reach
 * the underlying type. Returns original type if not wrapped.
 *
 * @param zodType - Zod type to unwrap
 * @returns Unwrapped Zod type
 *
 * @example
 * ```typescript
 * import { z } from 'zod';
 * import { unwrapZodType, getZodTypeName, ZodTypeNames } from '@vibe-agent-toolkit/utils';
 *
 * const schema = z.string().optional();
 * const unwrapped = unwrapZodType(schema);
 *
 * console.log(getZodTypeName(unwrapped)); // 'ZodString'
 * ```
 */
export function unwrapZodType(zodType: unknown): unknown {
  const typeName = getZodTypeName(zodType);

  if (typeName === ZodTypeNames.OPTIONAL || typeName === ZodTypeNames.NULLABLE) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inner = (zodType as any).unwrap?.() ?? (zodType as any)._def?.innerType;
    return inner ? unwrapZodType(inner) : zodType;
  }

  return zodType;
}

/**
 * Check if Zod type is optional (ZodOptional)
 *
 * @param zodType - Zod type to check
 * @returns True if type is optional
 */
export function isZodOptional(zodType: unknown): boolean {
  return isZodType(zodType, ZodTypeNames.OPTIONAL);
}

/**
 * Check if Zod type is nullable (ZodNullable)
 *
 * @param zodType - Zod type to check
 * @returns True if type is nullable
 */
export function isZodNullable(zodType: unknown): boolean {
  return isZodType(zodType, ZodTypeNames.NULLABLE);
}
