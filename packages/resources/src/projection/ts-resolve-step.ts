/**
 * The TypeScript resolve step: `ts_import_targets`, `ts_program_files` and
 * `ts_import_conditions`, derived per run from the `ts` instance's rows, the tsconfig step's parsed
 * configs, the workspace link table, git content and TypeScript's own resolver, never stored.
 *
 * It is the one main-thread importer of the vendored TypeScript loader (`vendored-typescript.ts`):
 * every module it calls (`ts-resolve-host.ts`, `ts-stand-ins.ts`, `ts-output-map.ts`,
 * `tsconfig-options.ts`, `workspace-links.ts`) takes TypeScript as a parameter. On the main thread
 * TypeScript reads strings and options only: resolution, and the parse of a stand-in whose text is
 * one of a closed template set, never a document's bytes. Nothing here reads disk: the host is a
 * virtual isolated install (`ts-resolve-host.ts`), and every row comes through the declared-reads
 * handle.
 *
 * ## What it reads, and in what order
 *
 * TypeScript's resolution is synchronous, so each root's reads come first, in one read per kind:
 * the `ts` pair (`ts__files`, `ts__imports`) of every routed TS/JS file, and the `json` pair of every
 * git-content `package.json` outside `node_modules`, whose rows the host serves as rebuilt JSON
 * (`jsonTextOf`, shared with the tsconfig step). A reached file with a TS/JS extension that is not
 * routed as `ts` is declared and read once more, so its absence comes from the handle, with its
 * reason and remedy.
 *
 * ## Per demanded config
 *
 * The configs are the tsconfig step's final parse (script-invoked configs and their `references`
 * closures), options made absolute by `absoluteOptions`. The run's output map covers every emitting
 * demanded config of every root. Per config, a breadth-first walk from its root files
 * (`tsconfig_files`) over `file` targets records `ts_program_files` (`distance`, `reachedOnly`). It
 * follows a `file` target only when tsc's program adds it (`joinsProgram`: no resolution diagnostic,
 * so a `.js`/`.jsx` needs `allowJs` and a `.tsx` a `jsx` setting; never a module augmentation's
 * target); one it does not add keeps its row and is no program file. A `member` target is recorded
 * and never followed, and so are a `file` target the output map redirected from another project's
 * output (tsc reads that output, so the source is that project's, a leaf like a member) and a `file`
 * target that is a root file of a project in the config's `references` closure, since tsc reads
 * that project's declaration output in its place (`referencedSourcesOf`; such a root file of the
 * config itself is no program file). The walk starts from root files only: a file the program
 * loads through the `types` option or an automatic type directive, and everything reachable only
 * from it, is no program file and has no target rows. Each reference the collection rule keeps
 * (`collected`) gets one `ts_import_targets` row: `referenceLib` is `lib`; a `referencePath` lands
 * by the triple-slash rule; a `referenceTypes` by `resolveTypeReferenceDirective` under the
 * directive's mode; every other kind by `resolveModuleName` under the mode `modeOf` answers, with one
 * resolution-cache pair per `(config, owning manifest)` (the owning manifest is the nearest
 * `workspace_packages` directory holding the file), counted `resolve.ts.hosts`. A result is mapped
 * through a link (`realpath`, which also covers `preserveSymlinks`), then back through the output
 * map (`redirected`), then classified.
 *
 * Under `noResolve` TypeScript still resolves the module references a file holds but adds no file
 * they reach to the program and processes no `referencePath` or `referenceTypes` directive, so the
 * walk adds no reached file and those directives have no row.
 *
 * ## Refusals: every one refuses all three relations
 *
 * - The tsconfig family's refusal, as it stands (no TypeScript is loaded).
 * - A file a closure reaches (a root file, or a `file` target) with a TS/JS extension the handle
 *   answers `absent`: `DATA_REQUEST_UNROUTED` when it is not routed as `ts` (unrouted, `exclude`d,
 *   under `node_modules`), else the pair's own code (`TS_FILE_NO_ROWS`, ...), with the data stage's
 *   remedy and retryability; the message names the config and the file.
 * - A `package.json` TypeScript reads while it resolves, whose `json` pair has no rows, likewise.
 *
 * An unresolved reference is a row, never a refusal; `TS_OUTPUT_REDIRECT_AMBIGUOUS` and
 * `TS_VERSION_SKEW` are condition rows, never refusals.
 *
 * A read that finds a row set evicted throws the row-set tier's `StoredRowsEvictedError` unchanged,
 * so the lane's one retry runs.
 */

import { appendAll, compareCodeUnits, countWork, mapInOrder, toForwardSlash, VatError } from '@vibe-agent-toolkit/utils';
import picomatch from 'picomatch';

import type { GitContentRow } from '../schemas/projection-git-content.js';
import type { TsImportConditionRow, TsImportTargetRow, TsProgramFileRow, TsTargetKind } from '../schemas/projection-ts-resolve.js';
import type { TsFileRow, TsImportRow, TsImportsRow, TsRouteRow, TsVariant } from '../schemas/projection-ts.js';
import type { TsconfigClosureRow } from '../schemas/projection-tsconfig.js';
import type { WorkspacePackageRow } from '../schemas/projection-workspace.js';
import type ts from '../vendor/typescript.cjs';
import { loadVendoredTypeScript, vendoredTypeScriptLacks } from '../vendored-typescript.js';

