/**
 * Cache command group.
 *
 * The paired `--no-cache` control surface lives in `./cache-control.js` and is
 * re-exported here, so the two stay findable together: `--no-cache` decides
 * whether this run *writes* to the caches, `vat cache clear` decides whether the
 * caches *survive*. They are separate modules only because `bin.ts` registers
 * the flag on every invocation and must not pay for this command's imports to
 * do it.
 */

import { Command } from 'commander';

import { cacheClearCommand, type CacheClearOptions } from './clear.js';

export { applyCacheControl, registerCacheControl, type CacheControlOptions } from './cache-control.js';


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
  holding one whole scanned tree per entry, and by far the largest of the
  four. None of them is durable — recovery is always "rescan".

  Only the projection store evicts anything on its own: it keeps the few most
  recently written trees per root and drops the rest as it writes. The other
  three rely on the OS temp purge, and every one of them is reclaimed in full
  by vat cache clear.

  To run WITHOUT the caches rather than remove them, use --no-cache on any
  command (or VAT_CACHE=0), which also applies to spawned phases and to the
  projection store.

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
  usually most of the bytes this reclaims. Every one of them is disposable by
  design: the next run repopulates what it needs, so the only cost of clearing
  is one cold pass.

  Runs regardless of --no-cache / VAT_CACHE=0. Turning caching off must not
  disarm the one command that reclaims the space.

  A cache directory that does not exist is not an error — nothing to remove is
  a successful clear.

  The tree is shared by every VAT on the machine, so another run writing into
  it can make the delete stop part-way. That is reported as status: partial,
  naming what went and what stayed, rather than failing with no account of it.

Output:
  - cacheDir: absolute path that was targeted
  - existed: whether the directory was there at all
  - removed: top-level entries that are now gone
  - remaining / reason: what survived a partial clear, and why (partial only)
  - entriesRemoved / bytesRemoved: file count and total size actually removed

Exit Codes:
  0 - Cache cleared (or already absent)
  1 - Cleared only in part, because something else is using the tree
  2 - Could not read or target the cache at all (permissions, unexpected layout)

Example:
  $ vat cache clear                    # Reclaim the temp-directory cache tree
`
    );

  return cache;
}
