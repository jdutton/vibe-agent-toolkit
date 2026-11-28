/**
 * The rules the resolved import graph's step asks TypeScript on the main thread, over rows rather
 * than trees: which references a `Program` would collect, each one's resolution
 * mode, whether a file is a module, where a `/// <reference path>` lands, and whether a `paths` key
 * matches a specifier.
 *
 * ## Stand-ins
 *
 * Warm runs hold `ts__files` and `ts__imports` rows, not trees, and TypeScript's mode selection
 * (`getModeForUsageLocation`) and module detection (`getSetExternalModuleIndicator`) read a tree. So
 * each question is asked of a **stand-in**: a source file TypeScript parses from a text VAT builds
 * out of a closed set of templates ({@link MODE_STAND_IN_TEMPLATES}, {@link MODULE_STAND_IN_TEMPLATES}),
 * one statement shape per `(kind, typeOnly, resolutionMode)` with the fixed placeholder specifier
 * {@link STAND_IN_SPECIFIER}, or the module-detection text of `(moduleSyntax, hasJsx, variant)`. The
 * text holds no byte of any document, so this main-thread parse is bounded; the templates are exported as data so a test can hold every main-thread parse to them.
 *
 * A stand-in is created as `createProgram` creates a file (`getCreateSourceFileOptions`): under the
 * real file name, with the implied node format and package scope from
 * `getImpliedNodeFormatForFileWorker` over the caller's host, `setExternalModuleIndicator` from
 * `getSetExternalModuleIndicator(options)`, the language version from `getEmitScriptTarget`, and
 * `packageJsonScope` set on the file AFTER the parse, as `createProgram` sets it (so module detection
 * during the parse sees no scope, exactly as it does in a `Program`). Parent links are ON: the
 * usage-location and emit-format functions walk them.
 *
 * Stand-ins are cached per `(config, package scope, file extension, text)`: every input those two
 * functions read about the file. The compiler differential is what catches a TypeScript release
 * that reads more. Each creation counts `resolve.ts.modeStandIns`.
 *
 * ## TypeScript is a parameter
 *
 * This module never loads TypeScript: it takes `typeof ts` and imports the vendored module's TYPE
 * only, so the step stays the one main-thread importer of the loader. The internals it calls sit
 * outside the public typings; {@link missingResolveInternal} names the first one absent, so the step
 * can refuse with the loader's own error before it calls anything.
 */

import { countWork } from '@vibe-agent-toolkit/utils';

import type { TsImportsRow, TsVariant } from '../schemas/projection-ts.js';
import type ts from '../vendor/typescript.cjs';

/** The placeholder specifier every mode template carries: a fixed string, never a document's. */
export const STAND_IN_SPECIFIER = 'vat-stand-in';

/** A resolution mode as the rows and relations name it. */
export type ResolutionModeName = 'import' | 'require';

/** The row kinds whose reference TypeScript resolves with a mode, so each has mode templates. */
type ModeKind =
  | 'import' | 'export' | 'importEquals' | 'dynamic' | 'require' | 'importType'
  | 'jsdocImportType' | 'jsdocImport' | 'ambient' | 'referenceTypes';

/** One mode template: the statement shape of `(kind, typeOnly, resolutionMode)`. */
interface ModeStandInTemplate {
  readonly kind: ModeKind;
  readonly typeOnly: boolean;
  readonly resolutionMode: ResolutionModeName | null;
  /** The variants whose rows can carry this shape; the text parses with no diagnostic in each. */
  readonly variants: readonly TsVariant[];
  readonly text: string;
}

/** One module-detection template: the text of `(moduleSyntax, hasJsx, variant)`. */
interface ModuleStandInTemplate {
  readonly moduleSyntax: boolean;
  readonly hasJsx: boolean;
  readonly variant: TsVariant;
  readonly text: string;
}

const QUOTED = JSON.stringify(STAND_IN_SPECIFIER);
const ALL_VARIANTS: readonly TsVariant[] = ['ts', 'dts', 'tsx', 'js'];
const JS_ONLY: readonly TsVariant[] = ['js'];
const MODES: readonly (ResolutionModeName | null)[] = [null, 'import', 'require'];

