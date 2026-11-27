/**
 * The tsconfig parse: a parse-pool job kind that runs TypeScript's own config parser over one
 * analysis root's demanded configs, in the parse worker, and answers plain data.
 *
 * ## Why in the worker
 *
 * TypeScript's JSON reader recurses, and a config rebuilt from `jsonc` rows may nest as deep as
 * `outputDepth`, which overflows the main thread's stack. So `parseJsonText`,
 * `parseJsonSourceFileConfigFileContent` and `matchFiles` run only here, under the worker's limits.
 * This module is the one importer of `vendored-typescript.ts`, and `parser-loader.ts` is the one
 * importer of this module (`parser-import-boundary.test.ts`, both ways). The main-thread step
 * (`tsconfig-step.ts`) imports its types only.
 *
 * ## The host
 *
 * It answers from the root's git-content listing alone: a file exists when it is listed; a
 * directory exists when a listed file lies beneath it; a directory's entries are its listed files
 * and the directories holding them. It never calls `readdir` or `stat`, so nothing gitignored and no
 * `node_modules` path exists. `realpath` is the identity (a tracked symlink is one listed name).
 * `readFile` answers a HELD text (JSON rebuilt from the path's `jsonc` rows); a listed path whose text
 * is not held is recorded as a request and answered `undefined`. A job that recorded a request
 * answers the requests instead of results: the step reads them and dispatches the next wave.
 *
 * ## What it answers, and what it never does
 *
 * Per config: `options` (`configFile` reduced to `{ fileName }`, every path option root-relative),
 * root-relative `fileNames` (git content only), `projectReferences`, the `extends` chain in
 * TypeScript's order, the error codes and categories, every path the host was asked about with its
 * call and phase (`chain` while the config and its bases resolve, `inputs` while its files are
 * walked), and the literal `files`/`include` entries that name a path outside git content. It never
 * answers a diagnostic's message text: nothing reads it, and an outside-root path is classified from
 * the recorded paths alone (a root-relative form that begins with a `..` segment).
 *
 * ## Limits
 *
 * Each text TypeScript is handed is first held to the document limits, as a data file is:
 * `inputBytes`, and depth through the data instance's nesting pre-scan (`gateJsonDepth`). A breach
 * answers the job `defective` with the data instance's code. The output is NOT held to the fixed
 * `outputRows`/`outputBytes` caps: every config's `fileNames` is a subset of the listing, so the
 * job's output is bounded by the listing's size times the config count, derived per job
 * ({@link tsconfigOutputBound}).
 */

