/**
 * The population lane behind Claude context analysis — its own lane, deliberately.
 *
 * `buildResourcePopulation` is the fast repo-wide enumerator and declares
 * `contentParsing: CONTENT_PARSING_SKIP`, which the driver checks against
 * `readsBlobs`. Both classifying contributors registered here read blob-keyed
 * tables, so they could not live in that lane even if it were desirable — and it
 * is not: that lane answers *what files are here*, this one answers *what does
 * the harness load*.
 *
 * ## Root discovery runs BEFORE the population, and that is structural
 *
 * `ContributorRegistry` keys on `id` and partitions on `kind` before any
 * `contribute` runs, so the set of import roots has to be known before
 * `populate` is called. That is the same constraint `buildInventoryPopulation`
 * satisfies by taking `skillMdPaths` as a parameter; here there is no caller
 * holding the list, so this lane has to find it for itself first.
 *
 * ## 🔑 It asks the STORE for that list before it crawls for it
 *
 * `resource_realizations` under a tree-hash key IS the enumeration, and the
 * three columns the classification reads (`path`, `basenameLower`,
 * `isDirectory`) do not depend on content demand, on the blob tier, or on which
 * other contributors ran. So {@link readStoredRealizations} answers the root
 * list outright whenever the store holds this tree's filesystem extent — under
 * the same key, the same reuse rule and the same unlistable-directory staleness
 * gate `populate` itself applies — and nothing is crawled, keyed or populated
 * to produce it.
 *
 * Measured warm on a 12.6k-file adopter (`vat-lab crawl`, `vat claude
 * context`): the discovery pass was **341.7 ms of a 794.6 ms** crawl total, the
 * single largest charge on a run whose real population was already a store hit.
 * On a store miss the discovery pass runs exactly as it did before.
 *
 * The discovery pass registers **only** the filesystem extent and asks for
 * `'deferred'` content, so it reads no bytes: it consumes four realization
 * columns, and `contentKey` is not one of them.
 *
 * ⚠️ **Two populations, ONE enumeration.** When the discovery pass does run, the
 * tree is crawled once and both passes are handed the same result — see
 * {@link sharedEnumeration}. The doubling that is structural is the
 * *registration* ordering above, not the walk, and letting the walk double with
 * it charged this lane a second full crawl for a list it already had. When the
 * store answers, there is one population and no crawl at all.
 *
 * ## ⚠️ Gitignored paths are DECLINED here, like every other lane
 *
 * This lane passes `DECLINE_IGNORED`, the same parameter set
 * `buildResourcePopulation` passes.
 *
 * It did not always. The argument for realizing them was that Claude Code reads
 * the FILESYSTEM, not git, so a gitignored `CLAUDE.md` or a generated handbook is
 * loaded into a real session and declining it under-reports on the file class
 * most likely to be large. That fact about the harness is still true. What
 * changed is the judgement about whether such a file is worth modelling: a file
 * that is inside a git repository but not in git tells nobody WHEN or HOW it was
 * built, or whether it was simply put there, so a budget computed against it
 * describes a session state no one can reproduce. Generated CLAUDE.md is
 * theoretical; the cost of modelling it was not.
 *
 * ⚠️ **The under-report this creates is DECLARED, not merely commented.**
 * `claude-context-limits.ts` publishes it as `gitignored-not-realized`, signed
 * `under-report`, and `vat claude context` prints it beside every answer. A
 * silent omission is indistinguishable from a file that is not there; that is
 * the one outcome this change was not allowed to have.
 *
 * ⛔ Outside a git working tree nothing is ignored and nothing is declined, so
 * the two behaviours are indistinguishable there — which is why every test that
 * pins this one runs `git init` first.
 *
 * ## What declining bought
 *
 * Measured on VAT's own repository, through `vat resources
 * validate`, which then ran this lane for a default-on always-loaded budget
 * check. ⚠️ It no longer does — that check has since been removed from VAT
 * entirely, and validate never runs this lane — so the harness below is
 * HISTORICAL and cannot be re-run as written. The saving is a property of this
 * lane, not of the command that happened to invoke it, and it moved with the
 * check. Interleaved A/B over two builds, n=9 each, medians: **2,365 ms →
 * 1,960 ms**, and the lane's marginal cost (against the same command under the
 * then-existing `--no-context-budget` opt-out, untouched at ~945 ms and serving
 * as the control) **1,413 ms → 1,020 ms**. `vat resources validate` measures
 * ~993 ms today, matching that control.
 *
 * The isolated charge is `builtin:filesystem` at the fixpoint pass this lane
 * runs in — its two `contribute` calls, one per pass — which fell from
 * **921–1,033 ms to 412–437 ms** across two runs of each arm. The resource
 * population's own charge in the same dumps did not move (172–180 ms against
 * 175–177 ms), which is what identifies the saving as this lane's rather than
 * the machine's. Two causes, roughly equal: the gitignored half is no longer
 * realized, and the two passes no longer crawl separately.
 *
 * The declined half is `dist/`, `coverage/`, `jscpd-report/`, `.vat-lab/` and
 * their like: on this tree, **6,271 realizations over 817 working locations
 * against 2,820 over 589**.
 *
 * ⚠️ Git worktrees were never an instance of the doubling this used to describe,
 * and naming them as one was wrong. Both `.worktrees` and `.claude/worktrees`
 * have entries in `NEVER_CRAWL_GLOBS` (`file-crawler.ts`), which
 * `crawl-source.ts` passes to `crawlDirectory` on the filesystem arm AND on the
 * git arm's walk of the ignored territory git declines to hold. Neither arm can
 * descend into a worktree copy, so it contributes nothing to enumerate.
 *
 * ## ⚠️ The blob stage is the dominant cost, and it cannot be scoped BY CALLER
 *
 * `readsBlobs` decides only whether the stage may be SKIPPED. This lane derives
 * a blob for every keyed path in the tree, and nothing a contributor declares
 * narrows that — measured at 6,839 ms cold on an 8,548-file monorepo, most of it
 * for files nothing here reads. Making the contributors small does not help;
 * that reasoning was tried and is false. If this lane ever needs to be faster,
 * the fix is in `blob-population.ts`, not here.
 *
 * ⚠️ **What DID narrow is the parse, and it narrowed by TYPE rather than by
 * caller.** Since `mime-type.ts` began typing paths, only `text/markdown`,
 * `text/plain` and `text/html` reach a document parser; everything else keys
 * `none.` and skips `unified()` while keeping its `blobs` row, its token
 * estimate and its full complement of lexical references. That is where the
 * bulk of the figure above went — 83.5% of remark time on the measured tree was
 * being spent on files that are not prose — but it is a fact about the TYPE
 * TABLE, not a scope this lane chose, and this lane still enumerates and keys
 * exactly what it did before.
 */