/** ` with { "resolution-mode": "<mode>" }`, the attributes clause of an import or export declaration. */
function declarationAttributes(mode: ResolutionModeName | null): string {
  return mode === null ? '' : ` with { "resolution-mode": "${mode}" }`;
}

/** `, { with: { "resolution-mode": "<mode>" } }`, the options argument of an import type. */
function importTypeAttributes(mode: ResolutionModeName | null): string {
  return mode === null ? '' : `, { with: { "resolution-mode": "${mode}" } }`;
}

/** ` resolution-mode="<mode>"`, the attribute of a `/// <reference types>` directive. */
function directiveAttribute(mode: ResolutionModeName | null): string {
  return mode === null ? '' : ` resolution-mode="${mode}"`;
}

/** The mode templates of one kind, over the modes it can carry. */
function overModes(kind: ModeKind, typeOnly: boolean, variants: readonly TsVariant[], text: (mode: ResolutionModeName | null) => string): ModeStandInTemplate[] {
  return MODES.map((resolutionMode) => ({ kind, typeOnly, resolutionMode, variants, text: text(resolutionMode) }));
}

/** The one template of a kind that carries no `resolution-mode`. */
function plain(kind: ModeKind, typeOnly: boolean, variants: readonly TsVariant[], text: string): ModeStandInTemplate {
  return { kind, typeOnly, resolutionMode: null, variants, text };
}

/**
 * The closed set of mode templates: every `(kind, typeOnly, resolutionMode)` a `ts_imports` row of a
 * mode kind can carry. `typeOnly` is set for `import`, `export` and `importEquals` only, and a
 * `resolution-mode` only where the extractor reads attributes (`import`, `export`, `importType`,
 * `jsdocImportType`, `jsdocImport`, `referenceTypes`).
 */
export const MODE_STAND_IN_TEMPLATES: readonly ModeStandInTemplate[] = [
  ...overModes('import', false, ALL_VARIANTS, (mode) => `import ${QUOTED}${declarationAttributes(mode)};\n`),
  ...overModes('import', true, ALL_VARIANTS, (mode) => `import type * as T from ${QUOTED}${declarationAttributes(mode)};\n`),
  ...overModes('export', false, ALL_VARIANTS, (mode) => `export * from ${QUOTED}${declarationAttributes(mode)};\n`),
  ...overModes('export', true, ALL_VARIANTS, (mode) => `export type * from ${QUOTED}${declarationAttributes(mode)};\n`),
  plain('importEquals', false, ALL_VARIANTS, `import T = require(${QUOTED});\n`),
  plain('importEquals', true, ALL_VARIANTS, `import type T = require(${QUOTED});\n`),
  plain('dynamic', false, ALL_VARIANTS, `import(${QUOTED});\n`),
  plain('require', false, ALL_VARIANTS, `require(${QUOTED});\n`),
  ...overModes('importType', false, ['ts', 'dts', 'tsx'], (mode) => `type T = import(${QUOTED}${importTypeAttributes(mode)});\n`),
  ...overModes('jsdocImportType', false, JS_ONLY, (mode) => `/** @type {import(${QUOTED}${importTypeAttributes(mode)})} */\nlet t;\n`),
  ...overModes('jsdocImport', false, JS_ONLY, (mode) => `/** @import * as T from ${QUOTED}${declarationAttributes(mode)} */\nlet t;\n`),
  plain('ambient', false, ALL_VARIANTS, `declare module ${QUOTED} {}\n`),
  ...overModes('referenceTypes', false, ALL_VARIANTS, (mode) => `/// <reference types=${QUOTED}${directiveAttribute(mode)} />\n`),
];

/** The variants that parse JSX: TSX and every JavaScript file (TypeScript's `LanguageVariant.JSX`). */
const JSX_VARIANTS: ReadonlySet<TsVariant> = new Set(['tsx', 'js']);

/**
 * The closed set of module-detection templates: the two syntax facts module detection reads, an
 * `export {}` for `moduleSyntax` and a JSX element for `hasJsx`, over the variants that can carry
 * them (a JSX element parses only in a `tsx` or `js` file, so `ts` and `dts` have no `hasJsx` text).
 */
