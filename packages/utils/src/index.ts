/**
 * @vibe-agent-toolkit/utils
 * Core shared utilities with no dependencies on other packages
 *
 * Utilities are added as needed by other packages, not speculatively.
 */

// Safe command execution (cross-platform, no shell injection)
export * from './safe-exec.js';

// Windows shell-invocation helpers (.cmd/.bat/.ps1 handling), shared by every spawn wrapper
export * from './windows-shell.js';

// Hardened async spawn (streaming stdio + correct Windows .cmd/.bat launching)
export * from './spawn-hardened.js';

// Cross-platform path utilities
export * from './path-utils.js';

// Blocking stdio for published bins (process.exit must not truncate output)
export * from './stdio-blocking.js';

// Asset reference resolution (paths + npm bare specifiers)
export * from './asset-reference.js';

// Filesystem utilities.
//
// Named rather than `export *` on purpose: `classifyFilenameCase` (the pure
// judge over a hand-held row) and `siblingNamesFrom` (the table lookup that
// throws on a miss) are internal members of the fill+judge pairs below, and a
// star re-export would publish them on this barrel the moment they were written.
// (The `./fs` subpath was already an explicit list and was never at risk.) The
// public surface is a decision, not a side effect of module layout.
//
// TWO materialized columns are published, both shaped fill-first-then-judge:
//
//   - sibling names — `fillSiblingNames` (every listing, once, up front) plus
//     `classifyFilenameCaseFrom` (pure judgement over the filled table). Its row
//     lookup `siblingNamesFrom` stays internal because a row there is not yet an
//     answer: it still needs a judge, and that judge is what we export.
//   - realpaths — `fillRealpaths` (every canonicalization, once, up front) plus
//     `realpathFrom`. Here the row lookup IS the judge: the canonical path is the
//     answer, so there is nothing left to keep internal.
//
// There is deliberately no one-call wrapper composing either pair: handed one, a
// caller with many paths loops over it, which reinstates the per-path `await` the
// pairs exist to remove.
//
// The `SiblingNames` row type is withheld for the same reason its judge is: it is
// only ever that judge's parameter, so publishing it would advertise a shape no
// consumer can hand anywhere. `SiblingNamesTable` and `RealpathTable` — what the
// fills return and the judges consume — are the ones a caller can name, as are
// `FilenameCaseVerdict`/`FilenameMatch`, which a consumer does not hand in but
// does receive and branch on.
//
// The cost of that decision, stated so it is not a surprise: a new *type* added
// to `fs-utils.ts` no longer reaches consumers automatically, and
// `barrel-exports.test.ts` pins runtime names only, so nothing will fail. The
// symptom is a type that cannot be imported, which surfaces the first time
// someone tries — not a silent break in existing code.
export {
  classifyFilenameCaseFrom,
  copyDirectory,
  fillRealpaths,
  fillSiblingNames,
  FsLookupCache,
  isFilesystemAccessError,
  realpathFrom,
} from './fs-utils.js';
export type {
  FilenameCaseVerdict,
  FilenameMatch,
  PathProbe,
  PathProbeStats,
  RealpathTable,
  SiblingNamesTable,
} from './fs-utils.js';

// Directory crawling with glob patterns
export * from './file-crawler.js';

// Git ignore checking
export * from './gitignore-checker.js';

// The one way to run git: scrubbed by default, `ambient: true` to opt out.
// safeExecSync/safeExecResult refuse `git` and point here. The scrub itself,
// and dirty-corrected tree snapshots, come from `@vibe-validate/git`.
export * from './git-run.js';

// Git URL parsing (parse/detect git URLs, GitHub shorthand, SSH forms)
export * from './git-url.js';

// Git utilities (using git commands directly)
export * from './git-utils.js';

// Project root discovery (canonical: config → git → null).
// CLI-boundary use only — see docs/concepts/roots-and-config.md.
export * from './project-utils.js';

// Git tracking cache (for efficient git-ignore checking)
export * from './git-tracker.js';

// Test helpers for isolated test output directories
export * from './test-helpers.js';

// Zod type introspection (version-agnostic)
export * from './zod-introspection.js';

// Handlebars template rendering (cached, no HTML escaping)
export * from './template.js';

// Skill target resolution (cross-platform flat skill install paths)
export * from './skill-targets.js';

// linkAuth pure engine — public API only (issue #113).
// Internal helpers (rewrite, build-headers, etc.) stay module-private.
export {
  type LinkAuthConfig,
  type Provider,
  type ProviderAuth,
  type ProviderCheck,
  resolveAuthenticatedUrl,
  type ResolveOutcome,
} from './link-auth/resolve.js';
export type { ProviderMatch } from './link-auth/select-provider.js';
export type { RewriteRule } from './link-auth/rewrite.js';
export { defaultRunCommand, type TokenSource } from './link-auth/resolve-token.js';
export { expandMacro, UnknownMacroError } from './link-auth/expand-macro.js';

// Skill testing utilities (environment management for headless agent runs)
export * from './skill-test/index.js';

// Glob pattern helpers (isGlob, staticGlobBase, globMagicRemainder)
export * from './glob/glob-pattern.js';

// Filesystem hashing (sha256 of raw file bytes)
export * from './fs/file-hash.js';

// Byte-surgical YAML value updater (replace/insert without reflowing the doc)
export * from './yaml/surgical-yaml.js';

export { parseWholeNumberAtLeast } from './numeric-args.js';

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
  CRAWL_REGISTRY_ADD_RESOURCE_ID,
  CRAWL_REGISTRY_ENUMERATE_ID,
  CRAWL_REGISTRY_ID_PREFIX,
  CRAWL_REGISTRY_RESOLVE_LINKS_ID,
  // Exported so the READER can pin itself against the WRITER. `@vibe-agent-toolkit/lab`
  // hard-refuses a dump whose version it does not recognise, and the two constants
  // used to be unrelated literals in two packages — drift was silent, and its symptom
  // is every dump being refused rather than a subtly wrong number.
  CRAWL_SEAM_DUMP_VERSION,
  CRAWL_SHARED_GIT_TRACKER_ID,
  CRAWL_STRATA,
  CRAWL_WALKER_GITIGNORE_ID,
  CRAWL_WALKER_ID,
  crawlTimingStart,
  recordContributorInvocation,
  recordCrawlPass,
  recordRegistryPass,
  recordSharedPass,
  withContributorStratum,
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
