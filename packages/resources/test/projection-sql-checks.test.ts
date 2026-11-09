/**
 * `resources.checks` — a project's own SQL assertions over its projection.
 *
 * The pure half lives here and in `sql-checks.ts`: given a check's declaration
 * and the rows its statement selected, what findings does that produce? The SQL
 * itself is the CLI's business, because only the CLI knows a storage backend
 * exists — so this file never opens a database, and every case below is a
 * literal row set.
 *
 * ## The contract, stated once
 *
 * **A check's statement selects the VIOLATIONS.** Zero rows is a pass. That
 * direction is the whole design: it makes a check self-describing (each row IS a
 * finding, and its columns are the finding's evidence) and it means an author
 * cannot write an assertion that passes vacuously by selecting nothing —
 * selecting nothing is exactly what success looks like, deliberately.
 */

import { sep } from 'node:path';

import { customCheckCode, type ValidationIssue } from '@vibe-agent-toolkit/schema';
import { describe, expect, it } from 'vitest';


import {
  checkStatements,
  describeUninterpretableRows,
  issuesFromCheckRows,
  type CheckRowConversion,
} from '../src/projection/sql-checks.js';
import { ResourceCheckSchema, type ResourceCheck } from '../src/schemas/project-config.js';

/** The one check name these tests use, and the code it must produce. */
const NAME = 'orphan-skills';
const CODE = 'CUSTOM:orphan-skills';

/** A path a row can name, and the aggregate check used for the no-path cases. */
const SKILL_PATH = 'skills/a/SKILL.md';
const COUNT_CHECK = {
  description: 'At most 50 skills',
  sql: 'SELECT COUNT(*) AS n FROM resources',
} as const;

/** A declaration with everything defaulted, for tests that vary one field. */
const CHECK = {
  description: 'Every skill must be referenced by a plugin',
  sql: 'SELECT path FROM resource_realizations',
} as const;

/**
 * The findings of a conversion every case here expects to succeed.
 *
 * @throws When the conversion refused a row, naming what it refused
 */
function issuesOf(name: string, check: ResourceCheck, rows: readonly Record<string, unknown>[]): readonly ValidationIssue[] {
  const result = issuesFromCheckRows(name, check, rows);
  if (!result.ok) throw new Error(`expected the rows to convert; row ${String(result.row)}'s ${result.field} was refused`);
  return result.issues;
}

/** The refusal of a conversion a case expects to fail. */
function refusalOf(rows: readonly Record<string, unknown>[]): Extract<CheckRowConversion, { ok: false }> {
  const result = issuesFromCheckRows(NAME, CHECK, rows);
  if (result.ok) throw new Error('expected the rows to be refused');
  return result;
}

describe('customCheckCode', () => {
  it('namespaces a check name so it cannot collide with a registry code', () => {
    // The registry's code space is closed and every entry carries a default
    // severity; a user-authored name landing in it would either shadow a shipped
    // code or crash the severity lookup. The prefix is what keeps the two spaces
    // disjoint by construction rather than by a naming convention nobody enforces.
    expect(customCheckCode(NAME)).toBe(CODE);
  });
});

