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

import { customCheckCode } from '@vibe-agent-toolkit/schema';
import { describe, expect, it } from 'vitest';

import { BUILTIN_CHECK_NAMES } from '../src/projection/builtin-check-names.js';
import {
  CHECK_REFUSAL_REASON_SCHEMA,
  checkStatements,
  describeUninterpretableExamined,
  describeUninterpretableRows,
  examinedCount,
  issuesFromCheckRows,
  LENS_REFUSAL_CODES,
  nearMissesOf,
  uninterpretableRowsReason,
  type CheckIssue,
  type CheckRowConversion,
} from '../src/projection/sql-checks.js';
import {
  EXAMINED_ALLOWED,
  ResourceCheckSchema,
  ResourcesConfigSchema,
  type ResourceCheck,
} from '../src/schemas/project-config.js';

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
function issuesOf(name: string, check: ResourceCheck, rows: readonly Record<string, unknown>[]): readonly CheckIssue[] {
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

  /**
   * 🔑 A text `path` that is no location is NOT a broken check. The projection's own relations
   * hold such values (`realization_conditions.path` carries `../` for an outside-root closure
   * reference; `roots.path` is absolute), and a natural check over them must report at its
   * declared severity. The value moves to evidence so nothing is lost.
   */
  it.each([
    ['POSIX-absolute', '/etc/passwd'],
    ['drive-letter (even with forward slashes)', 'C:/Users/x/a.md'],
    ['drive-relative', 'C:a.md'],
    ['root-escaping', '../outside.md'],
    ['mid-path root-escaping', 'docs/../../outside.md'],
    ['zero-length', ''],
  ])('reports a %s text path with no location, carrying the value as evidence', (_what, path) => {
    const [issue] = issuesOf(NAME, CHECK, [{ path, n: 1 }]);

    expect(issue).toBeDefined();
    expect(issue?.location).toBeUndefined();
    expect(issue?.severity).toBe('error');
    expect(issue?.evidence).toStrictEqual({ path, n: 1 });
  });

  // Gated: the backslash rule is per platform — a separator on win32, a filename character on POSIX.
  it.skipIf(sep === '\\')('keeps a POSIX filename containing a backslash as the location', () => {
    expect(locationFor(String.raw`docs\guide.md`)).toBe(String.raw`docs\guide.md`);
  });

  it.each([
    ['numeric', 7],
    ['BLOB', new Uint8Array([1])],
    ['boolean', true],
  ])('refuses the check for a %s path, as it does any other reserved column it cannot read', (_what, path) => {
    const refusal = refusalOf([{ path: 'fine.md' }, { path }]);

    expect(refusal).toMatchObject({ ok: false, row: 2, field: 'path', rowsSelected: 2 });
    expect(uninterpretableRowsReason(refusal)).toMatchObject({ column: 'path', row: 2, allowed: refusal.allowed });
    expect(describeUninterpretableRows(NAME, refusal)).toContain(`row 2's path =`);
  });

  it.each([['docs/guide.md'], ['./docs/guide.md'], ['././docs/guide.md']])(
    'reports the path %s at the location docs/guide.md, never with a leading ./',
    (path) => {
      expect(locationFor(path)).toBe('docs/guide.md');
    },
  );

  it('keeps a path whose .. stays inside the root', () => {
    expect(locationFor('docs/../guide.md')).toBe('docs/../guide.md');
  });

  it('reads a NULL path as no location, never a refusal', () => {
    expect(locationFor(null)).toBeUndefined();
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

  it('reports the FIRST bad row when two are bad', () => {
    const refusal = refusalOf([{ path: 'a.md' }, { path: 'b.md', finding_line: 0 }, { path: 'c.md', finding_severity: 'high' }]);

    expect(refusal).toMatchObject({ row: 2, field: 'finding_line', value: 0, rowsSelected: 3 });
  });
});

describe('uninterpretableRowsReason — the refusal as structure', () => {
  it.each([
    [{ finding_severity: 'high' }, { column: 'finding_severity', value: 'high', row: 1, allowed: 'one of error | warning | info' }],
    [{ finding_line: 0 }, { column: 'finding_line', value: 0, row: 1, allowed: 'a positive integer' }],
    [{ finding_line: new Uint8Array([3]) }, { column: 'finding_line', value: '{"0":3}', row: 1, allowed: 'a positive integer' }],
    [{ finding_column: 5 }, { column: 'finding_column', value: 5, row: 1, allowed: 'NULL without a finding_line' }],
  ])('names the column, the value as evidence renders it, the row and what is allowed (%o)', (row, reason) => {
    const refusal = refusalOf([{ path: 'a.md', ...row }]);

    expect(uninterpretableRowsReason(refusal)).toStrictEqual(reason);
    // One spelling: the sentence states what the structure allows.
    expect(describeUninterpretableRows(NAME, refusal)).toContain(`is not ${reason.allowed}, so`);
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
    expect(nearMissesOf(['path', 'severity', 'line', 'column'])).toStrictEqual([]);
  });
});

describe('nearMissesOf — the result columns that miss a reserved name only by case', () => {
  it('names each, in the order the statement selected them', () => {
    expect(nearMissesOf(['Path', 'n', 'FINDING_SEVERITY', 'Finding_Line'])).toStrictEqual([
      { column: 'Path', reserved: 'path' },
      { column: 'FINDING_SEVERITY', reserved: 'finding_severity' },
      { column: 'Finding_Line', reserved: 'finding_line' },
    ]);
  });

  it('names nothing when every reserved column is spelled exactly', () => {
    expect(nearMissesOf(['path', 'finding_severity', 'finding_line', 'finding_column'])).toStrictEqual([]);
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

  it('renders a BLOB as the message renders it', () => {
    const [issue] = issuesOf(NAME, CHECK, [{ digest: new Uint8Array([1, 255]) }]);

    expect(issue?.evidence).toStrictEqual({ digest: '{"0":1,"1":255}' });
    expect(issue?.message).toContain(`digest=${String(issue?.evidence?.['digest'])}`);
  });

  it.each([
    ['a location', { path: 'a.md', n: 1 }, 'a.md'],
    ['NULL', { path: null, n: 1 }, undefined],
    ['absent', { n: 1 }, undefined],
  ])('never carries path as evidence when it is %s', (_what, row, location) => {
    const [issue] = issuesOf(NAME, CHECK, [row]);

    expect(issue?.location).toBe(location);
    expect(issue?.evidence).toStrictEqual({ n: 1 });
  });

  it('keeps a column aliased __proto__ as an own evidence key', () => {
    const row: Record<string, unknown> = JSON.parse('{"path":"a.md","__proto__":"x"}') as Record<string, unknown>;
    const [issue] = issuesOf(NAME, CHECK, [row]);

    expect(Object.keys(issue?.evidence ?? {})).toStrictEqual(['__proto__']);
    expect(Object.getOwnPropertyDescriptor(issue?.evidence ?? {}, '__proto__')?.value).toBe('x');
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
      .toBe(`The check "${NAME}" ran and selected 2 rows, but row 2's finding_column = 5 is not NULL without a finding_line, so none of its rows were reported.`);
  });
});

describe('examinedCount — an examined statement is one count', () => {
  it.each([
    ['COUNT(*)', [{ 'COUNT(*)': 12 }], 12],
    ['a zero', [{ n: 0 }], 0],
  ])('reads %s as the count', (_what, rows, count) => {
    expect(examinedCount(rows)).toStrictEqual({ ok: true, count });
  });

  it.each([
    ['no row', [], { rows: 0 }],
    ['two rows', [{ n: 1 }, { n: 2 }], { rows: 2, columns: 1 }],
    ['two columns', [{ n: 1, m: 2 }], { rows: 1, columns: 2 }],
    ['text', [{ n: '3' }], { rows: 1, columns: 1, value: '3' }],
    ['a negative', [{ n: -1 }], { rows: 1, columns: 1, value: -1 }],
    ['a fraction', [{ n: 0.5 }], { rows: 1, columns: 1, value: 0.5 }],
    ['an unsafe integer', [{ n: Number.MAX_SAFE_INTEGER + 1 }], { rows: 1, columns: 1, value: Number.MAX_SAFE_INTEGER + 1 }],
    ['NULL', [{ n: null }], { rows: 1, columns: 1, value: null }],
    ['a BLOB', [{ n: new Uint8Array([1]) }], { rows: 1, columns: 1, value: '{"0":1}' }],
  ])('refuses %s, saying what came back', (_what, rows, shape) => {
    const read = examinedCount(rows);

    expect(read).toStrictEqual({ ok: false, reason: { statement: 'examined', ...shape, allowed: expect.stringContaining('COUNT(*)') } });
    expect(read.ok ? '' : describeUninterpretableExamined('n', read.reason)).toMatch(/^The check "n" ran its violations statement, but its examined statement returned .*COUNT\(\*\)/);
  });

  it('names the one value it refused, quoted when it is text', () => {
    const read = examinedCount([{ n: '3' }]);

    expect(read.ok ? '' : describeUninterpretableExamined('n', read.reason)).toContain('returned the value "3", not exactly one row');
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

describe('ResourcesConfigSchema — a declared check never takes a built-in\'s name', () => {
  it.each([...BUILTIN_CHECK_NAMES])('refuses a check named %s, naming the clash and the fix', (name) => {
    // The documented trap: copy a built-in's sqlTwin under its own name. Findings, the progress
    // log and cost records are all keyed on the name, so two checks under one name are one identity.
    const result = ResourcesConfigSchema.safeParse({ checks: { [name]: { description: 'd', sql: 'SELECT 1' } } });

    expect(result.success).toBe(false);
    const [issue] = result.success ? [] : result.error.issues;
    expect(issue?.path).toStrictEqual(['checks', name]);
    expect(issue?.message).toContain(`"${name}" is a built-in check's name`);
    expect(issue?.message).toContain('rename');
  });

  it('accepts a copied sqlTwin under a name of its own', () => {
    expect(ResourcesConfigSchema.safeParse({ checks: { 'my-glob-inert': { description: 'd', sql: 'SELECT 1' } } }).success).toBe(true);
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
    // 🔑 The contract is stated once: the refusal quotes it, never a paraphrase of it.
    expect(messages[0]).toContain(EXAMINED_ALLOWED);
  });

  it('describes the examined statement by the same contract it is held to', () => {
    expect(ResourceCheckSchema.innerType().shape.examined.description).toContain(EXAMINED_ALLOWED);
  });

  it('accepts only `true` for allowEmpty — `false` is the absence of the key', () => {
    expect(refusalsOf({ description: 'd', sql: 'SELECT 1', examined: 'SELECT 1', allowEmpty: false })).not.toStrictEqual([]);
  });

  it('refuses an empty examined statement', () => {
    expect(refusalsOf({ description: 'd', sql: 'SELECT 1', examined: '' })).not.toStrictEqual([]);
  });
});

/**
 * 🔑 A non-finite number has ONE rendering — its text — in the message, the evidence and a
 * refusal's `reason.value` alike. As a number JSON writes it `null` and YAML `.inf`, so the two
 * serializations of one document would disagree, and neither would agree with the message.
 */
describe('a non-finite number reads as its text everywhere', () => {
  const NON_FINITE = [['Infinity', Infinity], ['-Infinity', -Infinity], ['NaN', Number.NaN]] as const;

  it.each(NON_FINITE)('evidence and message agree on %s', (text, value) => {
    const conversion = issuesFromCheckRows(NAME, CHECK, [{ path: SKILL_PATH, n: value }]);
    const [issue] = conversion.ok ? conversion.issues : [];

    expect(issue?.evidence).toStrictEqual({ n: text });
    expect(issue?.message).toContain(`n=${text}`);
    // JSON has no Infinity: a bare number would serialize as null and disagree with YAML.
    expect(JSON.stringify(issue?.evidence)).toBe(`{"n":"${text}"}`);
  });

  it.each(NON_FINITE)('a refused reserved column carries %s as text', (text, value) => {
    const refusal = refusalOf([{ path: SKILL_PATH, finding_line: value }]);

    expect(uninterpretableRowsReason(refusal).value).toBe(text);
    expect(describeUninterpretableRows(NAME, refusal)).toContain(`finding_line = "${text}" is not`);
  });

  it.each(NON_FINITE)('a refusal quotes %s exactly as it quotes the same text selected as text', (text, value) => {
    const asNumber = describeUninterpretableRows(NAME, refusalOf([{ path: SKILL_PATH, finding_line: value }]));
    const asText = describeUninterpretableRows(NAME, refusalOf([{ path: SKILL_PATH, finding_line: text }]));

    expect(asNumber).toBe(asText);
  });

  it.each(NON_FINITE)('a refused examined count carries %s as text', (text, value) => {
    const read = examinedCount([{ n: value }]);

    expect(read.ok ? undefined : read.reason.value).toBe(text);
    expect(read.ok ? '' : describeUninterpretableExamined('n', read.reason)).toContain(`returned the value "${text}", not`);
  });
});

/**
 * 🔑 A refusal reason has ONE definition: the strict schema, from which every reason type is
 * inferred. `reason.refusal` is narrowed to the codes a derived relation can refuse with.
 */
describe('CHECK_REFUSAL_REASON_SCHEMA', () => {
  it.each(LENS_REFUSAL_CODES)('admits the lens refusal %s', (refusal) => {
    expect(CHECK_REFUSAL_REASON_SCHEMA.safeParse({ refusal }).success).toBe(true);
  });

  it.each(['CONFIG_INVALID', 'RUN_INCOMPLETE', 'RESOURCE_CHECK_BROKEN'])('refuses %s, which no relation refuses with', (refusal) => {
    expect(CHECK_REFUSAL_REASON_SCHEMA.safeParse({ refusal }).success).toBe(false);
  });

  it('parses what uninterpretableRowsReason and examinedCount produce', () => {
    const rows = uninterpretableRowsReason(refusalOf([{ path: 7 }]));
    const examined = examinedCount([]);
    if (examined.ok) throw new Error('an empty result is no count');

    expect(CHECK_REFUSAL_REASON_SCHEMA.parse(rows)).toStrictEqual(rows);
    expect(CHECK_REFUSAL_REASON_SCHEMA.parse(examined.reason)).toStrictEqual(examined.reason);
  });

  it('is strict', () => {
    expect(CHECK_REFUSAL_REASON_SCHEMA.safeParse({ refusal: 'USAGE_INVALID', extra: 1 }).success).toBe(false);
  });
});