import { compareCodeUnits, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';

import { ParserUnavailableError } from '../parse-cache.js';
import { inputBytesBreach, type ParseLimits } from '../parse-limits.js';
import type ts from '../vendor/typescript.cjs';
import { loadVendoredTypeScript } from '../vendored-typescript.js';

import { type DataOutputLimitName, gateJsonDepth } from './data-extractor.js';

/** One tsconfig job: one analysis root's demanded configs, the config texts held, and its listing. */
export interface TsconfigJobInput {
  /** The analysis root, absolute. A prefix only: the job reads nothing from disk. */
  readonly root: string;
  /** Root-relative paths of the demanded configs, answered in this order. */
  readonly configs: readonly string[];
  /** Root-relative path to the JSON text rebuilt from that path's `jsonc` rows (`shadowed = 0`). */
  readonly texts: Readonly<Record<string, string>>;
  /** The root's git content (`git_content`), root-relative. */
  readonly listing: readonly string[];
  /** Whether paths compare case-sensitively; TypeScript's own platform rule (`ts.sys`) when absent. */
  readonly useCaseSensitiveFileNames?: boolean;
}

/** Which part of a config's parse asked the host: resolving the config and its bases, or walking its files. */
type TsconfigPhase = 'chain' | 'inputs';

/** The host call that asked about a path; `files` is a literal `files` entry, which TypeScript never asks about. */
type TsconfigHostCall = 'fileExists' | 'directoryExists' | 'getFileSystemEntries' | 'readFile' | 'realpath' | 'files';

/** A path the host was asked about, root-relative (`..`-prefixed outside the root). */
export interface TsconfigAskedPath {
  readonly path: string;
  readonly call: TsconfigHostCall;
  readonly phase: TsconfigPhase;
}

/** One of `parsed.errors`: its code and `ts.DiagnosticCategory`, never its message text. */
export interface TsconfigDiagnostic {
  readonly code: number;
  readonly category: number;
}

/** A literal entry naming a path outside git content, filtered from the members. */
export interface TsconfigReachOutsideGit {
  readonly kind: 'files-entry' | 'include-entry';
  /** The entry as validated (after `${configDir}` substitution). */
  readonly entry: string;
  /** The path it names, root-relative. */
  readonly path: string;
}

/** One `references` entry, its path root-relative. */
export interface TsconfigProjectReference {
  readonly path: string;
  readonly originalPath: string;
  readonly circular: boolean;
}

/** The compiler options of one parsed config: path options root-relative, `configFile` reduced. */
export type TsconfigOptions = Omit<ts.CompilerOptions, 'configFile'> & { readonly configFile?: { readonly fileName: string } };

/** One demanded config as TypeScript parsed it. */
export interface ParsedTsconfig {
  readonly path: string;
  readonly options: TsconfigOptions;
  readonly fileNames: readonly string[];
  readonly projectReferences: readonly TsconfigProjectReference[];
  /** The `extends` chain in TypeScript's order (each base, then its own bases), root-relative. */
  readonly extends: readonly string[];
  readonly errors: readonly TsconfigDiagnostic[];
  readonly asked: readonly TsconfigAskedPath[];
  readonly reachesOutsideGit: readonly TsconfigReachOutsideGit[];
}

/** A held text past a document limit: defective with the data instance's code. */
export interface TsconfigTextDefect {
  readonly path: string;
  readonly code: 'PARSE_LIMIT_EXCEEDED' | 'DATA_PARSE_ERROR';
  readonly limit?: 'inputBytes' | DataOutputLimitName;
  readonly found?: number;
}

/**
 * What one job answers, with the TypeScript version that answered: a text past a limit (final),
 * else the held-text misses to read for the next wave, else every demanded config parsed.
 */
export type TsconfigJobAnswer =
  | { readonly outcome: 'defective'; readonly typescript: string; readonly defects: readonly TsconfigTextDefect[] }
  | { readonly outcome: 'requests'; readonly typescript: string; readonly requests: readonly string[] }
  | { readonly outcome: 'parsed'; readonly typescript: string; readonly configs: readonly ParsedTsconfig[] };

/** The limits a job holds each text to. */
export type TsconfigTextLimits = Pick<ParseLimits, 'inputBytes' | DataOutputLimitName>;

/** The job, with TypeScript loaded. */
export type TsconfigParse = (input: TsconfigJobInput, limits: TsconfigTextLimits) => TsconfigJobAnswer;

/** A directory's entries as `matchFiles` reads them: names, not paths. */
interface FileSystemEntries {
  readonly files: readonly string[];
  readonly directories: readonly string[];
}

/** `ts.matchFiles`' arguments, in its order. */
type MatchFilesArguments = [
  path: string,
  extensions: readonly string[] | undefined,
  excludes: readonly string[] | undefined,
  includes: readonly string[] | undefined,
  useCaseSensitiveFileNames: boolean,
  currentDirectory: string,
  depth: number | undefined,
  getFileSystemEntries: (path: string) => FileSystemEntries,
  realpath: (path: string) => string,
];

/** The internals of TypeScript the job calls beyond its public API. */
interface TypeScriptInternals {
  readonly matchFiles: (...args: MatchFilesArguments) => string[];
  readonly optionDeclarations: ReadonlyArray<{ readonly name: string; readonly type: unknown; readonly isFilePath?: boolean; readonly element?: { readonly isFilePath?: boolean } }>;
}

/** What TypeScript leaves on a parsed config's source file (internal members). */
interface ConfigSourceFileInternals {
  readonly parseDiagnostics?: readonly ts.Diagnostic[];
  readonly extendedSourceFiles?: readonly string[];
  readonly configFileSpecs?: { readonly validatedFilesSpec?: readonly string[]; readonly validatedIncludeSpecs?: readonly string[] };
}

/** The vendored file, named in a missing-internal refusal. */
const VENDORED_TYPESCRIPT = './vendor/typescript.cjs';

/** Joins an asked path's key parts: NUL, which no path holds. */
const KEY_SEPARATOR = String.fromCodePoint(0);

/** Path options TypeScript resolves but declares in no `optionDeclarations` entry. */
const UNDECLARED_PATH_OPTIONS = ['configFilePath', 'pathsBasePath'] as const;

/**
 * Load the vendored TypeScript and return the job bound to it. Refuses rather than guesses when an
 * internal the job needs is missing.
 *
 * @returns The job
 * @throws {ParserUnavailableError} If TypeScript cannot be loaded, or lacks `matchFiles` or `optionDeclarations`
 */
export async function loadTsconfigParse(): Promise<TsconfigParse> {
  const typescript = await loadVendoredTypeScript();
  internalsOf(typescript);
  return (input, limits) => parseTsconfigs(typescript, input, limits);
}

/**
 * @param typescript - The loaded TypeScript
 * @returns Its internals the job calls
 * @throws {ParserUnavailableError} If one is missing
 */
function internalsOf(typescript: typeof ts): TypeScriptInternals {
  const internals = typescript as unknown as Partial<TypeScriptInternals>;
  if (typeof internals.matchFiles !== 'function') throw missingInternal('matchFiles');
  if (!Array.isArray(internals.optionDeclarations)) throw missingInternal('optionDeclarations');
  return internals as TypeScriptInternals;
}

/** @returns The refusal for a TypeScript lacking `name` */
function missingInternal(name: string): ParserUnavailableError {
  return new ParserUnavailableError('typescript', VENDORED_TYPESCRIPT, new Error(`the vendored TypeScript has no ${name}, which the tsconfig parse calls`));
}

/**
 * Parse one root's demanded configs: the job, in-process. The worker calls it through
 * {@link loadTsconfigParse}; a unit test calls it directly with the loaded TypeScript.
 *
 * @param typescript - The loaded TypeScript
 * @param input - The root, the demanded configs, the held texts and the listing
 * @param limits - The document limits each text is held to
 * @returns The answer
 */
export function parseTsconfigs(typescript: typeof ts, input: TsconfigJobInput, limits: TsconfigTextLimits): TsconfigJobAnswer {
  const internals = internalsOf(typescript);
  const caseSensitive = input.useCaseSensitiveFileNames ?? typescript.sys.useCaseSensitiveFileNames;
  const listing = new ListingIndex(input.root, input.listing, caseSensitive);
  const texts = new HeldTexts(input, listing, limits);
  const configs = input.configs.map((path) => parseOne(typescript, internals, listing, texts, path));
  const version = typescript.version;
  if (texts.defects.length > 0) return { outcome: 'defective', typescript: version, defects: texts.defects };
  if (texts.requests.size > 0) return { outcome: 'requests', typescript: version, requests: [...texts.requests].sort(compareCodeUnits) };
  return { outcome: 'parsed', typescript: version, configs: configs.filter((config) => config !== undefined) };
}

/**
 * The output bound of one job, derived from its input: every config's `fileNames` is a subset of the
 * listing, so no answer holds more than the listing's size times the config count.
 *
 * @param input - The job's input
 * @returns The most `fileNames` entries the answer can hold
 */
export function tsconfigOutputBound(input: Pick<TsconfigJobInput, 'configs' | 'listing'>): number {
  return input.listing.length * input.configs.length;
}

/**
 * @param answer - A job's answer
 * @returns The `fileNames` entries it holds, the quantity {@link tsconfigOutputBound} bounds
 */
export function tsconfigOutputRows(answer: TsconfigJobAnswer): number {
  if (answer.outcome !== 'parsed') return 0;
  return answer.configs.reduce((sum, config) => sum + config.fileNames.length, 0);
}

/** The root's listing as the host reads it: listed files, and each listed directory's entries. */
class ListingIndex {
  readonly root: string;
  readonly caseSensitive: boolean;
  /** Canonical absolute path of each listed file, to its listed root-relative spelling. */
  readonly #files = new Map<string, string>();
  /** Canonical absolute path of each directory holding a listed file, to its entries' names. */
  readonly #directories = new Map<string, { readonly files: Set<string>; readonly directories: Set<string> }>();

  constructor(root: string, listing: readonly string[], caseSensitive: boolean) {
    this.root = safePath.resolve(root);
    this.caseSensitive = caseSensitive;
    for (const path of listing) this.#add(path);
  }

  #add(path: string): void {
    const segments = toForwardSlash(path).split('/');
    this.#files.set(this.canonical(safePath.join(this.root, path)), path);
    let directory = this.root;
    for (const [index, name] of segments.entries()) {
      const entries = this.#entriesAt(directory);
      if (index === segments.length - 1) {
        entries.files.add(name);
        return;
      }
      entries.directories.add(name);
      directory = safePath.join(directory, name);
    }
  }

  #entriesAt(directory: string): { readonly files: Set<string>; readonly directories: Set<string> } {
    const key = this.canonical(directory);
    let entries = this.#directories.get(key);
    if (entries === undefined) {
      entries = { files: new Set(), directories: new Set() };
      this.#directories.set(key, entries);
    }
    return entries;
  }

  /** @returns `path` absolute under the root, normalized, forward-slashed */
  absolute(path: string): string {
    return safePath.resolve(this.root, path);
  }

  /** @returns `path` relative to the root, forward-slashed (`..`-prefixed outside it) */
  relative(path: string): string {
    return safePath.relative(this.root, this.absolute(path));
  }

  /** @returns `path` as compared under the case rule */
  canonical(path: string): string {
    return this.caseSensitive ? path : path.toLowerCase();
  }

  /** @returns The listed root-relative spelling of a file, or undefined when it is not git content */
  file(path: string): string | undefined {
    return this.#files.get(this.canonical(this.absolute(path)));
  }

  /** @returns Whether a listed file lies beneath `path` */
  hasDirectory(path: string): boolean {
    return this.#directories.has(this.canonical(this.absolute(path)));
  }

  /** @returns A directory's listed files and the directories holding listed files, empty when there are none */
  entries(path: string): FileSystemEntries {
    const entries = this.#directories.get(this.canonical(this.absolute(path)));
    if (entries === undefined) return { files: [], directories: [] };
    return { files: [...entries.files], directories: [...entries.directories] };
  }
}

