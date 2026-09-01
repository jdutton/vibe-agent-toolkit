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

import { describe, expect, it } from 'vitest';

import {
  customCheckCode,
  issuesFromCheckRows,
} from '../src/projection/sql-checks.js';

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
    expect(issuesFromCheckRows(NAME, CHECK, [])).toStrictEqual([]);
  });

  it('emits one finding per violating row', () => {
    const issues = issuesFromCheckRows(NAME, CHECK, [
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
    const [issue] = issuesFromCheckRows(NAME, CHECK, [{ path: 'a.md' }]);

    expect(issue?.severity).toBe('error');
  });

  it('honours a declared severity', () => {
    const [issue] = issuesFromCheckRows(NAME, { ...CHECK, severity: 'warning' }, [{ path: 'a.md' }]);

    expect(issue?.severity).toBe('warning');
  });

  it('anchors the finding to the file when the row selected a path', () => {
    // A convention rather than a requirement: a check that selects `path` gets
    // findings a reader can open. Without it every finding would point at the
    // config file, which is where the check is written and not where the problem
    // is.
    const [issue] = issuesFromCheckRows(NAME, CHECK, [{ path: SKILL_PATH }]);

    expect(issue?.location).toBe(SKILL_PATH);
  });

  it('omits the location entirely when no path column was selected', () => {
    // 🪤 Never a placeholder. `ValidationIssue.location` is refined to a
    // project-relative POSIX path, and an aggregate check (`SELECT COUNT(*)`)
    // has no file to name — inventing one would put a reader in a file that has
    // nothing to do with the finding.
    const [issue] = issuesFromCheckRows('too-many-skills', COUNT_CHECK, [{ n: 51 }]);

    expect(issue?.location).toBeUndefined();
  });

  it('carries the row into the message, so the finding says WHICH row violated', () => {
    // The evidence. A message that only repeated the description would make two
    // violations of one check indistinguishable, and the row set is the only
    // thing that says what to go and look at.
    const [issue] = issuesFromCheckRows('too-many-skills', COUNT_CHECK, [{ n: 51 }]);

    expect(issue?.message).toContain(COUNT_CHECK.description);
    expect(issue?.message).toContain('n=51');
  });

  it('renders a null column as null rather than dropping it', () => {
    // 🪤 SQLite returns null for an absent value and the projection uses it
    // meaningfully — `contentKey` is null for a deferred row. A renderer that
    // skipped nulls would make "this column was null" and "this column was not
    // selected" the same finding text.
    const [issue] = issuesFromCheckRows(
      'unkeyed',
      { description: 'No unkeyed rows', sql: 'SELECT contentKey FROM resource_realizations' },
      [{ contentKey: null }],
    );

    expect(issue?.message).toContain('contentKey=null');
  });
});
