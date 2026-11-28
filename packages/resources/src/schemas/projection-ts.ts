/**
 * The `ts` instance's rows: the module surface of a TypeScript or JavaScript file as its syntax
 * states it, one row set per `(blob, variant)`.
 *
 * Stored (row-set tables, `ROW_SET_TABLES`): `ts__files` (the head), `ts__imports`,
 * `ts__import_names`, `ts__exports`. Every row carries `blob` and `variant`, which lead every
 * primary key; no stored column depends on the path, so a row set is a pure function of the bytes
 * and the variant (the variant fixes the synthetic file name the parse runs under).
 *
 * Derived per run, never stored (`DERIVED_TABLES`, producer `ts`): `ts__routes` (which path routed
 * to which pair, and the pair's state) and `ts_imports` (the imports of each routed pair, with the
 * facts that depend on the path or the running Node).
 *
 * Booleans are 1/0 in the store, as the data instance's are.
 */

import { z } from 'zod';

import { ContentKeySchema } from '../content-key.js';

import { BLOB_DESC, COLUMN_DESC, count, LINE_DESC, position, ROOT_PATH_COLUMNS, routeRowSchema } from './projection-row-set-columns.js';

/** The variants the `ts` instance parses: each fixes its synthetic file name and `ScriptKind`. */
export const TsVariantSchema = z.enum(['ts', 'dts', 'tsx', 'js'])
  .describe('How the bytes were parsed, each under one fixed synthetic file name: `ts` (`.ts`, `.mts`, `.cts`, not a declaration file) as `vat.ts`, ScriptKind TS; `dts` (every name TypeScript\'s isDeclarationFileName accepts) as `vat.d.ts`, ScriptKind TS; `tsx` (`.tsx`) as `vat.tsx`, ScriptKind TSX; `js` (`.js`, `.jsx`, `.mjs`, `.cjs`) as `vat.js`, ScriptKind JS');

/** One {@link TsVariantSchema} member. */
export type TsVariant = z.infer<typeof TsVariantSchema>;

/** The instance whose row sets these tables hold. */
export const TS_INSTANCE = 'ts';

/** The `ts` instance's id. */
export type TsInstance = typeof TS_INSTANCE;

/** The closed list of module references `ts__imports` holds a row for. */
export const TsImportKindSchema = z.enum([
  'import', 'export', 'importEquals', 'dynamic', 'importType', 'require', 'createRequire', 'ambient',
  'referencePath', 'referenceTypes', 'referenceLib', 'jsdocImport', 'jsdocImportType',
]).describe('The module reference: `import` an ImportDeclaration; `export` an ExportDeclaration with a module specifier; `importEquals` `import x = require(\'m\')`; `dynamic` `import(...)`; `importType` a type-position `import(\'m\')`; `require` a call whose callee is the identifier `require`, by spelling; `createRequire` a call `createRequire(...)(\'m\')` or a call through a name a variable declarator anywhere in the file binds to a `createRequire(...)` result (the bare name, a local name a top-level import from `module` or `node:module` binds, or `X.createRequire`); `ambient` `declare module \'m\'`; `referencePath`, `referenceTypes`, `referenceLib` a `/// <reference path|types|lib>` directive; `jsdocImport` a JSDoc `@import` tag (`js` only); `jsdocImportType` a JSDoc `import(\'m\')` type (`js` only)');

/** Where a module reference stands in the file. */
const TsImportScopeSchema = z.enum(['module', 'ambientModule', 'nested'])
  .describe('`module` a top-level statement; `ambientModule` inside a `declare module` body; `nested` inside a function, method, accessor or constructor that has a body (its body, and also a parameter initializer and a parameter or return type annotation of that function, as `function f(a = import(\'x\')) {}` and `const f = (): import(\'r\').R => 1`), a class, a block or a nested statement (a function type, a signature, a body-less declaration or an overload signature opens none, so the same annotation on a body-less overload is `module`)');

