/**
 * Which relations a statement names, and the tokens that decide it. The engine-held agreement of
 * the lexer with SQLite lives in projection-sqlite's `sql-lexer-differential.test.ts`; these pin
 * the scan's own rules.
 */

import { describe, expect, it } from 'vitest';

import {
  definesCteNamed,
  identifierSpellings,
  queryableRelationNames,
  queryableRelationSpecs,
  relationsNamedBy,
  sqlSpanAt,
  sqlTokens,
} from '../src/index.js';

const RELATIONS = ['blobs', 'edges', 'changed_files'];

describe('relationsNamedBy', () => {
  it.each([
    ['a bare name', 'SELECT * FROM blobs', ['blobs']],
    ['each quoted identifier form, in any case', 'SELECT * FROM "Blobs" JOIN [edges] JOIN `changed_files`', RELATIONS],
    ['a schema-qualified name', 'SELECT * FROM main.blobs', ['blobs']],
    ['a qualifier', 'SELECT blobs.k FROM x', ['blobs']],
    ['nothing inside a string literal', "SELECT 'blobs' AS x", []],
    ['nothing inside a line comment', 'SELECT 1 AS x -- blobs', []],
    ['nothing inside a closed or an unclosed block comment', 'SELECT 1 AS x /* edges */ /* blobs', []],
    ['nothing in the alias after AS, however it is spaced', 'SELECT COUNT(*) AS changed_files, 1 AS"blobs", 2 as\n[edges] FROM t', []],
    ['an alias given without AS, harmlessly', 'SELECT * FROM t edges', ['edges']],
    ['a name a dollar sign extends into another identifier, not at all', 'SELECT * FROM blobs$x', []],
    ['a name inside a quoted identifier with other text, not at all', 'SELECT * FROM "my blobs"', []],
  ])('%s', (_label, sql, expected) => {
    expect(relationsNamedBy(sql, RELATIONS)).toStrictEqual(expected);
  });
});

describe('definesCteNamed', () => {
  it.each([
    ['a plain CTE', 'WITH changed_files AS (SELECT 1) SELECT * FROM changed_files', true],
    ['a later CTE, with columns and MATERIALIZED', 'WITH a AS (SELECT 1), changed_files(x) AS NOT MATERIALIZED (SELECT 1) SELECT 1', true],
    ['a recursive quoted CTE', 'WITH RECURSIVE "changed_files" AS (SELECT 1) SELECT 1', true],
    ['the relation read, not defined', 'SELECT * FROM changed_files', false],
    ['a CTE spelled only in a literal', "WITH x AS (SELECT 'changed_files AS (') SELECT 1", false],
    ['an unclosed column list', 'WITH changed_files (x AS (SELECT 1', false],
  ])('%s', (_label, sql, expected) => {
    expect(definesCteNamed(sql, 'changed_files')).toBe(expected);
  });
});

describe('the lexer', () => {
  it('unquotes and unescapes each quoted form', () => {
    expect(sqlTokens(`'it''s' "a""b" [x]] \`c\`\`d\``).map(({ kind, value }) => [kind, value])).toStrictEqual([
      ['string', "it's"],
      ['quotedIdentifier', 'a"b'],
      ['quotedIdentifier', 'x'],
      ['punctuation', ']'],
      ['quotedIdentifier', 'c`d'],
    ]);
  });

  it('runs an unclosed quote to the end, marked unclosed', () => {
    expect(sqlSpanAt("x 'open", 2)).toStrictEqual({ kind: 'string', end: 7, closed: false });
    expect(sqlTokens('[open').at(0)).toMatchObject({ kind: 'quotedIdentifier', value: 'open', closed: false });
  });

  it('opens a block comment only when a character follows the opener', () => {
    expect(sqlSpanAt('/* x', 0)).toStrictEqual({ kind: 'comment', end: 4, closed: true });
    expect(sqlSpanAt('/*', 0)).toBeUndefined();
    expect(sqlSpanAt('-- x\ny', 0)).toStrictEqual({ kind: 'comment', end: 4, closed: true });
    expect(sqlSpanAt('x', 0)).toBeUndefined();
  });
});

describe('the relation names and spellings', () => {
  it('lists every queryable relation by name, in specification order', () => {
    expect(queryableRelationNames()).toStrictEqual(queryableRelationSpecs().map((spec) => spec.name));
  });

  it('spells a relation plain, then in each quoted identifier form', () => {
    expect(identifierSpellings('blobs')).toStrictEqual(['blobs', '"blobs"', '[blobs]', '`blobs`']);
  });
});
