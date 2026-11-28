/**
 * The rules every `data` variant's rows are held to, written once: the JSON
 * extractor (`data-extractor.ts`), the YAML one (`data-yaml.ts`) and the
 * `.npmrc` one (`data-ini.ts`) all import them, so a line, a column, a
 * shadowed member or a lossy number means the same thing whichever parser read
 * the bytes.
 *
 * - **Positions.** Line and column are 1-based, the column in UTF-16 code
 *   units, over the one line index (`line-index.ts`).
 * - **Last occurrence wins.** Among an object's members with the same key,
 *   every earlier one is shadowed, and each one after the first raises one
 *   `DATA_DUPLICATE_KEY`.
 * - **Lossy numbers.** A number whose double does not hold its lexeme's exact
 *   value, or is not finite, raises `DATA_LOSSY_NUMBER`.
 * - **The caps.** The whole row set is held to the output caps by
 *   `factsOutputBreach`, the one rule every worker answer is held to.
 *
 * The placement (`placedMessage`) and the caps (`settleRows`) are shared with the `ts` extractor
 * (`ts-extractor.ts`), so a `ts` defect's position and a `ts` breach follow the same rules.
 *
 * No parser library is imported here: this module runs wherever its importers
 * do, and parses nothing.
 */

import { type factsOutputBreach, factsOutputVerdict, type OutputLimitName, type ParseLimits } from '../parse-limits.js';

import type {
  DataExtraction,
  ExtractedDataCondition,
  ExtractedDataNode,
  RowSetExtraction,
} from './data-extractor.js';
import { positionOf } from './line-index.js';

/**
 * @param what - What is wrong
 * @param offset - Where, as a UTF-16 offset into the text
 * @param starts - {@link lineStarts} of the text
 * @returns A defect's message: what, then its 1-based line and column
 */
export function placedMessage(what: string, offset: number, starts: readonly number[]): string {
  const { line, column } = positionOf(offset, starts);
  return `${what} at line ${String(line)}, column ${String(column)}`;
}

/** Where a key or string holds a lone surrogate. */
export interface LoneSurrogate {
  readonly inKey: boolean;
  readonly offset: number;
}

/**
 * @param lone - The first key or string holding a lone surrogate
 * @param starts - {@link lineStarts} of the text
 * @returns The document's `DATA_LONE_SURROGATE` defect, placed
 */
export function loneSurrogateDefect(lone: LoneSurrogate, starts: readonly number[]): DataExtraction {
  const what = lone.inKey ? 'A key' : 'A string';
  return { outcome: 'defect', code: 'DATA_LONE_SURROGATE', message: placedMessage(`${what} holds a lone UTF-16 surrogate`, lone.offset, starts) };
}

/** What an object decides about one member from its key alone. */
interface MemberOrder {
  /** A later sibling with the same key shadows it. */
  readonly shadowed: boolean;
  /** An earlier sibling had the same key: one `DATA_DUPLICATE_KEY` at this member. */
  readonly repeat: boolean;
}

/**
 * @param keys - An object's member keys, in document order
 * @returns For each member, whether a later one shadows it and whether it repeats an earlier one
 */
export function memberOrder(keys: readonly string[]): MemberOrder[] {
  const lastIndex = new Map(keys.map((key, index) => [key, index]));
  const seen = new Set<string>();
  return keys.map((key, index) => {
    const repeat = seen.has(key);
    seen.add(key);
    return { shadowed: lastIndex.get(key) !== index, repeat };
  });
}

/** What a node's parent found about its key, beyond the row. */
interface KeyFindings {
  /** The pointer of the object holding it when its key repeats an earlier sibling's; null when it does not. */
  readonly repeatIn: string | null;
  /** Its key is a YAML non-string, keyed by its source text. */
  readonly nonStringKey: boolean;
}

/**
 * Append the conditions one node raises, in a fixed order: a non-string key,
 * a repeated key, then a lossy number. Each is a warning at the node's place,
 * numbered after the document's conditions so far.
 *
 * @param conditions - The document's conditions so far, appended to
 * @param row - The node's row
 * @param found - What its parent found about its key
 */
