/**
 * The shared `[path]` scope guard for the skills commands that take one.
 *
 * `vat skills validate` and `vat skills build` both accept `[path]` meaning
 * "read the config in THIS directory". Neither checked that the directory
 * existed or held one, so a mistyped path silently rescoped the run to NOTHING
 * and still exited 0 — a green tick for a scan that never happened. The two
 * commands print different words while doing it (`nothing to validate` vs
 * `nothing to build`), which is the only thing that varies between them.
 *
 * One implementation, parameterised by those words. Fixing this for one command
 * and copying it into the other is how the pair drifts.
 */

import { existsSync, statSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';

/** The name `loadConfig` looks for in the directory these commands are pointed at. */
export const CONFIG_FILENAME = 'vibe-agent-toolkit.config.yaml';

/** The per-command words in an otherwise identical refusal. */
export interface SkillsScopeSubject {
  /** How the command is spelled to the operator, e.g. `vat skills build`. */
  command: string;
  /**
   * The SHORT phrase the mis-scoped run used to sign off with, quoted back as
   * evidence — `nothing to build`, not the whole banner it appeared in.
   *
   * Deliberately not the full line. The full banner is what a test asserts is
   * ABSENT from a refusal, to tell "the guard fired" apart from "the run
   * reported nothing to do and the exit stub turned its 0 into a 2". Quoting
   * the banner verbatim here would put it in both answers and retire that
   * discriminator — the only observable that can see this bug at all.
   */
  silentSuccess: string;
}

/**
 * Why the path the operator typed cannot scope this run — or `undefined` when it
 * can.
 *
 * Only an EXPLICIT argument is judged. With no argument the command means "the
 * current directory", and a cwd that happens to hold no config is the documented
 * nothing-to-do case, not a mis-scoped run.
 *
 * `VAT_TEST_CONFIG` is honoured for the same reason `loadConfig` honours it: when
 * it is set, the config does not come from the named directory at all, so
 * demanding one there would reject a scope that is in fact resolvable.
 *
 * Pure — returns the message instead of writing it, so both answers are
 * assertable without capturing a stream.
 */
export function unscopableSkillsPath(pathArg: string | undefined): string | undefined {
  if (pathArg === undefined) return undefined;

  const resolved = safePath.resolve(pathArg);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a CLI argument is the subject of this check
  if (!existsSync(resolved)) return 'no such directory';
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- ditto; existence was just established
  if (!statSync(resolved).isDirectory()) return 'not a directory';

  if (process.env['VAT_TEST_CONFIG'] !== undefined) return undefined;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- ditto
  if (!existsSync(safePath.join(resolved, CONFIG_FILENAME))) {
    return `no ${CONFIG_FILENAME} there`;
  }
  return undefined;
}

/**
 * The refusal text, as a string.
 *
 * Separate from the writing and the exiting so a test can assert what the
 * operator is told without capturing a stream or trapping `process.exit`.
 */
export function unscopablePathMessage(
  subject: SkillsScopeSubject,
  pathArg: string,
  reason: string,
): string {
  const { command, silentSuccess } = subject;
  return (
    `error: '${command}' cannot scope to '${pathArg}' (${reason}).\n` +
    `\n` +
    `  '${command} <path>' reads the ${CONFIG_FILENAME} in the directory it is\n` +
    `  pointed at. This argument used to be accepted and the run silently\n` +
    `  rescoped to NOTHING: it printed "${silentSuccess}" and exited 0, so an\n` +
    `  operator who mistyped a path got a green tick for a run that never\n` +
    `  happened.\n` +
    `\n` +
    `  Fix: point '${command}' at a directory holding a ${CONFIG_FILENAME},\n` +
    `  or run it with no argument to use the current directory.\n` +
    `  To inspect ONE skill or bundle by path, use: vat skill review <path>\n`
  );
}

/**
 * Refuse to run when the operator scoped the command at something it cannot
 * read a config from.
 *
 * Exit 2, matching `rejectPositionalArguments`: exit 1 on these commands is
 * documented as "errors found", and reporting a usage error as 1 tells a CI gate
 * the project's skills are broken when nothing was inspected.
 */
export function rejectUnscopablePath(
  subject: SkillsScopeSubject,
  pathArg: string | undefined,
): void {
  const reason = unscopableSkillsPath(pathArg);
  if (reason === undefined) return;

  process.stderr.write(unscopablePathMessage(subject, String(pathArg), reason));
  process.exit(2);
}