/** The closed list of export forms `ts__exports` holds a row for. */
const TsExportKindSchema = z.enum([
  'declaration', 'local', 'expression', 'reexport', 'star', 'namespace', 'assignment', 'cjs', 'globalNamespace', 'importAlias',
]).describe('The export form: `declaration` an `export` modifier (`export default function f` included); `local` `export { a as b }` or `export default ident`; `expression` `export default <other>`; `reexport` `export { a as b } from`; `star` `export * from`; `namespace` `export * as ns from`; `assignment` `export =` or `module.exports =`; `cjs` `exports.x =` or `module.exports.x =`; `globalNamespace` `export as namespace X`; `importAlias` `export import a = N.b`');

/** A row of the `ts__files` table, the instance's head: one per stored row set. */
export const TsFileRowSchema = z.object({
  blob: ContentKeySchema.describe(BLOB_DESC),
  variant: TsVariantSchema,
  moduleSyntax: z.boolean().describe('Whether the file has `import`, `export` or `import.meta` syntax (TypeScript\'s isFileProbablyExternalModule)'),
  hasJsx: z.boolean().describe('Whether the tree holds a JSX element, self-closing element or fragment (what TypeScript\'s module detection reads under `jsx` `react-jsx` or `react-jsxdev`)'),
}).strict().describe('A row of the `ts__files` table');

export type TsFileRow = z.infer<typeof TsFileRowSchema>;

/**
 * Every `ts__imports` column after `blob`, in order: shared by `ts__imports` and the derived
 * `ts_imports`, which carries every one of them for each routed pair. Spread where they stand: an
 * object's key order is the column order the registry derives.
 */
const TS_IMPORT_COLUMNS = {
  variant: TsVariantSchema,
  ordinal: count().describe('0-based position among the file\'s module references, in source order'),
  kind: TsImportKindSchema,
  specifier: z.string().nullable().describe('The text of the first argument or module specifier when it is a string literal or a template literal with no substitutions (for a call, seen through any parentheses around the argument), else null'),
  specifierForm: z.enum(['string', 'template']).nullable().describe('`string` a string literal, `template` a template literal with no substitutions, or null when `specifier` is null'),
  argumentCount: count().nullable().describe('The call\'s argument count for `dynamic`, `require` and `createRequire`, else null'),
  typeOnly: z.boolean().describe('Statement level only: TypeScript\'s isExclusivelyTypeOnlyImportOrExport for `import` and `export`, isTypeOnly for `importEquals`; false for every other kind'),
  hasClause: z.boolean().describe('Whether the statement has an import or export clause'),
  hasDefault: z.boolean().describe('Whether the import clause binds a default import'),
  hasNamespace: z.boolean().describe('Whether the clause is a namespace import (`* as ns`) or a namespace export (`export * as ns from`)'),
  namedBindings: count().nullable().describe('The number of named elements, or null when there is no named clause'),
  typeOnlyNamed: count().nullable().describe('How many named elements carry an inline `type`, or null when there is no named clause'),
  resolutionMode: z.enum(['import', 'require']).nullable().describe('The `resolution-mode` attribute through TypeScript\'s getResolutionModeOverride (on `import`/`export` attributes, an `importType`\'s attributes, a `referenceTypes` directive), or null'),
  attributeType: z.string().nullable().describe('The `with { type }` attribute\'s value, or null'),
  scope: TsImportScopeSchema,
  line: position().describe(`${LINE_DESC}; at the specifier token's start (the opening quote or backtick), the argument's start when the specifier is null, the start of the value in the comment for a triple-slash directive`),
  column: position().describe(COLUMN_DESC),
  nodeLine: position().describe(`${LINE_DESC}; at the start of the node that carries the reference: the declaration for \`import\`, \`export\` and \`ambient\`, the external module reference for \`importEquals\`, the call for \`dynamic\`, \`require\` and \`createRequire\`, the import type node for \`importType\` (at its \`import\` keyword under a \`typeof\`, as ESTree places it), and \`line\` itself for triple-slash and JSDoc rows`),
  nodeColumn: position().describe(COLUMN_DESC),
} as const;

/** A row of the `ts__imports` table: one per module reference, in source order. */
export const TsImportRowSchema = z.object({
  blob: ContentKeySchema.describe(BLOB_DESC),
  ...TS_IMPORT_COLUMNS,
}).strict().describe('A row of the `ts__imports` table');