import { safePath } from '@vibe-agent-toolkit/utils';
import { type GitTracker } from '@vibe-agent-toolkit/utils/git';

import type { CollectionConfig } from '../schemas/project-config.js';
import type { JsonValue } from '../schemas/projection-shared.js';

import { ContributorRegistry } from './contributor.js';
import { AgenticConventionContributor } from './contributors/agentic-convention.js';
import {
  ClaudeImportExtentContributor,
  claudeImportContributorId,
  claudeImportExtentDeclaration,
  claudeImportRootsFrom,
} from './contributors/claude-import-extent.js';
import { ClaudeRulesScopeContributor } from './contributors/claude-rules-scope.js';
import { DECLINE_IGNORED, FilesystemExtentContributor } from './contributors/filesystem-extent.js';
import { crawlSourceFor, type CrawlSource } from './crawl-source.js';
import {
  CONTENT_PARSING_SKIP,
  DISCARD_BLOB_POPULATION,
  populate,
  populationOracles,
  readStoredRealizations,
  type BlobPopulationReport,
  type PopulateOptions,
  type PopulationCache,
} from './merge.js';
import type { Projection } from './projection.js';

/**
 * One crawl of the root, handed to both passes.
 *
 * ⛔ The enumeration is performed HERE, eagerly, rather than memoized behind a
 * lazy `enumerate()`. A memo is a cache, and a cache is a thing that can miss —
 * this cannot: the whole point is that a reader can see the single `await` that
 * produces the single crawl, and that a later edit adding a third registration
 * cannot quietly reintroduce a second one.
 *
 * Sound because both passes ask the extent the SAME question. They differ only
 * in `contentDemand` (`'deferred'` for discovery, the default for the real
 * pass), which decides what a realization row *says*, never which paths the
 * crawl found; and both now pass {@link DECLINE_IGNORED}, which is applied
 * per-path inside the contributor, after enumeration. If those two ever diverge
 * on the crawl itself, this sharing is what has to be undone first.
 *
 * 🪤 Bound to ONE root, and the source it wraps was built for that root. Never
 * hand the returned value to a population rooted anywhere else: it would answer
 * tree B's enumeration with tree A's paths, and — with a store open — file it
 * under A's extent key.
 *
 * @param root - Absolute, already-resolved corpus root
 * @returns A source that reports the enumerator that ran and replays its result
 */