import type { DeclaredAnswer, DeclaredPair, DeclaredReads } from './declared-reads.js';
import { DERIVED_TABLES } from './derived-table-registry.js';
import { compareRows } from './export.js';
import { openIoWindow } from './io-window.js';
import { tsVariantOf } from './router.js';
import { bareSpecifierPackage, tsImportsRows } from './ts-imports.js';
import { OutputMaps, type OutputMapConfig, type RunOutputMap } from './ts-output-map.js';
import { resolveHost, type ResolveHost } from './ts-resolve-host.js';
import { collected, hasReferenceOutput, joinsProgram, missingResolveInternal, pathsMatch, tripleSlashPathTarget, TsStandIns, type StandInFile } from './ts-stand-ins.js';
import { versionSkewRows } from './ts-version-skew.js';
import { absoluteOptions, type AbsoluteTsconfigOptions } from './tsconfig-options.js';
import type { ParsedTsconfig } from './tsconfig-parse.js';
import { jsonTextOf, type TsconfigAnswer, type TsconfigRefusal } from './tsconfig-step.js';
import { linkedPath, NO_WORKSPACE_LINKS, withCaseRule, type WorkspaceLinkTable } from './workspace-links.js';
import type { WorkspaceAnswer } from './workspace-packages.js';

/** How a refusal of a missing internal names this step. */
const CALLER = 'the TypeScript resolve step';

const PACKAGE_JSON = 'package.json';

/** Joins a key's parts: a NUL, which no path or config name holds. */
const KEY_SEPARATOR = String.fromCodePoint(0);

/** A path under `node_modules`: never git content the step reads. */
const NODE_MODULES = picomatch('**/node_modules/**');

/** What the step reads of a `ts` pair. */
const TS_TABLES: { readonly tables: readonly ['tsFiles', 'tsImports'] } = { tables: ['tsFiles', 'tsImports'] };

/** What the step reads of a `json` pair. */
const NODES: { readonly tables: readonly ['dataNodes'] } = { tables: ['dataNodes'] };

/** The three relations, in words, for a refusal's message. */
const RELATIONS = 'ts_import_targets, ts_program_files and ts_import_conditions';

/** Every relation's rows, each sorted by its key. */
export interface TsResolveRows {
  readonly targets: readonly TsImportTargetRow[];
  readonly programFiles: readonly TsProgramFileRow[];
  readonly conditions: readonly TsImportConditionRow[];
}

/**
 * The step's answer, with the TypeScript version that answered (the loaded module's `version`), or
 * the refusal that refuses all three relations. A refusal has the tsconfig family's shape, so the
 * stage publishes both alike; the family's own refusal is carried as it stands.
 */
export type TsResolveAnswer =
  | { readonly outcome: 'rows'; readonly typescript: string; readonly rows: TsResolveRows }
  | { readonly outcome: 'refused'; readonly typescript: string | null; readonly refusal: TsconfigRefusal };

/**
 * What the step reads: everything the data stage holds once the workspace and tsconfig steps have
 * run (filled from the stage, after the tsconfig step).
 */
interface TsResolveInput {
  /** Every root of the run, in order: its id, and its absolute path (the host's prefix, never read). */
  readonly roots: ReadonlyArray<{ readonly id: string; readonly path: string }>;
  /** The tsconfig step's answer: its parsed configs, or the refusal that refuses this step too. */
  readonly tsconfig: TsconfigAnswer;
  /** The workspace step's answer: the owning manifests, the member names and the skew rows read its rows; a refused or absent answer gives none. */
  readonly workspace: WorkspaceAnswer | undefined;
  /** Each root's workspace link table (the one the tsconfig job was handed), by root id; a root absent here has no links. */
  readonly links: ReadonlyMap<string, WorkspaceLinkTable>;
  /** The run's git content (`git_content`), every root. */
  readonly gitContent: readonly GitContentRow[];
  /** The run's `ts__routes` rows, every root: the routed TS/JS files whose pairs the step reads. */
  readonly tsRoutes: readonly TsRouteRow[];
  /** The handle over a declared set: the step builds one per read as its set grows. */
  readonly declaredReads: (declared: readonly DeclaredPair[]) => DeclaredReads;
  /** The TypeScript to resolve with; the vendored loader's module when absent. A test passes a wrapped module here. */
  readonly typescript?: typeof ts;
}

/** Thrown inside the step to refuse the three relations; caught once, never past the step. */
class Refused extends VatError {
  constructor(readonly refusal: TsconfigRefusal) {
    super(refusal.code, refusal.message);
  }
}

/** An absent answer of the handle. */
type Absent = Extract<DeclaredAnswer<never>, { state: 'absent' }>;

/**
 * Resolve the import graph of every demanded config of every root.
 *
 * @param input - The run's roots, the tsconfig and workspace answers, links, git content, routes and handle
 * @returns The rows, or the refusal of all three relations
 * @throws {import('../parse-cache.js').ParserUnavailableError} When the vendored TypeScript cannot load or lacks an internal the step calls
 * @throws A `StoredRowsEvictedError` of the row-set tier, store on, from the handle
 */