/** The job's held texts: each gated once, the misses and the defects collected across every config. */
class HeldTexts {
  readonly requests = new Set<string>();
  readonly defects: TsconfigTextDefect[] = [];
  readonly #texts = new Map<string, string>();
  readonly #gated = new Map<string, string | undefined>();
  readonly #listing: ListingIndex;
  readonly #limits: TsconfigTextLimits;

  constructor(input: TsconfigJobInput, listing: ListingIndex, limits: TsconfigTextLimits) {
    this.#listing = listing;
    this.#limits = limits;
    for (const [path, text] of Object.entries(input.texts)) this.#texts.set(listing.canonical(listing.absolute(path)), text);
  }

  /**
   * A held text, gated; a listed path not held is requested. `undefined` for a miss, a defect, or a
   * path that is not git content.
   *
   * @param path - Absolute, or root-relative
   * @param demanded - Whether the path is a demanded config, requested even when not listed
   * @returns The text TypeScript reads, or undefined
   */
  read(path: string, demanded = false): string | undefined {
    const key = this.#listing.canonical(this.#listing.absolute(path));
    if (this.#gated.has(key)) return this.#gated.get(key);
    const text = this.#texts.get(key);
    if (text === undefined) {
      const listed = this.#listing.file(path);
      if (listed !== undefined || demanded) this.requests.add(listed ?? this.#listing.relative(path));
      return undefined;
    }
    const gated = this.#gate(this.#listing.relative(path), text);
    this.#gated.set(key, gated);
    return gated;
  }

  #gate(path: string, text: string): string | undefined {
    const bytes = Buffer.byteLength(text, 'utf8');
    if (inputBytesBreach(bytes, this.#limits.inputBytes) !== undefined) {
      this.defects.push({ path, code: 'PARSE_LIMIT_EXCEEDED', limit: 'inputBytes', found: bytes });
      return undefined;
    }
    const gate = gateJsonDepth(text, this.#limits);
    if (gate.outcome === 'depth') return text;
    this.defects.push(gate.outcome === 'breach'
      ? { path, code: 'PARSE_LIMIT_EXCEEDED', limit: gate.limit, found: gate.found }
      : { path, code: gate.code });
    return undefined;
  }
}

/** The host for one config's parse, recording what it was asked. */
class RecordingHost implements ts.ParseConfigHost {
  readonly useCaseSensitiveFileNames: boolean;
  readonly asked = new Map<string, TsconfigAskedPath>();
  phase: TsconfigPhase = 'chain';
  readonly #listing: ListingIndex;
  readonly #texts: HeldTexts;
  readonly #internals: TypeScriptInternals;

  constructor(listing: ListingIndex, texts: HeldTexts, internals: TypeScriptInternals) {
    this.useCaseSensitiveFileNames = listing.caseSensitive;
    this.#listing = listing;
    this.#texts = texts;
    this.#internals = internals;
  }

  record(path: string, call: TsconfigHostCall, phase: TsconfigPhase = this.phase): void {
    const relative = this.#listing.relative(path);
    const key = [phase, call, relative].join(KEY_SEPARATOR);
    if (!this.asked.has(key)) this.asked.set(key, { path: relative, call, phase });
  }

  fileExists(path: string): boolean {
    this.record(path, 'fileExists');
    return this.#listing.file(path) !== undefined;
  }

  directoryExists(path: string): boolean {
    this.record(path, 'directoryExists');
    return this.#listing.hasDirectory(path);
  }

  readFile(path: string): string | undefined {
    this.record(path, 'readFile');
    return this.#texts.read(path);
  }

  realpath(path: string): string {
    this.record(path, 'realpath');
    return path;
  }

  readDirectory(rootDir: string, extensions: readonly string[], excludes: readonly string[] | undefined, includes: readonly string[], depth?: number): string[] {
    this.phase = 'inputs';
    try {
      return this.#internals.matchFiles(
        rootDir, extensions, excludes, includes, this.useCaseSensitiveFileNames, this.#listing.root, depth,
        (path) => {
          this.record(path, 'getFileSystemEntries');
          return this.#listing.entries(path);
        },
        (path) => this.realpath(path),
      );
    } finally {
      this.phase = 'chain';
    }
  }
}

/**
 * Parse one demanded config, or undefined when its own text is a miss or a defect.
 *
 * @returns The parsed config
 */
function parseOne(
  typescript: typeof ts,
  internals: TypeScriptInternals,
  listing: ListingIndex,
  texts: HeldTexts,
  path: string,
): ParsedTsconfig | undefined {
  const text = texts.read(path, true);
  if (text === undefined) return undefined;
  const fileName = listing.absolute(path);
  const directory = safePath.resolve(fileName, '..');
  const host = new RecordingHost(listing, texts, internals);
  const sourceFile = typescript.parseJsonText(fileName, text);
  const parsed = typescript.parseJsonSourceFileConfigFileContent(sourceFile, host, directory, undefined, fileName);
  const own = sourceFile as unknown as ConfigSourceFileInternals;
  if (own.configFileSpecs === undefined) throw missingInternal('configFileSpecs on a parsed config');
  const outside = literalsOutsideGit(listing, directory, own.configFileSpecs, host);
  const filtered = new Set(outside.filter((entry) => entry.kind === 'files-entry').map((entry) => listing.canonical(listing.absolute(entry.path))));
  return {
    path,
    options: rootRelativeOptions(internals, listing, parsed.options),
    fileNames: parsed.fileNames.filter((name) => !filtered.has(listing.canonical(name))).map((name) => listing.relative(name)),
    projectReferences: (parsed.projectReferences ?? []).map((reference) => ({
      path: listing.relative(reference.path),
      originalPath: reference.originalPath ?? reference.path,
      circular: reference.circular === true,
    })),
    extends: (own.extendedSourceFiles ?? []).map((base) => listing.relative(base)),
    errors: [...(own.parseDiagnostics ?? []), ...parsed.errors].map((error) => ({ code: error.code, category: error.category })),
    asked: [...host.asked.values()],
    reachesOutsideGit: outside,
  };
}

/** Whether a spec has no wildcard: a literal path. */
function isLiteralSpec(spec: string): boolean {
  return !spec.includes('*') && !spec.includes('?');
}

/**
 * The literal `files` and `include` entries that name a path outside git content. Every literal
 * `files` entry is recorded as asked about in the inputs phase: TypeScript takes it without asking
 * the host, and an outside-root one must still classify the config.
 *
 * @returns One entry per literal naming neither a listed file nor a listed directory
 */
function literalsOutsideGit(
  listing: ListingIndex,
  configDirectory: string,
  specs: NonNullable<ConfigSourceFileInternals['configFileSpecs']>,
  host: RecordingHost,
): TsconfigReachOutsideGit[] {
  const outside: TsconfigReachOutsideGit[] = [];
  for (const entry of specs.validatedFilesSpec ?? []) {
    const path = safePath.resolve(configDirectory, entry);
    host.record(path, 'files', 'inputs');
    if (listing.file(path) === undefined) outside.push({ kind: 'files-entry', entry, path: listing.relative(path) });
  }
  for (const entry of (specs.validatedIncludeSpecs ?? []).filter((spec) => isLiteralSpec(spec))) {
    const path = safePath.resolve(configDirectory, entry);
    if (listing.file(path) === undefined && !listing.hasDirectory(path)) outside.push({ kind: 'include-entry', entry, path: listing.relative(path) });
  }
  return outside;
}

/** Whether an option's value is the parsed config's source file (`options.configFile`). */
function isConfigSourceFile(value: unknown): value is { readonly fileName: string } {
  return typeof value === 'object' && value !== null && typeof (value as { fileName?: unknown }).fileName === 'string';
}

/**
 * The options with every path option root-relative (the ones TypeScript declares `isFilePath`, as a
 * string or a list's element, and the two it resolves undeclared) and `configFile` reduced to its
 * root-relative `fileName`.
 *
 * @returns Plain data a structured clone carries
 */
function rootRelativeOptions(internals: TypeScriptInternals, listing: ListingIndex, options: ts.CompilerOptions): TsconfigOptions {
  const { configFile, ...rest } = options;
  const out: Record<string, unknown> = { ...rest };
  const pathNames = [
    ...internals.optionDeclarations
      .filter((declaration) => declaration.isFilePath === true || declaration.element?.isFilePath === true)
      .map((declaration) => declaration.name),
    ...UNDECLARED_PATH_OPTIONS,
  ];
  for (const name of pathNames) {
    const value = out[name];
    if (typeof value === 'string') out[name] = listing.relative(value);
    else if (Array.isArray(value)) out[name] = value.map((item: unknown) => (typeof item === 'string' ? listing.relative(item) : item));
  }
  if (isConfigSourceFile(configFile)) out['configFile'] = { fileName: listing.relative(configFile.fileName) };
  return out as TsconfigOptions;
}
