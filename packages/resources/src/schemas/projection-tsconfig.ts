/**
 * The tsconfig relations: which TypeScript configurations a repository's `package.json` scripts
 * invoke, and what TypeScript's own config parser makes of the demanded ones (their references and
 * its closure, options, `extends` chain, root files, `paths`, and conditions). Derived per run by the
 * tsconfig resolve step (`projection/tsconfig-step.ts`), never stored; every row carries `root`.
 */

import { z } from 'zod';

/** The compiler names a script segment is read as invoking when config names none. */
export const DEFAULT_TSCONFIG_COMPILERS: readonly string[] = ['tsc', 'tsc-native', 'ngc'];

/** A row of the derived `tsconfig_invocations` relation: one per project a compiling script segment names. */
export const TsconfigInvocationRowSchema = z.object({
  root: z.string().describe('The id of the root the path is under'),
  path: z.string().describe('The package.json holding the script, relative to its root'),
  script: z.string().describe('The script\'s name (its last occurrence when the key repeats)'),
  segment: z.number().int().nonnegative().describe('0-based position of the compiling segment among the script\'s segments, split on `&&`, `||` and `;`'),
  ordinal: z.number().int().nonnegative().describe('0-based position among the projects the segment names: 0 for a `-p` or default project, each build-mode positional in order'),
  package: z.string().nullable().describe('The package.json `name`, or null when absent or not a string'),
  packageDir: z.string().describe('The package\'s directory, relative to its root; `.` for the root package'),
  compiler: z.string().describe('The compiler token\'s basename, as written'),
  project: z.string().describe('The project as named, normalised and relative to the root: `-p`/`--project` value, a build-mode positional, or by default the package\'s `tsconfig.json` (build mode) or the nearest `tsconfig.json` at or above the package (a bare compiler, as tsc walks up). A path starting `..` leaves the root'),
  config: z.string().nullable().describe('The tsconfig file the project names, relative to its root (a directory resolves to its `tsconfig.json`); null when the file is not git content (TSCONFIG_INVOKED_MISSING) or the project leaves the root'),
  buildMode: z.boolean().describe('Whether the segment ran the compiler in build mode (`-b`, `--build`)'),
  line: z.number().int().positive().describe('The 1-based line of the script\'s value in the package.json'),
}).strict().describe('A row of the derived `tsconfig_invocations` relation');

export type TsconfigInvocationRow = z.infer<typeof TsconfigInvocationRowSchema>;

/** What a tsconfig condition says. */
const TsconfigConditionCodeSchema = z.enum(['TSCONFIG_INVOKED_MISSING', 'TSCONFIG_INVOKED_UNKNOWN', 'TSCONFIG_REACHES_OUTSIDE_GIT']).describe([
  '`TSCONFIG_INVOKED_MISSING`: a script names a tsconfig file that is not git content; the invocation row has a null `config`, and the condition is at the package.json',
  '`TSCONFIG_INVOKED_UNKNOWN`: a script runs a compiler whose project the script text does not settle (a `cd` or a launcher option that changes the working directory, an argument the shell expands, a bare compiler with no `tsconfig.json` at or above the package inside the root); there is no invocation row for it, and the condition is at the package.json',
  '`TSCONFIG_REACHES_OUTSIDE_GIT`: a literal `files` entry, or an `include` entry with no `*` or `?`, names a path that is not git content; it is filtered from the members, and the condition is at the config',
].join('; '));


/** The root id column every tsconfig relation carries. */
const ROOT_DESC = 'The id of the root the paths are under';

/** A demanded config's path column. */
const CONFIG_DESC = 'The demanded config, relative to its root';

/** A row of the derived `tsconfig_conditions` relation. */
export const TsconfigConditionRowSchema = z.object({
  root: z.string().describe(ROOT_DESC),
  path: z.string().describe('The file the condition is about, relative to its root: the package.json for TSCONFIG_INVOKED_MISSING and TSCONFIG_INVOKED_UNKNOWN, the config for TSCONFIG_REACHES_OUTSIDE_GIT'),
  code: TsconfigConditionCodeSchema,
  seq: z.number().int().nonnegative().describe('0-based position among the path\'s conditions of this code'),
  message: z.string(),
  kind: z.enum(['files-entry', 'include-entry']).nullable().describe('For TSCONFIG_REACHES_OUTSIDE_GIT, which literal entry reaches outside git content; null otherwise'),
  reached: z.string().nullable().describe('For TSCONFIG_REACHES_OUTSIDE_GIT, the path the entry names, relative to the root; null otherwise'),
}).strict().describe('A row of the derived `tsconfig_conditions` relation');

