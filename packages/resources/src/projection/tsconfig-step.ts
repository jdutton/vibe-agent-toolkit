/**
 * The tsconfig resolve step: every `tsconfig_*` relation, derived per run from the `data`
 * instance's rows, the run's git-content listing and TypeScript's own config parser, never stored.
 *
 * It runs on the main thread and never loads TypeScript: the parse is a parse-pool job
 * (`tsconfig-parse.ts`), dispatched through the `parse` function it is handed. It reads ONLY
 * through the declared-reads handle, never the disk.
 *
 * ## What it reads, and in what order
 *
 * 1. The `json` pair of every `package.json` the run holds outside `node_modules` (one read). Each
 *    one with rows gives its `tsconfig_invocations` (`tsconfig-invocations.ts`); one with none
 *    gives none (its `DATA_FILE_NO_ROWS` finding already fails the run). A project the tokeniser
 *    places outside the root refuses `TSCONFIG_INVOKED_OUTSIDE_ROOT` before anything else.
 * 2. The demanded configs are the invoked ones that are git content. Then the waves, per root: read
 *    (one read through a handle over the declared set so far) the `jsonc` pairs of the demanded
 *    configs and of each path the last job requested that the step does not hold; rebuild each
 *    one's JSON from its `data__nodes` rows ({@link jsonTextOf}: shadowed nodes too, a repeated key
 *    repeated in source order, as TypeScript's reader reads every occurrence); dispatch one job over every demanded
 *    config. A job that requests paths starts another wave. A parsed answer whose `references`
 *    name an in-root config not yet demanded adds it and starts another wave (the `references`
 *    closure). Only the final job's parse is read.
 * 3. A request for a `package.json` (TypeScript's package scope lookup while it resolves a
 *    package-name `extends`) is served from the rows step 1 already read, rebuilt the same way, with
 *    no second read; one the step holds no rows for refuses as a config would. Every request is
 *    either served or refused, and a path is read at most once, so the waves end: the listing is
 *    finite and every wave serves at least one new path or refuses.
 *
 * The declared set is the step's own inputs, never the routing: every held `package.json` as
 * `json`, every demanded config and every requested path (an `extends` target, or a reference
 * target) as `jsonc`, a requested `package.json` as `json`. It grows per wave, one handle per wave.
 *
 * ## Refusals: one per family, the first met
 *
 * Any refusal refuses every `tsconfig_*` relation. In order:
 *
 * - `TSCONFIG_INVOKED_OUTSIDE_ROOT`: a `-p` or build-mode project outside the root.
 * - A `references` target that is not git content (absent, or ignored): `TSCONFIG_PARSE_ERRORS`
 *   naming it at the referencing config, before any read; an ignored config is never parsed.
 * - A demanded config, or a path a chain or a scope lookup reads, the handle answers `absent`:
 *   `DATA_REQUEST_UNROUTED` (unrouted, `exclude`d, or routed as another variant)
 *   naming the config that needs it, the path and the reason; or, with no rows, the pair's own
 *   code (`DATA_PARSE_ERROR`, ...), with the data stage's remedy and retryable carried through (a pair `refused` because the run decided is retryable; one refused because a store-off run already holds as many bytes of rows as it may is not). A text past a
 *   document limit in the job refuses with the job's code.
 * - On the final parse, per demanded config in order, from the recorded paths only and never from
 *   diagnostic text (the job carries none): a chain-phase path outside the root,
 *   `TSCONFIG_EXTENDS_OUTSIDE_ROOT`; an inputs-phase one, `TSCONFIG_INPUTS_OUTSIDE_ROOT`; a
 *   reference outside the root, `TSCONFIG_REFERENCE_OUTSIDE_ROOT`; then any `parsed.errors` entry,
 *   `TSCONFIG_PARSE_ERRORS` (TS18003 included). A chain-phase path that is only TypeScript's module
 *   resolution walking above the root (an ancestor directory, an ancestor's `node_modules` directory itself, an
 *   ancestor's `package.json`) is not an `extends` outside the root: a package-name `extends` makes
 *   it, and refuses `TSCONFIG_PARSE_ERRORS` (TS6053), since in PR4a no `node_modules` path exists.
 *
 * A read that finds a row set evicted throws the row-set tier's `StoredRowsEvictedError`
 * unchanged, so the lane's one retry runs.
 */