export async function resolveTsImports(input: TsResolveInput): Promise<TsResolveAnswer> {
  const { tsconfig } = input;
  if (tsconfig.outcome === 'refused') return { outcome: 'refused', typescript: tsconfig.typescript, refusal: tsconfig.refusal };
  const typescript = input.typescript ?? await loadVendoredTypeScript();
  // The window opens once the module is loaded: loading it may stat the disk (its case-sensitivity probe, skipped on Windows), which is not resolution.
  const close = openIoWindow();
  try {
    const run = new RunResolve(typescript, input, tsconfig.parsed, tsconfig.rows.closure);
    try {
      return { outcome: 'rows', typescript: typescript.version, rows: await run.resolve() };
    } catch (error) {
      if (error instanceof Refused) return { outcome: 'refused', typescript: typescript.version, refusal: error.refusal };
      throw error;
    }
  } finally {
    close();
  }
}

/** One demanded config, as the resolver takes it. */
interface ResolveConfig {
  /** Its path, root-relative: the relations' `config` column. */
  readonly path: string;
  readonly options: AbsoluteTsconfigOptions;
  /** The same options, as TypeScript's resolvers type them. */
  readonly compilerOptions: ts.CompilerOptions;
  /** Its root files, root-relative (`tsconfig_files`). */
  readonly fileNames: readonly string[];
  /** What the output map reads: absolute options and inputs. */
  readonly output: OutputMapConfig;
  /**
   * The sources tsc takes from a referenced project's declaration output instead (root-relative,
   * folded by the run's case rule): see {@link referencedSourcesOf}. The walk never enters one.
   */
  readonly referencedSources: ReadonlySet<string>;
}

/** The run's state shared by every root: TypeScript, its stand-ins and its output map. */
class RunResolve {
  readonly #typescript: typeof ts;
  readonly #input: TsResolveInput;
  readonly #parsed: ReadonlyMap<string, readonly ParsedTsconfig[]>;
  readonly #closure: readonly TsconfigClosureRow[];

  constructor(typescript: typeof ts, input: TsResolveInput, parsed: ReadonlyMap<string, readonly ParsedTsconfig[]>, closure: readonly TsconfigClosureRow[]) {
    this.#typescript = typescript;
    this.#input = input;
    this.#parsed = parsed;
    this.#closure = closure;
  }

  /**
   * @returns Every root's rows, each relation sorted by its key
   * @throws Refused when a root refuses
   * @throws {import('../parse-cache.js').ParserUnavailableError} When the module lacks an internal the step calls
   */
  async resolve(): Promise<TsResolveRows> {
    const typescript = this.#typescript;
    const missing = missingResolveInternal(typescript);
    if (missing !== undefined) throw vendoredTypeScriptLacks(missing, CALLER);
    const caseSensitive = typescript.sys.useCaseSensitiveFileNames;
    const outputMaps = new OutputMaps(typescript, !caseSensitive, (name) => vendoredTypeScriptLacks(name, CALLER));
    const fold = caseSensitive ? (path: string): string => path : (path: string): string => path.toLowerCase();
    const configs = new Map(this.#input.roots.map((root) => {
      const parsed = this.#parsed.get(root.id) ?? [];
      const closure = this.#closure.filter((row) => row.root === root.id);
      return [root.id, parsed.map((config) => resolveConfigOf(typescript, config, root.path, referencedSourcesOf(typescript, config.path, parsed, closure, fold)))];
    }));
    const outputs = outputMaps.combined([...configs.values()].flat().map((config) => config.output));
    const shared: RunShared = { typescript, caseSensitive, outputs, standIns: new TsStandIns(typescript), input: this.#input };
    // One root at a time: the first refusal refuses the relations, so no later root resolves.
    const parts = await mapInOrder(this.#input.roots, (root) => new RootResolve(root, configs.get(root.id) ?? [], shared).resolve());
    return {
      targets: parts.flatMap((part) => part.targets).toSorted(compareRows(DERIVED_TABLES.tsImportTargets)),
      programFiles: parts.flatMap((part) => part.programFiles).toSorted(compareRows(DERIVED_TABLES.tsProgramFiles)),
      conditions: parts.flatMap((part) => part.conditions).toSorted(compareRows(DERIVED_TABLES.tsImportConditions)),
    };
  }
}

/** What every root's resolve shares. */
interface RunShared {
  readonly typescript: typeof ts;
  readonly caseSensitive: boolean;
  /** The run's output map over every emitting demanded config. */
  readonly outputs: RunOutputMap;
  readonly standIns: TsStandIns;
  readonly input: TsResolveInput;
}

/**
 * A parsed config as the resolver takes it: path options absolute under the root (the inverse of
 * the worker's relativizing, by the same declared list), root files absolute for the output map.
 */
function resolveConfigOf(typescript: typeof ts, config: ParsedTsconfig, rootPath: string, referencedSources: ReadonlySet<string>): ResolveConfig {
  const root = withoutTrailingSlash(toForwardSlash(rootPath));
  const options = absoluteOptions(typescript, config.options, root);
  const compilerOptions = options as ts.CompilerOptions;
  return { path: config.path, options, compilerOptions, fileNames: config.fileNames, output: { options: compilerOptions, fileNames: config.fileNames.map((name) => `${root}/${name}`) }, referencedSources };
}

