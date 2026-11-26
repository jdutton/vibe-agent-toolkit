/**
 * Cache command group.
 *
 * The paired `--no-cache` control surface lives in `./cache-control.js`:
 * `--no-cache` decides whether this run *writes* to the caches, `vat cache
 * clear` and `vat cache prune` decide whether the caches *survive*. They are
 * separate modules only because `bin.ts` registers the flag on every invocation
 * and must not pay for this command's imports to do it.
 *
 * ⛔ Do NOT re-export `cache-control.js` from here for convenience. Importing it
 * through this module pulls `./clear.js` and the whole resources package behind
 * it — the exact ~1.2s that splitting the file removed — so a re-export leaves
 * the expensive path one identical-looking import away, with nothing pinning
 * the cheap one. Import from `./cache-control.js` directly.
 */

import { Command } from 'commander';

import { cacheClearCommand, type CacheClearOptions } from './clear.js';
import { cachePruneCommand, type CachePruneOptions } from './prune.js';

/** Why a clear or prune may refuse the cache root: said once, in both commands' help. */
const GUARD_HELP = `  Both commands refuse (USAGE_INVALID, nothing deleted) a cache root they
  cannot prove is VAT's: it must carry the CACHEDIR.TAG file VAT writes into a
  root it created or found empty, or be the default <tmpdir>/.vat-cache (a
  real directory you own, never a symbolic link). The filesystem root, your
  home directory, the temp directory itself and any directory holding the
  current directory are always refused. Point VAT_CACHE_DIR at a directory
  used only by VAT: VAT tags it on first use if it is new or empty.`;

