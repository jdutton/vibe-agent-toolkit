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
 * - The **per-file admission facts** ({@link AdmittedFacts}): the content-addressed
 *   half of each resource (its content key included), by path. Nothing that depends
 *   on a view: the id, duplicate detection, link resolution, population conditions
 *   and parse refusals are computed per registry view by the same code as ever.
 *   Views never share link objects: a registry copies the links it is handed.
 * - Each root's enumeration, once ({@link RunPopulation.source}): the home's
 *   full population under a store, or each root's names ({@link RootListing}),
 *   listed once and narrowed per crawl.
 * - On a store hit, what the store holds about each of the home's members
 *   (`stored-admission.ts`): a member is admitted from the blob tier through the
 *   one fact reader, with no read, key or parse, wherever the stored answer is
 *   the cold one.
 *
 * ## Lifetime
 *
 * One run, opened by {@link withRunPopulation}, which shuts the dispatcher down
 * however the run ends. First read wins for the whole run (see
 * {@link RunContentCache.read}), which is only correct for a run that writes
 * nothing into the tree it reads before it reads it again; a verb that builds
 * reads its own output through a population of that output's directory.
 */

import { open } from 'node:fs/promises';

import { countWork, safePath } from '@vibe-agent-toolkit/utils';
import { gitFindRoot, gitLinksCheckedOutAsFiles, GitTracker } from '@vibe-agent-toolkit/utils/git';

import { defaultParseCache } from '../parse-cache.js';
import { ParseDispatcher } from '../parse-dispatcher.js';
import type { CollectionConfig } from '../schemas/project-config.js';
import { sameDirectory } from '../utils.js';

import type { NotAdmittedEntry } from './blob-refusals.js';
import type { BlobResourceFacts } from './blob-resource-facts.js';
import { RunContentCache } from './content-cache.js';
import { RootListing, type PopulationUnreadablePolicy } from './crawl-source.js';
import type { PopulationCache } from './merge.js';
import {
  buildResourceListing,
  buildResourcePopulation,
  type PopulationMembers,
  type ResourceEnumeration,
  type ResourcePopulationSource,
} from './resource-population.js';
import { hydratesUnder, readRoute, respelledContent, storedRoute, type StoredMember } from './stored-admission.js';

/**
 * One file's admission facts: what a registry admitting it reads, keys and
 * parses, and nothing that depends on which view admits it. The stat is not
 * here: its link chain is read beneath a view's root, so it is its own fact per
 * (root, path) ({@link RunPopulation.stat}).
 *
 * - `facts`: the content-addressed half of the resource, built from a cold
 *   parse (`blobResourceFactsOf`) or from the store's blob tier
 *   (`blobFactsReader`) alike, so both are built into a resource by one code
 *   path. SHARED between views: a view copies what it mutates (its links and
 *   headings).
 * - `not-admitted`: the stored refusal of a file a warm run admits from the
 *   store, in the not-admitted log's own entry. A cold refusal is a throw, as
 *   it always was.
 */
