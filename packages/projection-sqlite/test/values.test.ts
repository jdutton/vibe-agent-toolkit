/**
 * The value codec, and above all its round trip.
 *
 * A value that encodes plausibly and decodes into something else is the failure
 * mode worth testing here — a `Date` that reads back as a string, a `false` that
 * reads back as truthy, a JSON `null` that reads back as the four-character
 * string. None of those throw, and all of them corrupt a row quietly.
 */

import {
  ROW_SET_TABLES,
  projectionColumnTypes,
  type ProjectionColumnKind,
  type ProjectionColumnType,
} from '@vibe-agent-toolkit/resources';
import { describe, expect, it } from 'vitest';

import { decodeRow, encodeKeyValue, encodeRow, type RowColumns, type SqliteResultValue } from '../src/values.js';

/** A fixed instant, named once so the timestamp cases share one literal. */
const INSTANT = '2026-08-18T12:34:56.789Z';

/** A second instant, for the coerce-from-string case. */
const MIDNIGHT = '2026-08-18T00:00:00.000Z';

/** A column kind other than `scalar`, whose value encodes alone. */
type ValueKind = Exclude<ProjectionColumnKind, 'scalar'>;

/**
 * A one-column row shape of `kind`: the row entry points are the only way in, so each value case
 * goes through them.
 *
 * @param kind - The column's kind
 * @returns The row shape
 */
function oneColumn(kind: ValueKind): RowColumns {
  const type: ProjectionColumnType = { kind, nullable: true };
  return [['v', type]];
}

/** Encode one value as its row's only column. */
function encodeValue(kind: ValueKind, value: unknown): unknown {
  return encodeRow(oneColumn(kind), { v: value })[0];
}

/** Decode one stored value as its row's only column. */
function decodeValue(kind: ValueKind, stored: SqliteResultValue): unknown {
  return decodeRow(oneColumn(kind), { v: stored })['v'];
}

/** Encode then decode, which is the only property that matters. */
function roundTrip(kind: ValueKind, value: unknown): unknown {
  return decodeValue(kind, encodeValue(kind, value) as SqliteResultValue);
}

describe('encodeRow, one value', () => {
  it('stores a boolean as 0 or 1', () => {
    expect(encodeValue('boolean', true)).toBe(1);
    expect(encodeValue('boolean', false)).toBe(0);
  });

  it('stores an instant as UTC ISO-8601', () => {
    expect(encodeValue('timestamp', new Date(INSTANT)))
      .toBe(INSTANT);
  });

  it('accepts a date-shaped string, because mtime is a z.coerce.date()', () => {
    expect(encodeValue('timestamp', MIDNIGHT)).toBe(MIDNIGHT);
  });

  it('reports an invalid instant as one, rather than as RangeError from toISOString', () => {
    expect(() => encodeValue('timestamp', 'not a date')).toThrow(/not a valid instant/u);
  });

  it('serializes a JSON column', () => {
    expect(encodeValue('json', { a: [1, 'two'] })).toBe('{"a":[1,"two"]}');
  });

  it('stores SQL NULL for both null and undefined', () => {
    expect(encodeValue('text', null)).toBeNull();
    expect(encodeValue('text', undefined)).toBeNull();
    expect(encodeValue('json', null)).toBeNull();
  });

  it('refuses a non-boolean in a boolean column instead of storing a truthy 1', () => {
    expect(() => encodeValue('boolean', 'true')).toThrow(TypeError);
    expect(() => encodeValue('boolean', 1)).toThrow(TypeError);
  });

  it('refuses a non-number in a numeric column', () => {
    expect(() => encodeValue('integer', '7')).toThrow(TypeError);
  });
});

describe('decodeRow, one value', () => {
  it('reads 0 as false, not as a falsy number', () => {
    expect(decodeValue('boolean', 0)).toBe(false);
    expect(decodeValue('boolean', 1)).toBe(true);
  });

  it('reads a stored instant back as a Date', () => {
    expect(decodeValue('timestamp', MIDNIGHT)).toBeInstanceOf(Date);
  });

  it('narrows a bigint to a number, since every integer column is a count or an offset', () => {
    expect(decodeValue('integer', 42n)).toBe(42);
  });

  it('reads SQL NULL as null for every kind', () => {
    const kinds: readonly ValueKind[] =['text', 'integer', 'real', 'boolean', 'timestamp', 'json'];
    for (const kind of kinds) {
      expect(decodeValue(kind, null), kind).toBeNull();
    }
  });
});

describe('round trip', () => {
  it('preserves a Date to the millisecond', () => {
    const instant = new Date(INSTANT);
    expect((roundTrip('timestamp', instant) as Date).getTime()).toBe(instant.getTime());
  });

  it('preserves false, which a truthiness test would lose', () => {
    expect(roundTrip('boolean', false)).toBe(false);
  });

  it('preserves an empty string, which a null test would lose', () => {
    expect(roundTrip('text', '')).toBe('');
  });

  it('preserves zero', () => {
    expect(roundTrip('integer', 0)).toBe(0);
  });

  it('keeps a JSON null and the string "null" distinguishable', () => {
    // The trap this rules out: storing the token `null` for a JS null would make
    // these two decode identically.
    expect(roundTrip('json', null)).toBeNull();
    expect(roundTrip('json', 'null')).toBe('null');
  });

  it('preserves a nested JSON structure', () => {
    const payload = { sources: ['a', 'b'], model: { status: 'modeled' }, count: 3, ok: true, missing: null };
    expect(roundTrip('json', payload)).toEqual(payload);
  });

  it('preserves a JSON array at the top level', () => {
    expect(roundTrip('json', [1, [2, 3]])).toEqual([1, [2, 3]]);
  });

  it('preserves text with quotes, newlines and non-ASCII bytes', () => {
    const awkward = 'a"b\'c\n\td — ünïcode \0tail';
    expect(roundTrip('text', awkward)).toBe(awkward);
  });

  it('preserves a negative and a fractional real', () => {
    expect(roundTrip('real', -1.5)).toBe(-1.5);
  });
});