describe('issuesFromCheckRows', () => {
  it('emits nothing when the statement selected nothing, because that is the pass', () => {
    expect(issuesOf(NAME, CHECK, [])).toStrictEqual([]);
  });

  it('emits one finding per violating row', () => {
    const issues = issuesOf(NAME, CHECK, [
      { path: SKILL_PATH },
      { path: 'skills/b/SKILL.md' },
    ]);

    expect(issues).toHaveLength(2);
    expect(issues[0]?.code).toBe(CODE);
    expect(issues[1]?.code).toBe(CODE);
  });

  it('defaults to error severity, so a check that says nothing still fails a build', () => {
    // The safe direction. A check whose author did not think about severity is
    // an assertion they wanted enforced; defaulting to `warning` would let it
    // pass CI silently, which is the failure mode a check exists to prevent.
    const [issue] = issuesOf(NAME, CHECK, [{ path: 'a.md' }]);

    expect(issue?.severity).toBe('error');
  });

  it('honours a declared severity', () => {
    const [issue] = issuesOf(NAME, { ...CHECK, severity: 'warning' }, [{ path: 'a.md' }]);

    expect(issue?.severity).toBe('warning');
  });

  it('anchors the finding to the file when the row selected a path', () => {
    // A convention rather than a requirement: a check that selects `path` gets
    // findings a reader can open. Without it every finding would point at the
    // config file, which is where the check is written and not where the problem
    // is.
    const [issue] = issuesOf(NAME, CHECK, [{ path: SKILL_PATH }]);

    expect(issue?.location).toBe(SKILL_PATH);
  });

  it('omits the location entirely when no path column was selected', () => {
    // 🪤 Never a placeholder. `ValidationIssue.location` is refined to a
    // project-relative POSIX path, and an aggregate check (`SELECT COUNT(*)`)
    // has no file to name — inventing one would put a reader in a file that has
    // nothing to do with the finding.
    const [issue] = issuesOf('too-many-skills', COUNT_CHECK, [{ n: 51 }]);

    expect(issue?.location).toBeUndefined();
  });

  it('carries the row into the message, so the finding says WHICH row violated', () => {
    // The evidence. A message that only repeated the description would make two
    // violations of one check indistinguishable, and the row set is the only
    // thing that says what to go and look at.
    const [issue] = issuesOf('too-many-skills', COUNT_CHECK, [{ n: 51 }]);

    expect(issue?.message).toContain(COUNT_CHECK.description);
    expect(issue?.message).toContain('n=51');
  });

  /** The location a one-row check reports for a given `path` value. */
  const locationFor = (path: unknown): string | undefined =>
    issuesOf(NAME, CHECK, [{ path }])[0]?.location;

  // Gated: a backslash is a separator only on win32; on POSIX it is a filename character (next case).
  it.skipIf(sep !== '\\')('declines a backslashed path rather than emitting an invalid location', () => {
    // 🪤 NOTHING on this path parses the findings through ValidationIssueSchema,
    // so this guard is the ONLY enforcement of its `location` contract. A
    // backslashed value emitted here would be a schema-violating issue that no
    // gate catches — `validation.allow` globs are matched against `location`, so
    // it would also silently fail to match any allow entry an adopter wrote.
    expect(locationFor(String.raw`docs\guide.md`)).toBeUndefined();
  });

  // Gated: on win32 the backslash is a separator, and the case above is the contract there.
  it.skipIf(sep === '\\')('keeps a POSIX filename that contains a backslash as the location', () => {
    expect(locationFor(String.raw`.claude/rules/a\b.md`)).toBe(String.raw`.claude/rules/a\b.md`);
  });

  it('declines a POSIX-absolute path', () => {
    // Every projection table stores root-relative POSIX paths, so this only
    // fires on a statement that built an absolute one itself (a literal, a
    // concatenation). Losing the anchor beats emitting a location that names a
    // machine rather than a place in the project.
    expect(locationFor('/etc/passwd')).toBeUndefined();
  });

  it('declines a Windows drive-letter path even with forward slashes', () => {
    // A separate branch from the backslash guard: `C:/Users/x/a.md` contains no
    // backslash and does not start with `/`, so only the drive-letter test
    // refuses it.
    expect(locationFor('C:/Users/x/a.md')).toBeUndefined();
  });

  it('keeps the anchor when the path names a DIRECTORY (documented decision)', () => {
    // 📌 DECIDED: a directory row keeps its anchor. This module holds no SQL and
    // never opens a database, so it cannot tell `docs` (a directory row) from
    // `docs` (a file with no extension) — the distinction lives in the
    // projection's `kind` column, which the rows do not have to carry. Dropping
    // every extension-less path would silently unanchor legitimate file rows
    // (`LICENSE`, `Makefile`), which is the worse trade. Consequence an adopter
    // must know: `validation.allow` globs are matched against `location`, and
    // `docs/**` does not match the bare directory `docs` — allow the directory
    // itself when a check selects directory rows.
    expect(locationFor('docs')).toBe('docs');
  });

  it('renders a BLOB column through JSON rather than as [object Uint8Array]', () => {
    // Query rows come back UNDECODED on purpose (arbitrary SQL has no table
    // spec), so a BLOB column genuinely reaches the renderer as a Uint8Array.
    // `String()` on one gives the reader `[object Uint8Array]`, which names the
    // TYPE and never the value.
    const [issue] = issuesOf(
      'blobbed',
      { description: 'No blobs', sql: 'SELECT digest FROM blobs' },
      [{ digest: new Uint8Array([1, 255]) }],
    );

    expect(issue?.message).toContain('digest={"0":1,"1":255}');
  });

  it('renders a null column as null rather than dropping it', () => {
    // 🪤 SQLite returns null for an absent value and the projection uses it
    // meaningfully — `contentKey` is null for a deferred row. A renderer that
    // skipped nulls would make "this column was null" and "this column was not
    // selected" the same finding text.
    const [issue] = issuesOf(
      'unkeyed',
      { description: 'No unkeyed rows', sql: 'SELECT contentKey FROM resource_realizations' },
      [{ contentKey: null }],
    );

    expect(issue?.message).toContain('contentKey=null');
  });
});