export type AdmittedFacts =
  | { readonly kind: 'facts'; readonly facts: BlobResourceFacts }
  | { readonly kind: 'not-admitted'; readonly entry: NotAdmittedEntry };

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
  readonly #listings = new Map<string, Promise<RootListing>>();
  readonly #trackers = new Map<string, Promise<GitTracker | undefined>>();
  /**
   * What the store holds about each member of the home's population, by absolute
   * path in every spelling a crawl asked by: recorded when a store hit resolves,
   * empty for a run whose home was derived or listed.
   */
  readonly #stored = new Map<string, StoredMember>();
  /** Each listed root's tracked links checked out as plain files, by root. */
  readonly #linksAsFiles = new Map<string, ReadonlySet<string> | null>();
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
    this.source = {
      enumerate: (root, outputs, unreadable, members) => this.#enumerate(root, outputs, unreadable, members),
    };
  }

  /**
   * One file's admission facts: decided the first time this run asks for this
   * path under this parser kind, and handed back every later time — a rejection
   * included, so a file that cannot be read is read once and refused the same
   * way in every view.
   *
   * On a store hit a member is admitted from what the store holds about it when
   * {@link storedRoute} and {@link readRoute} say so (built from the blob tier by
   * the one fact reader, no read, key or parse), and by `compute` otherwise —
   * see `stored-admission.ts`. Counted `registry.admitted` once whichever way it
   * was admitted; a stated refusal is not an admission.
   *
   * @param absolutePath - The file, resolved
   * @param parserKind - The parser its content routes to: part of the key, as in
   *   the content cache, since one path's reading under another kind is another fact
   * @param compute - Reads, keys and parses the file: the cold lane
   * @returns The run's one answer for the file
   */
  admit(absolutePath: string, parserKind: string, compute: () => Promise<AdmittedFacts>): Promise<AdmittedFacts> {
    const resolved = safePath.resolve(absolutePath);
    return memoized(this.#admissions, `${parserKind} ${resolved}`, () => this.#admitted(resolved, parserKind, compute));
  }

  /** The body of {@link admit}'s memo miss. */
  async #admitted(absolutePath: string, parserKind: string, compute: () => Promise<AdmittedFacts>): Promise<AdmittedFacts> {
    const stored = this.#stored.get(absolutePath);
    if (stored === undefined) return compute();
    const route = storedRoute(stored.realization, parserKind);
    if (route.kind === 'compute') return compute();
    // A file that cannot be read now is the cold lane's: its read raises the cold error, an
    // oversize file's included (the cold lane opens it before it refuses it by its size).
    if (route.kind === 'not-admitted') {
      return (await readRefusal(absolutePath)) === null ? { kind: 'not-admitted', entry: route.entry } : compute();
    }
    const read = readRoute((await stored.facts())(route.contentKey));
    if (read.kind === 'compute' || (await readRefusal(absolutePath)) !== null) return compute();
    if (read.admitted.kind === 'facts') countWork('registry.admitted', 1);
    return read.admitted;
  }

  /**
   * Record what a store hit holds about its members, under the spelling the
   * crawl asked by, so {@link admit} can admit them from it. Nothing is
   * recorded for a run whose dispatcher parses under other limits than the ones
   * the store's facts were filed under ({@link hydratesUnder}): every member is
   * then computed.
   *
   * @param enumeration - A resolved enumeration
   */
  #recordStored(enumeration: ResourceEnumeration): void {
    const { stored } = enumeration;
    if (stored === null || !hydratesUnder(this.dispatcher.limits)) return;
    for (const [path, realization] of stored.members) {
      if (!this.#stored.has(path)) this.#stored.set(path, { realization, facts: stored.facts });
    }
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
   * The home root, asked by a refusing crawl, is the full population when the
   * run has a store: read and keyed once, so the store answers every later run
   * and every resources lane of this one ({@link buildResourcePopulation}). Every
   * other enumeration has no store to pay off — another root (a path argument
   * outside the project, a skill directory with no project root, a nested
   * project), the home with the store off or outside a repository, and every
   * degrading crawl, whose narrowed population the store's key could not
   * describe — so it is a listing of the crawl's members alone, which reads no
   * file ({@link buildResourceListing}). The root's names are listed once per
   * run per `outputs` ({@link RootListing}) and narrowed per member set, so a
   * second crawl of the root with other globs lists nothing again. Another root
   * is listed under its own ignore oracle and the collections its own config
   * declares, and never under the home's extent key.
   *
   * Which root is the home is the filesystem's answer ({@link sameDirectory}):
   * `/tmp/x` and `/private/tmp/x` are one root, so the second spelling is served
   * by the home's store and its paths come back in the spelling asked.
   *
   * A degrading enumeration (`{ degrade }`) is not memoized: its refusals are
   * handed to the caller that asked, and another caller must be handed them too.
   * A refusing one is, rejection included: one enumeration per root per run.
   *
   * @param root - Absolute root to enumerate
   * @param outputs - The trees the calling verb writes
   * @param unreadable - What a refused listing inside the population does
   * @param members - The calling crawl's include and exclude globs
   * @returns The root's population
   */
  #enumerate(
    root: string,
    outputs: readonly string[],
    unreadable: PopulationUnreadablePolicy,
    members: PopulationMembers,
  ): Promise<ResourceEnumeration> {
    const resolved = safePath.resolve(root);
    const home = sameDirectory(this.root, resolved);
    if (unreadable !== 'refuse') return this.#list(resolved, home, outputs, unreadable, members);
    // The home's full population is one per run whatever the crawl's members;
    // a listing is of the members asked for.
    const key = `${JSON.stringify(outputs)} ${resolved} ${JSON.stringify(members)}`;
    return memoized(this.#enumerations, key, async () => {
      const homeKey = `${JSON.stringify(outputs)} home`;
      const cache = home ? await this.#options.cacheOf() : undefined;
      if (cache === undefined) return this.#list(resolved, home, outputs, unreadable, members);
      const population = await memoized(this.#enumerations, homeKey, () => this.#populate(outputs, cache));
      const enumeration = respelled(population, this.root, resolved);
      this.#recordStored(enumeration);
      return enumeration;
    });
  }

  /** The home root's full population, under the run's store. */
  async #populate(outputs: readonly string[], cache: PopulationCache): Promise<ResourceEnumeration> {
    const { gitTracker, collectionsFor } = this.#options;
    const collections = await collectionsFor(this.root);
    // The store is open: opening it took the snapshot that keys it, which the
    // tracker now reads rather than asking git again.
    await gitTracker.initialize();
    return buildResourcePopulation({
      root: this.root,
      outputs,
      run: this,
      gitTracker,
      cache,
      ...(collections !== undefined && { collections }),
    });
  }

  /**
   * A root's members, listed with no store (see {@link buildResourceListing}).
   * The home is listed under the run's spelling of it, which its tracker's
   * names are spelled under, and handed back in the spelling asked.
   */
  async #list(
    root: string,
    home: boolean,
    outputs: readonly string[],
    unreadable: PopulationUnreadablePolicy,
    members: PopulationMembers,
  ): Promise<ResourceEnumeration> {
    const listed = home ? this.root : root;
    const collections = await this.#options.collectionsFor(listed);
    const gitTracker = await this.#trackerOf(listed, home);
    const listing = await memoized(this.#listings, `${JSON.stringify(outputs)} ${listed}`, () =>
      RootListing.of(listed, outputs, {
        names: () => this.#gitListing(listed, home),
        linksCheckedOutAsFiles: () => this.#linksAsFilesOf(listed),
      }));
    const population = await buildResourceListing({
      root: listed,
      listing,
      unreadable,
      members,
      run: this,
      ...(gitTracker !== undefined && { gitTracker }),
      ...(collections !== undefined && { collections }),
    });
    return respelled(population, listed, root);
  }

  /**
   * A root's ignore oracle, initialized once per run: the run's own for the
   * home, none outside a repository (there is nothing to ask, and asking costs
   * a spawn).
   */
  #trackerOf(root: string, home: boolean): Promise<GitTracker | undefined> {
    return memoized(this.#trackers, root, async () => {
      if (gitFindRoot(root) === null) return undefined;
      const tracker = home ? this.gitTracker : new GitTracker(root);
      await tracker.initialize();
      return tracker;
    });
  }

  /**
   * The tracked links under a root its checkout wrote as plain files, read once per
   * root per run: one `git config` read, and the index under it only when
   * `core.symlinks` is `false`. `null` when git did not answer.
   */
  #linksAsFilesOf(root: string): ReadonlySet<string> | null {
    // Read under the root, never the whole repository: `ls-files -s` of a large
    // monorepo is twice its names and could pass the output cap for a small root.
    if (!this.#linksAsFiles.has(root)) this.#linksAsFiles.set(root, gitLinksCheckedOutAsFiles(root));
    return this.#linksAsFiles.get(root) ?? null;
  }

  /**
   * A root's names as git lists them: its tracker's listing, or a tracker of
   * the root's own when the run's was initialized without untracked files.
   */
  async #gitListing(root: string, home: boolean): Promise<readonly string[] | null> {
    const listing = (await this.#trackerOf(root, home))?.listing() ?? null;
    if (listing !== null || !home) return listing;
    const own = new GitTracker(root);
    await own.initialize();
    return own.listing();
  }
}