export const MODULE_STAND_IN_TEMPLATES: readonly ModuleStandInTemplate[] = ALL_VARIANTS.flatMap((variant) =>
  [false, true].flatMap((moduleSyntax) =>
    (JSX_VARIANTS.has(variant) ? [false, true] : [false]).map((hasJsx) => ({
      moduleSyntax,
      hasJsx,
      variant,
      text: `${moduleSyntax ? 'export {};\n' : ''}${hasJsx ? '<a />;\n' : ''}`,
    })),
  ),
);

/** @returns Every stand-in text, so a test can hold the main thread's parses to the closed set */
export function standInTexts(): ReadonlySet<string> {
  return new Set([...MODE_STAND_IN_TEMPLATES, ...MODULE_STAND_IN_TEMPLATES].map((template) => template.text));
}

/** The package scope TypeScript finds for a file: what `packageJsonScope` holds. */
interface PackageJsonScope {
  readonly packageDirectory: string;
}

/** `getImpliedNodeFormatForFileWorker`'s answer: a format alone, or one found from a package scope. */
type ImpliedNodeFormatAnswer = ts.ResolutionMode | {
  readonly impliedNodeFormat: ts.ResolutionMode;
  readonly packageJsonLocations: readonly string[];
  readonly packageJsonScope: PackageJsonScope | undefined;
};

/** `tryParsePatterns`' answer, passed back to `matchPatternOrExact` unread. */
interface ParsedPatterns {
  readonly parsedPatterns: never;
}

/** The internals these rules call: on the `ts` object, outside the public typings. */
interface ResolveInternals {
  readonly getImpliedNodeFormatForFileWorker: (fileName: string, cache: ts.PackageJsonInfoCache | undefined, host: ts.ModuleResolutionHost, options: ts.CompilerOptions) => ImpliedNodeFormatAnswer;
  readonly getSetExternalModuleIndicator: (options: ts.CompilerOptions) => (file: ts.SourceFile) => void;
  readonly getDefaultResolutionModeForFileWorker: (file: ts.SourceFile, options: ts.CompilerOptions) => ts.ResolutionMode;
  readonly getEmitScriptTarget: (options: ts.CompilerOptions) => ts.ScriptTarget;
  readonly getSupportedExtensions: (options: ts.CompilerOptions) => readonly (readonly string[])[];
  readonly getSupportedExtensionsWithJsonIfResolveJsonModule: (options: ts.CompilerOptions, supported: readonly (readonly string[])[]) => readonly (readonly string[])[];
  readonly isDeclarationFileName: (fileName: string) => boolean;
  readonly hasExtension: (fileName: string) => boolean;
  readonly fileExtensionIs: (path: string, extension: string) => boolean;
  readonly tryParsePatterns: (paths: ts.MapLike<string[]>) => ParsedPatterns;
  readonly matchPatternOrExact: (patterns: ParsedPatterns, candidate: string) => unknown;
  readonly getResolutionDiagnostic: (options: ts.CompilerOptions, resolution: { readonly extension: string }, file: { readonly isDeclarationFile: boolean }) => unknown;
  readonly getAllowJSCompilerOption: (options: ts.CompilerOptions) => boolean;
  readonly resolutionExtensionIsTSOrJson: (extension: string) => boolean;
}

/** The internals {@link ResolveInternals} names, in the order {@link missingResolveInternal} checks them. */
export const RESOLVE_INTERNALS: readonly (keyof ResolveInternals)[] = [
  'getImpliedNodeFormatForFileWorker', 'getSetExternalModuleIndicator', 'getDefaultResolutionModeForFileWorker',
  'getEmitScriptTarget', 'getSupportedExtensions', 'getSupportedExtensionsWithJsonIfResolveJsonModule',
  'isDeclarationFileName', 'hasExtension', 'fileExtensionIs', 'tryParsePatterns', 'matchPatternOrExact',
  'getResolutionDiagnostic', 'getAllowJSCompilerOption', 'resolutionExtensionIsTSOrJson',
];

/**
 * @param typescript - The loaded TypeScript
 * @returns The first internal these rules call that it lacks, or undefined when it has them all
 */
export function missingResolveInternal(typescript: typeof ts): string | undefined {
  const candidate = typescript as unknown as Partial<Record<keyof ResolveInternals, unknown>>;
  return RESOLVE_INTERNALS.find((name) => typeof candidate[name] !== 'function');
}

/**
 * @param typescript - The loaded TypeScript
 * @returns Its internals, typed
 * @throws {TypeError} If one is missing (the step checks {@link missingResolveInternal} first and refuses with the loader's error)
 */