/**
 * The reserved row columns: `path` (above), `finding_severity`, `finding_line`
 * and `finding_column`.
 *
 * 🔑 Each is EXACT. A value the column cannot mean refuses the whole check
 * rather than being skipped: a row whose `finding_severity` reads `'high'` was
 * written by an author who meant something, and reporting it at the declared
 * severity would silently re-grade it.
 *
 * 🔑 The `finding_` names are chosen so no projection relation carries them, so a
 * `SELECT *` can never feed one — `check-reserved-columns.test.ts` in
 * projection-sqlite holds every relation's columns to that.
 */
describe('issuesFromCheckRows — the reserved finding_severity column', () => {
  it('takes a row\'s own severity over the declared one', () => {
    const issues = issuesOf(NAME, CHECK, [
      { path: 'a.md', finding_severity: 'warning' },
      { path: 'b.md', finding_severity: 'info' },
    ]);

    expect(issues.map((issue) => issue.severity)).toStrictEqual(['warning', 'info']);
  });

  it.each([
    ['NULL', { path: 'a.md', finding_severity: null }],
    ['absent', { path: 'a.md' }],
  ])('falls back to the declared severity when the column is %s', (_label, row) => {
    const [issue] = issuesOf(NAME, { ...CHECK, severity: 'warning' }, [row]);

    expect(issue?.severity).toBe('warning');
  });

  it.each([
    ['an unknown word', 'high'],
    ['the override-only value', 'ignore'],
    ['a case variant', 'Error'],
    ['a number', 2],
    ['a BLOB', new Uint8Array([1])],
  ])('refuses %s', (_label, value) => {
    const refusal = refusalOf([{ path: 'a.md' }, { path: 'b.md', finding_severity: value }]);

    expect(refusal).toMatchObject({ ok: false, row: 2, field: 'finding_severity', value, rowsSelected: 2 });
  });
});