import { appendAll, compareCodeUnits, countWork, mapInOrder, safePath, VatError } from '@vibe-agent-toolkit/utils';
import picomatch from 'picomatch';

import { isParseLimitError, isParseWorkerDiedError } from '../parse-limits.js';
import type { DataNodeRow, DataVariant } from '../schemas/projection-data.js';
import type { GitContentRow } from '../schemas/projection-git-content.js';
import type {
  TsconfigClosureRow,
  TsconfigConditionRow,
  TsconfigConfigRow,
  TsconfigExtendsRow,
  TsconfigFileRow,
  TsconfigInvocationRow,
  TsconfigPathRow,
  TsconfigReferenceRow,
} from '../schemas/projection-tsconfig.js';

import type { ExtractedDataNode } from './data-extractor.js';
import type { DeclaredAnswer, DeclaredPair, DeclaredReads } from './declared-reads.js';
import { DERIVED_TABLES } from './derived-table-registry.js';
import { compareRows } from './export.js';
import { invocationsOf } from './tsconfig-invocations.js';
import type { ParsedTsconfig, TsconfigJobAnswer, TsconfigJobInput, TsconfigOptions, TsconfigTextDefect } from './tsconfig-parse.js';

const PACKAGE_JSON = 'package.json';
const TSCONFIG = 'tsconfig.json';

/** A path under `node_modules`: never declared, never git content. */
const NODE_MODULES = picomatch('**/node_modules/**');

/** The tables the step reads of a pair. */
const NODES: { readonly tables: readonly ['dataNodes'] } = { tables: ['dataNodes'] };

/** The step's own refusal codes; a pair with no rows refuses with the pair's code instead. */
type TsconfigRefusalCode =
  | 'DATA_REQUEST_UNROUTED'
  | 'TSCONFIG_PARSE_ERRORS'
  | 'TSCONFIG_EXTENDS_OUTSIDE_ROOT'
  | 'TSCONFIG_INPUTS_OUTSIDE_ROOT'
  | 'TSCONFIG_REFERENCE_OUTSIDE_ROOT'
  | 'TSCONFIG_INVOKED_OUTSIDE_ROOT';

/** Why the family has no rows this run. */
export interface TsconfigRefusal {
  /** A {@link TsconfigRefusalCode}, or the `data__routes` code of a pair with no rows. */
  readonly code: string;
  /** The root id of the file. */
  readonly root: string;
  /** The file the refusal is about (the config or package.json that needs what failed), relative to its root. */
  readonly path: string;
  readonly message: string;
  readonly remedy: string;
  /** Whether a rerun may answer: the data stage's verdict, carried through. A pair refused because the run decided is retryable; one refused because a store-off run holds as many bytes of rows as it may (held-cap) is not. */
  readonly retryable: boolean;
}

/** Every `tsconfig_*` relation's rows, each sorted by its key. */
export interface TsconfigRows {
  readonly invocations: readonly TsconfigInvocationRow[];
  readonly references: readonly TsconfigReferenceRow[];
  readonly closure: readonly TsconfigClosureRow[];
  readonly configs: readonly TsconfigConfigRow[];
  readonly extends: readonly TsconfigExtendsRow[];
  readonly files: readonly TsconfigFileRow[];
  readonly paths: readonly TsconfigPathRow[];
  readonly conditions: readonly TsconfigConditionRow[];
}

/**
 * The step's answer, with the TypeScript version that answered: the vendored copy's `ts.version`
 * as the job reported it, or null when no job ran (no demanded config, so TypeScript never loaded).
 */
export type TsconfigAnswer =
  | { readonly outcome: 'rows'; readonly typescript: string | null; readonly rows: TsconfigRows }
  | { readonly outcome: 'refused'; readonly typescript: string | null; readonly refusal: TsconfigRefusal };

/** What the step reads. */
interface TsconfigStepInput {
  /** Every root of the run, in order: its id, and its absolute path (the job's prefix, never read). */
  readonly roots: ReadonlyArray<{ readonly id: string; readonly path: string }>;
  /** Every path the run holds a file with content at, by root id. */
  readonly files: ReadonlyMap<string, ReadonlySet<string>>;
  /** The handle over a declared set: the step builds one per wave as its set grows. */
  readonly declaredReads: (declared: readonly DeclaredPair[]) => DeclaredReads;
  /** The run's git content (`git_content`), every root. */
  readonly gitContent: readonly GitContentRow[];
  /** The compiler basenames a script segment is read as invoking. */
  readonly compilers: readonly string[];
  /** Dispatch one parse job: the parse dispatcher's `tsconfig`, or the job in-process in a test. */
  readonly parse: (job: TsconfigJobInput) => Promise<TsconfigJobAnswer>;
}

