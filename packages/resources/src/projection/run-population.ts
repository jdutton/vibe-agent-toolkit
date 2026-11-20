/**
 * The **run population**: each file read, keyed, parsed and admitted once per
 * VAT process run, whichever lane asks.
 *
 * A run such as `vat validate` reaches the same files from several lanes: the
 * projection population that answers the store, the resources phase's registry,
 * and one skills view per project root. Each used to read, key, parse and admit
 * its files itself, so one file was read three times and admitted twice. The rule
 * this enforces is rule 4 of "Decision: content identity is per source"
 * (docs/architecture/content-keying-and-git.md): within one VAT process each file
 * is read, keyed and admitted once, and every lane shares that read, key and
 * admission. The supervised checks child is a separate process.
 *
 * ## What it holds, and what it does not
 *
 * - ONE {@link RunContentCache}: every population of the run reads through it,
 *   and so does every registry admission ({@link RunPopulation.admit}), so a file
 *   the population keyed is admitted from memory.
 * - ONE {@link ParseDispatcher}, which parses each content key once
 *   (`ParseDispatcher.parse`), so the blob stage's parse of a file is the
 *   registry's.
 * - The **per-file admission facts** ({@link AdmittedFacts}): the parse, the size,
 *   the modification time and the checksum, by path. Nothing that depends on a
 *   view: the id, duplicate detection, link resolution, population conditions and
 *   parse refusals are computed per registry view by the same code as ever. Views
 *   never share link objects: a registry copies the links it is handed.
 * - Each root's enumeration, once ({@link RunPopulation.source}).
 *
 * ## Lifetime
 *
 * One run, opened by {@link withRunPopulation}, which shuts the dispatcher down
 * however the run ends. First read wins for the whole run (see
 * {@link RunContentCache.read}), which is only correct for a run that writes
 * nothing into the tree it reads before it reads it again; a verb that builds
 * reads its own output through a population of that output's directory.
 */

import { safePath } from '@vibe-agent-toolkit/utils';
import { GitTracker } from '@vibe-agent-toolkit/utils/git';

import type { ParseResult } from '../link-parser.js';
import { defaultParseCache } from '../parse-cache.js';
import { ParseDispatcher } from '../parse-dispatcher.js';
import type { SHA256 } from '../schemas/checksum.js';
import type { CollectionConfig } from '../schemas/project-config.js';

import { RunContentCache } from './content-cache.js';
import type { PopulationUnreadablePolicy } from './crawl-source.js';
import type { PopulationCache } from './merge.js';
import { buildResourcePopulation, type ResourceEnumeration, type ResourcePopulationSource } from './resource-population.js';

/**
 * One file's admission facts: what a registry admitting it reads, keys and
 * parses, and nothing that depends on which view admits it. The stat is not
 * here: its link chain is read beneath a view's root, so it is its own fact per
 * (root, path) ({@link RunPopulation.stat}).
 */
export interface AdmittedFacts {
  /** The parse, SHARED between views: a view copies what it mutates (its links). */
  readonly parse: ParseResult;
  /** SHA-256 of the decoded content (`ResourceMetadata.checksum`). */
  readonly checksum: SHA256;
}

/** What a registry reads off a file's stat. */
export interface AdmittedStat {
  /** `stat().size`: the on-disk byte count. */
  readonly size: number;
  /** `stat().mtime`. */
  readonly mtime: Date;
}

/**
 * What a population reads and parses through: one run's content cache and
 * dispatcher. Every population takes one (`PopulateOptions.run`), so no population
 * reads or parses beside its run's other lanes.
 */
export interface PopulationRun {
  /** The run's one read-and-key memo. */
  readonly content: RunContentCache;
  /** The run's one parse dispatcher, under the population's parse limits. */
  readonly dispatcher: ParseDispatcher;
}

/**
 * Run `work` with a {@link PopulationRun} of its own — for a caller whose
 * population is the run's only lane (`vat resources query`, an inventory, a
 * test) — and shut its dispatcher down however `work` ends.
 *
 * @param work - The run
 * @returns Whatever `work` returned
 */
export async function withPopulationRun<T>(work: (run: PopulationRun) => Promise<T>): Promise<T> {
  // The dispatcher parses through the run's content cache, so a file any lane
  // parses by path is read once per run whichever lane read it first.
  const content = new RunContentCache();
  const dispatcher = new ParseDispatcher(defaultParseCache(), { content });
  try {
    return await work({ content, dispatcher });
  } finally {
    await dispatcher.shutdown();
  }
}

/** What a run's population is built over: its home root and that root's oracles. */
export interface RunPopulationOptions {
  /** The run's root: the project root a verb resolved. */
  readonly root: string;
  /**
   * The home root's ignore oracle. Not cosmetic: with none every realization row
   * reads `gitignored: false`, so the population would admit the ignored half of a
   * git tree. Initialized by the first enumeration of the home root (initializing
   * is idempotent), so a caller may take its git snapshot first and the tracker
   * then reads that snapshot rather than asking git again.
   */
  readonly gitTracker: GitTracker;
  /**
   * The run's projection store, or `undefined` when the store is off: asked for
   * at the first enumeration, so a run that enumerates nothing never opens it.
   */
  readonly cacheOf: () => Promise<PopulationCache | undefined>;
  /**
   * The `resources.collections` governing a root, so a declared `mimeType`
   * routes the file it matches to a parser: read off the root being enumerated,
   * so the declaration and the enumeration are always of one tree.
   */
  readonly collectionsFor: (root: string) => Promise<Readonly<Record<string, CollectionConfig>> | undefined>;
}

