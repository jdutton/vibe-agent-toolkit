/**
 * Cache command group, plus the root-level `--no-cache` control surface.
 *
 * Both live here so the flag and the command that cleans up after it stay in one
 * place: `--no-cache` decides whether this run *writes* to the caches, `vat cache
 * clear` decides whether the caches *survive*.
 */

import { Command } from 'commander';

import { cacheClearCommand, type CacheClearOptions } from './clear.js';

/**
 * Root options this module reads. Commander represents `--no-cache` as the
 * POSITIVE key `cache` — `true` by default, `false` only when the negated flag
 * is passed. It NEVER produces `noCache`; reading that key is the exact bug that
 * made three flags in this package silent no-ops (see
 * `test/commands/commander-option-keys.test.ts`).
 */
export interface CacheControlOptions {
  cache?: boolean;
}

/**
 * Register the root-level `--no-cache` flag and the hook that gives it effect.
 *
 * ## Why this sets an environment variable instead of plumbing a flag
 *
 * `vat validate`, `vat verify` and `vat build` enumerate nothing in their own
 * process: each `spawnSync`s the vat binary once per phase, and the child is
 * what parses the corpus. A flag parsed in the parent therefore never reaches
 * the process whose caching it is supposed to control, whereas `process.env` is
 * inherited by every child for free. `bin.ts` already leans on exactly that for
 * `VAT_CONTEXT` / `VAT_CONTEXT_PATH`.
 *
 * `VAT_CACHE=0` is read by `ParseCache` (packages/resources/src/parse-cache.ts)
 * per construction, never at module load, so setting it from a `preAction` hook
 * — after Commander has parsed, before any command body runs — is observed.
 *
 * ## The collision with `vat resources validate --no-cache`
 *
 * This root program does NOT use `enablePositionalOptions()`, so Commander scans
 * the WHOLE argv for root options, including everything after the subcommand
 * name. That is the same mechanism that let a root `-v` shadow the subcommands'
 * own `-v, --verbose` (see the incident recorded in `bin.ts`). Measured against
 * commander 12: `vat resources validate docs --no-cache` leaves the ROOT with
 * `cache: false` and the SUBCOMMAND with `cache: true` — the subcommand's
 * identically-named flag is swallowed before it ever sees it, which would have
 * silently re-enabled the external-URL cache the flag exists to bypass.
 *
 * Rather than break a shipped flag, the hook hands the value back down to
 * whichever action command declares a `cache` option of its own. `--no-cache` is
 * a superset — every cache off — so the handoff is a strengthening, never a
 * reversal.
 *
 * @param program - The root program to register the flag and hook on
 */
export function registerCacheControl(program: Command): void {
  program.option('--no-cache', "Disable VAT's disk caches for this run (also applies to spawned phases)");

  program.hook('preAction', (_thisCommand, actionCommand) => {
    applyCacheControl(program.opts<CacheControlOptions>(), actionCommand);
  });
}

/**
 * Apply the root `--no-cache` decision: export it to child processes, and hand
 * it down to an action command that declares its own `cache` option.
 *
 * Exported so a test can drive it from real parsed options rather than from a
 * hand-built bag. Deliberately does nothing when the flag was not passed — a
 * toggle that writes `VAT_CACHE=1` by default would be indistinguishable from
 * one that is always on.
 *
 * @param rootOptions - Options bag from the ROOT program
 * @param actionCommand - The command whose action is about to run
 */
export function applyCacheControl(rootOptions: CacheControlOptions, actionCommand: Command): void {
  if (rootOptions.cache !== false) return;

  process.env['VAT_CACHE'] = '0';

  // `attributeName()`, not `name()`: for `--no-cache` the latter returns
  // 'no-cache', so a check written against it never matches and the handoff
  // above becomes a no-op that looks like it works.
  if (actionCommand.options.some((option) => option.attributeName() === 'cache')) {
    actionCommand.setOptionValue('cache', false);
  }
}

export function createCacheCommand(): Command {
  const cache = new Command('cache');

  cache
    .description("Manage VAT's shared on-disk caches in the system temp directory")
    .helpCommand(false)
    .addHelpText(
      'after',
      `
Description:
  VAT keeps three disposable caches under <tmpdir>/.vat-cache: parse facts
  keyed by file content, external-URL validation results, and per-OS-user
  authenticated-link content. None of them is durable — recovery is always
  "rescan", and the OS temp purge is the eviction policy.

  To run WITHOUT the caches rather than remove them, use --no-cache on any
  command (or VAT_CACHE=0), which also applies to spawned phases.

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
  external-URL validation cache, and the per-OS-user authenticated-link cache.
  Every one of them is disposable by design: the next run repopulates what it
  needs, so the only cost of clearing is one cold pass.

  Runs regardless of --no-cache / VAT_CACHE=0. Turning caching off must not
  disarm the one command that reclaims the space.

  A cache directory that does not exist is not an error — nothing to remove is
  a successful clear.

Output:
  - cacheDir: absolute path that was targeted
  - existed: whether the directory was there at all
  - removed: top-level entries that were deleted
  - entriesRemoved / bytesRemoved: file count and total size, measured before
    deletion

Exit Codes:
  0 - Cache cleared (or already absent)
  2 - Could not remove the cache (permissions, busy file)

Example:
  $ vat cache clear                    # Reclaim the temp-directory cache tree
`
    );

  return cache;
}
