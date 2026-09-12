/**
 * @vibe-agent-toolkit/utils
 * Core shared utilities with no dependencies on other packages
 *
 * Utilities are added as needed by other packages, not speculatively.
 *
 * **A module that brings a third-party dependency belongs on a subpath, not
 * here.** This entry has ~245 in-repo importers plus published adopters, and
 * every one of them pays for the whole graph reachable from it — a bundler that
 * cannot tree-shake a dependency (a CJS package, or one reached through
 * `new URL(..., import.meta.url)`) inlines it into every consumer that touched
 * a path helper. The domains that carry weight each have their own entry:
 * `./crawl`, `./git`, `./process`, `./skill-test`, `./template`, `./yaml`.
 * `./skill-test` is there for a *transitive* reason rather than a direct one —
 * it declares no dependency itself, but spawning a headless agent goes through
 * `./process`, which reaches `which` and (because `safeExecSync` refuses `git`
 * and delegates) `@vibe-validate/git`. Reachability is the criterion, not the
 * import a module happens to write.
 *
 * The rule is enforced, not merely stated: `test/subpath-purity.test.ts` asserts
 * this entry's reachable third-party set by equality, so a dependency arriving
 * here — directly or transitively, through any module below — turns that row red
 * and has to be an argued edit rather than an unnoticed one.
 */

// Cross-platform path utilities
export * from './path-utils.js';

// THE content-decoding seam: bytes to text, in one place. `decodeTextContent` is
// pure and also reachable from the dependency-free `./text` entry; the two
// file-reading wrappers need `node:fs` and are also on `./fs`. Other routes from
// bytes to text — `buf.toString('utf-8')`, `new TextDecoder()`,
// `readFile(p, 'utf-8')` — are a lint error under `local/no-raw-text-decode`
// WHERE IT IS REGISTERED (this package's `src` and `resources`' `src`); the rest
// of the repo is a migration ledger in `eslint.config.js`, not a covered claim.
export * from './text-content.js';
export * from './text-file.js';

// Asset reference resolution (paths + npm bare specifiers)
export * from './asset-reference.js';

// Filesystem utilities.
//
// Named rather than `export *` on purpose: `fs-utils.ts` holds internal members
// of the fill+judge pairs below — the per-directory index build, the table-key
// derivation — and a star re-export would publish each of them on this barrel
// the moment it was written. (The `./fs` subpath was already an explicit list
// and was never at risk.) The public surface is a decision, not a side effect of
// module layout.
//
// TWO materialized columns are published, both shaped fill-first-then-judge:
//
//   - path spellings — `fillPathSpellings` plus `pathSpellingFrom`. It judges a
//     WHOLE path, which is what a caller validating references needs: judging
//     only the basename hands every directory component back to the host
//     filesystem's own folding, so a link that resolves on macOS 404s on a
//     case-sensitive filesystem. The `DirectorySpellingIndex` underneath is
//     published too, for the lazy caller that cannot enumerate its targets up
//     front.
//   - realpaths — `fillRealpaths` (every canonicalization, once, up front) plus
//     `realpathFrom`.
//
// In both, the row lookup IS the judge: the row is the answer, so there is
// nothing left to keep internal.
//
// There is deliberately no one-call wrapper composing either pair: handed one, a
// caller with many paths loops over it, which reinstates the per-path `await` the
// pairs exist to remove.
//
// `PathSpellingTable` and `RealpathTable` — what the fills return and the judges
// consume — are the types a caller can name, as are `PathSpelling`,
// `PathSpellingRequest`, `ComponentMatch` and `FilenameMatch`, which a consumer
// receives and branches on.
//
// The cost of that decision, stated so it is not a surprise: a new *type* added
// to `fs-utils.ts` no longer reaches consumers automatically, and
// `barrel-exports.test.ts` pins runtime names only, so nothing will fail. The
// symptom is a type that cannot be imported, which surfaces the first time
// someone tries — not a silent break in existing code.
// The lookups themselves, plus the memo every fill shares.
export {
  copyDirectory,
  FsLookupCache,
  isFilesystemAccessError,
  transientRefusalClause,
} from './fs-utils.js';
// The two fill+judge pairs, in the order the note above lists them, plus the
// lazy index a caller that cannot enumerate its targets up front reaches for.
export {
  DirectorySpellingIndex,
  fillPathSpellings,
  fillRealpaths,
  pathSpellingFrom,
  realpathFrom,
  spellingWalkRoot,
} from './fs-utils.js';
export type {
  AbsenceCause,
  ComponentMatch,
  FilenameMatch,
  PathProbe,
  PathProbeStats,
  PathSpelling,
  PathSpellingRequest,
  PathSpellingTable,
  RealpathTable,
} from './fs-utils.js';

