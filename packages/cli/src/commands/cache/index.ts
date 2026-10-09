/**
 * Cache command group.
 *
 * The paired `--no-cache` control surface lives in `./cache-control.js`:
 * `--no-cache` decides whether this run *writes* to the caches, `vat cache
 * clear` decides whether the caches *survive*. They are separate modules only
 * because `bin.ts` registers the flag on every invocation and must not pay for
 * this command's imports to do it.
 *
 * ⛔ Do NOT re-export `cache-control.js` from here for convenience. Importing it
 * through this module pulls `./clear.js` and the whole resources package behind
 * it — the exact ~1.2s that splitting the file removed — so a re-export leaves
 * the expensive path one identical-looking import away, with nothing pinning
 * the cheap one. Import from `./cache-control.js` directly.
 */

import { Command } from 'commander';

import { cacheClearCommand, type CacheClearOptions } from './clear.js';


export function createCacheCommand(): Command {
  const cache = new Command('cache');

  cache
    .description("Manage VAT's shared on-disk caches in the system temp directory")
    .helpCommand(false)
    .addHelpText(
      'after',
      `
Description:
  VAT keeps four disposable caches under <tmpdir>/.vat-cache: parse facts
  keyed by file content, external-URL validation results, per-OS-user
  authenticated-link content, and the projection store — a SQLite database
  holding one whole scanned tree per entry, on by default, and by far the
  largest of the four. None of them is durable — recovery is always "rescan".

  How large: one 12,602-file repository measured 71 MB of projection store,
  and the file holds several trees per repository plus a shared blob tier, so
  a machine that has scanned a few projects reaches the hundreds of MB. The
  other three tenants are a few MB between them.

  Only the projection store evicts anything on its own: it keeps the three
  most recently written trees per root and the 50,000 most recently written
  content keys, dropping the rest as it writes. The other three rely on the OS
  temp purge, and every one of them is reclaimed in full by vat cache clear.

  To run WITHOUT the caches rather than remove them, use --no-cache on any
  command (or VAT_CACHE=0), which also applies to spawned phases and to the
  projection store. VAT_PROJECTION_STORE=off turns off just the store.

Example:
  $ vat cache clear                    # Reclaim the temp-directory cache tree
`
    );

  cache
    .command('clear')
    .description('Delete the whole VAT cache tree from the system temp directory')
    .action(async function (this: Command) {
      await cacheClearCommand(this.optsWithGlobals() as CacheClearOptions);
    })
    .addHelpText(
      'after',
      `
Description:
  Removes <tmpdir>/.vat-cache in its entirety — the parse cache, the
  external-URL validation cache, the per-OS-user authenticated-link cache, and
  the projection store (<namespace>/projection-<shape>/projection.db), which is
  usually most of the bytes this reclaims: 71 MB for a single 12,602-file
  repository, and the hundreds of MB once a machine has scanned several. Every
  one of them is disposable by design: the next run repopulates what it needs,
  so the only cost of clearing is one cold pass.

  A projection store relocated with VAT_PROJECTION_STORE_DIR lives outside
  this tree and is not removed — delete that directory yourself.

  Runs regardless of --no-cache / VAT_CACHE=0. Turning caching off must not
  disarm the one command that reclaims the space.

  A cache directory that does not exist is not an error — nothing to remove is
  a successful clear.

  The tree is moved off its path whole, then removed: a delete the OS stops
  (another VAT writing into the shared tree, a file it will not remove) leaves
  no part of a cache at <tmpdir>/.vat-cache. That is the report's error branch
  (error.code RUN_INCOMPLETE) still carrying the data of the clear, with a
  TREE_CLEANUP_INCOMPLETE warning naming where the moved-aside tree is, so you
  can remove it yourself.

Output:
  A YAML report on stdout (status ok, or error); its data holds:
  - cacheDir: absolute path that was targeted
  - existed: whether the directory was there at all
  - removed: top-level entries that are now gone
  - entriesRemoved / bytesRemoved: file count and total size removed

Exit Codes:
  0 - Cache cleared (or already absent)
  2 - RUN_INCOMPLETE: the cache could not be examined, listed, measured or
      moved off its path (nothing cleared, data null), or the moved-aside tree
      could not then be deleted (cleared, data present, a warning naming it).
      The cache is VAT's own scratch, so a refusal there is the run not
      finishing; the document's error says which

Example:
  $ vat cache clear                    # Reclaim the temp-directory cache tree
`
    );

  return cache;
}
