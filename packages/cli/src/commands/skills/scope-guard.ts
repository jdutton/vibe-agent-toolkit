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
 * One judgement, parameterised by those words. Fixing this for one command
 * and copying it into the other is how the pair drifts. How each command ENDS
 * on it is its own: `skills validate` throws the coded refusal into its report
 * lane ({@link assertScopableSkillsPath}); `skills build`, still a legacy
 * document, publishes its failure document from the same reason.
 */

import { existsSync } from 'node:fs';

import type { RefusalCode } from '@vibe-agent-toolkit/schema';
import { safePath } from '@vibe-agent-toolkit/utils';

import { CommandRefusalError } from '../../utils/command-refusal.js';
import { readableDirectoryRefusal } from '../../utils/project-root-policy.js';

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

/** Why a typed path cannot scope the run, and which refusal that is. */
interface ScopeRefusal {
  /** `USAGE_INVALID` for a path naming no usable directory; `INPUT_UNREADABLE` for one the OS refuses. */
  refusal: RefusalCode;
  /** The reason, quoted into {@link unscopablePathMessage}. */
  reason: string;
}

/**
 * Why the path the operator typed cannot scope this run — or `undefined` when it
 * can.
 *
 * Only an EXPLICIT argument is judged. With no argument the command means "the
 * current directory".
 *
 * A directory the OS will not let the process read is the INPUT's refusal
 * (`INPUT_UNREADABLE`), never "holds no config": the config may well be there.
 *
 * `VAT_TEST_CONFIG` is honoured for the same reason `loadConfig` honours it: when
 * it is set, the config does not come from the named directory at all, so
 * demanding one there would reject a scope that is in fact resolvable.
 *
 * Pure of output — returns the refusal instead of writing it, so every answer
 * is assertable without capturing a stream.
 */
export function unscopableSkillsPath(pathArg: string | undefined): ScopeRefusal | undefined {
  if (pathArg === undefined) return undefined;

  const resolved = safePath.resolve(pathArg);
  // The one directory judgement every path-taking verb shares.
  const refusal = readableDirectoryRefusal(resolved);
  if (refusal !== undefined) return { refusal: refusal.refusal, reason: refusal.message };

  if (process.env['VAT_TEST_CONFIG'] !== undefined) return undefined;
  if (!existsSync(safePath.join(resolved, CONFIG_FILENAME))) {
    return { refusal: 'USAGE_INVALID', reason: `no ${CONFIG_FILENAME} there` };
  }
  return undefined;
}

/**
 * The refusal text, as a string.
 *
 * Separate from the ending so a test can assert what the operator is told
 * without capturing a stream or trapping `process.exit`.
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
 * Refuse, by code, a run the operator scoped at something it cannot read a
 * config from — thrown into the caller's report lane, which publishes it as
 * the envelope's error branch (exit 2). Exit 1 on these commands means
 * "errors found", and reporting a usage mistake as 1 tells a CI gate the
 * project's skills are broken when nothing was inspected.
 *
 * @throws {CommandRefusalError} `USAGE_INVALID` or `INPUT_UNREADABLE` — see {@link unscopableSkillsPath}
 */
export function assertScopableSkillsPath(subject: SkillsScopeSubject, pathArg: string | undefined): void {
  const refusal = unscopableSkillsPath(pathArg);
  if (refusal === undefined) return;
  throw new CommandRefusalError(refusal.refusal, unscopablePathMessage(subject, String(pathArg), refusal.reason).trimEnd());
}