// Project root discovery (canonical: config → git → null).
// CLI-boundary use only — see docs/concepts/roots-and-config.md.
export * from './project-utils.js';

// Test helpers for isolated test output directories
export * from './test-helpers.js';

// Zod type introspection (version-agnostic)
export * from './zod-introspection.js';

// Skill target resolution (cross-platform flat skill install paths)
export * from './skill-targets.js';

// Glob pattern helpers (isGlob, staticGlobBase, globMagicRemainder)
export * from './glob/glob-pattern.js';

// Filesystem hashing (sha256 of raw file bytes)
export * from './fs/file-hash.js';

export { parseWholeNumberAtLeast } from './numeric-args.js';

// THE reading of an environment variable as a boolean. One implementation
// because three switches each had their own `!== '0'` comparison and none of
// them turned off for `=false`.
export { parseEnvBoolean } from './env-flag.js';

// Machine-independent string ordering for hashed/serialized output — never `localeCompare`.
export { compareCodeUnits } from './compare-code-units.js';

// The crawl-timing seam: which contributor, stratum and fixpoint pass owns the
// time it takes to FIND documents.
//
// It lives HERE, at the bottom of the graph, because the work it measures is
// spread across four packages above this one — `resources` builds the registry,
// `agent-skills` walks the link graph, `claude-marketplace` enumerates an
// inventory, and `utils` itself initializes the `GitTracker` both crawlers
// consume. Both arms must record through ONE recorder or the two are not
// comparable, and only `utils` is beneath all of them. See the module header.
//
// Named rather than `export *`: the accumulator internals (`addEntry`,
// `keyOf`, `recordInheritedPass`) are not surface, and `timing-dump.ts` is
// plumbing shared with `resources`' package-internal `parse-timing.ts` — a star
// re-export would publish both the moment either grew a symbol.
export {
  CRAWL_BLOB_POPULATE_ID,
  CRAWL_CLOSURE_CONTRIBUTE_ID,
  CRAWL_CLOSURE_RESOLVE_ID,
  CRAWL_PASS_INSIDE,
  CRAWL_REGISTRY_ADMIT_ID,
  CRAWL_REGISTRY_ENUMERATE_ID,
  CRAWL_REGISTRY_ID_PREFIX,
  CRAWL_REGISTRY_RESOLVE_LINKS_ID,
  CRAWL_SHARED_GIT_TRACKER_ID,
  CRAWL_STORE_READ_ID,
  CRAWL_STORE_WRITE_ID,
  CRAWL_STRATA,
  CRAWL_WALKER_GITIGNORE_ID,
  CRAWL_WALKER_ID,
  crawlTimingStart,
  recordContributorInvocation,
  recordCrawlPass,
  recordRegistryPass,
  recordSharedPass,
  withContributorStratum,
  withOuterBracket,
  type CrawlDriverStratum,
  type CrawlStratum,
  type CrawlTimingDump,
  type CrawlTimingEntry,
  type CrawlTimingProcess,
  __readCrawlTimingSnapshot,
  __setCrawlTimingForTest,
  __writeCrawlTimingDumpForTest,
} from './crawl-timing.js';

// The on-disk plumbing both timing seams share. Exported because
// `resources`' `parse-timing.ts` is the other consumer and now sits a package
// away; nothing else should reach for it.
export {
  ensureTimingDirectory,
  normalizeTimingDirectory,
  readTimingProcess,
  type TimingProcess,
  writeTimingDump,
} from './timing-dump.js';