/** Thrown inside the step to refuse the family; caught once, never past the step. */
class Refused extends VatError {
  constructor(readonly refusal: TsconfigRefusal) {
    super(refusal.code, refusal.message);
  }
}

/** The remedy for a path outside the analysis root (spec 7.1). */
const OUTSIDE_ROOT_REMEDY = 'the analysis root is the directory of the nearest vibe-agent-toolkit.config.yaml at or above the command\'s [path], else the git root; declare the config at the repository root, or remove the sub-root\'s own vibe-agent-toolkit.config.yaml, so the analysis root holds every file the config reaches';

/** The remedy for a parse error. */
const PARSE_ERRORS_REMEDY = 'fix the config so TypeScript parses it without error; every file it extends or includes must be git content (tracked, or untracked and not ignored) under the analysis root, and no node_modules path is read';

/**
 * Resolve every `tsconfig_*` relation of every root.
 *
 * @param input - The run's roots, held files, handle factory, git content, compiler set and parse
 * @returns The rows, or the family's refusal
 * @throws A `StoredRowsEvictedError` of the row-set tier, store on, from the handle
 */
export async function resolveTsconfig(input: TsconfigStepInput): Promise<TsconfigAnswer> {
  const version: { value: string | null } = { value: null };
  let parts: RootRows[];
  try {
    // One root at a time: the first refusal refuses the family, so no later root's job runs.
    parts = await mapInOrder(input.roots, (root) => new RootStep(root, input, version).resolve());
  } catch (error) {
    if (error instanceof Refused) return { outcome: 'refused', typescript: version.value, refusal: error.refusal };
    throw error;
  }
  const rows = mergedRows(parts);
  const reaches = rows.conditions.filter((row) => row.code === 'TSCONFIG_REACHES_OUTSIDE_GIT').length;
  if (reaches > 0) countWork('resolve.tsconfig.reachesOutsideGit', reaches);
  return { outcome: 'rows', typescript: version.value, rows };
}

/** One root's rows while they are built. */
interface RootRows {
  readonly invocations: TsconfigInvocationRow[];
  readonly references: TsconfigReferenceRow[];
  readonly closure: TsconfigClosureRow[];
  readonly configs: TsconfigConfigRow[];
  readonly extends: TsconfigExtendsRow[];
  readonly files: TsconfigFileRow[];
  readonly paths: TsconfigPathRow[];
  readonly conditions: TsconfigConditionRow[];
}

/** @returns A root's rows, empty */
function emptyRows(): RootRows {
  return { invocations: [], references: [], closure: [], configs: [], extends: [], files: [], paths: [], conditions: [] };
}

/** @returns Every root's rows, each relation sorted by its key */
function mergedRows(parts: readonly RootRows[]): TsconfigRows {
  const all = emptyRows();
  for (const part of parts) {
    for (const name of Object.keys(all) as Array<keyof RootRows>) appendAll(all[name] as unknown[], part[name]);
  }
  return {
    invocations: all.invocations.toSorted(compareRows(DERIVED_TABLES.tsconfigInvocations)),
    references: all.references.toSorted(compareRows(DERIVED_TABLES.tsconfigReferences)),
    closure: all.closure.toSorted(compareRows(DERIVED_TABLES.tsconfigClosure)),
    configs: all.configs.toSorted(compareRows(DERIVED_TABLES.tsconfigConfigs)),
    extends: all.extends.toSorted(compareRows(DERIVED_TABLES.tsconfigExtends)),
    files: all.files.toSorted(compareRows(DERIVED_TABLES.tsconfigFiles)),
    paths: all.paths.toSorted(compareRows(DERIVED_TABLES.tsconfigPaths)),
    conditions: all.conditions.toSorted(compareRows(DERIVED_TABLES.tsconfigConditions)),
  };
}

/** An absent answer of the handle. */
type Absent = Extract<DeclaredAnswer<'dataNodes'>, { state: 'absent' }>;

/** @returns A text key for a path read as a variant */
function pairKey(path: string, variant: DataVariant): string {
  return `${path}\0${variant}`;
}

/** @returns Whether a path is a `package.json` */
function isPackageJson(path: string): boolean {
  return path === PACKAGE_JSON || path.endsWith(`/${PACKAGE_JSON}`);
}