export type TsImportRow = z.infer<typeof TsImportRowSchema>;

/** A row of the `ts__import_names` table: one per local binding a module reference creates. */
export const TsImportNameRowSchema = z.object({
  blob: ContentKeySchema.describe(BLOB_DESC),
  variant: TsVariantSchema,
  import: count().describe('The `ts__imports` ordinal of the reference that creates the binding'),
  seq: count().describe('0-based position among the reference\'s bindings, in source order'),
  imported: z.string().describe('The exported name bound: a name, `default`, or `*` for a namespace import, `import x = require()` and a whole-module `const x = require()`'),
  local: z.string().describe('The local name the binding creates'),
  typeOnly: z.boolean().describe('Whether the binding is type-only, at statement level or by an inline `type`'),
  line: position().describe(`${LINE_DESC}; at the local name token`),
  column: position().describe(COLUMN_DESC),
}).strict().describe('A row of the `ts__import_names` table');

export type TsImportNameRow = z.infer<typeof TsImportNameRowSchema>;

/** A row of the `ts__exports` table: one per exported name or export form, in source order. */
export const TsExportRowSchema = z.object({
  blob: ContentKeySchema.describe(BLOB_DESC),
  variant: TsVariantSchema,
  seq: count().describe('0-based position among the file\'s exports, in source order'),
  name: z.string().nullable().describe('The exported name, or null for `export *` and for `assignment` (`export =`, `module.exports =`), which replace the whole module and name no export'),
  kind: TsExportKindSchema,
  local: z.string().nullable().describe('The local name exported, or null when the form names none'),
  imported: z.string().nullable().describe('The source module\'s name for `reexport`, else null'),
  import: count().nullable().describe('The `ts__imports` ordinal of the module reference for `reexport`, `star` and `namespace`, else null'),
  typeOnly: z.boolean().describe('Whether the export is type-only, at statement level or by an inline `type`'),
  line: position().describe(`${LINE_DESC}; at the exported name token (the module specifier for \`star\`, the expression for \`assignment\`)`),
  column: position().describe(COLUMN_DESC),
}).strict().describe('A row of the `ts__exports` table');

export type TsExportRow = z.infer<typeof TsExportRowSchema>;

/** A row of the derived `ts__routes` relation: one per routed path. */
export const TsRouteRowSchema = routeRowSchema(TsVariantSchema, 'ts__routes');

export type TsRouteRow = z.infer<typeof TsRouteRowSchema>;

/**
 * A row of the derived `ts_imports` relation: every `ts__imports` column but `blob` for each routed
 * `facts` pair, plus the facts that depend on the path or the run and therefore cannot be stored.
 */
export const TsImportsRowSchema = z.object({
  ...ROOT_PATH_COLUMNS,
  ...TS_IMPORT_COLUMNS,
  package: z.string().nullable().describe('For a bare specifier (one that starts with none of `.`, `/`, `#` or a `scheme:`): its first segment, or its first two when it starts with `@`; null otherwise, `node:` specifiers included. Always null for `referencePath`, `referenceTypes`, `referenceLib` and `ambient`, which declare or reference a module and do not import one by package (a `referenceTypes` name is not the package name: `node` resolves to `@types/node`)'),
  builtin: z.boolean().describe('Whether the specifier starts with `node:` or the running Node\'s isBuiltin (`node:module`) says it names a builtin; always false for `referencePath`, `referenceTypes`, `referenceLib` and `ambient`'),
  lexicalTarget: z.string().nullable().describe('A relative specifier folded against the file\'s directory (`.` and `..` segments only, no host; a `referencePath` reads `\\` as `/`), relative to the root; null otherwise. Set for `import`, `export`, `importEquals`, `dynamic`, `importType`, `require`, `createRequire`, `ambient`, `jsdocImport` and `jsdocImportType` when the specifier starts `.`, `..`, `./` or `../`; for `referencePath` set for any specifier that is not absolute (`globals.d.ts` is read as `./globals.d.ts`); always null for `referenceTypes` and `referenceLib`'),
}).strict().describe('A row of the derived `ts_imports` relation');

export type TsImportsRow = z.infer<typeof TsImportsRowSchema>;