/**
 * The sources a config's program takes from a referenced project's declaration output, as tsc
 * builds it (`createProgram` with `projectReferences`, `useSourceOfProjectReferenceRedirect` off,
 * as it is for tsc; only the language service turns it on). tsc maps every root file of every
 * project in the config's `references` closure, transitively and never the config itself
 * (`options.configFile !== sourceFile`), and `findSourceFileWorker` then replaces such a file,
 * whether a root file or a reached one, by its `.d.ts` output (or drops it under the referenced
 * project's `outFile`), which is not git content. A declaration file or a `.json` file of the
 * referenced project has no output and stays itself, so it is not one of these.
 *
 * @param typescript - The vendored module, for its declaration-file rule (`hasReferenceOutput`)
 * @param config - The config's root-relative path
 * @param parsed - The root's final parsed configs
 * @param closure - The root's `tsconfig_closure` rows
 * @param fold - The run's case rule
 * @returns The folded root-relative paths
 */
function referencedSourcesOf(typescript: typeof ts, config: string, parsed: readonly ParsedTsconfig[], closure: readonly TsconfigClosureRow[], fold: (path: string) => string): Set<string> {
  const members = new Set(closure.filter((row) => row.config === config && row.member !== config).map((row) => row.member));
  const sources = parsed.filter((candidate) => members.has(candidate.path)).flatMap((candidate) => candidate.fileNames);
  return new Set(sources.filter((path) => hasReferenceOutput(typescript, path)).map(fold));
}

/** @returns `path` without trailing slashes (a filesystem root keeps its one) */
function withoutTrailingSlash(path: string): string {
  let end = path.length;
  while (end > 1 && path[end - 1] === '/') end--;
  return path.slice(0, end);
}

/** One routed `ts` pair's facts, as the walk reads them. */
interface FileFacts {
  readonly variant: TsVariant;
  readonly file: TsFileRow;
  /** Its `ts_imports` rows, in ordinal order. */
  readonly imports: readonly TsImportsRow[];
}

/** One root's rows while they are built. */
interface RootRows {
  readonly targets: TsImportTargetRow[];
  readonly programFiles: TsProgramFileRow[];
  readonly conditions: TsImportConditionRow[];
}

/** A resolution-cache pair, one per `(config, owning manifest)`. */
interface CachePair {
  readonly modules: ts.ModuleResolutionCache;
  readonly typeReferences: ts.TypeReferenceDirectiveResolutionCache;
}

/** The file a reference is resolved from, under one config. */
interface Containing {
  readonly config: ResolveConfig;
  /** Root-relative. */
  readonly path: string;
  /** Absolute. */
  readonly fileName: string;
  readonly caches: CachePair;
  readonly standIn: StandInFile;
}

/** What one reference resolved to, before classification. */
interface Resolved {
  /** Absolute, as TypeScript answered it. */
  readonly fileName: string;
  /** Whether TypeScript found it through `node_modules`: the only `node_modules` entries are links. */
  readonly throughLink: boolean;
  /** Whether tsc adds the file to the program when it is a `file` target ({@link joinsProgram}; a directive's file always joins). */
  readonly joins: boolean;
}

/** A reference's row, and whether the walk follows it. */
interface Reached {
  readonly row: TsImportTargetRow;
  /** A `file` target tsc adds to the program, not redirected from another project's output. */
  readonly follows: boolean;
}

/** A reached TS/JS file with no held rows: the walk stops there, and the step refuses. */
interface Stuck {
  readonly config: ResolveConfig;
  readonly path: string;
  readonly variant: TsVariant;
}

/** A reference's outcome columns. */
type Outcome = Pick<TsImportTargetRow, 'targetKind' | 'target' | 'redirected'> & { readonly follows: boolean };

/** One root's resolve: its reads, its configs' walks and its rows. */
class RootResolve {
  readonly #id: string;
  readonly #root: string;
  readonly #configs: readonly ResolveConfig[];
  readonly #shared: RunShared;
  readonly #listing: readonly string[];
  readonly #declared = new Map<string, DeclaredPair>();
  /** Each routed `ts` pair with rows, by path. */
  readonly #facts = new Map<string, FileFacts>();
  /** Each `ts` pair the handle answered absent, by path. */
  readonly #absentFiles = new Map<string, Absent>();
  /** Each git-content `package.json`'s rebuilt text, or the handle's absence. */
  readonly #packages = new Map<string, string | Absent>();
  /** The `package.json` paths TypeScript asked for that have no rows, in order: each refuses. */
  readonly #missedPackages: string[] = [];
  readonly #host: ResolveHost;
  readonly #links: WorkspaceLinkTable;
  readonly #ownerDirs: readonly string[];
  readonly #members: ReadonlySet<string>;
  readonly #caches = new Map<string, CachePair>();
  /** Where the root's demanded configs put their outputs, folded by the run's case rule. */
  readonly #outputPlaces: readonly OutputPlace[];

