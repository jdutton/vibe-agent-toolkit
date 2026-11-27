/**
 * A check's `with:` — CTE definitions VAT prepends to its `sql` and `examined`, so a derived
 * population is written once and both statements read the same one.
 *
 * The composition is pure text over the shared lexer's tokens; the last block runs the composed
 * statements on an in-memory SQLite to prove the merge is one SQLite accepts.
 */

import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import { composeWithCtes } from '../src/projection/check-ctes.js';
import { ResourceCheckSchema } from '../src/schemas/project-config.js';

const POP = "pop AS (SELECT 'a' AS path)";

/** The composed text, or a failure naming the refusal. */
function composed(withCtes: string, statement: string): string {
  const result = composeWithCtes(withCtes, statement);
  if (!result.ok) throw new Error(`refused: ${result.message}`);
  return result.sql;
}

/** The refusal, or a failure naming the composed text. */
function refusal(withCtes: string, statement: string): string {
  const result = composeWithCtes(withCtes, statement);
  if (result.ok) throw new Error(`composed: ${result.sql}`);
  return result.message;
}

/** The parse's issues as path and message; none when it parsed. */
function issuesOf(declaration: unknown): Array<{ path: string; message: string }> {
  const { error } = ResourceCheckSchema.safeParse(declaration);
  return (error?.issues ?? []).map(({ path, message }) => ({ path: path.join('.'), message }));
}

describe('composeWithCtes', () => {
  it('prepends WITH to a statement that has none', () => {
    expect(composed(POP, 'SELECT path FROM pop')).toBe(`WITH ${POP}\nSELECT path FROM pop`);
  });

  it('merges into a statement\'s own leading WITH, with() CTEs first', () => {
    expect(composed(POP, 'WITH b AS (SELECT path FROM pop) SELECT * FROM b'))
      .toBe(`WITH ${POP}\n, b AS (SELECT path FROM pop) SELECT * FROM b`);
  });

  it('reads the statement\'s WITH case-insensitively, past leading comments', () => {
    expect(composed(POP, '-- lead\n/* c */ with b AS (SELECT 1) SELECT * FROM b'))
      .toBe(`WITH ${POP}\n, b AS (SELECT 1) SELECT * FROM b`);
  });

  it('is WITH RECURSIVE when the statement\'s own WITH is', () => {
    expect(composed(POP, 'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3) SELECT * FROM n'))
      .toBe(`WITH RECURSIVE ${POP}\n, n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3) SELECT * FROM n`);
  });

  it('is WITH RECURSIVE when with: begins with RECURSIVE, merged or not', () => {
    const recursive = 'RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3)';
    const body = 'n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3)';
    expect(composed(recursive, 'SELECT * FROM n')).toBe(`WITH RECURSIVE ${body}\nSELECT * FROM n`);
    expect(composed(recursive, 'WITH b AS (SELECT * FROM n) SELECT * FROM b'))
      .toBe(`WITH RECURSIVE ${body}\n, b AS (SELECT * FROM n) SELECT * FROM b`);
    expect(composed(recursive, 'WITH RECURSIVE b AS (SELECT * FROM n) SELECT * FROM b'))
      .toBe(`WITH RECURSIVE ${body}\n, b AS (SELECT * FROM n) SELECT * FROM b`);
  });

  it('does not mistake WITH inside a comment or string for the statement\'s own', () => {
    expect(composed(POP, "/* WITH x AS (SELECT 1) */ SELECT 'WITH' FROM pop"))
      .toBe(`WITH ${POP}\n/* WITH x AS (SELECT 1) */ SELECT 'WITH' FROM pop`);
    expect(composed(POP, "SELECT path FROM pop WHERE path <> 'WITH'"))
      .toBe(`WITH ${POP}\nSELECT path FROM pop WHERE path <> 'WITH'`);
  });

  it('does not mistake a comment or string in with: for its structure', () => {
    const withCtes = "pop AS (SELECT 'x), y AS (' AS path) -- WITH trailing";
    expect(composed(withCtes, 'SELECT path FROM pop')).toBe(`WITH ${withCtes}\nSELECT path FROM pop`);
  });

  it('refuses a name defined in both with: and the statement, naming both', () => {
    const message = refusal(POP, 'WITH other AS (SELECT 1), "POP" AS (SELECT 2) SELECT * FROM pop');
    expect(message).toContain('"pop"');
    expect(message).toContain('`with`');
    expect(message).toContain('the statement\'s own WITH');
  });

  it('allows a same-named CTE nested in a subquery: only the leading WITH is a clash', () => {
    expect(composeWithCtes(POP, 'SELECT * FROM (WITH pop AS (SELECT 2) SELECT * FROM pop)').ok).toBe(true);
  });

  it('refuses with: that begins with WITH', () => {
    expect(refusal(`WITH ${POP}`, 'SELECT 1')).toContain('begins with the keyword WITH');
    expect(refusal(`/* c */ with ${POP}`, 'SELECT 1')).toContain('begins with the keyword WITH');
  });

  it('refuses with: that holds no definition', () => {
    expect(refusal('', 'SELECT 1')).toContain('holds no CTE definition');
    expect(refusal('  -- only a comment\n', 'SELECT 1')).toContain('holds no CTE definition');
    expect(refusal('RECURSIVE', 'SELECT 1')).toContain('holds no CTE definition');
  });

  it('refuses with: that is not CTE definitions only', () => {
    expect(refusal('SELECT 1', 'SELECT 1')).toContain('only CTE definitions');
    expect(refusal(`${POP} SELECT 1`, 'SELECT 1')).toContain('only CTE definitions');
    expect(refusal(`${POP}, `, 'SELECT 1')).toContain('only CTE definitions');
    expect(refusal(`${POP}; DELETE FROM t`, 'SELECT 1')).toContain('only CTE definitions');
    expect(refusal("pop AS (SELECT 1", 'SELECT 1')).toContain('only CTE definitions');
  });

  it('refuses with: that ends inside an unclosed block comment, which would swallow the statement', () => {
    expect(refusal(`${POP} /* open`, 'SELECT path FROM pop')).toContain('unclosed block comment');
    expect(refusal(`${POP} /* closed */ /* open`, 'WITH b AS (SELECT 1) SELECT * FROM b')).toContain('unclosed block comment');
    // A closed one is only a comment.
    expect(composed(`${POP} /* closed */`, 'SELECT path FROM pop')).toBe(`WITH ${POP} /* closed */\nSELECT path FROM pop`);
  });

  it('accepts a column list and [NOT] MATERIALIZED', () => {
    expect(composeWithCtes('p(a, b) AS NOT MATERIALIZED (SELECT 1, 2), q AS MATERIALIZED (SELECT 3)', 'SELECT * FROM p').ok).toBe(true);
  });
});

