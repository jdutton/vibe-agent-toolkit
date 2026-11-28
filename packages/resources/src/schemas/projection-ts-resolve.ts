/**
 * The resolved import graph's relations, produced by the `tsResolve` step over the `ts` instance's
 * rows, the workspace and tsconfig relations and git content: `ts_import_targets`,
 * `ts_program_files` and `ts_import_conditions`.
 *
 * Derived per run, never stored. Every relation answers one question: what TypeScript's own
 * resolution, under the demanded config's options, resolves a reference to. It is not a runtime
 * claim: Node, a bundler or the emitted JavaScript can load something else (a package whose
 * `exports` offers only `{ types, import }` resolves under `require` mode here, while Node fails).
 */

import { z } from 'zod';

import { count, ROOT_PATH_COLUMNS } from './projection-row-set-columns.js';
import { TsImportKindSchema } from './projection-ts.js';

/** The root id column every relation of the resolved graph carries. */
const ROOT_DESC = ROOT_PATH_COLUMNS.root.description ?? '';

/** The demanded config a row answers for. */
const CONFIG_DESC = 'The demanded config the compilation is of, relative to its root';

/** What TypeScript's mode selection answered for a reference. */
const TsImportModeSchema = z.enum(['import', 'require'])
  .describe('What TypeScript\'s mode selection answered for the reference: `import` or `require`');

/** The closed list of outcomes a reference resolves to; each value means one thing. */
export const TsTargetKindSchema = z.enum([
  'file', 'member', 'memberUndeclared', 'external', 'builtin', 'lib', 'outputUnmapped', 'unresolved',
]).describe([
  '`file`: resolved into git content, not through member mapping',
  '`member`: resolved through the member mapping into a workspace member, after the output map',
  '`memberUndeclared`: a bare specifier naming a workspace member that neither the file\'s owning manifest nor a workspace manifest above it declares, so no link exists',
  '`external`: a bare specifier that is no workspace member and that no `paths` key matches: third-party code lives in `node_modules`, never git content, so only its name is known',
  '`builtin`: unresolved, and `node:`-prefixed or a builtin per the running Node\'s isBuiltin',
  '`lib`: a `referenceLib` directive; TypeScript\'s bundled library files are not git content',
  '`outputUnmapped`: resolved to a path under an emitting config\'s output directories that no demanded config\'s output map holds, such as a bundler\'s output',
  '`unresolved`: resolution failed for a relative, absolute, `#` or `paths`-matched specifier, or for a member mapping',
].join('; '));

/** One {@link TsTargetKindSchema} member. */
export type TsTargetKind = z.infer<typeof TsTargetKindSchema>;

/**
 * A row of the derived `ts_import_targets` relation: how the compilation of one demanded config
 * resolves one module reference of one file. An unresolved reference is a row, never a refusal.
 */
export const TsImportTargetRowSchema = z.object({
  root: z.string().describe(ROOT_DESC),
  config: z.string().describe(CONFIG_DESC),
  path: z.string().describe('The file holding the reference, relative to its root'),
  ordinal: count().describe('The reference\'s `ts_imports` ordinal in the file'),
  kind: TsImportKindSchema,
  specifier: z.string().describe('The reference\'s specifier, as in `ts_imports`: never null, since TypeScript collects only a reference with a literal specifier'),
  mode: TsImportModeSchema.nullable().describe('What TypeScript\'s mode selection answered for the reference (`import` or `require`), or null when it answered none'),
  targetKind: TsTargetKindSchema,
  target: z.string().nullable().describe('The resolved file, relative to its root, or null when the outcome names no git-content file'),
  package: z.string().nullable().describe('As in `ts_imports`: set for every bare specifier, whatever the resolution'),
  pathsMatched: z.boolean().describe('Whether a `paths` key of the config matches the specifier by TypeScript\'s own matcher'),
  redirected: z.boolean().describe('Whether the output map turned a resolved output path into its source'),
}).strict().describe('A row of the derived `ts_import_targets` relation: what TypeScript resolves a reference to under a demanded config, not a runtime claim');

export type TsImportTargetRow = z.infer<typeof TsImportTargetRowSchema>;

/**
 * A row of the derived `ts_program_files` relation: one per file of a demanded config's program
 * closure within git content.
 */
export const TsProgramFileRowSchema = z.object({
  root: z.string().describe(ROOT_DESC),
  config: z.string().describe(CONFIG_DESC),
  path: z.string().describe('A file of the config\'s program closure within git content, relative to its root'),
  distance: count().describe('0 for the config\'s own root files (`tsconfig_files`); else the length of the shortest chain of `file` targets from one'),
  reachedOnly: z.boolean().describe('Whether the file is reached through a reference and is not one of the config\'s root files'),
}).strict().describe('A row of the derived `ts_program_files` relation: the files a demanded config\'s compilation reaches within git content, not a runtime claim');

export type TsProgramFileRow = z.infer<typeof TsProgramFileRowSchema>;

/** What a resolved-graph condition says. */
const TsImportConditionCodeSchema = z.enum(['TS_OUTPUT_REDIRECT_AMBIGUOUS', 'TS_VERSION_SKEW']).describe([
  '`TS_OUTPUT_REDIRECT_AMBIGUOUS`: an output path of the config\'s output map has two sources (two configs, or `x.ts` and `x.tsx` in one config), so a reference resolved to it is `unresolved`; the row is at that reference and `message` names both sources',
  '`TS_VERSION_SKEW`: at least one workspace manifest declares a `typescript` of a major other than the one VAT answers with; a root-level row, with null `config`, `path` and `ordinal`',
].join('; '));

/** The skew columns' shared description tail. */
const SKEW_ONLY = 'for TS_VERSION_SKEW; null for every other code';

/**
 * A row of the derived `ts_import_conditions` relation. Its key is `(root, config, path, ordinal,
 * code)`; a root-level row (`TS_VERSION_SKEW`) has `config`, `path` and `ordinal` null.
 */
export const TsImportConditionRowSchema = z.object({
  root: z.string().describe(ROOT_DESC),
  config: z.string().nullable().describe(`${CONFIG_DESC}; null for a root-level row`),
  path: z.string().nullable().describe('The file holding the reference the condition is about, relative to its root; null for a root-level row'),
  ordinal: count().nullable().describe('The reference\'s `ts_imports` ordinal in the file; null for a root-level row'),
  code: TsImportConditionCodeSchema,
  message: z.string().describe('What the condition found; for TS_OUTPUT_REDIRECT_AMBIGUOUS it names both sources'),
  pinnedMajor: count().nullable().describe(`The major of the TypeScript VAT answers with, read from the loaded module; ${SKEW_ONLY}`),
  declaredMajors: z.string().nullable().describe(`The distinct majors the workspace manifests declare, ascending, comma separated; ${SKEW_ONLY}`),
  manifests: count().nullable().describe(`How many manifests declare a major other than \`pinnedMajor\`; ${SKEW_ONLY}`),
}).strict().describe('A row of the derived `ts_import_conditions` relation: a finding about the resolved graph that is a value, not a registry finding code; the step never refuses on it');

export type TsImportConditionRow = z.infer<typeof TsImportConditionRowSchema>;