describe('issuesFromCheckRows — the reserved finding_line and finding_column columns', () => {
  it('consumes location, line and column', () => {
    const [issue] = issuesOf(NAME, CHECK, [{ path: 'a.md', finding_line: 3, finding_column: 5 }]);

    expect(issue).toMatchObject({ location: 'a.md', line: 3, column: 5 });
  });

  it('accepts an in-range bigint, as a store reading int64 returns one', () => {
    const [issue] = issuesOf(NAME, CHECK, [{ path: 'a.md', finding_line: 3n, finding_column: 5n }]);

    expect(issue).toMatchObject({ line: 3, column: 5 });
  });

  it('omits both when NULL or absent', () => {
    const issues = issuesOf(NAME, CHECK, [{ path: 'a.md', finding_line: null, finding_column: null }, { path: 'b.md' }]);

    for (const issue of issues) {
      expect(Object.hasOwn(issue, 'line')).toBe(false);
      expect(Object.hasOwn(issue, 'column')).toBe(false);
    }
  });

  it('keeps a line with no usable path', () => {
    const [issue] = issuesOf(NAME, CHECK, [{ n: 1, finding_line: 3 }]);

    expect(issue?.location).toBeUndefined();
    expect(issue?.line).toBe(3);
  });

  it.each([
    ['finding_line', 0],
    ['finding_line', -1],
    ['finding_line', 1.5],
    ['finding_line', '3'],
    ['finding_line', Number.MAX_SAFE_INTEGER + 1],
    ['finding_line', BigInt(Number.MAX_SAFE_INTEGER) + 1n],
    ['finding_line', 0n],
    ['finding_line', new Uint8Array([3])],
    ['finding_column', 0],
    ['finding_column', '5'],
  ])('refuses %s = %s', (field, value) => {
    const refusal = refusalOf([{ path: 'a.md', finding_line: 1, [field]: value }]);

    expect(refusal).toMatchObject({ ok: false, row: 1, field, rowsSelected: 1 });
    expect(refusal.value).toBe(value);
  });

  it('refuses a column without a line', () => {
    const refusal = refusalOf([{ path: 'a.md', finding_column: 5 }]);

    expect(refusal).toMatchObject({ ok: false, row: 1, field: 'finding_column', value: 5 });
  });
});

describe('issuesFromCheckRows — the bare severity, line and column names are evidence', () => {
  it('reads them as nothing but evidence: no severity, position or refusal comes from them', () => {
    // 🔑 Projection tables carry columns of exactly these names, which is why the
    // reserved ones are prefixed. A value no reserved column could hold is fine here.
    const result = issuesFromCheckRows(NAME, CHECK, [{ path: 'a.md', severity: 'high', line: 0, column: 'x' }]);

    expect(result.ok).toBe(true);
    const [issue] = result.ok ? result.issues : [];
    expect(issue?.severity).toBe('error');
    expect(Object.hasOwn(issue ?? {}, 'line')).toBe(false);
    expect(Object.hasOwn(issue ?? {}, 'column')).toBe(false);
    expect(issue?.evidence).toStrictEqual({ severity: 'high', line: 0, column: 'x' });
    expect(result.ok && result.nearMisses).toStrictEqual([]);
  });
});

describe('issuesFromCheckRows — near misses of the reserved names', () => {
  it('names a column that matches a reserved name in another case', () => {
    const result = issuesFromCheckRows(NAME, CHECK, [{ Path: 'a.md', FINDING_SEVERITY: 'warning', Finding_Line: 1 }]);

    expect(result.ok && result.nearMisses).toStrictEqual([
      { column: 'Path', reserved: 'path' },
      { column: 'FINDING_SEVERITY', reserved: 'finding_severity' },
      { column: 'Finding_Line', reserved: 'finding_line' },
    ]);
  });

  it('names nothing when every reserved column is spelled exactly', () => {
    const result = issuesFromCheckRows(NAME, CHECK, [
      { path: 'a.md', finding_severity: 'info', finding_line: 1, finding_column: 2 },
    ]);

    expect(result.ok && result.nearMisses).toStrictEqual([]);
  });
});