function internalsOf(typescript: typeof ts): ResolveInternals {
  const missing = missingResolveInternal(typescript);
  if (missing !== undefined) throw new TypeError(`the vendored TypeScript has no ${missing}, which the TypeScript resolve step calls`);
  return typescript as unknown as ResolveInternals;
}

/** A stand-in's package scope, set after the parse as `createProgram` sets it. */
interface WithPackageJsonScope {
  packageJsonScope?: PackageJsonScope | undefined;
}

/** The file a stand-in stands in for, and the compilation it is asked under. */
export interface StandInFile {
  /** The demanded config, root-relative: the compilation's identity in the cache key. */
  readonly config: string;
  /** The config's options, absolutized, as the resolution calls take them. */
  readonly options: ts.CompilerOptions;
  /** The file's name, absolute and normalized, as `createProgram` would see it. */
  readonly fileName: string;
  /** The resolution host the package scope is looked up through. */
  readonly host: ts.ModuleResolutionHost;
  /** The resolution cache's package.json cache (`getPackageJsonInfoCache()`), as `createProgram` passes it. */
  readonly packageJsonInfoCache: ts.PackageJsonInfoCache | undefined;
}

/** The `ts_imports` columns mode selection reads. */
type ModeColumns = Pick<TsImportsRow, 'kind' | 'typeOnly' | 'resolutionMode'>;

/** The `ts__files` columns module detection reads, with the pair's variant. */
interface ModuleFacts {
  readonly variant: TsVariant;
  readonly moduleSyntax: boolean;
  readonly hasJsx: boolean;
}

/** `createProgram`'s create options for a file, and the package scope it sets after the parse. */
interface CreateOptions {
  readonly options: ts.CreateSourceFileOptions;
  readonly scope: PackageJsonScope | undefined;
}

/** Joins a cache key's parts: a NUL, which no path, config name or template holds. */
const KEY_SEPARATOR = String.fromCodePoint(0);

/**
 * Stand-ins for one run: mode selection and module detection asked of TypeScript, cached per
 * `(config, package scope, file extension, text)`.
 */
export class TsStandIns {
  readonly #typescript: typeof ts;
  readonly #internals: ResolveInternals;
  readonly #standIns = new Map<string, ts.SourceFile>();
  readonly #createOptions = new Map<string, CreateOptions>();

  /**
   * @param typescript - The loaded TypeScript
   * @throws {TypeError} If it lacks an internal these rules call
   */
  constructor(typescript: typeof ts) {
    this.#typescript = typescript;
    this.#internals = internalsOf(typescript);
  }