  constructor(root: { readonly id: string; readonly path: string }, configs: readonly ResolveConfig[], shared: RunShared) {
    this.#id = root.id;
    this.#root = withoutTrailingSlash(toForwardSlash(root.path));
    this.#configs = configs;
    this.#shared = shared;
    const { input } = shared;
    this.#listing = input.gitContent.filter((row) => row.root === root.id).map((row) => row.path);
    const links = input.links.get(root.id) ?? NO_WORKSPACE_LINKS;
    this.#links = withCaseRule(links, !shared.caseSensitive);
    const packages = input.workspace?.outcome === 'rows' ? input.workspace.packages.filter((row) => row.root === root.id) : [];
    this.#ownerDirs = ownerDirsOf(packages);
    this.#members = new Set(packages.flatMap((row) => (row.name === null ? [] : [row.name])));
    this.#outputPlaces = configs.flatMap((config) => outputPlacesOf(config.compilerOptions)).map((place) => ({ ...place, path: this.#fold(place.path) }));
    this.#host = resolveHost({
      root: this.#root,
      listing: this.#listing,
      links,
      outputs: shared.outputs,
      packageJsonText: (path) => this.#packageJsonText(path),
      useCaseSensitiveFileNames: shared.caseSensitive,
    });
  }

  /**
   * @returns The root's rows
   * @throws Refused when a reached file or a read `package.json` has no rows
   */
  async resolve(): Promise<RootRows> {
    const rows: RootRows = { targets: [], programFiles: [], conditions: [] };
    const { input, typescript } = this.#shared;
    if (input.workspace?.outcome === 'rows') appendAll(rows.conditions, versionSkewRows(this.#id, input.workspace.dependencies, typescript.version));
    if (this.#configs.length === 0) return rows;
    await this.#readPairs();
    const stuck = this.#walkAll(rows);
    if (stuck !== undefined) throw this.#absent(stuck.config, this.#absentFiles.get(stuck.path) ?? await this.#readUnrouted(stuck.path, stuck.variant));
    return rows;
  }

  /** @returns Where the walk of the configs, in order, stopped at a reached file with no rows; undefined when every walk ended */
  #walkAll(rows: RootRows): Stuck | undefined {
    for (const config of this.#configs) {
      const stuck = this.#walk(config, rows);
      if (stuck !== undefined) return stuck;
    }
    return undefined;
  }

  /** One read of every routed `ts` pair, one of every git-content `package.json`. */
  async #readPairs(): Promise<void> {
    const routes = this.#shared.input.tsRoutes.filter((route) => route.root === this.#id);
    const tsPairs = routes.map((route): DeclaredPair => ({ root: this.#id, path: route.path, instance: 'ts', variant: route.variant }));
    const jsonPairs = this.#listing
      .filter((path) => isPackageJson(path) && !NODE_MODULES(path))
      .toSorted(compareCodeUnits)
      .map((path): DeclaredPair => ({ root: this.#id, path, instance: 'data', variant: 'json' }));
    for (const pair of [...tsPairs, ...jsonPairs]) this.#declared.set(pairKey(pair), pair);
    const handle = this.#shared.input.declaredReads([...this.#declared.values()]);
    if (tsPairs.length > 0) this.#holdFiles(routes, await handle.read(tsPairs, TS_TABLES));
    if (jsonPairs.length === 0) return;
    for (const answer of await handle.read(jsonPairs, NODES)) {
      this.#packages.set(answer.pair.path, answer.state === 'present' ? jsonTextOf(answer.rows.dataNodes) : answer);
    }
  }

  /** Hold each present `ts` pair's facts, and each absent one's answer. */
  #holdFiles(routes: readonly TsRouteRow[], answers: ReadonlyArray<DeclaredAnswer<'tsFiles' | 'tsImports'>>): void {
    const imports: TsImportRow[] = [];
    const heads = new Map<string, TsFileRow>();
    // Files with the same bytes share one row set: its rows are taken once, and every route to it reads them.
    const taken = new Set<string>();
    for (const answer of answers) {
      if (answer.state !== 'present') {
        this.#absentFiles.set(answer.pair.path, answer);
        continue;
      }
      const [head] = answer.rows.tsFiles;
      if (head === undefined) continue;
      heads.set(answer.pair.path, head);
      const rowSet = [head.blob, head.variant].join(KEY_SEPARATOR);
      if (taken.has(rowSet)) continue;
      taken.add(rowSet);
      appendAll(imports, answer.rows.tsImports);
    }
    const byPath = new Map<string, TsImportsRow[]>();
    for (const row of tsImportsRows(routes.filter((route) => heads.has(route.path)), imports)) {
      const held = byPath.get(row.path);
      if (held === undefined) byPath.set(row.path, [row]);
      else held.push(row);
    }
    for (const [path, file] of heads) this.#facts.set(path, { variant: file.variant, file, imports: byPath.get(path) ?? [] });
  }

  /**
   * A `package.json`'s text for the host. One with no rows answers nothing and is recorded, so the
   * reference that read it refuses: TypeScript would otherwise resolve as if the file were empty.
   */
  #packageJsonText(path: string): string | undefined {
    const held = this.#packages.get(path);
    if (typeof held === 'string') return held;
    if (held !== undefined) this.#missedPackages.push(path);
    return undefined;
  }

  /**
   * One config's breadth-first walk from its root files over `file` targets.
   *
   * @returns Where it stopped: a reached TS/JS file with no rows, which refuses; undefined when it ended
   * @throws Refused when a `package.json` TypeScript reads has no rows
   */
  #walk(config: ResolveConfig, rows: RootRows): Stuck | undefined {
    countWork('resolve.ts.configs', 1);
    const leaf = (path: string): boolean => config.referencedSources.has(this.#fold(path));
    // A referenced project's root file is a leaf: tsc reads its declaration output instead, whether it is a root file here or reached.
    const roots = config.fileNames.filter((path) => !leaf(path));
    const distance = new Map(roots.map((path) => [path, 0]));
    const queue = [...roots];
    const follows = config.compilerOptions.noResolve !== true;
    for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
      const at = distance.get(path) ?? 0;
      rows.programFiles.push({ root: this.#id, config: config.path, path, distance: at, reachedOnly: at > 0 });
      const facts = this.#facts.get(path);
      if (facts === undefined) {
        // A file the `ts` instance never parses (a `.json` input) has no references; any other stops the walk.
        const variant = tsVariantOf(path);
        if (variant === undefined) continue;
        return { config, path, variant };
      }
      const reached = this.#targetsOf(config, path, facts, rows);
      this.#refuseMissedPackage(config);
      appendAll(rows.targets, reached.map((each) => each.row));
      countWork('resolve.ts.references', reached.length);
      for (const { row: { target }, follows: joins } of reached) {
        if (!follows || !joins || target === null || distance.has(target) || leaf(target)) continue;
        distance.set(target, at + 1);
        queue.push(target);
      }
    }
    countWork('resolve.ts.files', distance.size);
    return undefined;
  }

  /** @returns The handle's absence for a reached `ts` pair not among the routed ones, read through a handle over the grown declared set */
  async #readUnrouted(path: string, variant: TsVariant): Promise<Absent> {
    const pair: DeclaredPair = { root: this.#id, path, instance: 'ts', variant };
    this.#declared.set(pairKey(pair), pair);
    const [answer] = await this.#shared.input.declaredReads([...this.#declared.values()]).read([pair], TS_TABLES);
    if (answer?.state !== 'absent') throw new Error(`The reached file '${path}' is not routed as ts, yet the handle answered it present.`);
    return answer;
  }

  /**
   * Refuse when TypeScript read a `package.json` with no rows while it resolved (or looked up a
   * file's package scope): its answer would treat the file as empty.
   *
   * @throws Refused naming the config and the `package.json`
   */
  #refuseMissedPackage(config: ResolveConfig): void {
    const [missed] = this.#missedPackages;
    const held = missed === undefined ? undefined : this.#packages.get(missed);
    if (held !== undefined && typeof held !== 'string') throw this.#absent(config, held);
  }

  /** @returns The refusal of a reached file (or a read `package.json`) with no rows, naming the config */
  #absent(config: ResolveConfig, answer: Absent): Refused {
    const { path, variant } = answer.pair;
    const needs = `'${config.path}' reaches '${path}' (${variant})`;
    if (answer.cause === 'unrouted') {
      return new Refused({
        code: answer.code,
        root: this.#id,
        path,
        message: `${needs}, and it cannot be read: ${answer.detail}. The resolve step reads only routed pairs, so ${RELATIONS} cannot answer.`,
        remedy: `${answer.remedy}; the resolved import graph answers only when every file a demanded config's program reaches is routed`,
        retryable: false,
      });
    }
    return new Refused({
      code: answer.code,
      root: this.#id,
      path,
      message: `${needs}, which has no rows this run (${answer.routeState} ${answer.code}), so ${RELATIONS} cannot answer.`,
      // The data stage's one remedy for the file, so this and its finding never disagree.
      remedy: answer.remedy,
      retryable: answer.retryable,
    });
  }

  /** @returns The target row of every collected reference of one file, and whether the walk follows it */
  #targetsOf(config: ResolveConfig, path: string, facts: FileFacts, rows: RootRows): Reached[] {
    const containing = this.#containing(config, path);
    const isModule = this.#shared.standIns.isModuleFile(containing.standIn, { variant: facts.variant, moduleSyntax: facts.file.moduleSyntax, hasJsx: facts.file.hasJsx });
    const { typescript } = this.#shared;
    const kept = facts.imports.filter((row) => collected(typescript, row, { variant: facts.variant, isModule }) && !skippedUnderNoResolve(config, row));
    return kept.map((row) => this.#targetOf(containing, facts.variant, row, rows));
  }

  /** The containing file under a config: its name, its `(config, owning manifest)` caches and its stand-in file. */
  #containing(config: ResolveConfig, path: string): Containing {
    const fileName = `${this.#root}/${path}`;
    const caches = this.#cachesOf(config, ownerOf(this.#ownerDirs, path));
    const standIn: StandInFile = { config: config.path, options: config.compilerOptions, fileName, host: this.#host, packageJsonInfoCache: caches.modules.getPackageJsonInfoCache() };
    return { config, path, fileName, caches, standIn };
  }

  /** @returns The `(config, owning manifest)` cache pair, created and counted on first use */
  #cachesOf(config: ResolveConfig, owner: string): CachePair {
    const key = [config.path, owner].join(KEY_SEPARATOR);
    const held = this.#caches.get(key);
    if (held !== undefined) return held;
    const { typescript, caseSensitive } = this.#shared;
    const canonical = caseSensitive ? (name: string): string => name : (name: string): string => name.toLowerCase();
    const options = config.compilerOptions;
    const modules = typescript.createModuleResolutionCache(this.#root, canonical, options);
    const pair = { modules, typeReferences: typescript.createTypeReferenceDirectiveResolutionCache(this.#root, canonical, options, modules.getPackageJsonInfoCache()) };
    this.#caches.set(key, pair);
    countWork('resolve.ts.hosts', 1);
    return pair;
  }

  /** One reference's row, and whether the walk follows it. */
  #targetOf(containing: Containing, variant: TsVariant, row: TsImportsRow, rows: RootRows): Reached {
    const { typescript, standIns } = this.#shared;
    const options = containing.config.compilerOptions;
    const mode = standIns.modeOf(containing.standIn, row);
    const { specifier } = row;
    // The collection rule (`collected`) keeps only a reference with a literal specifier.
    if (specifier === null) throw new Error(`The collection rule kept reference ${String(row.ordinal)} of '${containing.path}', which has no literal specifier.`);
    const matched = isModuleReference(row.kind) && pathsMatch(typescript, options, specifier);
    const { follows, ...outcome } = this.#outcomeOf(containing, { row, variant }, { specifier, mode, matched }, rows);
    return { row: { root: this.#id, config: containing.config.path, path: containing.path, ordinal: row.ordinal, kind: row.kind, specifier, mode, ...outcome, package: row.package, pathsMatched: matched }, follows };
  }

  /** The outcome of one reference: resolved and classified, or why not. */
  #outcomeOf(
    containing: Containing,
    reference: { readonly row: TsImportsRow; readonly variant: TsVariant },
    asked: { readonly specifier: string; readonly mode: 'import' | 'require' | null; readonly matched: boolean },
    rows: RootRows,
  ): Outcome {
    const { row } = reference;
    if (row.kind === 'referenceLib') return { targetKind: 'lib', target: null, redirected: false, follows: false };
    const resolved = this.#resolve(containing, reference, asked.specifier, asked.mode);
    if (resolved === undefined) return { targetKind: this.#unresolvedKind(containing.path, row, asked.matched), target: null, redirected: false, follows: false };
    return this.#mapped(containing, row, resolved, rows);
  }

  /** TypeScript's answer for one reference, or undefined when it resolved none. */
  #resolve(containing: Containing, reference: { readonly row: TsImportsRow; readonly variant: TsVariant }, specifier: string, mode: 'import' | 'require' | null): Resolved | undefined {
    const { typescript } = this.#shared;
    const options = containing.config.compilerOptions;
    const { kind } = reference.row;
    if (kind === 'referencePath') {
      const fileName = tripleSlashPathTarget(typescript, specifier, containing.fileName, options, (path) => this.#host.fileExists(path));
      return fileName === undefined ? undefined : { fileName, throughLink: false, joins: true };
    }
    const resolutionMode = mode === null ? undefined : modeKindOf(typescript, mode);
    if (kind === 'referenceTypes') {
      const directive = typescript.resolveTypeReferenceDirective(specifier, containing.fileName, options, this.#host, undefined, containing.caches.typeReferences, resolutionMode).resolvedTypeReferenceDirective;
      return directive?.resolvedFileName === undefined ? undefined : { fileName: directive.resolvedFileName, throughLink: directive.isExternalLibraryImport === true, joins: true };
    }
    const module = typescript.resolveModuleName(specifier, containing.fileName, options, this.#host, containing.caches.modules, undefined, resolutionMode).resolvedModule;
    if (module === undefined) return undefined;
    const joins = joinsProgram(typescript, options, { kind, extension: module.extension, containing: reference.variant });
    return { fileName: module.resolvedFileName, throughLink: module.isExternalLibraryImport === true, joins };
  }

  /**
   * A resolved path through the link map (`realpath`, which TypeScript already applied unless
   * `preserveSymlinks`), then the output map, then classified. Only a `file` target the program
   * adds ({@link Resolved.joins}) and the output map did not redirect is followed: a redirected one
   * stands for another project's output, which tsc reads as that output, so its source is a leaf
   * like a member's.
   */
  #mapped(containing: Containing, row: TsImportsRow, resolved: Resolved, rows: RootRows): Outcome {
    const real = this.#host.realpath(resolved.fileName);
    const lookup = this.#shared.outputs.lookup(real);
    if (lookup?.kind === 'ambiguous') {
      rows.conditions.push(this.#ambiguity(containing, row, real, lookup.sources));
      return { targetKind: 'unresolved', target: null, redirected: false, follows: false };
    }
    const fileName = lookup?.kind === 'source' ? lookup.source : real;
    const redirected = lookup?.kind === 'source';
    const target = this.#host.contentPath(fileName) ?? null;
    if (!redirected && this.#underOutputDirectory(fileName)) return { targetKind: 'outputUnmapped', target, redirected, follows: false };
    if (target === null) return { targetKind: 'unresolved', target, redirected, follows: false };
    if (resolved.throughLink) return { targetKind: 'member', target, redirected, follows: false };
    return { targetKind: 'file', target, redirected, follows: resolved.joins && !redirected };
  }

  /** @returns Whether a path lies under an output directory (or is an `outFile` output) of a demanded config that emits */
  #underOutputDirectory(fileName: string): boolean {
    const folded = this.#fold(fileName);
    return this.#outputPlaces.some((place) => (place.kind === 'file' ? place.path === folded : isBelow(folded, place.path)));
  }

  /** @returns A path folded by the run's case rule */
  #fold(path: string): string {
    return this.#shared.caseSensitive ? path : path.toLowerCase();
  }

  /** The `TS_OUTPUT_REDIRECT_AMBIGUOUS` condition of a reference resolved to an output with two sources. */
  #ambiguity(containing: Containing, row: TsImportsRow, output: string, sources: readonly string[]): TsImportConditionRow {
    const named = sources.map((source) => `'${this.#host.contentPath(source) ?? source}'`).join(' and ');
    return {
      root: this.#id,
      config: containing.config.path,
      path: containing.path,
      ordinal: row.ordinal,
      code: 'TS_OUTPUT_REDIRECT_AMBIGUOUS',
      message: `'${row.specifier ?? ''}' resolves to the output '${this.#host.contentPath(output) ?? relativeTo(this.#root, output)}', which the output map maps from ${named}, so it is unresolved`,
      pinnedMajor: null,
      declaredMajors: null,
      manifests: null,
    };
  }

  /**
   * Why a reference TypeScript did not resolve failed, by its specifier: a `paths` alias, a
   * relative, absolute or `#` specifier is `unresolved`; a builtin `builtin`; a bare specifier
   * naming a workspace member with no link from the file `memberUndeclared` (with a link,
   * `unresolved`); any other bare specifier `external`.
   */
  #unresolvedKind(path: string, row: TsImportsRow, matched: boolean): TsTargetKind {
    if (matched || row.kind === 'referencePath') return 'unresolved';
    const specifier = row.specifier ?? '';
    if (row.builtin) return 'builtin';
    const named = bareSpecifierPackage(specifier);
    if (named === null) return 'unresolved';
    if (!this.#members.has(named)) return 'external';
    return this.#linkVisible(path, named) ? 'unresolved' : 'memberUndeclared';
  }

  /** @returns Whether a link `<D>/node_modules/<name>` exists for a directory `D` holding the file or above it */
  #linkVisible(path: string, name: string): boolean {
    for (let dir = dirOf(path); ; dir = dirOf(dir)) {
      if (linkedPath(this.#links, joined(dir, `node_modules/${name}`)) !== undefined) return true;
      if (dir === '') return false;
    }
  }
}

/** The kinds TypeScript's module resolution answers (and `paths` applies to). */
function isModuleReference(kind: TsImportsRow['kind']): boolean {
  return kind !== 'referencePath' && kind !== 'referenceTypes' && kind !== 'referenceLib';
}

/** Under `noResolve` a `Program` processes no `referencePath` or `referenceTypes` directive. */
function skippedUnderNoResolve(config: ResolveConfig, row: TsImportsRow): boolean {
  return config.compilerOptions.noResolve === true && (row.kind === 'referencePath' || row.kind === 'referenceTypes');
}

/** @returns The `ResolutionMode` TypeScript's resolvers take for a mode name */
function modeKindOf(typescript: typeof ts, mode: 'import' | 'require'): ts.ResolutionMode {
  return mode === 'import' ? typescript.ModuleKind.ESNext : typescript.ModuleKind.CommonJS;
}

/** An output place of a config: a directory its outputs go under, or one bundle file. */
interface OutputPlace {
  readonly kind: 'directory' | 'file';
  /** Absolute. */
  readonly path: string;
}

/**
 * Where a demanded config that emits puts its outputs: `outDir` and `declarationDir`, and for an
 * `outFile` config the bundle and its declaration (`<outFile minus extension>.d.ts`), which no
 * output map holds because a bundle has no per-file outputs.
 */
function outputPlacesOf(options: ts.CompilerOptions): OutputPlace[] {
  if (options.noEmit === true) return [];
  const places: OutputPlace[] = [];
  for (const name of ['outDir', 'declarationDir'] as const) {
    const value = options[name];
    if (typeof value === 'string') places.push({ kind: 'directory', path: withoutTrailingSlash(value) });
  }
  const { outFile } = options;
  if (typeof outFile === 'string' && outFile !== '') {
    const dot = outFile.lastIndexOf('.');
    places.push({ kind: 'file', path: outFile }, { kind: 'file', path: `${dot > outFile.lastIndexOf('/') ? outFile.slice(0, dot) : outFile}.d.ts` });
  }
  return places;
}

/** @returns Every workspace manifest's directory of a root, root-relative (`''` for the root), deepest first */
function ownerDirsOf(packages: readonly WorkspacePackageRow[]): string[] {
  return [...new Set(packages.map((row) => (row.dir === '.' ? '' : row.dir)))].sort((left, right) => right.length - left.length || compareCodeUnits(left, right));
}

/** @returns The owning manifest's directory of a file: the deepest workspace manifest directory holding it, `''` for the root or none */
function ownerOf(ownerDirs: readonly string[], path: string): string {
  return ownerDirs.find((dir) => dir === '' || isBelow(path, dir)) ?? '';
}

/** @returns A text key for a declared pair */
function pairKey(pair: DeclaredPair): string {
  return [pair.path, pair.instance, pair.variant].join(KEY_SEPARATOR);
}

/** @returns Whether a path is a `package.json` */
function isPackageJson(path: string): boolean {
  return path === PACKAGE_JSON || path.endsWith(`/${PACKAGE_JSON}`);
}

/** @returns A path's directory, `''` for a file at the root */
function dirOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

/** @returns An absolute path relative to the root, as a message names it */
function relativeTo(root: string, path: string): string {
  return isBelow(path, root) ? path.slice(root.length + 1) : path;
}

/**
 * Whether one forward-slash path lies below a directory. Both are spellings the step built (git
 * content, TypeScript's answers, absolutized options), already forward-slash.
 */
function isBelow(below: string, directory: string): boolean {
  return toForwardSlash(below).startsWith(`${toForwardSlash(directory)}/`);
}

/** @returns A root-relative directory joined with a relative path; `''` is the root */
function joined(dir: string, rest: string): string {
  return dir === '' ? rest : `${dir}/${rest}`;
}