export function createCacheCommand(): Command {
  const cache = new Command('cache');

  cache
    .description("Manage VAT's on-disk caches")
    .helpCommand(false)
    .addHelpText(
      'after',
      `
Description:
  VAT keeps two kinds of disposable cache. None of them is durable: recovery
  is always "rescan".

  The cache root — VAT_CACHE_DIR, else <tmpdir>/.vat-cache — holds one
  directory per VAT release (its namespace), and in it the parse cache (facts
  keyed by file content) and the projection store, a SQLite database holding
  one whole scanned tree per entry, on by default and by far the larger of
  the two. This is the directory to save and restore between CI runs: key
  the CI cache on the runner's OS, architecture, Node version, lockfile hash
  and commit, restore only from keys that share all but the commit, save from
  default-branch runs, and keep it outside the checkout (in GitHub Actions,
  $RUNNER_TEMP/vat-cache).
  Another VAT build never reads it. Within a build, the parse cache and the
  store's shared blob tier are keyed by file content, so they hit on any
  machine with the same bytes; a stored tree is keyed by the repository's
  identity and path, so it misses when the checkout moves or line endings
  differ (a cold scan, never a wrong answer). A projection store SQLite finds
  corrupt or not a database at open is discarded with a warning and rebuilt.

  The link cache — <tmpdir>/.vat-link-cache — holds external-URL validation
  results and per-OS-user authenticated-link content. It is never under
  VAT_CACHE_DIR: it describes the network and one user's credentials, not
  the files a CI cache restores.

  How large: one 12,602-file repository measured 71 MB of projection store,
  and the file holds several trees per repository plus a shared blob tier, so
  a machine that has scanned a few projects reaches the hundreds of MB.

  Only the projection store evicts anything on its own: it keeps the three
  most recently written trees per root, and the most recently written content
  keys whose facts fit about 265 MB. vat cache prune removes every namespace but this build's
  (older and newer releases, and under the shared default root other
  worktrees' and other VATs' too) and every other projection shape's store;
  vat cache clear removes everything.

  To run WITHOUT the caches rather than remove them, use --no-cache on any
  command (or VAT_CACHE=0), which also applies to spawned phases and to the
  projection store. VAT_PROJECTION_STORE=off turns off just the store.

Environment:
  VAT_CACHE_DIR    The cache root. A relative path resolves against the
                   current directory; empty means unset.

Example:
  $ vat cache prune --dry-run          # What a prune would reclaim
  $ vat cache clear                    # Reclaim every VAT cache
`
    );

  cache
    .command('clear')
    .description('Delete the VAT cache root and the link cache')
    .action(async function (this: Command) {
      await cacheClearCommand(this.optsWithGlobals() as CacheClearOptions);
    })
    .addHelpText(
      'after',
      `
Description:
  Removes the cache root (VAT_CACHE_DIR, else <tmpdir>/.vat-cache) and the
  link cache (<tmpdir>/.vat-link-cache) in their entirety — every release
  namespace's parse cache and projection store, the external-URL validation
  cache and the per-OS-user authenticated-link cache. The projection store is
  usually most of the bytes this reclaims: 71 MB for a single 12,602-file
  repository, and the hundreds of MB once a machine has scanned several.
  Every one of them is disposable by design: the next run repopulates what it
  needs, so the only cost of clearing is one cold pass.

${GUARD_HELP}

  Runs regardless of --no-cache / VAT_CACHE=0. Turning caching off must not
  disarm the one command that reclaims the space.

  A cache directory that does not exist is not an error — nothing to remove is
  a successful clear.

  Each location is moved off its path whole, then removed: a delete the OS
  stops (another VAT writing into the shared tree, a file it will not remove)
  leaves no part of a cache where VAT looks. That is the report's error branch
  (error.code RUN_INCOMPLETE) still carrying the data of the clear, with a
  TREE_CLEANUP_INCOMPLETE warning naming where the moved-aside tree is, so you
  can remove it yourself.

Output:
  A YAML report on stdout (status ok, or error); its data holds:
  - locations: one entry per location, cache root first, each with
    cacheDir (absolute path targeted), existed, removed (top-level entries
    now gone), entriesRemoved and bytesRemoved
  - entriesRemoved / bytesRemoved: totals across both locations

Exit Codes:
  0 - Caches cleared (or already absent)
  2 - USAGE_INVALID: the cache root is not recognisably VAT's (nothing
      deleted); or RUN_INCOMPLETE: a cache could not be examined, listed,
      measured or moved off its path, or a moved-aside tree could not then be
      deleted (a warning names it). The document's error says which

Example:
  $ vat cache clear                    # Reclaim every VAT cache
`
    );

  cache
    .command('prune')
    .description('Delete every cache entry this VAT build does not use')
    .option('--dry-run', 'Report what would be removed without deleting anything', false)
    .action(async function (this: Command) {
      await cachePruneCommand(this.optsWithGlobals() as CachePruneOptions);
    })
    .addHelpText(
      'after',
      `
Description:
  Keeps this build's warm cache and drops everything else VAT wrote. Under
  the cache root (VAT_CACHE_DIR, else <tmpdir>/.vat-cache) it removes every
  namespace except this version's (older AND newer releases, prereleases
  included, so they run cold next time; every checkout and install of this
  version shares its namespace and keeps it),
  what older releases kept at the root (the
  link-cache files and the root-level parse/ directory), and inside this
  build's namespace every projection-<shape> store except the current
  shape's. Only names VAT recognises as its own are removed: anything else in
  the directory, and the root's CACHEDIR.TAG, stay. An entry holding a
  projection store a running VAT has open (another worktree's or release's)
  is left and listed under inUse; a later prune removes it. The link cache is
  not touched.

  Run it after restoring a CI cache and before saving it, so the saved cache
  stops growing with every release.

${GUARD_HELP}

Output:
  A YAML report on stdout (status ok, or error); its data holds:
  - cacheDir: the cache root pruned
  - namespace / keptStore: what was kept
  - dryRun: true when nothing was deleted
  - removed: entries removed (or that would be), relative to the root
  - inUse: entries left because a running VAT has a store in them open
  - entriesRemoved / bytesRemoved: file count and total size

Exit Codes:
  0 - Pruned (or nothing to prune)
  2 - USAGE_INVALID: the cache root is not recognisably VAT's (nothing
      deleted); or RUN_INCOMPLETE: an entry could not be listed, measured or
      moved aside, or a moved-aside entry could not then be deleted (a
      warning names it)

Example:
  $ vat cache prune --dry-run          # What a prune would reclaim
  $ vat cache prune                    # Reclaim it
`
    );

  return cache;
}