/** `data__nodes`' row shape: its `value` is a scalar whose companions are `type` and `lexeme`. */
const NODE_COLUMNS: RowColumns = projectionColumnTypes(ROW_SET_TABLES.dataNodes);

/** Where `value` sits in a `data__nodes` row as `encodeRow` binds it. */
const VALUE_AT = NODE_COLUMNS.findIndex(([column]) => column === 'value');

/**
 * A `data__nodes` row of one scalar, every other column filled.
 *
 * @param type - The node's source type
 * @param value - Its value
 * @param lexeme - A number's source text, else null
 * @returns The row
 */
function nodeRow(type: string, value: unknown, lexeme: string | null = null): Record<string, unknown> {
  return {
    blob: 'none.sha256.0', variant: 'json', doc: 0, ordinal: 0, parent: null, pointer: '', key: null, idx: null,
    depth: 1, type, value, lexeme, childCount: 0, shadowed: false, line: 1, column: 1,
  };
}

/**
 * The bound `value` of a scalar node.
 *
 * @param type - The node's source type
 * @param value - Its value
 * @param lexeme - A number's source text
 * @returns What `encodeRow` binds for `value`
 */
function encodedScalar(type: string, value: unknown, lexeme: string | null = null): unknown {
  return encodeRow(NODE_COLUMNS, nodeRow(type, value, lexeme))[VALUE_AT];
}

/**
 * A stored `data__nodes` row whose `value` is `stored`, decoded.
 *
 * @param type - The node's source type
 * @param stored - What SQLite returned for `value`
 * @param lexeme - A number's source text
 * @returns The decoded `value`
 */
function decodedScalar(type: string, stored: SqliteResultValue, lexeme: string | null = null): unknown {
  const encoded = encodeRow(NODE_COLUMNS, nodeRow('null', null, lexeme));
  const raw: Record<string, SqliteResultValue> = {};
  for (const [index, [column]] of NODE_COLUMNS.entries()) raw[column] = encoded[index] ?? null;
  return decodeRow(NODE_COLUMNS, { ...raw, type, value: stored })['value'];
}

describe('a scalar is encoded from its row, by its type and lexeme', () => {
  it.each([
    ['a string, as text', 'string', '1', null, '1'],
    ['an integer lexeme, as a bigint (INTEGER)', 'number', 1, '1', 1n],
    ['a decimal lexeme of an integral value, as a number (REAL)', 'number', 1, '1.0', 1],
    ['an exponent lexeme, as a number (REAL)', 'number', 100, '1e2', 100],
    ['true, as 1n (INTEGER)', 'boolean', true, null, 1n],
    ['false, as 0n (INTEGER)', 'boolean', false, null, 0n],
    ['2^53+1, past the safe range, as the double (REAL)', 'number', 9_007_199_254_740_992, '9007199254740993', 9_007_199_254_740_992],
    ['-0, as the integer 0', 'number', -0, '-0', 0n],
    ['a negative integer, as a bigint', 'number', -42, '-42', -42n],
    ['null, as NULL', 'null', null, null, null],
    ['an object, as NULL', 'object', null, null, null],
    ['an array, as NULL', 'array', null, null, null],
  ] as const)('%s', (_name, type, value, lexeme, expected) => {
    expect(encodedScalar(type, value, lexeme)).toStrictEqual(expected);
  });

  it('refuses a number with no lexeme, and a value its type does not describe', () => {
    expect(() => encodedScalar('number', 1, null)).toThrow(TypeError);
    expect(() => encodedScalar('string', 1)).toThrow(TypeError);
    expect(() => encodedScalar('boolean', 1)).toThrow(TypeError);
  });

  it('decodes by the row\'s type: 1 is true for a boolean and 1 for a number', () => {
    expect(decodedScalar('boolean', 1)).toBe(true);
    expect(decodedScalar('boolean', 0n)).toBe(false);
    expect(decodedScalar('number', 1n, '1')).toBe(1);
    expect(decodedScalar('number', 1.5, '1.5')).toBe(1.5);
    expect(decodedScalar('string', '1')).toBe('1');
    expect(decodedScalar('object', null)).toBeNull();
  });
});

describe('encodeKeyValue', () => {
  it('binds a key or filter value as a write binds its column', () => {
    expect(encodeKeyValue('boolean', true)).toBe(1);
    expect(encodeKeyValue('text', 'ast-link')).toBe('ast-link');
  });

  it('refuses a scalar, whose class only its row decides', () => {
    expect(() => encodeKeyValue('scalar', 1)).toThrow(TypeError);
  });
});
