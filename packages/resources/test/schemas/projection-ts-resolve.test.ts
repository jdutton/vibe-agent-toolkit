/**
 * The resolved import graph's row schemas: each refuses a key it does not declare, holds the closed
 * lists the spec names, and takes its `kind` list from `ts__imports` rather than copying it.
 */

import { describe, expect, it } from 'vitest';

import {
  TsImportConditionRowSchema,
  TsImportTargetRowSchema,
  TsProgramFileRowSchema,
  TsTargetKindSchema,
} from '../../src/schemas/projection-ts-resolve.js';
import { TsImportKindSchema } from '../../src/schemas/projection-ts.js';

/** One valid row of each relation. */
const VALID_ROWS = {
  ts_import_targets: [TsImportTargetRowSchema, {
    root: 'r0', config: 'tsconfig.json', path: 'src/a.ts', ordinal: 0, kind: 'import', specifier: './b.js', mode: 'import',
    targetKind: 'file', target: 'src/b.ts', package: null, pathsMatched: false, redirected: false,
  }],
  ts_program_files: [TsProgramFileRowSchema, { root: 'r0', config: 'tsconfig.json', path: 'src/b.ts', distance: 1, reachedOnly: true }],
  ts_import_conditions: [TsImportConditionRowSchema, {
    root: 'r0', config: null, path: null, ordinal: null, code: 'TS_VERSION_SKEW', message: 'declared 5',
    pinnedMajor: 6, declaredMajors: '5,6', manifests: 1,
  }],
} as const;

describe('the resolved graph row schemas', () => {
  it.each(Object.entries(VALID_ROWS))('%s accepts a valid row and refuses an extra key', (_name, [schema, row]) => {
    expect(schema.safeParse(row).success).toBe(true);
    expect(schema.safeParse({ ...row, extra: 1 }).success).toBe(false);
  });

  it('closes targetKind over exactly eight values: no collected reference has a null specifier, so none is non-literal', () => {
    expect(TsTargetKindSchema.options).toStrictEqual([
      'file', 'member', 'memberUndeclared', 'external', 'builtin', 'lib', 'outputUnmapped', 'unresolved',
    ]);
    expect(TsImportTargetRowSchema.shape.specifier.safeParse(null).success).toBe(false);
    expect(TsImportTargetRowSchema.shape.targetKind).toBe(TsTargetKindSchema);
  });

  it('reads the reference kind from ts__imports itself, not a copy', () => {
    expect(TsImportTargetRowSchema.shape.kind).toBe(TsImportKindSchema);
  });

  it('holds mode to import, require or null', () => {
    const base = VALID_ROWS.ts_import_targets[1];
    expect(TsImportTargetRowSchema.safeParse({ ...base, mode: null }).success).toBe(true);
    expect(TsImportTargetRowSchema.safeParse({ ...base, mode: 'require' }).success).toBe(true);
    expect(TsImportTargetRowSchema.safeParse({ ...base, mode: 'node16' }).success).toBe(false);
  });

  it('holds the condition code to the two codes, and a root-level row to NULL config, path and ordinal being allowed', () => {
    const base = VALID_ROWS.ts_import_conditions[1];
    expect(TsImportConditionRowSchema.shape.code.options).toStrictEqual(['TS_OUTPUT_REDIRECT_AMBIGUOUS', 'TS_VERSION_SKEW']);
    expect(TsImportConditionRowSchema.safeParse({ ...base, code: 'TS_OTHER' }).success).toBe(false);
    expect(TsImportConditionRowSchema.safeParse({
      ...base, config: 'tsconfig.json', path: 'src/a.ts', ordinal: 2, code: 'TS_OUTPUT_REDIRECT_AMBIGUOUS',
      pinnedMajor: null, declaredMajors: null, manifests: null,
    }).success).toBe(true);
  });

  it('says in every relation description that the answer is not a runtime claim', () => {
    expect(TsImportTargetRowSchema.description).toContain('not a runtime claim');
    expect(TsProgramFileRowSchema.description).toContain('not a runtime claim');
  });
});
