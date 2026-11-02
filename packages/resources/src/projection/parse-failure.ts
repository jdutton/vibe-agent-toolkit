/**
 * The one spelling of a `BLOB_PARSE_FAILED` row's message, and its one reader.
 *
 * The writer (`blob-population.ts`) and the reader (`blob-refusals.ts`, which
 * names what each parse threw in the population line) live here together so the
 * marker the reader looks for cannot drift from the text the writer emits — the
 * round trip is pinned by `blob-refusals.test.ts`.
 */

import type { ParserKind } from '../content-key.js';

import { errorLabel } from './error-label.js';

/** What precedes the failure label in every parse-failed message. */
const THREW_MARKER = ' parser threw on these bytes (';

/**
 * A `BLOB_PARSE_FAILED` row's message.
 *
 * @param parserKind - The parser that threw
 * @param error - What it threw
 * @returns `The <kind> parser threw on these bytes (<code or message>)`
 */
export function parseFailedMessage(parserKind: ParserKind, error: unknown): string {
  return `The ${parserKind}${THREW_MARKER}${errorLabel(error)})`;
}

/**
 * The failure label a {@link parseFailedMessage} carries — an error's `code`
 * (`ERR_WORKER_OUT_OF_MEMORY`) or its message.
 *
 * @param message - A `BLOB_PARSE_FAILED` row's message
 * @returns The label, or undefined when the message is not one this module wrote
 */
export function parseFailureLabelOf(message: string): string | undefined {
  const at = message.indexOf(THREW_MARKER);
  if (at === -1 || !message.endsWith(')')) return undefined;
  return message.slice(at + THREW_MARKER.length, -1);
}
