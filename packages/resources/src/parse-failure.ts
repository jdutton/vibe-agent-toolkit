/**
 * The one answer to "whose fault is this parse failure?" — for every lane that
 * wraps a read-and-parse of one file in a per-file `try`.
 *
 * ## An allowlist, never a blocklist
 *
 * Exactly three outcomes are facts about the file or the run, and nothing else
 * is:
 *
 * - `refused` — a per-run refusal ({@link isPerRunParseRefusal}): a limit
 *   breach or a dead worker. Never stored (ADR I6); re-attempted next run.
 * - `document` — the parser's own throw over the bytes, branded by the worker
 *   ({@link isParserThrewError}).
 * - `unreadable` — the OS refused to read the file itself, or it is too large
 *   to decode ({@link isReadFailure}).
 *
 * Everything else is VAT's fault — a broken install (`ParserUnavailableError`),
 * a decode defect (`ParseDecodeDefectError`), an unbranded worker failure, a
 * machine out of descriptors — and {@link classifyParseFailure} rethrows it
 * untouched. A lane that instead rethrew only `isParserUnavailable` and filed
 * everything else as a finding about the file blamed an innocent document for
 * every VAT defect but one, and could exit 0 over a run that parsed nothing. A
 * bare `isParserUnavailable(` guard in `src` is refused by
 * `packages/dev-tools/test/parse-failure-classifier.test.ts`.
 */

import { type FsFaultClass, fsFaultOf, isFsFaultError, isVatError } from '@vibe-agent-toolkit/utils';
import { TextTooLargeError } from '@vibe-agent-toolkit/utils/text';

import { isParserThrewError, isPerRunParseRefusal } from './parse-limits.js';

/**
 * The fault classes ({@link fsFaultOf}) that mean "this path could not be read",
 * as opposed to "VAT is broken".
 *
 * Deliberately an allow-list rather than a catch-all. Demoting every non-
 * duplicate error to a finding would silently convert a parser or indexing
 * defect into a per-file warning, and the corpus-wide symptom of that is a
 * quietly shrinking population — the exact failure mode this code exists to
 * make loud.
 *
 * `absent` is the dangling symlink and the file deleted between enumeration and
 * parse; `refused` a mode bit; `wrong-type` a symlink cycle, a name too long, a
 * path whose type changed underneath the crawl, or a pipe or device where a
 * file was expected. `exhausted` (descriptors, disk, quota) is deliberately NOT
 * here: it is the machine's fault, not the file's, so it throws classified and
 * refuses `RUN_INCOMPLETE` — a per-file finding could be downgraded by config to
 * exit 0 over a run that never read the file. A `device` fault (a hung mount,
 * failing hardware) is not something a finding about the file can describe
 * either.
 *
 * Being an allow-list is also what makes this boundary safe for the parser load:
 * a failed load arrives as `ParserUnavailableError`, a VAT error whose own code is
 * no errno ({@link readFault} never walks the `cause` chain), so it is never
 * demoted.
 */
const READ_FAILURE_CLASSES: ReadonlySet<FsFaultClass> = new Set(['absent', 'refused', 'wrong-type']);

/**
 * Whether an error is a filesystem read failure rather than a defect.
 *
 * The file past what one JS string can hold (`TEXT_TOO_LARGE`) is admitted too:
 * not an errno, refused by size before any read, but the consequence is the same
 * — the file is enumerated and cannot be admitted — and it reaches the finding as
 * its own code, so no reader goes looking for a permissions problem.
 *
 * @param error - The thrown value
 * @returns True when the error is a read failure the classifier recognizes
 */
export function isReadFailure(error: unknown): error is Error {
  if (!(error instanceof Error)) return false;
  if (isVatError(error, TextTooLargeError.code)) return true;
  const faultClass = readFault(error)?.faultClass;
  return faultClass !== undefined && READ_FAILURE_CLASSES.has(faultClass);
}

/**
 * The fault a read failure IS: a classified `FsFaultError`, or a raw errno on the
 * error itself. Deliberately not a walk of the `cause` chain: a coded error, or a
 * wrapper, that merely carries an errno underneath has already said what it
 * means, and demoting it to a per-file finding would hide that.
 */
function readFault(error: Error): { faultClass: FsFaultClass; errno: string } | undefined {
  if (isFsFaultError(error)) return { faultClass: error.faultClass, errno: error.errno };
  if (isVatError(error)) return undefined;
  // The classifier asked of the error itself (its syscall and path decide an unlisted or network
  // errno), and kept only when the errno it found is this error's own, never one down its cause chain.
  const facts = fsFaultOf(error);
  return facts !== undefined && facts.errno === (error as { code?: unknown }).code ? facts : undefined;
}

/**
 * The code a {@link isReadFailure} error is recorded under: its errno ({@link readFault}),
 * else its own code (`TEXT_TOO_LARGE`).
 */
export function readFailureCode(error: Error): string {
  return readFault(error)?.errno ?? (isVatError(error) ? error.code : 'UNKNOWN');
}

/** Whose a per-file parse failure is, when it is not VAT's — see the module comment. */
export type ParseFailureKind = 'refused' | 'document' | 'unreadable';

/**
 * Classify a per-file parse failure, or rethrow it when it is VAT's own.
 *
 * @param error - What a read-and-parse of one file threw
 * @returns `refused`, `document` or `unreadable` — see the module comment
 * @throws `error` itself, untouched, for anything else: a broken install, a
 *   decode defect, an unbranded failure — never a finding about the file
 */
export function classifyParseFailure(error: unknown): ParseFailureKind {
  if (isPerRunParseRefusal(error)) return 'refused';
  if (isParserThrewError(error)) return 'document';
  if (isReadFailure(error)) return 'unreadable';
  throw error;
}