/**
 * Whether a path at a root is the tsconfig step's root input: the root `package.json`, whose having
 * no rows refuses the family rather than marking a file. The data stage reads it so it never tells
 * that file to route itself away.
 *
 * @param path - A path relative to its root
 * @returns True for the root `package.json`
 */
export function isTsconfigRootInput(path: string): boolean {
  return path === PACKAGE_JSON;
}

/** @returns A path's directory, `''` for the root */
function dirOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

/** @returns A root-relative path column: `.` for the root itself */
function dotted(path: string): string {
  return path === '' ? '.' : path;
}

/** One root's resolve: its reads, its waves and its rows. */
class RootStep {
  readonly #id: string;
  readonly #path: string;
  readonly #input: TsconfigStepInput;
  readonly #version: { value: string | null };
  readonly #listing: readonly string[];
  readonly #listed: ReadonlySet<string>;
  readonly #declared = new Map<string, DeclaredPair>();
  /** Root-relative path to the JSON text rebuilt from its rows: what the job reads. */
  readonly #texts: Record<string, string> = {};
  /** Each `package.json` read in step 1: its rows, or the handle's absence. */
  readonly #packages = new Map<string, readonly DataNodeRow[] | Absent>();
  /** Who needs a path: the package.json invoking a config, the config referencing or extending one. */
  readonly #requesters = new Map<string, string>();
  readonly #demanded: string[] = [];

  constructor(root: { readonly id: string; readonly path: string }, input: TsconfigStepInput, version: { value: string | null }) {
    this.#id = root.id;
    this.#path = root.path;
    this.#input = input;
    this.#version = version;
    this.#listing = input.gitContent.filter((row) => row.root === root.id).map((row) => row.path);
    this.#listed = new Set(this.#listing);
  }