describe('ResourceCheckSchema with with:', () => {
  it('composes sql and examined once, at parse, and keeps no with: key', () => {
    const parsed = ResourceCheckSchema.parse({
      description: 'd',
      with: POP,
      sql: 'SELECT path FROM pop WHERE 0',
      examined: 'SELECT COUNT(*) FROM pop',
    });
    expect(parsed).toStrictEqual({
      description: 'd',
      sql: `WITH ${POP}\nSELECT path FROM pop WHERE 0`,
      examined: `WITH ${POP}\nSELECT COUNT(*) FROM pop`,
    });
  });

  it('is idempotent: the parsed check parses to itself', () => {
    const parsed = ResourceCheckSchema.parse({ description: 'd', with: POP, sql: 'SELECT path FROM pop' });
    expect(ResourceCheckSchema.parse(parsed)).toStrictEqual(parsed);
  });

  it('refuses a clash in examined, naming examined', () => {
    const issues = issuesOf({ description: 'd', with: POP, sql: 'SELECT 1', examined: 'WITH pop AS (SELECT 1) SELECT COUNT(*) FROM pop' });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe('with');
    expect(issues[0]?.message).toContain('`examined`');
  });

  it('reports a malformed with: once, not once per statement', () => {
    expect(issuesOf({ description: 'd', with: `WITH ${POP}`, sql: 'SELECT 1', examined: 'SELECT 1' })).toHaveLength(1);
  });
});

describe('composed statements run on SQLite', () => {
  const database = new DatabaseSync(':memory:');
  const rows = (sql: string): unknown[] => database.prepare(sql).all();

  it('runs each composition shape', () => {
    const recursive = 'RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3)';
    expect(rows(composed(POP, 'SELECT path FROM pop'))).toHaveLength(1);
    expect(rows(composed(POP, 'WITH b AS (SELECT path FROM pop) SELECT * FROM b'))).toHaveLength(1);
    expect(rows(composed(recursive, 'SELECT * FROM n'))).toHaveLength(3);
    expect(rows(composed(recursive, 'WITH b AS (SELECT * FROM n) SELECT * FROM b'))).toHaveLength(3);
    expect(rows(composed(POP, 'WITH RECURSIVE m(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM m WHERE i < 2) SELECT * FROM m, pop'))).toHaveLength(2);
    expect(rows(composed('p AS (SELECT 1) -- trailing comment', 'SELECT * FROM p'))).toHaveLength(1);
  });
});
