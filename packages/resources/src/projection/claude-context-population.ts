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
 * holding the list, so this function enumerates twice — once cheaply, under
 * `CONTENT_PARSING_SKIP`, purely to find the roots, and once for real.
 *
 * The discovery pass registers **only** the filesystem extent and asks for
 * `'deferred'` content, so it reads no bytes: it consumes four realization
 * columns, and `contentKey` is not one of them.
 *
 * ## ⚠️ Gitignored paths ARE realized here, and that is a decision with a cost
 *
 * `buildResourcePopulation` passes `DECLINE_IGNORED`; this lane does not.
 * Claude Code reads the FILESYSTEM, not git, so a gitignored `CLAUDE.md` or a
 * generated handbook is loaded into a real session. Declining them would
 * under-report on the file class most likely to be large, and an under-report is
 * the direction a context-budget answer cannot tolerate.
 *
 * The cost is real, and is stated here rather than discovered later: a gitignored
 * directory holding a second copy of the tree — a vendored dependency checkout, a
 * generated site bundle, a release staging directory — contributes its own
 * `CLAUDE.md` and `.claude/rules/` set, so root discovery registers a contributor
 * per copy and the population grows with them.
 *
 * ⚠️ Git worktrees are NOT an instance of this, and naming them as one was wrong.
 * Both `.worktrees` and `.claude/worktrees` have entries in
 * `NEVER_CRAWL_GLOBS` (`file-crawler.ts`), which `crawl-source.ts` passes to
 * `crawlDirectory` on the filesystem arm AND on the git arm's walk of the
 * ignored territory git declines to hold. Neither arm can descend into a
 * worktree copy, so it contributes nothing to enumerate. Only a gitignored copy
 * that survives that list costs anything here.
 *
 * It does not double any ANSWER, and the two reasons are worth separating:
 * a copy's `CLAUDE.md` is only ever an ancestor of paths *inside* that copy, so
 * an ancestry walk never reaches it from outside; and a copy's paths-less rules
 * are tagged `rule-scope: nested` rather than charged tree-globally, which is
 * precisely the case `claude-rules-scope.ts` splits `nested` off to cover. What
 * it doubles is the WORK.
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
import { FilesystemExtentContributor } from './contributors/filesystem-extent.js';
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
 * Every `@`-import root under a tree, found without reading a single byte.
 *
 * Split out from {@link buildClaudeContextPopulation} because it is the half
 * that must NOT get more expensive: it exists only to name the contributors the
 * real population will register, and the moment it starts parsing content the
 * lane pays the blob stage twice.
 *
 * @param root - Absolute, already-resolved corpus root
 * @param gitTracker - The run's git oracle, or undefined. Passed through so the
 *   two passes enumerate the same tree; this lane realizes gitignored paths
 *   either way, so the tracker changes only the `gitignored` column
 * @returns Root-relative paths of every `CLAUDE.md` / `.claude/rules` file
 */
async function discoverImportRoots(
  root: string,
  gitTracker: GitTracker | undefined,
): Promise<string[]> {
  const registry = new ContributorRegistry();
  // `'deferred'` — enumerated, deliberately not read. `claudeImportRootsFrom`
  // consumes `path`, `basenameLower` and `isDirectory`, and `contentKey` is not
  // among them, so every byte read to compute one would be read for nobody.
  registry.register(new FilesystemExtentContributor(undefined, 'deferred'));

  const discovery = await populate({
    root,
    registry,
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
 * @param options.gitTracker - The ignore oracle, or omitted. Not cosmetic:
 *   `resource_realizations.gitignored` is filled only when a tracker was
 *   supplied. This lane realizes ignored paths regardless — see the header — so
 *   the tracker decides whether a consumer can TELL which members were ignored,
 *   not which members there are
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
  const roots = await discoverImportRoots(root, options.gitTracker);

  const registry = new ContributorRegistry();
  // No `DECLINE_IGNORED`: this lane realizes the gitignored half on purpose —
  // see the header for the cost that buys.
  registry.register(new FilesystemExtentContributor());
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

  const parameters: Record<string, JsonValue> = {};
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