  /**
   * @returns The root's rows
   * @throws Refused when the family refuses
   */
  async resolve(): Promise<RootRows> {
    const rows = emptyRows();
    await this.#readInvocations(rows);
    if (this.#demanded.length === 0) return rows;
    countWork('resolve.tsconfig.entriesListed', this.#listing.length);
    const final = await this.#waves(this.#demanded);
    countWork('resolve.tsconfig.configs', final.length);
    for (const config of final) this.#refuseFinal(config);
    for (const config of final) this.#addConfigRows(config, rows);
    appendAll(rows.closure, closureRows(this.#id, final));
    return rows;
  }

  /** Step 1: every held package.json, its invocations, the demanded configs. */
  async #readInvocations(rows: RootRows): Promise<void> {
    const listed = this.#listed;
    const paths = [...this.#input.files.get(this.#id) ?? []]
      .filter((path) => isPackageJson(path) && !NODE_MODULES(path))
      .toSorted(compareCodeUnits);
    if (paths.length === 0) return;
    const answers = await this.#read(paths.map((path) => ({ root: this.#id, path, variant: 'json' as const })));
    const outside: TsconfigInvocationRow[] = [];
    for (const answer of answers) {
      const { path } = answer.pair;
      this.#packages.set(path, answer.state === 'present' ? answer.rows.dataNodes : answer);
      if (answer.state !== 'present') continue;
      const found = invocationsOf({ root: this.#id, path, nodes: answer.rows.dataNodes, compilers: this.#input.compilers, isGitContent: (named) => listed.has(named) });
      appendAll(rows.invocations, found.invocations);
      appendAll(rows.conditions, found.conditions);
      appendAll(outside, found.outsideRoot);
    }
    const [leaving] = outside;
    if (leaving !== undefined) {
      throw this.#refused('TSCONFIG_INVOKED_OUTSIDE_ROOT', leaving.path, `script "${leaving.script}" in '${leaving.path}' compiles the project '${leaving.project}', which is outside the analysis root, so the tsconfig relations cannot answer for it.`, OUTSIDE_ROOT_REMEDY);
    }
    // An invoked config is its own subject: a refusal about it names it, not the script.
    for (const row of rows.invocations) {
      if (row.config !== null && !this.#demanded.includes(row.config)) this.#demand(row.config, row.config);
    }
  }

  /** Add a demanded config, needed by `requester`. */
  #demand(config: string, requester: string): void {
    this.#demanded.push(config);
    if (!this.#requesters.has(config)) this.#requesters.set(config, requester);
  }

  /**
   * Step 2: one wave (read what it wants, dispatch one job), then the next wave, until a job parses
   * every demanded config with no new reference. Each wave depends on the last job's answer, so the
   * waves chain; there are as many as the longest `extends` or `references` path, never recursion
   * per file.
   *
   * @param wanted - The paths this wave reads
   * @returns The final parse's configs
   */
  async #waves(wanted: readonly string[]): Promise<readonly ParsedTsconfig[]> {
    await this.#readWave(wanted);
    const answer = await this.#dispatch();
    if (answer.outcome === 'defective') throw this.#defect(answer.defects[0]);
    if (answer.outcome === 'requests') return this.#waves(this.#unserved(answer.requests));
    const added = this.#newReferences(answer.configs);
    return added.length === 0 ? answer.configs : this.#waves(added);
  }

  /** @returns One job's answer over every demanded config and every text held */
  async #dispatch(): Promise<TsconfigJobAnswer> {
    const answer = await this.#parsed();
    countWork('resolve.tsconfig.waves', 1);
    this.#version.value ??= answer.typescript;
    return answer;
  }

  /**
   * The job's answer. A job the run stopped (a limit of the parse, a worker that died holding it)
   * refuses this family with a retryable refusal: the run decided, never the bytes, so a rerun may
   * answer, and no other relation of the run fails with it.
   *
   * @returns The job's answer
   * @throws Refused (retryable) when the job hit a parse limit or its worker died
   */
  async #parsed(): Promise<TsconfigJobAnswer> {
    try {
      return await this.#input.parse({ root: this.#path, configs: [...this.#demanded], texts: { ...this.#texts }, listing: this.#listing });
    } catch (error) {
      if (!isParseLimitError(error) && !isParseWorkerDiedError(error)) throw error;
      throw new Refused({ code: error.code, root: this.#id, path: '.', message: error.message, remedy: 'rerun the command; the parse was stopped by a limit of this run, not by the repository', retryable: true });
    }
  }

  /**
   * Serve what a job requested from rows already held (a `package.json` step 1 read), and return
   * the rest to read. A path already read cannot be requested again: the job holds its text.
   *
   * @returns The `jsonc` paths and unread `package.json` paths to read next wave
   * @throws Refused when a requested `package.json` has no rows
   */
  #unserved(requests: readonly string[]): string[] {
    const toRead: string[] = [];
    for (const path of requests) {
      if (path in this.#texts) throw new Error(`The tsconfig job requested '${path}', which it was handed: the waves would not end.`);
      this.#requesters.set(path, this.#requesters.get(path) ?? this.#extenderOf(path) ?? path);
      const held = isPackageJson(path) ? this.#packages.get(path) : undefined;
      if (held === undefined) toRead.push(path);
      else if (Array.isArray(held)) this.#texts[path] = jsonTextOf(held);
      else throw this.#absent(held as Absent);
    }
    return toRead;
  }

  /** @returns Each in-root config the parsed configs reference that is not yet demanded, now demanded */
  #newReferences(configs: readonly ParsedTsconfig[]): string[] {
    const added: string[] = [];
    for (const config of configs) {
      for (const reference of config.projectReferences) {
        const target = referencedConfig(reference.path);
        if (leavesRoot(target) || this.#demanded.includes(target)) continue;
        // A config that is not git content is never read, whatever its routing: it does not exist to the parse.
        if (!this.#listed.has(target)) throw this.#refused('TSCONFIG_PARSE_ERRORS', config.path, `'${config.path}' references '${target}', which is not git content under the analysis root, so it is not read.`, PARSE_ERRORS_REMEDY);
        this.#demand(target, config.path);
        added.push(target);
      }
    }
    return added;
  }

  /**
   * One wave's read: declare the paths, build a handle over the declared set, read them at once.
   *
   * @throws Refused when one is absent
   */
  async #readWave(paths: readonly string[]): Promise<void> {
    const pairs = paths.filter((path) => !(path in this.#texts)).map((path): DeclaredPair => ({ root: this.#id, path, variant: isPackageJson(path) ? 'json' : 'jsonc' }));
    if (pairs.length === 0) return;
    for (const answer of await this.#read(pairs)) {
      if (answer.state !== 'present') throw this.#absent(answer);
      this.#texts[answer.pair.path] = jsonTextOf(answer.rows.dataNodes);
    }
  }

  /** @returns The handle's answers for `pairs`, read through a handle over the grown declared set */
  #read(pairs: readonly DeclaredPair[]): Promise<Array<DeclaredAnswer<'dataNodes'>>> {
    for (const pair of pairs) this.#declared.set(pairKey(pair.path, pair.variant), pair);
    return this.#input.declaredReads([...this.#declared.values()]).read(pairs, NODES);
  }

  /**
   * The held config whose `extends` names `target` relatively, or undefined (a package-name
   * `extends`, which TypeScript resolves itself).
   */
  #extenderOf(target: string): string | undefined {
    for (const [path, text] of Object.entries(this.#texts)) {
      if (isPackageJson(path)) continue;
      const specs = extendsSpecs(text).filter((spec) => spec.startsWith('.'));
      const named = specs.map((spec) => safePath.join(dirOf(path), spec));
      if (named.some((candidate) => candidate === target || `${candidate}.json` === target)) return path;
    }
    return undefined;
  }

  /** @returns The refusal for an absent pair, at the file that needs it */
  #absent(answer: Absent): Refused {
    const { path, variant } = answer.pair;
    const requester = this.#requesters.get(path) ?? path;
    const needs = requester === path ? `'${path}'` : `'${requester}' needs '${path}' (${variant}), and that`;
    if (answer.cause === 'unrouted') {
      return this.#refused(answer.code, requester, `${needs} cannot be read: ${answer.detail}. The tsconfig step reads only routed pairs, so the tsconfig relations cannot answer.`, `${answer.remedy}; the tsconfig relations answer only when every file a demanded config's chain reads is routed`);
    }
    return new Refused({
      code: answer.code,
      root: this.#id,
      path: requester,
      message: `${needs} has no rows this run (${answer.routeState} ${answer.code}), so the tsconfig relations cannot answer.`,
      // The data stage's one remedy for the file, so this and its finding never disagree.
      remedy: answer.remedy,
      retryable: answer.retryable,
    });
  }

  /** @returns The refusal for a text the job held to a document limit */
  #defect(defect: TsconfigTextDefect | undefined): Refused {
    const path = defect?.path ?? '';
    const requester = this.#requesters.get(path) ?? path;
    const limit = defect?.limit === undefined ? 'it is not valid JSON' : `it exceeds ${defect.limit} (${String(defect.found)})`;
    return this.#refused(defect?.code ?? 'DATA_PARSE_ERROR', requester, `'${path}', as TypeScript reads it for '${requester}', cannot be parsed: ${limit}.`, 'make the config smaller or simpler');
  }

  /**
   * Refuse a final config from its recorded paths and its errors, in the order the header gives.
   *
   * @throws Refused when it refuses
   */
  #refuseFinal(config: ParsedTsconfig): void {
    const chain = config.asked.find((asked) => asked.phase === 'chain' && leavesRoot(asked.path) && !isResolutionProbe(asked.path));
    if (chain !== undefined) throw this.#outside('TSCONFIG_EXTENDS_OUTSIDE_ROOT', config, `its extends chain reaches '${chain.path}'`);
    const inputs = config.asked.find((asked) => asked.phase === 'inputs' && leavesRoot(asked.path));
    if (inputs !== undefined) throw this.#outside('TSCONFIG_INPUTS_OUTSIDE_ROOT', config, `its inputs reach '${inputs.path}'`);
    const reference = config.projectReferences.find((entry) => leavesRoot(entry.path));
    if (reference !== undefined) throw this.#outside('TSCONFIG_REFERENCE_OUTSIDE_ROOT', config, `it references '${reference.path}'`);
    if (config.errors.length > 0) {
      const codes = [...new Set(config.errors.map((error) => `TS${String(error.code)}`))].join(', ');
      throw this.#refused('TSCONFIG_PARSE_ERRORS', config.path, `TypeScript parses '${config.path}' with errors (${codes}), reading only git content under the analysis root.`, PARSE_ERRORS_REMEDY);
    }
  }

  /** @returns An outside-root refusal of a config */
  #outside(code: TsconfigRefusalCode, config: ParsedTsconfig, what: string): Refused {
    return this.#refused(code, config.path, `'${config.path}' leaves the analysis root: ${what}. Paths outside the analysis root are not read.`, OUTSIDE_ROOT_REMEDY);
  }

  /** @returns A refusal of the step's own, never retryable */
  #refused(code: string, path: string, message: string, remedy: string): Refused {
    return new Refused({ code, root: this.#id, path, message, remedy, retryable: false });
  }

  /** Add one final config's rows. */
  #addConfigRows(config: ParsedTsconfig, rows: RootRows): void {
    const root = this.#id;
    const { options } = config;
    rows.configs.push({
      root,
      path: config.path,
      outDir: pathOption(options, 'outDir'),
      rootDir: pathOption(options, 'rootDir'),
      baseUrl: pathOption(options, 'baseUrl'),
      allowJs: booleanOption(options, 'allowJs'),
      resolveJsonModule: booleanOption(options, 'resolveJsonModule'),
      composite: booleanOption(options, 'composite'),
    });
    for (const [ordinal, reference] of config.projectReferences.entries()) {
      rows.references.push({ root, config: config.path, ordinal, spec: reference.originalPath, path: referencedConfig(reference.path) });
    }
    for (const [ordinal, path] of config.extends.entries()) rows.extends.push({ root, config: config.path, ordinal, path });
    for (const path of config.fileNames) rows.files.push({ root, config: config.path, path });
    // TypeScript's `getPathsBasePath`: `baseUrl` when set, else the directory of the config that set `paths`.
    const basePath = pathOption(options, 'baseUrl') ?? pathOption(options, 'pathsBasePath') ?? dotted(dirOf(config.path));
    for (const [pattern, targets] of pathsOption(options)) {
      for (const [ordinal, target] of targets.entries()) rows.paths.push({ root, config: config.path, pattern, ordinal, target, basePath });
    }
    const seqs = new Map<string, number>();
    for (const reach of config.reachesOutsideGit) {
      const seq = seqs.get(config.path) ?? 0;
      seqs.set(config.path, seq + 1);
      rows.conditions.push({
        root,
        path: config.path,
        code: 'TSCONFIG_REACHES_OUTSIDE_GIT',
        seq,
        message: `the ${reach.kind === 'files-entry' ? 'files' : 'include'} entry '${reach.entry}' names '${reach.path}', which is not git content; it is not a member`,
        kind: reach.kind,
        reached: reach.path,
      });
    }
  }
}

/** @returns A path option as a column: root-relative (the job made it so), `.` for the root, null when unset */
function pathOption(options: TsconfigOptions, name: string): string | null {
  const value = options[name];
  return typeof value === 'string' ? dotted(value) : null;
}

/** @returns A boolean option, null when unset */
function booleanOption(options: TsconfigOptions, name: string): boolean | null {
  const value = options[name];
  return typeof value === 'boolean' ? value : null;
}

/** @returns `paths` as TypeScript parsed it: each pattern with its string targets, in source order */
function pathsOption(options: TsconfigOptions): Array<[string, string[]]> {
  const value = options['paths'];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>).map(([pattern, targets]): [string, string[]] => [
    pattern,
    Array.isArray(targets) ? targets.filter((target): target is string => typeof target === 'string') : [],
  ]);
}

/** @returns The config a `references` path names: itself when it ends `.json`, else its `tsconfig.json` */
function referencedConfig(path: string): string {
  if (path.endsWith('.json')) return path;
  return path === '' ? TSCONFIG : `${path}/${TSCONFIG}`;
}

/** @returns The `extends` specifiers of a rebuilt config text, string or array */
function extendsSpecs(text: string): string[] {
  const parsed: unknown = text === '' ? undefined : JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null) return [];
  const value = (parsed as { extends?: unknown }).extends;
  const specs = Array.isArray(value) ? value : [value];
  return specs.filter((spec): spec is string => typeof spec === 'string');
}

/**
 * Whether a recorded path leaves the analysis root: a root-relative form whose first segment is
 * `..`, or an absolute path, which is what a path on another Windows drive relativizes to.
 *
 * @param path - A root-relative path the job recorded
 * @returns True when it is outside the root
 */
export function leavesRoot(path: string): boolean {
  return PARENT_FIRST.test(path) || ABSOLUTE.test(path);
}

// The two tests below are lexical on purpose: they classify strings the job recorded relative to
// the root, never a path on disk, so there is nothing for a filesystem containment check to ask.
/** A root-relative path whose first segment is `..`. */
const PARENT_FIRST = /^\.\.(?:\/|$)/u;
/** An absolute path: POSIX, or a Windows drive. */
const ABSOLUTE = /^(?:\/|[A-Za-z]:\/)/u;
/** Every leading `..` segment. */
const PARENT_PREFIX = /^(?:\.\.(?:\/|$))+/u;

/**
 * Whether an outside-root path asked while a chain resolves is TypeScript's module resolution
 * walking above the root rather than a config naming a path there: an ancestor directory itself, an
 * ancestor's `node_modules` directory itself (a package-name `extends` makes one `directoryExists`
 * call), or an ancestor's `package.json` (the package scope lookup). A path THROUGH an ancestor's
 * `node_modules` is a config naming it (`../node_modules/x/tsconfig.json`), so it leaves the root.
 *
 * @param path - An outside-root, root-relative path
 * @returns True for a resolution probe
 */
function isResolutionProbe(path: string): boolean {
  const rest = path.replace(PARENT_PREFIX, '');
  return rest === '' || rest === 'node_modules' || rest === PACKAGE_JSON;
}

/**
 * `tsconfig_closure`: for each final config, every config reachable through in-root `references`
 * edges, itself at 0 and each other at its shortest distance (breadth-first; each member visited
 * once, so a cycle ends).
 *
 * @param root - The root id
 * @param configs - The final parse's configs
 * @returns The rows
 */
function closureRows(root: string, configs: readonly ParsedTsconfig[]): TsconfigClosureRow[] {
  const edges = new Map(configs.map((config) => [config.path, config.projectReferences.map((reference) => referencedConfig(reference.path)).filter((target) => !leavesRoot(target))]));
  const rows: TsconfigClosureRow[] = [];
  for (const config of configs) {
    const distance = new Map([[config.path, 0]]);
    const queue = [config.path];
    for (let at = queue.shift(); at !== undefined; at = queue.shift()) {
      const next = (distance.get(at) ?? 0) + 1;
      for (const target of edges.get(at) ?? []) {
        if (distance.has(target)) continue;
        distance.set(target, next);
        queue.push(target);
      }
    }
    for (const [member, length] of distance) rows.push({ root, config: config.path, member, distance: length });
  }
  return rows;
}

/** A node row as {@link jsonTextOf} reads it: a stored row, or the extractor's row before its pair. */
type TextNode = ExtractedDataNode;

/**
 * A file's JSON text rebuilt from its rows as TypeScript's JSONC reader reads it: the first
 * document, every node (shadowed ones too, a repeated key repeated, as TypeScript reads each
 * occurrence), members and elements in source order, a number as written. Built without recursion, since a config may nest to
 * `outputDepth`.
 *
 * @param nodes - The file's `data__nodes` rows
 * @returns Compact JSON, or `''` for a file with no document
 */
export function jsonTextOf(nodes: readonly TextNode[]): string {
  // Shadowed nodes stay, in source order: TypeScript reads every occurrence of a repeated key
  // (each sets its property in turn), so a shadowed `extends` is still read, and an earlier
  // `compilerOptions` still contributes the options a later one does not set.
  const kept = nodes.filter((node) => node.doc === 0);
  const children = new Map<number, TextNode[]>();
  for (const node of kept) {
    if (node.parent === null) continue;
    const held = children.get(node.parent);
    if (held === undefined) children.set(node.parent, [node]);
    else held.push(node);
  }
  const top = kept.find((node) => node.parent === null);
  if (top === undefined) return '';
  const out: string[] = [];
  const stack: Array<TextNode | string> = [top];
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    if (typeof item === 'string') out.push(item);
    else emitNode(item, (children.get(item.ordinal) ?? []).toSorted((left, right) => left.ordinal - right.ordinal), out, stack);
  }
  return out.join('');
}

/** Emit a scalar, or open a container and stack its members and its close. */
function emitNode(node: TextNode, members: readonly TextNode[], out: string[], stack: Array<TextNode | string>): void {
  if (node.type !== 'object' && node.type !== 'array') {
    out.push(scalarText(node));
    return;
  }
  out.push(node.type === 'object' ? '{' : '[');
  stack.push(node.type === 'object' ? '}' : ']');
  for (let index = members.length - 1; index >= 0; index--) {
    const member = members[index];
    if (member === undefined) continue;
    stack.push(member);
    if (node.type === 'object') stack.push(`${JSON.stringify(member.key ?? '')}:`);
    if (index > 0) stack.push(',');
  }
}

/** @returns A scalar node's JSON text */
function scalarText(node: TextNode): string {
  if (node.type === 'number') return node.lexeme ?? String(node.value);
  if (node.type === 'null') return 'null';
  return JSON.stringify(node.value);
}
