/**
 * The output map (output path to source) from TypeScript's own `getOutputFileNames`.
 *
 * A workspace member's `exports` name built output (`./dist/index.js`), which is never git content.
 * The resolve step's host answers such a path as present when it is a key of this map, and the step
 * maps a resolved key back to its source. Every rule of what a config emits where (`rootDir`'s
 * default, `outDir`, `declarationDir`, `emitDeclarationOnly`, `declaration`, `jsx: preserve`,
 * `.json` under `resolveJsonModule`, `.mts`/`.cts`, declaration inputs emitting nothing) is
 * TypeScript's: this module restates none of them.
 *
 * ## Linear, not quadratic
 *
 * Called as is, each `getOutputFileNames(parsed, input)` asserts the input is in `parsed.fileNames`
 * with a linear scan and may recompute the common source directory over every input, so a config
 * costs inputs squared. Instead the common source directory is computed once
 * (`getCommonSourceDirectoryOfConfig`, an internal absent from the public typings), and each input
 * is asked on a SHADOW command line: `parsed.options` with `rootDir` set to that directory, and
 * `fileNames: [input]`. With `rootDir` set TypeScript uses it directly, so the outputs are the plain
 * call's; `ts-output-map.test.ts` proves the equality over every fixture.
 *
 * ## Emitting configs
 *
 * Only a config without `noEmit` (which `getOutputFileNames` does not consult) and without `outFile`
 * (a bundle has no per-file outputs) has a map.
 *
 * ## Ambiguity
 *
 * One output key with two distinct sources (two of the run's configs, or `x.ts` and `x.tsx` in one)
 * is ambiguous: the step answers such a target `unresolved` with a `TS_OUTPUT_REDIRECT_AMBIGUOUS`
 * condition naming both. Two configs mapping one output from the SAME source are not ambiguous.
 *
 * ## Loading
 *
 * TypeScript arrives as a parameter (type-only import): the resolve step is the one main-thread
 * importer of the loader. A missing internal is refused through the caller's `lacks` factory (the
 * step passes `vendoredTypeScriptLacks`), so this module never imports the loader as a value.
 */

import { compareCodeUnits, countWork } from '@vibe-agent-toolkit/utils';

import type ts from '../vendor/typescript.cjs';

/** What the map reads of a parsed config: its options (absolute, with `configFilePath`) and inputs. */
export type OutputMapConfig = Pick<ts.ParsedCommandLine, 'options' | 'fileNames'>;

/** Builds the refusal for a vendored TypeScript lacking the named internal. */
type LacksInternal = (name: string) => Error;

/** One emitting config's map. */
interface ConfigOutputMap {
  /** The config's `configFilePath`, as TypeScript holds it. */
  readonly config: string;
  /** Each output path TypeScript names, to its distinct inputs (sorted; two or more is ambiguous). */
  readonly entries: ReadonlyMap<string, readonly string[]>;
}

/** What a path is in the run's combined map. */
export type OutputLookup =
  | { readonly kind: 'source'; readonly source: string }
  | { readonly kind: 'ambiguous'; readonly sources: readonly string[] };

/** An output key with two or more distinct sources across the run's configs. */
export interface AmbiguousOutput {
  readonly output: string;
  readonly sources: readonly string[];
}

/** The run's map over all its emitting demanded configs: what the host and the mapping back read. */
export interface RunOutputMap {
  /** The number of distinct output keys. */
  readonly size: number;
  /** Whether `path` is an output key (case-folded when the run ignores case). */
  has(path: string): boolean;
  /** `path`'s source, or both sources when ambiguous; `undefined` when `path` is no output. */
  lookup(path: string): OutputLookup | undefined;
  /** Every output key as TypeScript spelled it, sorted (for `directoryExists` and listings). */
  outputs(): readonly string[];
  /** Every ambiguous key, sorted by output. */
  readonly ambiguities: readonly AmbiguousOutput[];
}

/** The internal this module calls, absent from the public typings. */
interface OutputMapInternals {
  getCommonSourceDirectoryOfConfig(config: OutputMapConfig, ignoreCase: boolean): string;
}

/**
 * @param typescript - The loaded TypeScript
 * @param lacks - The refusal factory
 * @returns Its internals the map calls
 * @throws {Error} The factory's refusal, if one is missing
 */
function internalsOf(typescript: typeof ts, lacks: LacksInternal): OutputMapInternals {
  const internals = typescript as unknown as Partial<OutputMapInternals>;
  if (typeof internals.getCommonSourceDirectoryOfConfig !== 'function') throw lacks('getCommonSourceDirectoryOfConfig');
  return internals as OutputMapInternals;
}

/**
 * @param config - A parsed config
 * @returns Whether it emits per-file outputs (no `noEmit`, no `outFile`)
 */
export function isEmittingConfig(config: OutputMapConfig): boolean {
  return config.options.noEmit !== true && (config.options.outFile ?? '') === '';
}

/**
 * @param config - A parsed config
 * @returns Its `configFilePath`
 * @throws {Error} If it has none: every config the tsconfig job parses carries one, and TypeScript's
 *   own functions assert it
 */
function configPathOf(config: OutputMapConfig): string {
  const path = config.options['configFilePath'];
  if (typeof path !== 'string') throw new Error('the output map needs a parsed config carrying configFilePath');
  return path;
}

