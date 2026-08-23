/**
 * Column classification, and the two facts a backend cannot get anywhere else.
 *
 * The interesting assertions are the nullability ones. Every storage backend
 * turns `nullable: false` into a `NOT NULL`, so a column classified wrong here
 * becomes a constraint failure on real data — or, worse, a column that accepts
 * a null the row type says cannot happen.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  projectionColumnType,
  projectionColumnTypes,
  projectionRowShape,
} from '../src/projection/column-kinds.js';
import { PROJECTION_TABLES } from '../src/projection/table-registry.js';

/** Classify one ad-hoc column, which is what every case below needs. */
function classify(schema: z.ZodTypeAny): { kind: string; nullable: boolean } {
  return projectionColumnType('column', schema);
}

describe('projectionColumnType', () => {
  it('reads a string and an enum as text', () => {
    expect(classify(z.string()).kind).toBe('text');
    expect(classify(z.enum(['a', 'b'])).kind).toBe('text');
  });

  it('separates an integer from a real, since only one can be stored exactly', () => {
    expect(classify(z.number().int()).kind).toBe('integer');
    expect(classify(z.number()).kind).toBe('real');
  });

  it('reads a boolean and a date as their own kinds, not as text', () => {
    expect(classify(z.boolean()).kind).toBe('boolean');
    expect(classify(z.coerce.date()).kind).toBe('timestamp');
  });

  it('reads every JSON-shaped Zod type as json', () => {
    expect(classify(z.record(z.string(), z.unknown())).kind).toBe('json');
    expect(classify(z.array(z.string())).kind).toBe('json');
    expect(classify(z.object({ a: z.string() })).kind).toBe('json');
    expect(classify(z.union([z.string(), z.number()])).kind).toBe('json');
    expect(classify(z.lazy(() => z.string())).kind).toBe('json');
  });

  it('sees through refinements to the type underneath', () => {
    expect(classify(z.string().min(1).describe('x')).kind).toBe('text');
    expect(classify(z.number().int().superRefine(() => undefined)).kind).toBe('integer');
  });

  it('reports nullability from the wrapper chain', () => {
    expect(classify(z.string()).nullable).toBe(false);
    expect(classify(z.string().nullable()).nullable).toBe(true);
    expect(classify(z.string().optional()).nullable).toBe(true);
  });

  it('reports a JSON column as nullable even with no nullable wrapper', () => {
    // Its own union carries `z.null()`, so a backend reading only the wrapper
    // chain would emit NOT NULL and fail on the first null payload.
    expect(classify(z.union([z.string(), z.null()])).nullable).toBe(true);
    expect(classify(z.record(z.string(), z.unknown())).nullable).toBe(true);
  });

  it('refuses a column the row schema does not declare', () => {
    expect(() => projectionColumnType('missing', undefined)).toThrow(/not declared/u);
  });

  it('refuses a Zod type no backend has been taught to store', () => {
    expect(() => classify(z.instanceof(Uint8Array))).toThrow(/no storage representation/u);
  });
});

describe('projectionRowShape', () => {
  it('unwraps a row schema wrapped in superRefine', () => {
    // Two of the twelve are; a caller reading `.shape` directly sees nothing.
    expect(Object.keys(projectionRowShape(PROJECTION_TABLES.resourceRealizations.schema)))
      .toContain('symlinkResolves');
    expect(Object.keys(projectionRowShape(PROJECTION_TABLES.resolutionContexts.schema)))
      .toContain('extentContextId');
  });

  it('refuses a schema that is not an object underneath', () => {
    expect(() => projectionRowShape(z.string())).toThrow(/must be a z.object/u);
  });
});

describe('projectionColumnTypes over the registry', () => {
  it('classifies every column of every table without throwing', () => {
    for (const spec of Object.values(PROJECTION_TABLES)) {
      const types = projectionColumnTypes(spec);
      expect(types.map(([column]) => column), spec.name).toEqual([...spec.columns]);
    }
  });

  it('classifies the columns the two backends disagree about most easily', () => {
    const realization = new Map(projectionColumnTypes(PROJECTION_TABLES.resourceRealizations));
    expect(realization.get('mtime')).toEqual({ kind: 'timestamp', nullable: true });
    expect(realization.get('exists')).toEqual({ kind: 'boolean', nullable: false });
    expect(realization.get('symlinkResolves')).toEqual({ kind: 'boolean', nullable: true });
    expect(realization.get('depth')).toEqual({ kind: 'integer', nullable: false });

    const blobs = new Map(projectionColumnTypes(PROJECTION_TABLES.blobs));
    expect(blobs.get('frontmatter')).toEqual({ kind: 'json', nullable: true });
    expect(blobs.get('contentKey')).toEqual({ kind: 'text', nullable: false });
  });
});
