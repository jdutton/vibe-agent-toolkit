/**
 * The shared SQL lexer reads comments, string literals and quoted identifiers where SQLite does.
 *
 * Every short text over the characters that open, close or escape one is put after `SELECT 1 AS`,
 * and the engine says whether it compiles and what it names the column. The lexer predicts both:
 * the text compiles exactly when, past whitespace and comments, it is one closed string, quoted
 * identifier or bare name, and the column is named that token's value. An unclosed block comment
 * is a comment to the end, as SQLite reads it; any other unclosed quote fails to compile.
 */

import { DatabaseSync } from 'node:sqlite';

import { sqlTokens } from '@vibe-agent-toolkit/resources';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isStatementRefusal } from '../src/sql-gate.js';

/** Every string of exactly `length` characters drawn from `alphabet`. */
function stringsOf(alphabet: readonly string[], length: number): string[] {
  let texts = [''];
  for (let at = 0; at < length; at += 1) texts = texts.flatMap((text) => alphabet.map((char) => text + char));
  return texts;
}

/** What the engine makes of `SELECT 1 AS <text>`: the column's name, or undefined when it does not compile. */
function engineAlias(database: DatabaseSync, text: string): string | undefined {
  let statement;
  try {
    statement = database.prepare(`SELECT 1 AS ${text}`);
  } catch (error) {
    if (isStatementRefusal(error)) return undefined;
    throw error;
  }
  const columns = statement.columns();
  return columns.length === 1 ? columns[0]?.name : undefined;
}

/** What the lexer predicts for the same text. */
function lexerAlias(text: string): string | undefined {
  const tokens = sqlTokens(text);
  const [only] = tokens;
  if (tokens.length !== 1 || only === undefined || !only.closed || only.kind === 'punctuation') return undefined;
  return only.value;
}

/** The characters that open, close or escape a span, a name character, and space. */
const FULL_ALPHABET: readonly string[] = ["'", '"', '`', '[', ']', '/', '*', '-', '\n', 'x', ' '];

/** A narrower set, enumerated one character longer. */
const NARROW_ALPHABET: readonly string[] = ["'", '[', ']', '/', '*', '\n', 'x'];

let database: DatabaseSync;

beforeAll(() => {
  database = new DatabaseSync(':memory:');
});

afterAll(() => {
  database.close();
});

describe('the shared lexer agrees with SQLite\'s tokenizer', () => {
  it.each([
    ['every text of up to four characters over the full alphabet', FULL_ALPHABET, 4],
    ['every text of five characters over the narrow alphabet', NARROW_ALPHABET, 5],
  ] as const)('%s', (_label, alphabet, longest) => {
    const disagreements: string[] = [];
    for (let length = 1; length <= longest; length += 1) {
      for (const text of stringsOf(alphabet, length)) {
        const engine = engineAlias(database, text);
        const lexer = lexerAlias(text);
        if (engine !== lexer) disagreements.push(`${JSON.stringify(text)}: engine ${String(engine)}, lexer ${String(lexer)}`);
      }
    }
    expect(disagreements.slice(0, 20)).toStrictEqual([]);
  });

  it('is not vacuous: each kind of span compiles, and an unclosed quote does not', () => {
    expect(engineAlias(database, "'a''b'")).toBe("a'b");
    expect(engineAlias(database, '"a""b"')).toBe('a"b');
    expect(engineAlias(database, '[a]')).toBe('a');
    expect(engineAlias(database, 'x /* open')).toBe('x');
    expect(engineAlias(database, "'open")).toBeUndefined();
  });
});
