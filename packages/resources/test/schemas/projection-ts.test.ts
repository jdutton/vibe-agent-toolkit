/**
 * The `ts` instance's row schemas: each refuses a key it does not declare, holds the closed kind
 * lists the spec names, and shares the route-state enum (and its meaning) with `data__routes`.
 */

import { describe, expect, it } from 'vitest';

import { computeContentKey } from '../../src/content-key.js';
import { DataRouteRowSchema } from '../../src/schemas/projection-data.js';
import {
  TsExportRowSchema,
  TsFileRowSchema,
  TsImportNameRowSchema,
  TsImportRowSchema,
  TsImportsRowSchema,
  TsRouteRowSchema,
  TsVariantSchema,
} from '../../src/schemas/projection-ts.js';

const blob = computeContentKey(new TextEncoder().encode('export {};\n'), 'none');

/** One valid row of each `ts` relation, the stored four and the derived two. */
const VALID_ROWS = {
  ts__files: [TsFileRowSchema, { blob, variant: 'ts', moduleSyntax: true, hasJsx: false }],
  ts__imports: [TsImportRowSchema, {
    blob, variant: 'ts', ordinal: 0, kind: 'import', specifier: 'node:fs', specifierForm: 'string', argumentCount: null,
    typeOnly: false, hasClause: true, hasDefault: false, hasNamespace: false, namedBindings: 1, typeOnlyNamed: 0,
    resolutionMode: null, attributeType: null, scope: 'module', line: 1, column: 22, nodeLine: 1, nodeColumn: 1,
  }],
  ts__import_names: [TsImportNameRowSchema, {
    blob, variant: 'ts', import: 0, seq: 0, imported: 'readFile', local: 'readFile', typeOnly: false, line: 1, column: 10,
  }],
  ts__exports: [TsExportRowSchema, {
    blob, variant: 'ts', seq: 0, name: null, kind: 'star', local: null, imported: null, import: 0, typeOnly: false, line: 1, column: 15,
  }],
  ts__routes: [TsRouteRowSchema, { root: 'r0', path: 'src/a.ts', blob, variant: 'ts', state: 'facts', code: null }],
  ts_imports: [TsImportsRowSchema, {
    root: 'r0', path: 'src/a.ts', variant: 'ts', ordinal: 0, kind: 'import', specifier: './b.js', specifierForm: 'string',
    argumentCount: null, typeOnly: false, hasClause: true, hasDefault: true, hasNamespace: false, namedBindings: null,
    typeOnlyNamed: null, resolutionMode: null, attributeType: null, scope: 'module', line: 1, column: 15, nodeLine: 1,
    nodeColumn: 1, package: null, builtin: false, lexicalTarget: 'src/b.js',
  }],
} as const;

describe('the ts row schemas', () => {
  it.each(Object.entries(VALID_ROWS))('%s accepts a valid row and refuses an extra key', (_name, [schema, row]) => {
    expect(schema.safeParse(row).success).toBe(true);
    expect(schema.safeParse({ ...row, path: 'src/a.ts', extra: 1 }).success).toBe(false);
  });

  it('reads the bytes as exactly the four variants', () => {
    expect(TsVariantSchema.options).toStrictEqual(['ts', 'dts', 'tsx', 'js']);
  });

  it('closes ts__imports.kind over the thirteen module-reference kinds', () => {
    expect(TsImportRowSchema.shape.kind.options).toStrictEqual([
      'import', 'export', 'importEquals', 'dynamic', 'importType', 'require', 'createRequire', 'ambient',
      'referencePath', 'referenceTypes', 'referenceLib', 'jsdocImport', 'jsdocImportType',
    ]);
    expect(TsImportRowSchema.shape.scope.options).toStrictEqual(['module', 'ambientModule', 'nested']);
  });

  it('closes ts__exports.kind over the ten export kinds', () => {
    expect(TsExportRowSchema.shape.kind.options).toStrictEqual([
      'declaration', 'local', 'expression', 'reexport', 'star', 'namespace', 'assignment', 'cjs', 'globalNamespace', 'importAlias',
    ]);
  });

  it('shares the route-state enum and its meaning with data__routes, one source', () => {
    expect(TsRouteRowSchema.shape.state).toBe(DataRouteRowSchema.shape.state);
  });

  it('refuses a data variant in a ts row', () => {
    expect(TsFileRowSchema.safeParse({ blob, variant: 'json', moduleSyntax: false, hasJsx: false }).success).toBe(false);
  });
});
