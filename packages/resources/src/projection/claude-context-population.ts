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
 * holding the list, so this function POPULATES twice — once cheaply, under
 * `CONTENT_PARSING_SKIP`, purely to find the roots, and once for real.
 *
 * The discovery pass registers **only** the filesystem extent and asks for
 * `'deferred'` content, so it reads no bytes: it consumes four realization
 * columns, and `contentKey` is not one of them.
 *
 * ⚠️ **Two populations, ONE enumeration.** The tree is crawled once and both
 * passes are handed the same result — see {@link sharedEnumeration}. The
 * doubling that is structural is the *registration* ordering above, not the
 * walk, and letting the walk double with it charged this lane a second full
 * crawl for a list it already had.
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
 * Measured on VAT's own repository on 2026-08-23, through `vat resources
 * validate`, which then ran this lane for a default-on always-loaded budget
 * check. ⚠️ It no longer does — that check is now `vat claude budget`, and
 * validate has no knowledge of the budget at all — so the harness below is
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
 * ## ⚠️ The blob stage is the dominant cost, and it cannot be scoped
 *
 * `readsBlobs` decides only whether the stage may be SKIPPED. The stage has no
 * extension allowlist, so this lane parses every keyed blob in the tree —
 * measured at 6,839 ms cold on an 8,548-file monorepo, most of it for files
 * nothing here reads. Making the contributors small does not help; that
 * reasoning was tried and is false. If this lane ever needs to be fast, the fix
 * is in `blob-population.ts`, not here.
 */

import { safePath, type GitTracker } from '@vibe-agent-toolkit/utils';

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
  type BlobPopulationReport,
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
  // and a kind nobody kept is a kind nobody can report.
  return { kind: source.kind, enumerate: () => Promise.resolve(enumerated) };
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
 * @returns Root-relative paths of every `CLAUDE.md` / `.claude/rules` file
 */
async function discoverImportRoots(
  root: string,
  gitTracker: GitTracker | undefined,
  source: CrawlSource,
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
  onBlobPopulation: (report: BlobPopulationReport) => void;
}): Promise<Projection> {
  const root = safePath.resolve(options.root);
  // ONE crawl for both passes. Taken before root discovery rather than inside
  // it, so the single enumeration is visible at the level that owns both passes.
  const source = await sharedEnumeration(root);
  const roots = await discoverImportRoots(root, options.gitTracker, source);

  const registry = new ContributorRegistry();
  const filesystem = new FilesystemExtentContributor(() => source);
  registry.register(filesystem);
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

  // Gitignored paths are declined here exactly as they are in the discovery
  // pass — see the header for the ruling, and `claude-context-limits.ts` for the
  // under-report it is published as. Keyed off the INSTANCE's own id rather than
  // a second copy of the literal: a parameter set filed under an id no
  // registered contributor answers to is silently ignored.
  const parameters: Record<string, JsonValue> = { [filesystem.id]: DECLINE_IGNORED };
  for (const rootRelativePath of roots) {
    registry.register(new ClaudeImportExtentContributor(rootRelativePath));
    // Keyed off the same function the contributor derives its own id from,
    // rather than a second copy of the format: a parameter set filed under an id
    // no registered contributor answers to is SILENTLY ignored, and the extent
    // would then be its declared root and nothing else while reporting success.
    parameters[claudeImportContributorId(rootRelativePath)] =
      claudeImportExtentDeclaration(rootRelativePath) as unknown as JsonValue;
  }

  return populate({
    root,
    registry,
    parameters,
    onBlobPopulation: options.onBlobPopulation,
    ...populationOracles(options),
  });
}