/** One VAT process run's shared reads, parses, admissions and enumerations. */
export class RunPopulation implements PopulationRun {
  /** The run's home root, resolved. */
  readonly root: string;
  /** The home root's ignore oracle (see {@link RunPopulationOptions.gitTracker}). */
  readonly gitTracker: GitTracker;
  readonly content: RunContentCache;
  readonly dispatcher: ParseDispatcher;
  /** The run's enumerations, every root's through this one source. */
  readonly source: ResourcePopulationSource;
  readonly #admissions = new Map<string, Promise<AdmittedFacts>>();
  readonly #stats = new Map<string, Promise<AdmittedStat>>();
  readonly #enumerations = new Map<string, Promise<ResourceEnumeration>>();
  readonly #options: RunPopulationOptions;

  /**
   * @param options - The home root and its oracles
   * @param run - The run's content cache and dispatcher, which {@link withRunPopulation} owns
   */
  constructor(options: RunPopulationOptions, run: PopulationRun) {
    this.#options = options;
    this.root = safePath.resolve(options.root);
    this.gitTracker = options.gitTracker;
    this.content = run.content;
    this.dispatcher = run.dispatcher;
    this.source = { enumerate: (root, outputs, unreadable) => this.#enumerate(root, outputs, unreadable) };
  }

  /**
   * One file's admission facts: computed by `compute` the first time this run
   * asks for this path under this parser kind, and handed back every later time —
   * a rejection included, so a file that cannot be read is read once and refused
   * the same way in every view.
   *
   * @param absolutePath - The file, resolved
   * @param parserKind - The parser its content routes to: part of the key, as in
   *   the content cache, since one path's reading under another kind is another fact
   * @param compute - Reads, keys and parses the file
   * @returns The run's one answer for the file
   */
  admit(absolutePath: string, parserKind: string, compute: () => Promise<AdmittedFacts>): Promise<AdmittedFacts> {
    return memoized(this.#admissions, `${parserKind} ${safePath.resolve(absolutePath)}`, compute);
  }

  /**
   * One file's stat with its link chain read beneath `statRoot`, once per run per
   * (root, path): a chain that leaves one view's root may stay inside another's.
   *
   * @param absolutePath - The file, resolved
   * @param statRoot - The root its link chain is read beneath
   * @param compute - Stats the file
   * @returns The run's one answer for the file under that root
   */
  stat(absolutePath: string, statRoot: string, compute: () => Promise<AdmittedStat>): Promise<AdmittedStat> {
    return memoized(this.#stats, `${statRoot} ${safePath.resolve(absolutePath)}`, compute);
  }

  /**
   * Enumerate a root once per run.
   *
   * The home root is enumerated under the run's oracles and store. Another root —
   * a path argument outside the project, a skill directory with no project root,
   * a nested project — is enumerated under its own: its own ignore oracle, no
   * store (the store holds the home tree's extents), and the collections its own
   * config declares. Nothing is declined and nothing is walked.
   *
   * A degrading enumeration (`{ degrade }`) is not memoized: its refusals are
   * handed to the caller that asked, and another caller must be handed them too.
   *
   * @param root - Absolute root to enumerate
   * @param outputs - The trees the calling verb writes
   * @param unreadable - What a refused listing inside the population does
   * @returns The root's population
   */
  #enumerate(root: string, outputs: readonly string[], unreadable: PopulationUnreadablePolicy): Promise<ResourceEnumeration> {
    const resolved = safePath.resolve(root);
    if (unreadable !== 'refuse') return this.#build(resolved, outputs, unreadable);
    const key = `${JSON.stringify(outputs)} ${resolved}`;
    const held = this.#enumerations.get(key);
    if (held !== undefined) return held;
    const enumeration = this.#build(resolved, outputs, unreadable);
    this.#enumerations.set(key, enumeration);
    return enumeration;
  }

  async #build(root: string, outputs: readonly string[], unreadable: PopulationUnreadablePolicy): Promise<ResourceEnumeration> {
    const { gitTracker, cacheOf, collectionsFor } = this.#options;
    const home = this.root === root;
    const collections = await collectionsFor(root);
    // The home root's store first: opening it takes the snapshot that keys it,
    // which the tracker then reads rather than asking git again. Another root
    // has no store (the store holds the home tree's extents) and opens none.
    const cache = home ? await cacheOf() : undefined;
    if (home) await gitTracker.initialize();
    return buildResourcePopulation({
      root,
      outputs,
      unreadable,
      run: this,
      gitTracker: home ? gitTracker : await initializedTracker(root),
      ...(cache !== undefined && { cache }),
      ...(collections !== undefined && { collections }),
    });
  }
}

/**
 * The memo's answer for `key`, computed by `compute` on first ask; a rejection is
 * an answer too.
 */
function memoized<T>(memo: Map<string, Promise<T>>, key: string, compute: () => Promise<T>): Promise<T> {
  const held = memo.get(key);
  if (held !== undefined) return held;
  const computed = compute();
  memo.set(key, computed);
  return computed;
}

/**
 * An initialized ignore oracle for a root that is not the run's home root.
 *
 * @param root - The root
 * @returns Its tracker
 */
async function initializedTracker(root: string): Promise<GitTracker> {
  const tracker = new GitTracker(root);
  await tracker.initialize();
  return tracker;
}

/**
 * Run `work` with one {@link RunPopulation}, and shut its dispatcher down however
 * `work` ends.
 *
 * @param options - The run's home root and its oracles
 * @param work - The run
 * @returns Whatever `work` returned
 */
export function withRunPopulation<T>(
  options: RunPopulationOptions,
  work: (population: RunPopulation) => Promise<T>,
): Promise<T> {
  return withPopulationRun((run) => work(new RunPopulation(options, run)));
}
