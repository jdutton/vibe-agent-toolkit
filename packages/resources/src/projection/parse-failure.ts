/**
 * The one spelling of a `BLOB_PARSE_FAILED` row's message, its one reader, and the one spelling
 * of the failures the population warning's parse-failed clause names
 * (`3 parse failed [ERR_WORKER_OUT_OF_MEMORY, "Unexpected token (3:1)"]`).
 *
 * The writer (`blob-population.ts`) and the reader (`blob-refusals.ts`) live here together so the
 * marker the reader looks for cannot drift from the text the writer emits — the round trip is
 * pinned by `blob-refusals.test.ts`. None of it is on the package barrel.
 */

import { compareCodeUnits } from '@vibe-agent-toolkit/utils';

import type { ParserKind } from '../content-key.js';

/** What a failed parse threw: an error's `code`, or the message of an error that has none. */
interface ParseFailure {
  readonly kind: 'code' | 'message';
  /** The code, or the message on one line with its whitespace collapsed. */
  readonly text: string;
}

/** The shape of a code the clause prints bare. Anything else is said as a quoted message. */
const PARSE_FAILURE_CODE_SHAPE = /^[A-Za-z_][\w.-]*$/;

/** How many messages the clause names before it counts the rest. Every code is named. */
const MESSAGES_NAMED = 3;

/** What precedes the failure in every parse-failed message. */
const THREW_MARKER = ' parser threw on these bytes (';

/** How the failure is introduced: an error's `code`, or — with none — its message. */
const CODE_PREFIX = 'code ';
const MESSAGE_PREFIX = 'message ';

/** A message on one line: every run of whitespace one space. */
function oneLine(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim();
}

/**
 * What `error` names, in a form a projection row may carry — never `String(error)`, whose
 * `fs` message embeds an absolute path (see `error-label.ts`).
 */
function failureOf(error: unknown): ParseFailure {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = String((error as { code: unknown }).code);
    // Only an identifier-shaped code is printed bare; anything else is said as the text it is.
    if (PARSE_FAILURE_CODE_SHAPE.test(code)) return { kind: 'code', text: code };
    return { kind: 'message', text: oneLine(`code ${code}`) };
  }
  return { kind: 'message', text: oneLine(error instanceof Error ? error.message : 'unknown error') };
}

/**
 * A `BLOB_PARSE_FAILED` row's message.
 *
 * @param parserKind - The parser that threw
 * @param error - What it threw
 * @returns `The <kind> parser threw on these bytes (code <code>)`, or `(message <message>)`
 */
export function parseFailedMessage(parserKind: ParserKind, error: unknown): string {
  const failure = failureOf(error);
  return `The ${parserKind}${THREW_MARKER}${failure.kind === 'code' ? CODE_PREFIX : MESSAGE_PREFIX}${failure.text})`;
}

/**
 * The failure a {@link parseFailedMessage} carries. Unambiguous: the marker's FIRST occurrence
 * ends the parser kind (which never holds it), the prefix says code or message, and the rest up
 * to the final `)` is the text — whatever a message itself contains.
 *
 * @param message - A `BLOB_PARSE_FAILED` row's message
 * @returns The failure, or undefined when the message is not one this module wrote
 */
export function parseFailureOf(message: string): ParseFailure | undefined {
  const at = message.indexOf(THREW_MARKER);
  if (at === -1 || !message.endsWith(')')) return undefined;
  const body = message.slice(at + THREW_MARKER.length, -1);
  if (body.startsWith(CODE_PREFIX)) return { kind: 'code', text: body.slice(CODE_PREFIX.length) };
  if (body.startsWith(MESSAGE_PREFIX)) return { kind: 'message', text: body.slice(MESSAGE_PREFIX.length) };
  return undefined;
}

/**
 * The failures as the parse-failed clause names them, on one line: every distinct code bare, in
 * code-unit order, then the distinct messages quoted, the first three and a count of the rest.
 * Codes come first and are never cut, so a code always survives the cap.
 *
 * @param failures - What each failed parse threw
 * @returns `ERR_A, ERR_B, "m1", "m2", "m3", +2 more`, or `''` when there are none
 */
export function formatParseFailures(failures: readonly ParseFailure[]): string {
  const distinct = (kind: ParseFailure['kind']): string[] =>
    [...new Set(failures.filter((failure) => failure.kind === kind).map((failure) => failure.text))].sort(compareCodeUnits);
  const messages = distinct('message');
  const rest = messages.length - MESSAGES_NAMED;
  return [
    ...distinct('code'),
    ...messages.slice(0, MESSAGES_NAMED).map((text) => JSON.stringify(text)),
    ...(rest > 0 ? [`+${rest.toString()} more`] : []),
  ].join(', ');
}