async function sharedEnumeration(root: string): Promise<CrawlSource> {
  const source = crawlSourceFor(root);
  const enumerated = await source.enumerate();
  // `kind` is the INSTANCE's own, never re-read from the environment:
  // `crawlSourceFor` falls back silently when the root is not in a repository,
  // and a kind nobody kept is a kind nobody can report. `unlistable` travels for
  // the same reason: it is a fact about THIS enumeration, and a replay that
  // dropped it would hand the second pass a population with no record of the
  // directories the first pass could not see into.
  return {
    kind: source.kind,
    unlistable: source.unlistable,
    symlinks: source.symlinks,
    enumerate: () => Promise.resolve(enumerated),
  };
}

/**
 * Every `@`-import root under a tree, found without reading a single byte.
 *
 * Split out from {@link buildClaudeContextPopulation} because it is the half
 * that must NOT get more expensive: it exists only to name the contributors the
 * real population will register, and the moment it starts parsing content the
 * lane pays the blob stage twice.
 *
 * @param root - Absolute, already-resolved corpus root
 * @param gitTracker - The run's git oracle, or undefined. Passed through so the
 *   two passes ask the same question of the same tree — and it is not cosmetic
 *   here: with no tracker nothing is ignored, so {@link DECLINE_IGNORED}
 *   declines nothing and this pass discovers roots the real pass will too
 * @param source - The run's single enumeration, from {@link sharedEnumeration}
 * @param collections - The project's collections, forwarded for the same reason
 *   `gitTracker` is: the two passes ask one question of one tree.
 *
 *   ⚠️ **Inert today, and deliberately kept anyway — do not read it as
 *   load-bearing.** An earlier version of this note claimed omitting it would
 *   make the two passes EVICT EACH OTHER from the projection store. That cannot
 *   happen: this pass is never handed a `cache` (the real pass gets one through
 *   `populationOracles`, and there is no `cache` key below), so it neither reads
 *   nor writes the store and has no key to collide with. Nor can a declared type
 *   change what this pass ANSWERS — `claudeImportRootsFrom` consumes `path`,
 *   `basenameLower` and `isDirectory`, never `mime`, and content parsing is
 *   skipped outright.
 *
 *   It stays because the day this pass gains a store, or a consumer that reads
 *   `mime`, the two passes must already agree — and because a divergence would
 *   be SILENT (a store that never hits is indistinguishable from a cold one).
 *   `projection-mime-routing-store-key.test.ts` pins that agreement as a
 *   tripwire rather than as a live property.
 * @returns Root-relative paths of every `CLAUDE.md` / `.claude/rules` file
 */