  /**
   * TypeScript's resolution mode for a reference, as a `Program` answers it: `getModeForUsageLocation`
   * on the reference's stand-in, or, for a `referenceTypes` directive, its own `resolution-mode`, else
   * `getDefaultResolutionModeForFileWorker` (what `getModeForTypeReferenceDirectiveInFile` calls).
   *
   * @param file - The file and the compilation
   * @param row - The reference's shape
   * @returns The mode, or null when TypeScript answers none (and for a kind resolved without one)
   * @throws {RangeError} If the row's shape has no template (a row the extractor cannot produce)
   */
  modeOf(file: StandInFile, row: ModeColumns): ResolutionModeName | null {
    if (!isModeKind(row.kind)) return null;
    const template = MODE_STAND_IN_TEMPLATES.find(
      (candidate) => candidate.kind === row.kind && candidate.typeOnly === row.typeOnly && candidate.resolutionMode === row.resolutionMode,
    );
    if (template === undefined) throw new RangeError(`no stand-in template for ${JSON.stringify(row)}`);
    const standIn = this.#standIn(file, template.text);
    if (row.kind === 'referenceTypes') {
      const directive = standIn.typeReferenceDirectives[0];
      return this.#modeName(directive?.resolutionMode ?? this.#internals.getDefaultResolutionModeForFileWorker(standIn, file.options));
    }
    const usage = placeholderOf(this.#typescript, standIn);
    if (usage === undefined) throw new RangeError(`the stand-in for ${row.kind} holds no placeholder`);
    return this.#modeName(this.#typescript.getModeForUsageLocation(standIn, usage, file.options));
  }

  /**
   * Whether TypeScript reads the file as a module (`isExternalModule`), from the stand-in of its two
   * syntax facts under its real name and the compilation's `setExternalModuleIndicator`.
   *
   * @param file - The file and the compilation
   * @param facts - Its `ts__files` facts and variant
   * @returns True when the file is a module
   * @throws {RangeError} If the facts have no template (`hasJsx` in a variant that cannot parse JSX)
   */
  isModuleFile(file: StandInFile, facts: ModuleFacts): boolean {
    const template = MODULE_STAND_IN_TEMPLATES.find(
      (candidate) => candidate.variant === facts.variant && candidate.moduleSyntax === facts.moduleSyntax && candidate.hasJsx === facts.hasJsx,
    );
    if (template === undefined) throw new RangeError(`no module stand-in template for ${JSON.stringify(facts)}`);
    return this.#typescript.isExternalModule(this.#standIn(file, template.text));
  }

  /** The cached stand-in of `text` for `file`, created on a miss and counted. */
  #standIn(file: StandInFile, text: string): ts.SourceFile {
    const create = this.#createOptionsOf(file);
    const key = [file.config, create.scope?.packageDirectory ?? '', this.#extensionOf(file.fileName), text].join(KEY_SEPARATOR);
    const cached = this.#standIns.get(key);
    if (cached !== undefined) return cached;
    const standIn = this.#typescript.createSourceFile(file.fileName, text, create.options, true);
    (standIn as WithPackageJsonScope).packageJsonScope = create.scope;
    this.#standIns.set(key, standIn);
    countWork('resolve.ts.modeStandIns', 1);
    return standIn;
  }

  /** `getCreateSourceFileOptions`, as `createProgram` builds it for the file, memoized per `(config, file)`. */
  #createOptionsOf(file: StandInFile): CreateOptions {
    const key = `${file.config}${KEY_SEPARATOR}${file.fileName}`;
    const memo = this.#createOptions.get(key);
    if (memo !== undefined) return memo;
    const internals = this.#internals;
    const implied = internals.getImpliedNodeFormatForFileWorker(file.fileName, file.packageJsonInfoCache, file.host, file.options);
    const found = typeof implied === 'object' ? implied : undefined;
    const create: CreateOptions = {
      options: {
        languageVersion: internals.getEmitScriptTarget(file.options),
        impliedNodeFormat: found === undefined ? implied as ts.ResolutionMode : found.impliedNodeFormat,
        setExternalModuleIndicator: internals.getSetExternalModuleIndicator(file.options),
      },
      scope: found?.packageJsonScope,
    };
    this.#createOptions.set(key, create);
    return create;
  }

  /**
   * The file-name facts the two functions read: whether it is a declaration file name, and its last
   * extension (which fixes its `ScriptKind` and every extension test they make).
   */
  #extensionOf(fileName: string): string {
    const base = fileName.slice(fileName.lastIndexOf('/') + 1);
    const dot = base.lastIndexOf('.');
    return `${this.#internals.isDeclarationFileName(fileName) ? 'd' : ''}${dot < 0 ? '' : base.slice(dot)}`;
  }

  /** A `ResolutionMode` by name. */
  #modeName(mode: ts.ResolutionMode): ResolutionModeName | null {
    const kinds = this.#typescript.ModuleKind;
    if (mode === kinds.ESNext) return 'import';
    if (mode === kinds.CommonJS) return 'require';
    return null;
  }
}

const MODE_KINDS: ReadonlySet<string> = new Set(MODE_STAND_IN_TEMPLATES.map((template) => template.kind));

/** @returns Whether a row kind is resolved with a mode */
function isModeKind(kind: TsImportsRow['kind']): kind is ModeKind {
  return MODE_KINDS.has(kind);
}

/**
 * The placeholder literal in a stand-in, searched through the tree and through JSDoc tags (a JSDoc
 * `@import` or `import()` type lives in a comment, which `forEachChild` does not enter).
 */
function placeholderOf(typescript: typeof ts, standIn: ts.SourceFile): ts.StringLiteralLike | undefined {
  const find = (node: ts.Node): ts.StringLiteralLike | undefined =>
    typescript.isStringLiteralLike(node) && node.text === STAND_IN_SPECIFIER ? node : typescript.forEachChild(node, find);
  // A template's JSDoc hangs on its one statement; a tag's own children are walked by `forEachChild`.
  const tags = standIn.statements.flatMap((statement) => [...typescript.getJSDocTags(statement)]);
  return find(standIn) ?? tags.map(find).find((found) => found !== undefined);
}

