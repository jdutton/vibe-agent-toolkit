/**
 * Rejection of positional arguments on commands that take none.
 *
 * Shared by the config-driven top-level orchestrators (`vat build`,
 * `vat verify`, `vat validate`), which operate on the whole project as the
 * config describes it and have no path-shaped subject at all.
 */

import { CommandRefusalError } from '../utils/command-refusal.js';

/**
 * Fail the run when a caller passed a positional argument to a command that
 * takes none, naming the argument and where to take it instead.
 *
 * **Why this is not `.allowExcessArguments(false)`.** That is the Commander
 * mechanism for the same rejection and it would work, but its message is
 * `error: too many arguments for 'verify'. Expected 0 arguments but got 1.` —
 * which tells the reader the argument was wrong without telling them what the
 * command DOES operate on or where a path is accepted, so the next move is a
 * guess. The whole point of this fix is diagnosability, so the message is
 * written by hand and this rejection runs first in the action instead.
 *
 * ⚠️ Every other command DOES get `.allowExcessArguments(false)`, from
 * `applyCommandTreePolicy` (`command-tree.ts`), which would reject the operand
 * before this action ever ran. A caller of this function must therefore build
 * its command through `marksOperandRefusalByHand` to keep its operands.
 *
 * **Why a refusal (`USAGE_INVALID`, exit 2), not Commander's usage-error 1.**
 * Exit 1 is "findings". A usage error reported as 1 tells a CI gate the
 * project's artifacts are broken when in fact nothing was inspected. The
 * orchestrator's catch publishes the refusal as its document.
 *
 * @param operands - The command's parsed positional operands (`command.args`).
 * @param command - Command name for the message, e.g. `vat verify`.
 * @param operatesOn - One clause completing "<command> …", saying what the
 *   command actually runs against, so the reader learns why a path is
 *   meaningless rather than merely that it was refused.
 * @throws CommandRefusalError `USAGE_INVALID` when any operand was passed
 */
export function rejectPositionalArguments(
  operands: readonly string[],
  command: string,
  operatesOn: string,
): void {
  if (operands.length === 0) return;

  const listed = operands.map((operand) => `'${operand}'`).join(', ');

  throw new CommandRefusalError(
    'USAGE_INVALID',
    `error: '${command}' does not take a path argument (got: ${listed}).\n` +
      `\n` +
      `  '${command}' ${operatesOn}, so there is nothing for a path to scope.\n` +
      `  The argument used to be accepted and silently DISCARDED: the run went\n` +
      `  wide over the whole project and still reported success, so an operator\n` +
      `  who believed they had scoped the scan got a green tick for a scan that\n` +
      `  never happened.\n` +
      `\n` +
      `  Fix: run '${command}' with no arguments, and scope it in\n` +
      `  vibe-agent-toolkit.config.yaml.\n` +
      `  To inspect ONE skill or bundle by path, use: vat skill review <path>`,
  );
}