async function discoverImportRoots(
  root: string,
  gitTracker: GitTracker | undefined,
  source: CrawlSource,
  collections: Readonly<Record<string, CollectionConfig>> | undefined,
): Promise<string[]> {
  const registry = new ContributorRegistry();
  // `'deferred'` — enumerated, deliberately not read. `claudeImportRootsFrom`
  // consumes `path`, `basenameLower` and `isDirectory`, and `contentKey` is not
  // among them, so every byte read to compute one would be read for nobody.
  const filesystem = new FilesystemExtentContributor(() => source, 'deferred');
  registry.register(filesystem);

  const discovery = await populate({
    root,
    registry,
    // The SAME parameter set the real pass below passes, and that agreement is
    // load-bearing twice over: a root discovered here that the real pass
    // declined would register a contributor whose extent is its own root and
    // nothing else, and a stored extent is keyed on `(contributorId,
    // parameterSet)` — so two passes asking different questions of one tree also
    // evict each other from the projection store, run after run.
    parameters: { [filesystem.id]: DECLINE_IGNORED },
    // Sound only because the sole registered contributor declares
    // `readsBlobs: false`; the driver refuses the combination rather than
    // handing a blob reader empty tables.
    contentParsing: CONTENT_PARSING_SKIP,
    // The stage never runs under the line above, so there is nothing to observe.
    // Named rather than omitted, so dropping the skip becomes a visible edit
    // here instead of a silence.
    onBlobPopulation: DISCARD_BLOB_POPULATION,
    ...(gitTracker !== undefined && { gitTracker }),
    // See the `@param collections` note: omitting these HERE while the real pass
    // passes them gives the two passes different store keys over one tree.
    ...(collections !== undefined && { collections }),
  });

  return claudeImportRootsFrom(discovery.resourceRealizations);
}

/**
 * Populate a tree with one `@`-import extent per Claude instruction root, plus
 * the convention and rules-scope classifiers.
 *
 * @param options - The root, the run's oracles, and the blob-stage observer
 * @param options.root - Absolute root to populate
 * @param options.gitTracker - The ignore oracle, or omitted. Not cosmetic, and
 *   no longer merely descriptive: this lane passes {@link DECLINE_IGNORED}, so
 *   the tracker decides which members there ARE. With none, nothing is ignored,
 *   nothing is declined, and the population is the whole enumeration — correct
 *   rather than a hole, because outside a repository there is no ignore oracle
 *   to consult
 * @param options.cache - A projection store to answer this population from, or
 *   omitted to re-derive every time. 🔑 The reuse rule compares this run's
 *   registered contributors AND their parameter sets against what the store
 *   holds, which is why {@link claudeImportExtentDeclaration} being a parameter
 *   set is load-bearing: two runs over one tree under different declarations —
 *   a different `referenceDialect`, say — are two different questions, and the
 *   store refuses to answer one with the other
 * @param options.onBlobPopulation - Receives what the blob stage derived and
 *   what it REFUSED to derive. **Required**: a caller with nothing to do with
 *   the counts names `DISCARD_BLOB_POPULATION` rather than leaving the argument
 *   off, because a tree whose every document was declined as binary would
 *   otherwise populate as empty and report success
 * @returns The populated projection
 */
