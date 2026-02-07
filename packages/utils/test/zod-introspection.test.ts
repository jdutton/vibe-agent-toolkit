/**
 * Unit tests for Zod introspection utilities
 *
 * These utilities provide version-agnostic Zod type detection via duck typing,
 * supporting both Zod v3.25.0+ and v4.0.0+ simultaneously.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  getZodTypeName,
  isZodType,
  unwrapZodType,
  ZodTypeNames,
  type ZodTypeName,
} from '../src/zod-introspection.js';

describe('Zod Introspection', () => {
  describe('getZodTypeName', () => {
    describe('Primitive Types', () => {
      it('should detect string type', () => {
        const schema = z.string();
        expect(getZodTypeName(schema)).toBe(ZodTypeNames.STRING);
      });

      it('should detect number type', () => {
        const schema = z.number();
        expect(getZodTypeName(schema)).toBe(ZodTypeNames.NUMBER);
      });

      it('should detect boolean type', () => {
        const schema = z.boolean();
        expect(getZodTypeName(schema)).toBe(ZodTypeNames.BOOLEAN);
      });

      it('should detect bigint type', () => {
        const schema = z.bigint();
        expect(getZodTypeName(schema)).toBe(ZodTypeNames.BIGINT);
      });

      it('should detect date type', () => {
        const schema = z.date();
        expect(getZodTypeName(schema)).toBe(ZodTypeNames.DATE);
      });

      it('should detect undefined type', () => {
        const schema = z.undefined();
        expect(getZodTypeName(schema)).toBe(ZodTypeNames.UNDEFINED);
      });

      it('should detect null type', () => {
        const schema = z.null();
        expect(getZodTypeName(schema)).toBe(ZodTypeNames.NULL);
      });

      it('should detect any type', () => {
        const schema = z.any();
        expect(getZodTypeName(schema)).toBe(ZodTypeNames.ANY);
      });

      it('should detect unknown type', () => {
        const schema = z.unknown();
        expect(getZodTypeName(schema)).toBe(ZodTypeNames.UNKNOWN);
      });

      it('should detect void type', () => {
        const schema = z.void();
        expect(getZodTypeName(schema)).toBe(ZodTypeNames.VOID);
      });
    });

    describe('Complex Types', () => {
      it('should detect array type', () => {
        const schema = z.array(z.string());
        expect(getZodTypeName(schema)).toBe(ZodTypeNames.ARRAY);
      });

      it('should detect object type', () => {
        const schema = z.object({ name: z.string() });
        expect(getZodTypeName(schema)).toBe(ZodTypeNames.OBJECT);
      });

      it('should detect record type', () => {
        const schema = z.record(z.string());
        expect(getZodTypeName(schema)).toBe(ZodTypeNames.RECORD);
      });

      it('should detect map type', () => {
        const schema = z.map(z.string(), z.number());
        expect(getZodTypeName(schema)).toBe(ZodTypeNames.MAP);
      });

      it('should detect set type', () => {
        const schema = z.set(z.string());
        expect(getZodTypeName(schema)).toBe(ZodTypeNames.SET);
      });

      it('should detect tuple type', () => {
        const schema = z.tuple([z.string(), z.number()]);
        expect(getZodTypeName(schema)).toBe(ZodTypeNames.TUPLE);
      });

      it('should detect enum type', () => {
        const schema = z.enum(['red', 'green', 'blue']);
        expect(getZodTypeName(schema)).toBe(ZodTypeNames.ENUM);
      });

      it('should detect nativeEnum type', () => {
        enum Color {
          Red = 'red',
          Green = 'green',
          Blue = 'blue',
        }
        const schema = z.nativeEnum(Color);
        expect(getZodTypeName(schema)).toBe(ZodTypeNames.NATIVENUM);
      });

      it('should detect literal type', () => {
        const schema = z.literal('hello');
        expect(getZodTypeName(schema)).toBe(ZodTypeNames.LITERAL);
      });

      it('should detect union type', () => {
        const schema = z.union([z.string(), z.number()]);
        expect(getZodTypeName(schema)).toBe(ZodTypeNames.UNION);
      });

      it('should detect discriminated union type', () => {
        const schema = z.discriminatedUnion('type', [
          z.object({ type: z.literal('a'), a: z.string() }),
          z.object({ type: z.literal('b'), b: z.number() }),
        ]);
        expect(getZodTypeName(schema)).toBe(ZodTypeNames.DISCRIMINATED_UNION);
      });

      it('should detect intersection type', () => {
        const schema = z.intersection(
          z.object({ name: z.string() }),
          z.object({ age: z.number() }),
        );
        expect(getZodTypeName(schema)).toBe(ZodTypeNames.INTERSECTION);
      });

      it('should detect promise type', () => {
        const schema = z.promise(z.string());
        expect(getZodTypeName(schema)).toBe(ZodTypeNames.PROMISE);
      });

      it('should detect function type', () => {
        const schema = z.function().args(z.string()).returns(z.number());
        expect(getZodTypeName(schema)).toBe(ZodTypeNames.FUNCTION);
      });

      it('should detect lazy type', () => {
        // Lazy schema for recursive type (simplified to avoid deep nesting)
        interface Node {
          value: string;
          children?: Node[];
        }
        // Disable nesting rule for this test - lazy requires callback
        // eslint-disable-next-line sonarjs/no-nested-functions
        const schema: z.ZodType<Node> = z.lazy(() =>
          z.object({
            value: z.string(),
            children: z.array(z.any() as z.ZodType<Node>).optional(),
          }),
        );
        expect(getZodTypeName(schema)).toBe(ZodTypeNames.LAZY);
      });
    });

    describe('Wrapper Types', () => {
      it('should detect optional type', () => {
        const schema = z.string().optional();
        expect(getZodTypeName(schema)).toBe(ZodTypeNames.OPTIONAL);
      });

      it('should detect nullable type', () => {
        const schema = z.string().nullable();
        expect(getZodTypeName(schema)).toBe(ZodTypeNames.NULLABLE);
      });

      it('should detect default type', () => {
        const schema = z.string().default('hello');
        expect(getZodTypeName(schema)).toBe(ZodTypeNames.DEFAULT);
      });

      it('should detect branded type', () => {
        const schema = z.string().brand<'UserId'>();
        expect(getZodTypeName(schema)).toBe(ZodTypeNames.BRANDED);
      });

      it('should detect catch type', () => {
        const schema = z.string().catch('fallback');
        expect(getZodTypeName(schema)).toBe(ZodTypeNames.CATCH);
      });

      it('should detect pipeline type', () => {
        const schema = z.string().pipe(z.string().email());
        expect(getZodTypeName(schema)).toBe(ZodTypeNames.PIPELINE);
      });
    });

    describe('Special Types', () => {
      it('should detect effects (preprocess) type', () => {
        // Preprocess with direct function reference (no arrow function needed)
        const schema = z.preprocess(String, z.string());
        expect(getZodTypeName(schema)).toBe(ZodTypeNames.EFFECTS);
      });

      it('should detect effects (refine) type', () => {
        // Refine requires callback - disable nesting rule
        // eslint-disable-next-line sonarjs/no-nested-functions
        const schema = z.string().refine((val: string) => val.length > 0);
        expect(getZodTypeName(schema)).toBe(ZodTypeNames.EFFECTS);
      });

      it('should detect effects (transform) type', () => {
        // Transform requires callback - disable nesting rule
        // eslint-disable-next-line sonarjs/no-nested-functions
        const schema = z.string().transform((val: string) => val.toUpperCase());
        expect(getZodTypeName(schema)).toBe(ZodTypeNames.EFFECTS);
      });

      it('should detect nan type', () => {
        const schema = z.nan();
        expect(getZodTypeName(schema)).toBe(ZodTypeNames.NAN);
      });
    });

    describe('Edge Cases', () => {
      it('should return undefined for non-Zod objects', () => {
        expect(getZodTypeName({})).toBeUndefined();
        expect(getZodTypeName({ _def: null })).toBeUndefined();
        expect(getZodTypeName({ _def: {} })).toBeUndefined();
      });

      it('should return undefined for null', () => {
        expect(getZodTypeName(null)).toBeUndefined();
      });

      it('should return undefined for undefined', () => {
        expect(getZodTypeName(undefined)).toBeUndefined();
      });

      it('should return undefined for primitives', () => {
        expect(getZodTypeName('string')).toBeUndefined();
        expect(getZodTypeName(123)).toBeUndefined();
        expect(getZodTypeName(true)).toBeUndefined();
      });

      it('should handle objects with _def but no typeName or type', () => {
        const fakeSchema = { _def: { somethingElse: 'value' } };
        expect(getZodTypeName(fakeSchema)).toBeUndefined();
      });
    });
  });

  describe('isZodType', () => {
    it('should correctly identify string type', () => {
      const schema = z.string();
      expect(isZodType(schema, ZodTypeNames.STRING)).toBe(true);
      expect(isZodType(schema, ZodTypeNames.NUMBER)).toBe(false);
    });

    it('should correctly identify array type', () => {
      const schema = z.array(z.string());
      expect(isZodType(schema, ZodTypeNames.ARRAY)).toBe(true);
      expect(isZodType(schema, ZodTypeNames.OBJECT)).toBe(false);
    });

    it('should correctly identify object type', () => {
      const schema = z.object({ name: z.string() });
      expect(isZodType(schema, ZodTypeNames.OBJECT)).toBe(true);
      expect(isZodType(schema, ZodTypeNames.ARRAY)).toBe(false);
    });

    it('should return false for non-Zod objects', () => {
      expect(isZodType({}, ZodTypeNames.STRING)).toBe(false);
      expect(isZodType(null, ZodTypeNames.STRING)).toBe(false);
      expect(isZodType(undefined, ZodTypeNames.STRING)).toBe(false);
    });

    it('should handle wrapper types correctly', () => {
      const schema = z.string().optional();
      // Should identify as optional, not string (doesn't unwrap)
      expect(isZodType(schema, ZodTypeNames.OPTIONAL)).toBe(true);
      expect(isZodType(schema, ZodTypeNames.STRING)).toBe(false);
    });
  });

  describe('unwrapZodType', () => {
    describe('Single Unwrapping', () => {
      it('should unwrap optional types', () => {
        const schema = z.string().optional();
        const unwrapped = unwrapZodType(schema);
        expect(getZodTypeName(unwrapped)).toBe(ZodTypeNames.STRING);
      });

      it('should unwrap nullable types', () => {
        const schema = z.string().nullable();
        const unwrapped = unwrapZodType(schema);
        expect(getZodTypeName(unwrapped)).toBe(ZodTypeNames.STRING);
      });

      it('should NOT unwrap default types (only unwraps optional/nullable)', () => {
        const schema = z.string().default('hello');
        const unwrapped = unwrapZodType(schema);
        expect(getZodTypeName(unwrapped)).toBe(ZodTypeNames.DEFAULT);
        expect(unwrapped).toBe(schema); // Returns original
      });

      it('should NOT unwrap branded types (only unwraps optional/nullable)', () => {
        const schema = z.string().brand<'UserId'>();
        const unwrapped = unwrapZodType(schema);
        expect(getZodTypeName(unwrapped)).toBe(ZodTypeNames.BRANDED);
        expect(unwrapped).toBe(schema); // Returns original
      });

      it('should NOT unwrap catch types (only unwraps optional/nullable)', () => {
        const schema = z.string().catch('fallback');
        const unwrapped = unwrapZodType(schema);
        expect(getZodTypeName(unwrapped)).toBe(ZodTypeNames.CATCH);
        expect(unwrapped).toBe(schema); // Returns original
      });
    });

    describe('Nested Unwrapping', () => {
      it('should unwrap nested optional and nullable', () => {
        const schema = z.string().optional().nullable();
        const unwrapped = unwrapZodType(schema);
        expect(getZodTypeName(unwrapped)).toBe(ZodTypeNames.STRING);
      });

      it('should unwrap nested nullable and optional', () => {
        const schema = z.string().nullable().optional();
        const unwrapped = unwrapZodType(schema);
        expect(getZodTypeName(unwrapped)).toBe(ZodTypeNames.STRING);
      });

      it('should unwrap optional/nullable but stop at default', () => {
        const schema = z.string().optional().nullable().default('hello');
        const unwrapped = unwrapZodType(schema);
        // Unwraps nullable, unwraps optional, but stops at default
        expect(getZodTypeName(unwrapped)).toBe(ZodTypeNames.DEFAULT);
      });

      it('should unwrap optional but stop at catch', () => {
        // .brand() doesn't add a wrapper layer, it's part of the string type
        const schema = z.string().optional().catch('fallback');
        const unwrapped = unwrapZodType(schema);
        // Unwraps optional, stops at catch
        expect(getZodTypeName(unwrapped)).toBe(ZodTypeNames.CATCH);
      });
    });

    describe('Non-Wrapper Types', () => {
      it('should return original type for non-wrapped strings', () => {
        const schema = z.string();
        const unwrapped = unwrapZodType(schema);
        expect(unwrapped).toBe(schema);
        expect(getZodTypeName(unwrapped)).toBe(ZodTypeNames.STRING);
      });

      it('should return original type for arrays', () => {
        const schema = z.array(z.string());
        const unwrapped = unwrapZodType(schema);
        expect(unwrapped).toBe(schema);
        expect(getZodTypeName(unwrapped)).toBe(ZodTypeNames.ARRAY);
      });

      it('should return original type for objects', () => {
        const schema = z.object({ name: z.string() });
        const unwrapped = unwrapZodType(schema);
        expect(unwrapped).toBe(schema);
        expect(getZodTypeName(unwrapped)).toBe(ZodTypeNames.OBJECT);
      });

      it('should not unwrap effects (preprocess)', () => {
        // Preprocess with direct function reference (no arrow function needed)
        const schema = z.preprocess(String, z.string());
        const unwrapped = unwrapZodType(schema);
        // Effects are not unwrapped (contain logic that must run)
        expect(unwrapped).toBe(schema);
        expect(getZodTypeName(unwrapped)).toBe(ZodTypeNames.EFFECTS);
      });

      it('should not unwrap effects (transform)', () => {
        // Transform requires callback - disable nesting rule
        // eslint-disable-next-line sonarjs/no-nested-functions
        const schema = z.string().transform((val: string) => val.toUpperCase());
        const unwrapped = unwrapZodType(schema);
        // Effects are not unwrapped (contain logic that must run)
        expect(unwrapped).toBe(schema);
        expect(getZodTypeName(unwrapped)).toBe(ZodTypeNames.EFFECTS);
      });
    });

    describe('Unwrapping Complex Inner Types', () => {
      it('should unwrap optional array', () => {
        const schema = z.array(z.string()).optional();
        const unwrapped = unwrapZodType(schema);
        expect(getZodTypeName(unwrapped)).toBe(ZodTypeNames.ARRAY);
      });

      it('should unwrap nullable object', () => {
        const schema = z.object({ name: z.string() }).nullable();
        const unwrapped = unwrapZodType(schema);
        expect(getZodTypeName(unwrapped)).toBe(ZodTypeNames.OBJECT);
      });

      it('should stop at default (does not unwrap default)', () => {
        const schema = z
          .object({
            items: z.array(z.string()),
          })
          .default({ items: [] });
        const unwrapped = unwrapZodType(schema);
        // unwrapZodType only unwraps optional/nullable, not default
        expect(getZodTypeName(unwrapped)).toBe(ZodTypeNames.DEFAULT);
        expect(unwrapped).toBe(schema);
      });
    });

    describe('Edge Cases', () => {
      it('should unwrap only optional/nullable from deeply nested wrappers', () => {
        // Build complex nesting: string -> optional -> nullable -> default -> catch
        const schema = z.string().optional().nullable().default('hello').catch('fallback');
        const unwrapped = unwrapZodType(schema);
        // Unwraps nullable, unwraps optional, stops at catch (outer wrapper)
        expect(getZodTypeName(unwrapped)).toBe(ZodTypeNames.CATCH);
      });

      it('should return non-Zod input unchanged', () => {
        const notZod = { not: 'zod' };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const unwrapped = unwrapZodType(notZod as any);
        expect(unwrapped).toBe(notZod);
      });
    });
  });

  describe('ZodTypeNames Constants', () => {
    it('should have all expected type names', () => {
      const expectedTypes: ZodTypeName[] = [
        'ZodString',
        'ZodNumber',
        'ZodBoolean',
        'ZodBigInt',
        'ZodDate',
        'ZodUndefined',
        'ZodNull',
        'ZodAny',
        'ZodUnknown',
        'ZodNever',
        'ZodVoid',
        'ZodArray',
        'ZodObject',
        'ZodRecord',
        'ZodMap',
        'ZodSet',
        'ZodTuple',
        'ZodEnum',
        'ZodNativeEnum',
        'ZodLiteral',
        'ZodUnion',
        'ZodDiscriminatedUnion',
        'ZodIntersection',
        'ZodPromise',
        'ZodFunction',
        'ZodLazy',
        'ZodOptional',
        'ZodNullable',
        'ZodDefault',
        'ZodBranded',
        'ZodCatch',
        'ZodPipeline',
        'ZodReadonly',
        'ZodSymbol',
        'ZodEffects',
        'ZodNaN',
      ];

      const actualTypes = Object.values(ZodTypeNames);
      // Create copies for sorting (avoid mutating original arrays)
      const sortedActual = [...actualTypes].sort((a: string, b: string) => a.localeCompare(b));
      const sortedExpected = [...expectedTypes].sort((a: string, b: string) =>
        a.localeCompare(b),
      );
      expect(sortedActual).toEqual(sortedExpected);
    });

    it('should have unique values', () => {
      const values = Object.values(ZodTypeNames);
      const uniqueValues = new Set(values);
      expect(uniqueValues.size).toBe(values.length);
    });
  });

  describe('Real-World Usage Patterns', () => {
    it('should handle metadata schema with mixed types', () => {
      const metadataSchema = z.object({
        title: z.string(),
        tags: z.array(z.string()).optional(),
        priority: z.number().default(0),
        createdAt: z.date(),
      });

      expect(getZodTypeName(metadataSchema)).toBe(ZodTypeNames.OBJECT);

      const shape = metadataSchema.shape;
      expect(getZodTypeName(shape.title)).toBe(ZodTypeNames.STRING);
      expect(getZodTypeName(shape.tags)).toBe(ZodTypeNames.OPTIONAL);
      expect(unwrapZodType(shape.tags)).toSatisfy((t) => getZodTypeName(t) === ZodTypeNames.ARRAY);
      expect(getZodTypeName(shape.priority)).toBe(ZodTypeNames.DEFAULT);
      // unwrapZodType only unwraps optional/nullable, not default
      expect(getZodTypeName(unwrapZodType(shape.priority))).toBe(ZodTypeNames.DEFAULT);
      expect(getZodTypeName(shape.createdAt)).toBe(ZodTypeNames.DATE);
    });

    it('should handle union of primitives', () => {
      const schema = z.union([z.string(), z.number(), z.boolean()]);
      expect(getZodTypeName(schema)).toBe(ZodTypeNames.UNION);
    });

    it('should handle discriminated union for type safety', () => {
      const schema = z.discriminatedUnion('type', [
        z.object({ type: z.literal('text'), content: z.string() }),
        z.object({ type: z.literal('number'), value: z.number() }),
      ]);
      expect(getZodTypeName(schema)).toBe(ZodTypeNames.DISCRIMINATED_UNION);
    });

    it('should handle recursive schemas with lazy', () => {
      interface Category {
        name: string;
        subcategories?: Category[];
      }

      const categorySchema: z.ZodType<Category> = z.lazy(() =>
        z.object({
          name: z.string(),
          subcategories: z.array(categorySchema).optional(),
        }),
      );

      expect(getZodTypeName(categorySchema)).toBe(ZodTypeNames.LAZY);
    });
  });
});