export type TsconfigConditionRow = z.infer<typeof TsconfigConditionRowSchema>;

/** A row of the derived `tsconfig_references` relation: one per `references` entry of a demanded config. */
export const TsconfigReferenceRowSchema = z.object({
  root: z.string().describe(ROOT_DESC),
  config: z.string().describe(CONFIG_DESC),
  ordinal: z.number().int().nonnegative().describe('0-based position in the config\'s `references`'),
  spec: z.string().describe('The entry\'s `path` as written'),
  path: z.string().describe('The config the entry names, relative to the root (a directory names its `tsconfig.json`)'),
}).strict().describe('A row of the derived `tsconfig_references` relation');

export type TsconfigReferenceRow = z.infer<typeof TsconfigReferenceRowSchema>;

/** A row of the derived `tsconfig_closure` relation. */
export const TsconfigClosureRowSchema = z.object({
  root: z.string().describe(ROOT_DESC),
  config: z.string().describe(CONFIG_DESC),
  member: z.string().describe('A config reachable from `config` through `references` edges, `config` itself included'),
  distance: z.number().int().nonnegative().describe('The length of the shortest `references` path from `config` to `member`; 0 for the config itself'),
}).strict().describe('A row of the derived `tsconfig_closure` relation');

export type TsconfigClosureRow = z.infer<typeof TsconfigClosureRowSchema>;

/** A row of the derived `tsconfig_configs` relation: one per demanded config, as TypeScript parsed it. */
export const TsconfigConfigRowSchema = z.object({
  root: z.string().describe(ROOT_DESC),
  path: z.string().describe(CONFIG_DESC),
  outDir: z.string().nullable().describe('`compilerOptions.outDir` resolved, relative to the root (`.` for the root); null when unset'),
  rootDir: z.string().nullable().describe('`compilerOptions.rootDir` resolved, relative to the root; null when unset'),
  baseUrl: z.string().nullable().describe('`compilerOptions.baseUrl` resolved, relative to the root; null when unset (deprecated in TypeScript 6.0)'),
  allowJs: z.boolean().nullable().describe('`compilerOptions.allowJs`, null when unset'),
  resolveJsonModule: z.boolean().nullable().describe('`compilerOptions.resolveJsonModule`, null when unset'),
  composite: z.boolean().nullable().describe('`compilerOptions.composite`, null when unset'),
}).strict().describe('A row of the derived `tsconfig_configs` relation');

export type TsconfigConfigRow = z.infer<typeof TsconfigConfigRowSchema>;

/** A row of the derived `tsconfig_extends` relation. */
export const TsconfigExtendsRowSchema = z.object({
  root: z.string().describe(ROOT_DESC),
  config: z.string().describe(CONFIG_DESC),
  ordinal: z.number().int().nonnegative().describe('0-based position in the chain, in TypeScript\'s order: each base, then its own bases'),
  path: z.string().describe('The base config, relative to the root'),
}).strict().describe('A row of the derived `tsconfig_extends` relation');

export type TsconfigExtendsRow = z.infer<typeof TsconfigExtendsRowSchema>;

/** A row of the derived `tsconfig_files` relation. */
export const TsconfigFileRowSchema = z.object({
  root: z.string().describe(ROOT_DESC),
  config: z.string().describe(CONFIG_DESC),
  path: z.string().describe('A root file of the config (TypeScript\'s `fileNames`), among git content, relative to the root'),
}).strict().describe('A row of the derived `tsconfig_files` relation');

export type TsconfigFileRow = z.infer<typeof TsconfigFileRowSchema>;

/** A row of the derived `tsconfig_paths` relation: one per target of a `paths` pattern. */
export const TsconfigPathRowSchema = z.object({
  root: z.string().describe(ROOT_DESC),
  config: z.string().describe(CONFIG_DESC),
  pattern: z.string().describe('The `paths` key'),
  ordinal: z.number().int().nonnegative().describe('0-based position of the target among the pattern\'s targets'),
  target: z.string().describe('The target as written, relative to `basePath`'),
  basePath: z.string().describe('The directory the targets resolve from (the `baseUrl` when set, else the directory of the config that set `paths`), relative to the root; `.` for the root'),
}).strict().describe('A row of the derived `tsconfig_paths` relation');

export type TsconfigPathRow = z.infer<typeof TsconfigPathRowSchema>;
