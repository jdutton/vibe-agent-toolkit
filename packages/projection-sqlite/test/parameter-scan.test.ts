/**
 * The placeholder scanner agrees with SQLite on what is a parameter.
 *
 * The scanner decides which placeholders positional values reach; one it misses is a slot SQLite
 * binds to NULL, so the statement compares against nothing and reports success. Its character
 * class cannot drift from the engine's: every sigil is followed by every printable ASCII character,
 * the engine is asked (an `EXPLAIN` holding a `Variable` opcode is a statement with a parameter),
 * and the scanner must say the same of every statement the engine compiles.
 */

import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import { countBoundParameters, isStatementRefusal } from '../src/sql-gate.js';

/** Every character that opens a placeholder in SQLite. */
const SIGILS: readonly string[] = ['?', ':', '@', '$', '#'];

/** Every printable ASCII character, space through tilde. */
const PRINTABLE_ASCII: readonly string[] = Array.from({ length: 0x7e - 0x20 + 1 }, (_, offset) => String.fromCodePoint(0x20 + offset));

/** Whether the scanner sees any placeholder at all. */
function scannerSeesParameter(sql: string): boolean {
  const { slots, unreachable } = countBoundParameters(sql);
  return slots > 0 || unreachable !== undefined;
}

/** What the engine says of one statement: undefined when it refuses to compile it, else whether it has a parameter. */
function engineSeesParameter(database: DatabaseSync, sql: string): boolean | undefined {
  let program: readonly { opcode?: unknown }[];
  try {
    program = database.prepare(`EXPLAIN ${sql}`).all() as readonly { opcode?: unknown }[];
  } catch (error) {
    if (isStatementRefusal(error)) return undefined;
    throw error;
  }
  return program.some((op) => op.opcode === 'Variable');
}

describe('countBoundParameters agrees with the engine', () => {
  it('on every sigil followed by every printable ASCII character', () => {
    const database = new DatabaseSync(':memory:');
    try {
      const disagreements: string[] = [];
      const parametersPerSigil = new Map<string, number>();
      for (const sigil of SIGILS) {
        for (const next of PRINTABLE_ASCII) {
          const sql = `SELECT ${sigil}${next}`;
          const engine = engineSeesParameter(database, sql);
          if (engine === undefined) continue;
          if (engine) parametersPerSigil.set(sigil, (parametersPerSigil.get(sigil) ?? 0) + 1);
          if (scannerSeesParameter(sql) !== engine) disagreements.push(`${JSON.stringify(sql)}: engine ${String(engine)}`);
        }
      }
      expect(disagreements).toStrictEqual([]);
      // Not vacuous: the engine found a parameter after every sigil.
      expect([...parametersPerSigil.keys()].sort((left, right) => left.localeCompare(right, 'en'))).toStrictEqual(
        [...SIGILS].sort((left, right) => left.localeCompare(right, 'en')),
      );
    } finally {
      database.close();
    }
  });

  it('reads an identifier carrying a `$` as one identifier, never as a parameter inside it', () => {
    const database = new DatabaseSync(':memory:');
    try {
      const sql = 'SELECT 1 AS a$b';
      expect(engineSeesParameter(database, sql)).toBe(false);
      expect(countBoundParameters(sql)).toStrictEqual({ slots: 0, unreachable: undefined });
    } finally {
      database.close();
    }
  });
});