export function pushNodeConditions(conditions: ExtractedDataCondition[], row: ExtractedDataNode, found: KeyFindings): void {
  const raise = (code: ExtractedDataCondition['code'], message: string): void => {
    conditions.push({ doc: row.doc, seq: conditions.length, node: row.ordinal, code, severity: 'warning', message, line: row.line, column: row.column });
  };
  if (found.nonStringKey) {
    raise('DATA_NON_STRING_KEY', `The key ${JSON.stringify(row.key)} is not a string; the member is keyed by its source text.`);
  }
  if (found.repeatIn !== null) {
    const where = found.repeatIn === '' ? 'the document root' : found.repeatIn;
    raise('DATA_DUPLICATE_KEY', `The key ${JSON.stringify(row.key)} repeats in the object at ${where}; the last occurrence wins.`);
  }
  if (row.lexeme !== null && isLossy(row.lexeme)) {
    raise('DATA_LOSSY_NUMBER', `The number ${row.lexeme} is not exactly a double; it reads as ${String(row.value)}.`);
  }
}

/**
 * Hold a whole row set to the output caps: every instance's extractor settles its rows here (the
 * `ts` extractor too), so one rule decides the breach and the bytes the stage batches by.
 *
 * @param rows - The extraction's rows
 * @param limits - The output caps in force
 * @param expanded - What the extractor measured beyond the rows (the JSON depth scan)
 * @returns The rows, or the cap they breach
 */
export function settleRows<Rows extends object>(
  rows: Rows,
  limits: Pick<ParseLimits, OutputLimitName>,
  expanded?: Parameters<typeof factsOutputBreach>[2],
): RowSetExtraction<Rows, never> {
  const verdict = factsOutputVerdict(rows, limits, expanded);
  if ('limit' in verdict) return { outcome: 'breach', limit: verdict.limit, found: verdict.found };
  return { outcome: 'rows', rows, bytes: verdict.bytes };
}

/** A hex (`0x`) or octal (`0o`) integer lexeme, as the YAML 1.2 core schema writes them. */
const RADIX_PREFIXES = ['0x', '0o'] as const;

/**
 * Whether a number lexeme is lossy: the double it reads as is not finite, or
 * does not hold the lexeme's exact value. A hex or octal integer is compared
 * as an integer; a decimal lexeme by its exact decimal value against that of
 * the double's shortest round-trip form (`String(number)`), after dropping a
 * leading `+`. So `0.1` and `0x20000000000000` are exact, `9007199254740993`,
 * `0x20000000000001`, `1e400` and `.inf` are not.
 *
 * @param lexeme - The number's source text
 * @returns True when the double does not hold the lexeme's value
 */
function isLossy(lexeme: string): boolean {
  const number = Number(lexeme);
  if (!Number.isFinite(number)) return true;
  if (RADIX_PREFIXES.some((prefix) => lexeme.startsWith(prefix))) return BigInt(lexeme) !== BigInt(number);
  const exact = exactDecimal(lexeme.startsWith('+') ? lexeme.slice(1) : lexeme);
  const held = exactDecimal(String(number));
  return exact.negative !== held.negative || exact.digits !== held.digits || exact.exponent !== held.exponent;
}

/** A decimal lexeme's exact value: sign, significant digits, and the power of ten they scale by. */
interface ExactDecimal {
  readonly negative: boolean;
  readonly digits: string;
  readonly exponent: number;
}

/** The character `0`. */
const ZERO = 0x30;

/**
 * @param lexeme - A decimal number lexeme with no leading `+` (a JSON number,
 *   a YAML core-schema decimal, or `String(number)` of a finite number); its
 *   integer or fraction part may be empty (`.5`, `1.`)
 * @returns Its exact decimal value, normalised so equal values compare equal
 *   (zero has no sign, no digits and exponent 0)
 */
function exactDecimal(lexeme: string): ExactDecimal {
  const negative = lexeme.startsWith('-');
  const unsigned = negative ? lexeme.slice(1) : lexeme;
  const marker = Math.max(unsigned.indexOf('e'), unsigned.indexOf('E'));
  const mantissa = marker === -1 ? unsigned : unsigned.slice(0, marker);
  const power = marker === -1 ? 0 : Number(unsigned.slice(marker + 1));
  const dot = mantissa.indexOf('.');
  const fraction = dot === -1 ? '' : mantissa.slice(dot + 1);
  const significant = dot === -1 ? mantissa : `${mantissa.slice(0, dot)}${fraction}`;
  // Loops, not `/0+$/`: a trailing-run regex backtracks quadratically on a long lexeme.
  let first = 0;
  while (first < significant.length && significant.codePointAt(first) === ZERO) first += 1;
  let end = significant.length;
  while (end > first && significant.codePointAt(end - 1) === ZERO) end -= 1;
  if (end === first) return { negative: false, digits: '', exponent: 0 };
  const trailingZeros = significant.length - end;
  return { negative, digits: significant.slice(first, end), exponent: power - fraction.length + trailingZeros };
}
