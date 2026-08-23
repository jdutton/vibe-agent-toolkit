/**
 * The root-level `--no-cache` control surface, kept apart from the `cache`
 * command itself.
 *
 * `bin.ts` must call {@link registerCacheControl} on every single invocation,
 * before parsing. Co-locating it with `createCacheCommand` in `index.ts` meant
 * that unavoidable call dragged in `./clear.js` and, behind it, the whole
 * resources package — measured at ~1.2s of module load on Windows, paid even by
 * `vat --version`. This module imports nothing but commander, so the always-on
 * path stays cheap — keep it that way: any import added here is paid by every
 * `vat` invocation, and `index.ts` deliberately does not re-export it, so
 * reaching these functions through the command group cannot happen by accident.
 */

import type { Command } from 'commander';

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
