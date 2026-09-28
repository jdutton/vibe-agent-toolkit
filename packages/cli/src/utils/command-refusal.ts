/**
 * Which REFUSAL a thrown value is — the one place a command's catch learns
 * whether the run failed on the invocation, the project, the environment, or
 * a defect in VAT.
 *
 * 🔑 **Dispatch on a code, never on a message.** A user's mistake is thrown as
 * a {@link CommandRefusalError} carrying its refusal code, or as a library
 * `VatError` whose `code` is mapped below; an unreadable input is coded
 * `INPUT_UNREADABLE` at the site that reads it. Everything else — an uncoded
 * errno included — a `TypeError`, a resolver bug, an invariant a
 * driver broke — is `INTERNAL_ERROR`, published with its stack. A blanket
 * `catch` that relabels "anything thrown here" as the user's fault is exactly
 * what this module exists to make unnecessary: it would publish VAT's own
 * defects as usage mistakes.
 *
 * Kept apart from the document writer so a helper that only needs to REFUSE
 * (`project-root-policy.ts`, `check-supervisor.ts`) does not load the
 * published-shape registry to do it.
 */

import { CONFIG_LOAD_CODE } from '@vibe-agent-toolkit/resources';
import type { RefusalCode } from '@vibe-agent-toolkit/schema';
import { isVatError, VatError } from '@vibe-agent-toolkit/utils';

const COMMAND_REFUSAL = 'COMMAND_REFUSAL';

/**
 * The code a config that exists and could not be READ carries — the OS refused
 * it (permissions, a directory where the file should be). `config-loader.ts`'s
 * read of the adopter's own config is the one site that knows the errno is
 * about the user's input, so it throws this; the refusal is `INPUT_UNREADABLE`.
 */
export const CONFIG_UNREADABLE_CODE = 'CONFIG_UNREADABLE';

/** A refusal a command raises on purpose, carrying WHICH refusal. */
export class CommandRefusalError extends VatError {
  readonly refusal: RefusalCode;

  constructor(refusal: RefusalCode, message: string, options?: ErrorOptions) {
    super(COMMAND_REFUSAL, message, options);
    this.refusal = refusal;
  }
}

/** Library errors whose `code` already says which refusal they are. */
const REFUSAL_BY_ERROR_CODE: Readonly<Record<string, RefusalCode>> = {
  // A config file that exists and does not parse or validate (resources' parser and the CLI loader).
  [CONFIG_LOAD_CODE]: 'CONFIG_INVALID',
  // A config file that exists and the OS would not let VAT read.
  [CONFIG_UNREADABLE_CODE]: 'INPUT_UNREADABLE',
  // A bundle argument the project does not declare under `okf.bundles`.
  OKF_UNKNOWN_BUNDLE: 'USAGE_INVALID',
  // A directory the OS would not list, under a `refuse` policy.
  DIRECTORY_LISTING_REFUSED: 'INPUT_UNREADABLE',
};

/**
 * Which refusal a thrown value is.
 *
 * Read by brand and `code`, not by `instanceof`, for the reason `isVatError`
 * gives: a `dist` copy of the class never matches a `src` instance.
 *
 * @param error - What the command's catch received
 * @returns A {@link CommandRefusalError}'s own code; a mapped library code; otherwise
 *   `INTERNAL_ERROR`. ⛔ No errno walk: an uncoded errno is not known to be
 *   about the user's INPUT — an output write, a temp directory, VAT's own
 *   shipped asset — so it is a defect report, with its stack, until the site
 *   that reads user input codes it.
 */
export function refusalCodeOf(error: unknown): RefusalCode {
  if (isVatError(error, COMMAND_REFUSAL)) return (error as CommandRefusalError).refusal;
  if (isVatError(error) && Object.hasOwn(REFUSAL_BY_ERROR_CODE, error.code)) {
    return REFUSAL_BY_ERROR_CODE[error.code] ?? 'INTERNAL_ERROR';
  }
  return 'INTERNAL_ERROR';
}

/**
 * The human sentence a thrown value carries: an `Error`'s message, or the
 * value itself spelled out.
 *
 * @param error - Anything a catch received
 */
export function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
