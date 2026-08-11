/**
 * Rejection of positional arguments on commands that take none.
 *
 * Shared by the config-driven top-level orchestrators (`vat verify`,
 * `vat validate`), which operate on the whole project as the config describes
 * it and have no path-shaped subject at all.
 */

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
 * **Why exit 2, not Commander's usage-error 1.** On both of these commands exit
 * 1 is documented as "validation errors found". A usage error reported as 1
 * tells a CI gate the project's artifacts are broken when in fact nothing was
 * inspected — a different wrong answer to the same question, not a fix. Exit 2
 * is this repo's "the run could not tell you anything about your artifacts",
 * which is exactly true here. (It therefore diverges from `rejectRetiredOnly`,
 * which chose 1 to keep a pre-existing failing CI gate failing; there is no
 * such continuity to preserve for an argument that used to be *accepted*.)
 *
 * @param operands - The command's parsed positional operands (`command.args`).
 * @param command - Command name for the message, e.g. `vat verify`.
 * @param operatesOn - One clause completing "<command> …", saying what the
 *   command actually runs against, so the reader learns why a path is
 *   meaningless rather than merely that it was refused.
 */
export function rejectPositionalArguments(
  operands: readonly string[],
  command: string,
  operatesOn: string,
): void {
  if (operands.length === 0) return;

  const listed = operands.map((operand) => `'${operand}'`).join(', ');

  process.stderr.write(
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
      `  To inspect ONE skill or bundle by path, use: vat skill review <path>\n`,
  );
  process.exit(2);
}