/**
 * Build one config's map: `getCommonSourceDirectoryOfConfig` once, then `getOutputFileNames` per
 * input on the shadow command line. Counted `resolve.ts.outputMapBuilds` and `.outputMapEntries`.
 *
 * @param typescript - The loaded TypeScript
 * @param config - The parsed config, options absolute
 * @param ignoreCase - Whether the file system ignores case (TypeScript's own argument)
 * @param lacks - The refusal factory for a missing internal
 * @returns The map, or `undefined` for a config that does not emit
 * @throws {Error} The factory's refusal, if the internal is missing
 */
export function outputMapOf(typescript: typeof ts, config: OutputMapConfig, ignoreCase: boolean, lacks: LacksInternal): ConfigOutputMap | undefined {
  const internals = internalsOf(typescript, lacks);
  if (!isEmittingConfig(config)) return undefined;
  const rootDir = internals.getCommonSourceDirectoryOfConfig(config, ignoreCase);
  const options: ts.CompilerOptions = { ...config.options, rootDir };
  const sources = new Map<string, Set<string>>();
  for (const input of config.fileNames) {
    for (const output of typescript.getOutputFileNames({ options, fileNames: [input], errors: [] }, input, ignoreCase)) {
      const held = sources.get(output) ?? new Set<string>();
      held.add(input);
      sources.set(output, held);
    }
  }
  const entries = new Map([...sources].map(([output, inputs]) => [output, [...inputs].sort(compareCodeUnits)] as const));
  countWork('resolve.ts.outputMapBuilds', 1);
  countWork('resolve.ts.outputMapEntries', entries.size);
  return { config: configPathOf(config), entries };
}

/** The combined map: keys folded by case when the run ignores it, each to its spelling and sources. */
class CombinedOutputMap implements RunOutputMap {
  readonly #fold: (path: string) => string;
  readonly #keys = new Map<string, { readonly output: string; readonly sources: Set<string> }>();
  readonly ambiguities: readonly AmbiguousOutput[];

  constructor(maps: readonly (ConfigOutputMap | undefined)[], ignoreCase: boolean) {
    this.#fold = ignoreCase ? (path) => path.toLowerCase() : (path) => path;
    for (const map of maps) {
      for (const [output, inputs] of map?.entries ?? []) {
        const key = this.#fold(output);
        const held = this.#keys.get(key) ?? { output, sources: new Set<string>() };
        for (const input of inputs) held.sources.add(input);
        this.#keys.set(key, held);
      }
    }
    this.ambiguities = [...this.#keys.values()]
      .filter((held) => held.sources.size > 1)
      .map((held) => ({ output: held.output, sources: [...held.sources].sort(compareCodeUnits) }))
      .sort((left, right) => compareCodeUnits(left.output, right.output));
  }

  get size(): number {
    return this.#keys.size;
  }

  has(path: string): boolean {
    return this.#keys.has(this.#fold(path));
  }

  lookup(path: string): OutputLookup | undefined {
    const held = this.#keys.get(this.#fold(path));
    if (held === undefined) return undefined;
    const sources = [...held.sources].sort(compareCodeUnits);
    const [source] = sources;
    return sources.length === 1 && source !== undefined ? { kind: 'source', source } : { kind: 'ambiguous', sources };
  }

  outputs(): readonly string[] {
    return [...this.#keys.values()].map((held) => held.output).sort(compareCodeUnits);
  }
}

/**
 * Combine configs' maps into the run's: a key's sources are the union across them.
 *
 * @param maps - Each config's map (`undefined` for a non-emitting config, skipped)
 * @param ignoreCase - Whether keys match regardless of case
 * @returns The run's map
 */
export function combineOutputMaps(maps: readonly (ConfigOutputMap | undefined)[], ignoreCase: boolean): RunOutputMap {
  return new CombinedOutputMap(maps, ignoreCase);
}

/** The run's output maps, memoized per config (by `configFilePath`), so each config builds once. */
export class OutputMaps {
  readonly #typescript: typeof ts;
  readonly #ignoreCase: boolean;
  readonly #lacks: LacksInternal;
  readonly #built = new Map<string, ConfigOutputMap | undefined>();

  /**
   * @param typescript - The loaded TypeScript
   * @param ignoreCase - Whether the file system ignores case
   * @param lacks - The refusal factory for a missing internal
   * @throws {Error} The factory's refusal, at construction, if the internal is missing
   */
  constructor(typescript: typeof ts, ignoreCase: boolean, lacks: LacksInternal) {
    internalsOf(typescript, lacks);
    this.#typescript = typescript;
    this.#ignoreCase = ignoreCase;
    this.#lacks = lacks;
  }

  /**
   * @param config - A parsed config
   * @returns Its map, built on first ask; `undefined` when it does not emit
   */
  of(config: OutputMapConfig): ConfigOutputMap | undefined {
    const path = configPathOf(config);
    const key = this.#ignoreCase ? path.toLowerCase() : path;
    if (!this.#built.has(key)) this.#built.set(key, outputMapOf(this.#typescript, config, this.#ignoreCase, this.#lacks));
    return this.#built.get(key);
  }

  /**
   * @param configs - The run's demanded configs
   * @returns Their combined map, ambiguity across them included
   */
  combined(configs: readonly OutputMapConfig[]): RunOutputMap {
    return combineOutputMaps(configs.map((config) => this.of(config)), this.#ignoreCase);
  }
}