/** The `ts_imports` columns the collection rule reads. */
type CollectionColumns = Pick<TsImportsRow, 'kind' | 'specifier' | 'specifierForm' | 'argumentCount' | 'scope'>;

/** The file facts the collection rule reads. */
interface CollectionFile {
  readonly variant: TsVariant;
  /** Whether TypeScript reads the file as a module ({@link TsStandIns.isModuleFile}). */
  readonly isModule: boolean;
}

/**
 * Which references: whether a `Program` would collect the reference, as
 * `collectExternalModuleReferences` and `forEachDynamicImportOrRequireCall` (with type-space imports
 * and string-literal-like `require` arguments) and the referenced-file and type-reference passes do.
 *
 * Every `ambient` row counts as a `declare`d module declaration: `ts__imports` records every
 * string-named module declaration and carries no modifier column, and a quoted module name without
 * `declare` outside a `.d.*` file is TS1035 at check time.
 *
 * @param typescript - The loaded TypeScript
 * @param row - The reference
 * @param file - The file's variant and module-ness
 * @returns True when the reference has a `ts_import_targets` row
 */
export function collected(typescript: typeof ts, row: CollectionColumns, file: CollectionFile): boolean {
  const nonEmptyString = row.specifierForm === 'string' && row.specifier !== '';
  switch (row.kind) {
    case 'import':
    case 'export':
    case 'importEquals':
      return nonEmptyString && staticReferenceCollected(typescript, row, file);
    case 'ambient':
      return row.specifierForm === 'string' && augmentation(typescript, row, file);
    case 'dynamic':
      return row.specifierForm !== null && (row.argumentCount ?? 0) >= 1;
    case 'require':
      return file.variant === 'js' && row.argumentCount === 1 && row.specifierForm !== null;
    case 'importType':
    case 'jsdocImportType':
      // `isLiteralImportTypeNode`: a string literal argument, empty or not.
      return row.specifierForm === 'string';
    case 'jsdocImport':
      return nonEmptyString;
    case 'referencePath':
    case 'referenceTypes':
    case 'referenceLib':
      return true;
    case 'createRequire':
      return false;
  }
}

/**
 * An `import`, `export` or `importEquals`: a top-level statement, or one in a `declare module` body of
 * a file that is not a module with a non-relative specifier (TypeScript enters the body of an ambient
 * module, never an augmentation's).
 */
function staticReferenceCollected(typescript: typeof ts, row: CollectionColumns, file: CollectionFile): boolean {
  if (row.scope === 'module') return true;
  return row.scope === 'ambientModule' && !file.isModule && !typescript.isExternalModuleNameRelative(row.specifier ?? '');
}

/**
 * Whether a `declare module 'm'` is an augmentation, which TypeScript resolves: any top-level one in
 * a module file, and a non-relative one nested in an ambient module's body. A top-level one in a file
 * that is not a module declares an ambient module, which is a name and not resolved.
 */
function augmentation(typescript: typeof ts, row: CollectionColumns, file: CollectionFile): boolean {
  if (row.scope === 'module') return file.isModule;
  return row.scope === 'ambientModule' && !file.isModule && !typescript.isExternalModuleNameRelative(row.specifier ?? '');
}

/**
 * Where a `/// <reference path>` lands: `resolveTripleslashReference`, then the rule of
 * `getSourceFileFromReferenceWorker`, a `createProgram` closure the step cannot call. A path with an
 * extension resolves only when the extension is one `getSupportedExtensions(options)` lists (with
 * `.json` under `resolveJsonModule`) and the file exists; a path without one tries the first
 * extension group of that list in order (`.ts`, `.tsx`, `.d.ts`, and `.js`, `.jsx` under `allowJs`).
 * The internal `allowNonTsExtensions` option, which no tsconfig sets, is not modelled.
 *
 * @param typescript - The loaded TypeScript
 * @param specifier - The directive's `path`
 * @param containingFile - The referencing file, absolute
 * @param options - The config's options, absolutized
 * @param fileExists - The resolution host's `fileExists`
 * @returns The target, absolute, or undefined when the reference is unresolved
 */