describe('issuesFromCheckRows — the structured check name and evidence', () => {
  it('names the check on every finding', () => {
    const issues = issuesOf(NAME, CHECK, [{ path: 'a.md' }, { path: 'b.md' }]);

    expect(issues.map((issue) => issue.check)).toStrictEqual([NAME, NAME]);
  });

  it('carries every column but the reserved ones as evidence, in the order SQLite returned them', () => {
    const [issue] = issuesOf(NAME, CHECK, [{
      owner: null,
      path: 'a.md',
      finding_severity: 'warning',
      count: 3,
      finding_line: 2,
      finding_column: 4,
      label: 'x',
    }]);

    expect(issue?.evidence).toStrictEqual({ owner: null, count: 3, label: 'x' });
    expect(Object.keys(issue?.evidence ?? {})).toStrictEqual(['owner', 'count', 'label']);
  });

  it('renders a BLOB as the message renders it, and a bigint as its decimal text', () => {
    const [issue] = issuesOf(NAME, CHECK, [{ digest: new Uint8Array([1, 255]), big: 2n ** 64n }]);

    expect(issue?.evidence).toStrictEqual({ digest: '{"0":1,"1":255}', big: '18446744073709551616' });
    expect(issue?.message).toContain(`digest=${String(issue?.evidence?.['digest'])}`);
  });

  it('carries an empty evidence object when the row selected only reserved columns', () => {
    const [issue] = issuesOf(NAME, CHECK, [{ path: 'a.md' }]);

    expect(issue?.evidence).toStrictEqual({});
  });

  it('keeps the message exactly as it was: every column, reserved ones included', () => {
    const [issue] = issuesOf(NAME, CHECK, [{ path: 'a.md', finding_line: 2, n: 1 }]);

    expect(issue?.message).toBe(`${CHECK.description} — path=a.md, finding_line=2, n=1`);
  });
});

describe('describeUninterpretableRows', () => {
  it('quotes a text value, so "3" and 3 read differently', () => {
    expect(describeUninterpretableRows(NAME, refusalOf([{ path: 'a.md', finding_line: '3' }])))
      .toBe(`The check "${NAME}" ran and selected 1 row, but row 1's finding_line = "3" is not a positive integer, so none of its rows were reported.`);
  });

  it('names a column with no line as the problem', () => {
    expect(describeUninterpretableRows(NAME, refusalOf([{ path: 'a.md' }, { path: 'b.md', finding_column: 5 }])))
      .toBe(`The check "${NAME}" ran and selected 2 rows, but row 2's finding_column = 5 is set but its line is not, so none of its rows were reported.`);
  });
});

/**
 * 🔑 A check's `examined` statement is a second statement over the same
 * projection, so every place that asks "which statements may this run execute"
 * must see it — the lens selection most of all, or a derived relation only the
 * `examined` statement names is never evaluated and reads empty.
 */
describe('checkStatements — every statement a check may run', () => {
  it('is the violations statement alone when nothing else is declared', () => {
    expect(checkStatements({ description: 'd', sql: 'SELECT path FROM a' })).toStrictEqual(['SELECT path FROM a']);
  });

  it('adds the examined statement after it when one is declared', () => {
    expect(checkStatements({ description: 'd', sql: 'SELECT path FROM a', examined: 'SELECT path FROM b' }))
      .toStrictEqual(['SELECT path FROM a', 'SELECT path FROM b']);
  });
});

describe('ResourceCheckSchema — examined and allowEmpty', () => {
  /** The refusal messages, each prefixed with its dotted path. */
  const refusalsOf = (declaration: unknown): string[] => {
    const result = ResourceCheckSchema.safeParse(declaration);
    return result.success ? [] : result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
  };

  it('accepts an examined statement, with or without allowEmpty', () => {
    expect(refusalsOf({ description: 'd', sql: 'SELECT 1', examined: 'SELECT 1' })).toStrictEqual([]);
    expect(refusalsOf({ description: 'd', sql: 'SELECT 1', examined: 'SELECT 1', allowEmpty: true })).toStrictEqual([]);
  });

  it('refuses allowEmpty without examined, naming the fix', () => {
    // Zero is legitimate only about a count the check declared: without an
    // `examined` statement there is no count for it to excuse, so the line is
    // either a mistake or a belief that it does something it does not.
    const messages = refusalsOf({ description: 'd', sql: 'SELECT 1', allowEmpty: true });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/^allowEmpty: /);
    expect(messages[0]).toContain('declare `examined`');
  });

  it('accepts only `true` for allowEmpty — `false` is the absence of the key', () => {
    expect(refusalsOf({ description: 'd', sql: 'SELECT 1', examined: 'SELECT 1', allowEmpty: false })).not.toStrictEqual([]);
  });

  it('refuses an empty examined statement', () => {
    expect(refusalsOf({ description: 'd', sql: 'SELECT 1', examined: '' })).not.toStrictEqual([]);
  });
});