/**
 * A population of `from`, with its paths spelled under `to` — the same directory
 * by another spelling ({@link sameDirectory}), so the crawl that asked by `to`
 * gets paths under its own base.
 *
 * @param population - The population, its paths under `from`
 * @param from - The spelling it was enumerated under
 * @param to - The spelling the crawl asked by
 * @returns The population with its paths under `to`
 */
function respelled(population: ResourceEnumeration, from: string, to: string): ResourceEnumeration {
  if (from === to) return population;
  const respell = (path: string): string => safePath.join(to, safePath.relative(from, path));
  return {
    ...population,
    paths: population.paths.map(respell),
    stored: population.stored === null ? null : respelledContent(population.stored, respell),
  };
}

/**
 * What refuses reading a file the store answers for now, if anything: the one
 * probe a warm admission makes in place of the cold read, counted as the stat it
 * is. An open and a close, reading nothing: it fails exactly as the cold read's
 * own open would, a Windows sharing lock included, where a permission check
 * (`access`) succeeds. Any refusal sends the file to the cold lane, whose read
 * raises (and classifies) the cold error, so the refusal itself is only
 * reported, never judged.
 *
 * @param absolutePath - The file
 * @returns The refusal, or `null` when the file can be read
 */
async function readRefusal(absolutePath: string): Promise<{ readonly refused: unknown } | null> {
  countWork('fs.stat', 1);
  try {
    const handle = await open(absolutePath, 'r');
    await handle.close();
    return null;
  } catch (error) {
    return { refused: error };
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