export function tripleSlashPathTarget(
  typescript: typeof ts,
  specifier: string,
  containingFile: string,
  options: ts.CompilerOptions,
  fileExists: (path: string) => boolean,
): string | undefined {
  const internals = internalsOf(typescript);
  const fileName = typescript.resolveTripleslashReference(specifier, containingFile);
  const supported = internals.getSupportedExtensions(options);
  if (internals.hasExtension(fileName)) {
    const withJson = internals.getSupportedExtensionsWithJsonIfResolveJsonModule(options, supported);
    const known = withJson.flat().some((extension) => internals.fileExtensionIs(fileName, extension));
    return known && fileExists(fileName) ? fileName : undefined;
  }
  return supported[0]?.map((extension) => fileName + extension).find((candidate) => fileExists(candidate));
}

/**
 * Whether a `paths` key of the config matches the specifier, by TypeScript's own matcher
 * (`tryParsePatterns`, `matchPatternOrExact`): an exact key, or the best `*` pattern.
 *
 * @param typescript - The loaded TypeScript
 * @param options - The config's options
 * @param specifier - The specifier
 * @returns True when a key matches; false when the config has no `paths`
 */
export function pathsMatch(typescript: typeof ts, options: ts.CompilerOptions, specifier: string): boolean {
  if (options.paths === undefined) return false;
  const internals = internalsOf(typescript);
  return internals.matchPatternOrExact(internals.tryParsePatterns(options.paths), specifier) !== undefined;
}

/**
 * Whether a referenced project's root file has a declaration output tsc reads in its place
 * (`parseProjectReferenceConfigFile`): any file but a declaration file or a `.json` file, by
 * TypeScript's own rules (`isDeclarationFileName`, `fileExtensionIs`).
 *
 * @param typescript - The loaded TypeScript
 * @param fileName - The file
 * @returns True when tsc substitutes the file's output
 */
export function hasReferenceOutput(typescript: typeof ts, fileName: string): boolean {
  const internals = internalsOf(typescript);
  return !internals.isDeclarationFileName(fileName) && !internals.fileExtensionIs(fileName, '.json');
}

/** A resolved module reference, as {@link joinsProgram} reads it. */
interface ModuleResolutionFacts {
  readonly kind: TsImportsRow['kind'];
  /** The resolution's `extension`, as TypeScript answered it. */
  readonly extension: string;
  /** The containing file's variant: `js` is a JavaScript file (TypeScript's `isInJSFile`). */
  readonly containing: TsVariant;
}

/**
 * Whether a `Program` adds the file a module reference resolved to, as `processImportedModules`'
 * `shouldAddFile` decides: no resolution diagnostic (`getResolutionDiagnostic`: a `.tsx` needs a
 * `jsx` setting, a `.js`/`.jsx` needs `allowJs` or a non-strict `noImplicitAny`, a `.json`
 * `resolveJsonModule`, any other extension a declaration file or `allowArbitraryExtensions`), not a
 * JavaScript file without `allowJs` (`getAllowJSCompilerOption`), not a module augmentation (its
 * name sits past the file's `imports`, so tsc resolves it and adds nothing), and not a JSDoc
 * reference in a file that is not JavaScript. `noResolve` and a `node_modules` JavaScript depth are
 * the caller's: under `noResolve` nothing is followed, and every `node_modules` entry is a member
 * link, which is a leaf.
 *
 * @param typescript - The loaded TypeScript
 * @param options - The config's options
 * @param reference - The reference's kind, its resolution's extension and the containing file's variant
 * @returns True when tsc adds the resolved file to the program
 */
export function joinsProgram(typescript: typeof ts, options: ts.CompilerOptions, reference: ModuleResolutionFacts): boolean {
  const internals = internalsOf(typescript);
  if (reference.kind === 'ambient') return false;
  if ((reference.kind === 'jsdocImport' || reference.kind === 'jsdocImportType') && reference.containing !== 'js') return false;
  if (internals.getResolutionDiagnostic(options, { extension: reference.extension }, { isDeclarationFile: reference.containing === 'dts' }) !== undefined) return false;
  return internals.resolutionExtensionIsTSOrJson(reference.extension) || internals.getAllowJSCompilerOption(options);
}
