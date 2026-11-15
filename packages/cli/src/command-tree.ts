/**
 * Parse policy every node of the `vat` command tree is held to.
 *
 * Kept free of runtime imports (commander is a type-only import) because
 * `bin.ts` loads it on every invocation, `vat --version` included.
 */

import type { Command } from 'commander';

/**
 * Commands whose action refuses positional operands itself, with a better
 * message than commander's — see `rejectPositionalArguments` in
 * `commands/positional-args.ts`. A WeakSet rather than a flag on the Command so
 * no Commander private field is read or written.
 */
const refusesOperandsByHand = new WeakSet<Command>();

/**
 * Mark a command whose action refuses positional operands by hand, so
 * {@link applyCommandTreePolicy} leaves its excess arguments for the action to
 * see in `command.args` instead of having commander reject them first.
 *
 * @param command - The command to exempt from commander's excess-argument check
 * @returns The same command, for chaining at its construction site
 */
export function marksOperandRefusalByHand(command: Command): Command {
  refusesOperandsByHand.add(command);
  return command;
}

/**
 * Apply VAT's parse policy to `command` and every command beneath it.
 *
 * 1. **`exitOverride()`, so EVERY command's usage errors reach VAT's exit-code
 *    contract** (`utils/commander-ending.ts`: a usage mistake ends exit 2).
 *
 *    🪤 **`exitOverride()` on the root alone reaches nothing.** Commander's
 *    `_exit` reads `this._exitCallback` off the command that actually errored
 *    and never walks up to a parent, and `addCommand()` — how every command
 *    here is registered — does NOT copy inherited settings (only the
 *    `.command()` factory does, at command.js:164). So the override has to be
 *    applied to each node.
 *
 * 2. **`allowExcessArguments(false)`, so an operand a verb never declared is a
 *    usage error instead of being silently DISCARDED.** Commander 12 defaults it
 *    to `true`: `vat audit skills does-not-exist` audited `skills`, never
 *    mentioned the second path and exited 0. Same per-node reason as above.
 *    Commands marked with {@link marksOperandRefusalByHand} are skipped — their
 *    action refuses operands with a diagnostic commander's message lacks.
 *
 * This must run AFTER the lazy dispatcher in `bin.ts` has added whichever
 * commands this invocation needs, and after `loadDoctor()`, or it walks a tree
 * that is still empty and the very commands being invoked keep commander's
 * defaults.
 *
 * @param command - The command whose subtree gets the policy
 */
export function applyCommandTreePolicy(command: Command): void {
  command.exitOverride();
  if (!refusesOperandsByHand.has(command)) command.allowExcessArguments(false);
  for (const sub of command.commands) applyCommandTreePolicy(sub);
}
