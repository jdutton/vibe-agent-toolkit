/**
 * The exit code a commander ending takes — the one ending of a `vat` run that
 * happens before any verb's writer exists.
 */

import { ExitCode, type ExitCodeValue } from '@vibe-agent-toolkit/schema';

/**
 * Map a commander termination to the exit code VAT's contract promises.
 *
 * A USAGE mistake — a flag this program does not declare, a verb it does not
 * know, a missing or invalid argument — ends on `ExitCode.ERROR`, and the
 * reason is not style. Commander's default for a usage mistake is
 * `process.exit(1)`, so `vat resources check --json` (the option is
 * `--format json`) exited **1** — which, read against the contract the command
 * itself prints, asserts that at least one check was violated. Nothing had
 * run. A CI wrapper spelled `if [ $? -ne 0 ]; then report_findings` therefore
 * reported findings that were never computed. The same hole swallowed a
 * mistyped verb (`vat resources chekc`) and every unknown option on every
 * command.
 *
 * Commander reports BOTH successful and failing terminations through the same
 * `CommanderError`: `--help` and `--version` carry `exitCode` 0, while an
 * unknown option, an unknown command and `help({ error: true })` carry non-zero.
 * Anything non-zero is a usage mistake by construction — commander raises these
 * only while parsing, before any action runs — so it maps to `ERROR`.
 *
 * ⚠️ **Help and `--version` are NOT usage mistakes.** They terminate through
 * the same `_exit` path with code 0 and must stay `OK`; only a non-zero
 * commander ending is remapped.
 *
 * 🪤 Do NOT switch on `error.code` (`commander.unknownOption`, `commander.help`,
 * …). The unknown-COMMAND path arrives as `commander.help` with exitCode 1,
 * because the `command:*` handler renders help with `{ error: true }` — so the
 * code string says "help" for a case that is emphatically not one. The exit
 * code commander already computed is the honest discriminator; the string is not.
 *
 * @param commanderExitCode - The `exitCode` commander put on its CommanderError
 * @returns `OK` for a successful ending, `ERROR` otherwise
 */
export function exitCodeForCommanderEnding(commanderExitCode: number): ExitCodeValue {
  return commanderExitCode === 0 ? ExitCode.OK : ExitCode.ERROR;
}