export async function buildClaudeContextPopulation(options: {
  root: string;
  gitTracker?: GitTracker | undefined;
  cache?: PopulationCache | undefined;
  collections?: Readonly<Record<string, CollectionConfig>> | undefined;
  onBlobPopulation: (report: BlobPopulationReport) => void;
}): Promise<Projection> {
  const root = safePath.resolve(options.root);

  // The run's ONE crawl source, and the thunk the extent contributor reads it
  // through. Nothing asks it a question on a warm run: the store answers the
  // root list below, and `populate` then answers the population itself, so
  // neither pass reaches the crawl. "Two populations, ONE enumeration" holds in
  // both branches — the discovery branch replays its own crawl into this slot
  // (see {@link sharedEnumeration}), and the stored branch runs one population.
  let source: CrawlSource | undefined;
  const sourceOnce = (): CrawlSource => (source ??= crawlSourceFor(root));

  const registry = new ContributorRegistry();
  const filesystem = new FilesystemExtentContributor(sourceOnce);
  registry.register(filesystem);
  // Gitignored paths are declined here exactly as they are in the discovery
  // pass — see the header for the ruling, and `claude-context-limits.ts` for the
  // under-report it is published as. Keyed off the INSTANCE's own id rather than
  // a second copy of the literal: a parameter set filed under an id no
  // registered contributor answers to is silently ignored.
  const parameters: Record<string, JsonValue> = { [filesystem.id]: DECLINE_IGNORED };

  // ⛔ The SAME object `populate` is handed below, built before the import
  // contributors are registered so the two store reads compute one key from one
  // registry. See {@link readStoredRealizations} on why a later registration
  // cannot make that key wrong, only make this read miss.
  const populateOptions = {
    root,
    registry,
    parameters,
    onBlobPopulation: options.onBlobPopulation,
    ...populationOracles(options),
  };

  const discovered = await importRoots(populateOptions, filesystem.id);
  // The discovery branch's replaying source becomes the run's, so the real pass
  // reuses that crawl instead of taking a second one.
  if (discovered.source !== undefined) source = discovered.source;

  // AFTER the enumerator, and the order is load-bearing: `byStratum` returns
  // registration order and the driver runs base contributors sequentially, each
  // reading the base the previous ones grew. Registered first, this would
  // classify an empty realization table and report a complete, empty extent.
  registry.register(new AgenticConventionContributor());
  // `closure` stratum, so registration order relative to the base contributors
  // does not decide when it runs — but it is registered here, beside the other
  // classifier, because the two answer the same kind of question about the same
  // rows and a reader looking for one will look for the other.
  registry.register(new ClaudeRulesScopeContributor());

  for (const rootRelativePath of discovered.roots) {
    registry.register(new ClaudeImportExtentContributor(rootRelativePath));
    // Keyed off the same function the contributor derives its own id from,
    // rather than a second copy of the format: a parameter set filed under an id
    // no registered contributor answers to is SILENTLY ignored, and the extent
    // would then be its declared root and nothing else while reporting success.
    parameters[claudeImportContributorId(rootRelativePath)] =
      claudeImportExtentDeclaration(rootRelativePath) as unknown as JsonValue;
  }

  return populate(populateOptions);
}

/**
 * Every `@`-import root under the tree — from the store when it holds this
 * tree's filesystem extent, and from a discovery crawl when it does not.
 *
 * ## Why the store may answer this
 *
 * `resource_realizations` under a tree-hash key IS the enumeration, and the
 * three columns `claudeImportRootsFrom` reads — `path`, `basenameLower`,
 * `isDirectory` — are the three a `'deferred'` discovery pass would have
 * produced. They do not depend on content demand, on the blob tier, or on which
 * other contributors ran. So the stored rows are not an approximation of the
 * discovery pass's answer; they are the same answer, and
 * `readStoredRealizations` applies the same key, the same reuse rule and the
 * same unlistable-directory staleness gate `populate` applies before serving
 * one.
 *
 * ⚠️ Only the filesystem contributor is asked for, deliberately: it is the one
 * whose rows are the enumeration, and requiring the classifiers' provenance too
 * would turn a `vat resources scan`'s stored extent — which is enough to answer
 * this — into a miss.
 *
 * @param populateOptions - The options the real population will run under
 * @param filesystemId - The enumerating contributor's id, from the instance
 * @returns The roots, and — only when a crawl was taken to find them — the
 *   replaying source that crawl produced, so the caller can hand the very same
 *   enumeration to the real pass rather than taking a second one
 */
async function importRoots(
  populateOptions: PopulateOptions,
  filesystemId: string,
): Promise<{ roots: readonly string[]; source?: CrawlSource }> {
  const stored = await readStoredRealizations(populateOptions, [
    { id: filesystemId, parameterSet: DECLINE_IGNORED },
  ]);
  if (stored !== undefined) return { roots: claudeImportRootsFrom(stored) };

  const root = populateOptions.root;
  const source = await sharedEnumeration(root);
  return {
    roots: await discoverImportRoots(
      root,
      populateOptions.gitTracker,
      source,
      populateOptions.collections,
    ),
    source,
  };
}
