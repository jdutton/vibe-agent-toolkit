/**
 * `vat resources query` end to end.
 *
 * ## What only a spawn can prove here
 *
 * The payload's shape and the failure wording are pinned as pure unit tests
 * (`test/commands/resources-query-payload.test.ts`). What is left for a spawn is
 * everything the unit tests cannot reach: that a real tree populates, that the
 * blob tier is actually there to query, that the engine refuses a write, and —
 * the two this file exists for — that the answer is about the tree the command
 * was pointed at even when a store holds ANOTHER tree's rows, and that the cache
 * tell flips when a store is put behind the same question.
 *
 * ## 🚨 TWO roots, ONE store. The second root is the whole test.
 *
 * The defect this suite guards is a cross-repository disclosure: the projection
 * store is one database per VAT release shared by every root on the machine, and
 * arbitrary SQL carries no key predicate — so a statement run against the store
 * answered from every corpus that had ever warmed it.
 *
 * 🪤 **A single-root fixture cannot fail on that.** The first version of this
 * suite gave each run a private store directory written only by itself, so the
 * store held this fixture's rows and nothing else — and the two assertions that
 * NAME the defect returned the same values against the buggy code as against the
 * fixed code. The precondition for the bug was never created, and a guard that
 * cannot fail is not a guard.
 *
 * So the fixture builds a SECOND corpus ({@link foreignDir}) whose files sit
 * under a different path prefix, warms the shared store from it in `beforeAll`,
 * and only then asks the first corpus its questions. Every shared-store test
 * also asserts that the store FILE still holds the foreign rows at that moment:
 * without that, a future refactor that quietly stopped sharing the directory
 * would make this file vacuous again in exactly the same way, and nothing would
 * say so.
 *
 * ## 🔑 The cache tell needs two runs and a git repository
 *
 * A projection store is keyed on `git write-tree`, so a corpus outside a
 * repository is refused a key and populates uncached — the command says so on
 * stderr rather than silently declining. Both fixtures therefore commit, and the
 * two runs are the arms: the first must report `derived`, the second `store`.
 *
 * ⚠️ Asserted as a FLIP, never as `store` alone. A test that only checked the
 * second run would pass against a build that always reported `store`, which is
 * the failure the field exists to catch.
 */

import { spawnSync } from 'node:child_process';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import yaml from 'yaml';

import {
  cleanupTestTempDir,
  createTestTempDir,
  fs,
  getBinPath,
  safePath,
} from './test-common.js';
// 🪤 The SYNCHRONOUS `executeCli`. `test-common.ts` exports an async function of
// the same name that returns a promise, and awaiting nothing yields a result
// whose `stdout` is undefined — which surfaces as a YAML parse error, not as a
// missing await.
import { executeCli } from './test-helpers/index.js';

const binPath = getBinPath(import.meta.url);

/**
 * The one subdirectory the corpus under test keeps its files in.
 *
 * Every "is this answer about MY tree" predicate is written against it, so it is
 * named once rather than spelled into each statement.
 */
const OWN_PREFIX = 'docs';

/** The foreign corpus's prefix, chosen so a leaked row is unmistakable. */
const FOREIGN_PREFIX = 'pkgs';

/** The foreign corpus's one file, as a `resource_realizations.path` would hold it. */
const FOREIGN_PATH = `${FOREIGN_PREFIX}/zzz.md`;

/**
 * What `openSqliteProjectionStore` names its database.
 *
 * Spelled here rather than imported: it is a private constant of
 * `@vibe-agent-toolkit/projection-sqlite`, and this suite drives the built CLI
 * from outside rather than linking against the backend. If it ever changes,
 * {@link databasesUnder} finds nothing and the store-location arms fail loudly
 * — which is the right failure, not a silent pass.
 */
const PROJECTION_DATABASE = 'projection.db';

/**
 * A cheap aggregate, used wherever the QUESTION does not matter and only the run
 * does — the cache-tell arms, which are about where a population came from.
 */
const COUNT_BLOBS = 'SELECT COUNT(*) AS n FROM blobs';

/**
 * The UNFILTERED aggregate the regression test rests on.
 *
 * Unfiltered on purpose: a `WHERE` clause narrow enough to name this fixture's
 * own files cannot see a foreign row, which is exactly how the single-root
 * version of this suite passed against the buggy build.
 */
const COUNT_REALIZATIONS = 'SELECT COUNT(*) AS n FROM resource_realizations';

/** The corpus every question in this file is ASKED about. Files under `docs/`. */
let projectDir: string;

/**
 * A SECOND corpus, sharing one store directory with {@link projectDir}.
 *
 * It exists only to put foreign rows in the store before anything is asked, and
 * it is never the subject of a question. See this file's header.
 */
let foreignDir: string;

/**
 * Where this suite's stores live — OUTSIDE both corpora, deliberately.
 *
 * 🪤 A store under a corpus is a member of the tree it is caching. Writing it
 * changes the working tree, which changes `git write-tree`, which changes the
 * store key — so every run misses, the cache tell never flips, and the database
 * file itself shows up as a row in `resource_realizations`. Both symptoms are
 * confusing and neither points at the cause.
 */
let storeDir: string;

/** The store directory both corpora populate through. */
function sharedStoreDir(): string {
  return safePath.join(storeDir, 'shared');
}

/** A store is selected, but nothing says where it goes. */
function storeSelectedEnv(): NodeJS.ProcessEnv {
  return { ...process.env, VAT_PROJECTION_STORE: 'sqlite' };
}

/** The shared store this suite writes, kept beneath the fixture so cleanup takes it. */
function storeEnv(): NodeJS.ProcessEnv {
  return {
    ...storeSelectedEnv(),
    // 🪤 `VAT_PROJECTION_STORE_DIR` names ONLY the store, which is why this suite
    // uses it. Redirecting `TMPDIR` relocates the store too — the default-location
    // control below depends on exactly that — but it is blunt: it moves every other
    // temp consumer with it, and the variable name differs by platform. An earlier
    // version read `XDG_CACHE_HOME` + `HOME` and its comment claimed isolation it
    // did not have: `defaultStoreDirectory()` is under `tmpdir()` and consults
    // neither, so every run in this suite was writing into the developer's own
    // store.
    VAT_PROJECTION_STORE_DIR: sharedStoreDir(),
  };
}

/**
 * Give the DEFAULT store location a known, empty home for one child process.
 *
 * `defaultStoreDirectory()` is `normalizedTmpdir()/.vat-cache/<namespace>/
 * projection-<shapeDigest>`, and `normalizedTmpdir()` is `os.tmpdir()` — read
 * fresh at every call from `TMPDIR` on POSIX and `TEMP`, then `TMP`, on Windows.
 * All three are set, because setting one is silently inert on the other
 * platform.
 *
 * ⚠️ **Not an isolation mechanism, and not a second one.**
 * `PROJECTION_STORE_DIR_ENV`'s docstring is right that redirecting the OS temp
 * directory is the wrong instrument for putting a store somewhere — it moves
 * every other temp consumer in order to move one. This is the opposite use: it is how a test
 * OBSERVES the default location. `VAT_PROJECTION_STORE_DIR` says where the store
 * should go; nothing says where it should NOT go, so the only way to assert the
 * default was left alone is to make the default a directory this test owns and
 * can then find empty. Verified in both directions, which is what the
 * default-location control below exists to keep true: without
 * `VAT_PROJECTION_STORE_DIR` the database lands here, with it this stays empty.
 *
 * @param directory - Scratch directory to become the child's temp root
 * @returns The three variables to merge into a child environment
 */
function tmpdirRedirect(directory: string): NodeJS.ProcessEnv {
  fs.mkdirSync(directory, { recursive: true });
  return { TMPDIR: directory, TMP: directory, TEMP: directory };
}

/**
 * Every projection database beneath a directory, relative and forward-slashed.
 *
 * A recursive walk rather than a single `existsSync`, because the default
 * location is three directories deep under the temp root and its middle segments
 * are a version namespace and a shape digest — neither of which this suite
 * should have to know.
 *
 * @param directory - Where to look
 * @returns Sorted relative paths, empty when there are none
 */
function databasesUnder(directory: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const child = safePath.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(child);
      } else if (entry.name === PROJECTION_DATABASE) {
        found.push(safePath.relative(directory, child));
      }
    }
  };
  if (fs.existsSync(directory)) walk(directory);
  return found.sort((left, right) => left.localeCompare(right));
}

/**
 * The shared store's database file, as bytes.
 *
 * 🔑 The precondition every shared-store test here depends on, and the reason
 * this suite cannot go quietly vacuous: it asserts the file EXISTS and hands the
 * caller its contents so the call site can state what it expected to find in
 * them. SQLite stores text uncompressed, so a path that is in a row is in the
 * file — which makes a byte scan an honest answer to "are the foreign rows
 * available to leak?" without opening a second connection to a database the
 * command under test may still be holding.
 *
 * @returns The database's bytes
 */
function readSharedStoreFile(): Buffer {
  const database = safePath.join(sharedStoreDir(), PROJECTION_DATABASE);
  expect(fs.existsSync(database), `no store at ${database}`).toBe(true);
  return fs.readFileSync(database);
}

/**
 * Write a one-directory corpus and commit it, so `git write-tree` can key a store.
 *
 * @param options - The corpus
 * @param options.prefix - Temp-directory name prefix
 * @param options.directory - The one subdirectory its files live in
 * @param options.files - Basename to content, all inside `directory`
 * @returns The corpus root
 */
function createCommittedCorpus(options: {
  prefix: string;
  directory: string;
  files: Readonly<Record<string, string>>;
}): string {
  const root = createTestTempDir(options.prefix);
  fs.mkdirSync(safePath.join(root, options.directory), { recursive: true });
  for (const [name, content] of Object.entries(options.files)) {
    fs.writeFileSync(safePath.join(root, options.directory, name), content, 'utf-8');
  }
  const git = (args: string[]): void => {
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- fixture setup
    spawnSync('git', args, { cwd: root });
  };
  git(['init', '--quiet']);
  git(['add', '-A']);
  git(['-c', 'user.name=VAT Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture']);
  return root;
}

/** Run the verb and parse its document, failing loudly if it did not produce one. */
function query(sql: string, options?: { env?: NodeJS.ProcessEnv; cwd?: string }): {
  status: number | null;
  doc: Record<string, unknown>;
  stderr: string;
} {
  const result = executeCli(binPath, ['resources', 'query', sql], {
    cwd: options?.cwd ?? projectDir,
    ...(options?.env === undefined ? {} : { env: options.env }),
  });
  const doc = (yaml.parse(result.stdout) ?? {}) as Record<string, unknown>;
  return { status: result.status, doc, stderr: result.stderr };
}

describe('vat resources query', () => {
  beforeAll(() => {
    projectDir = createCommittedCorpus({
      prefix: 'vat-resources-query-',
      directory: OWN_PREFIX,
      files: {
        'a.md': '# Alpha\n\n## Beta\n\nSee [b](./b.md).\n',
        'b.md': '# Bravo\n',
      },
    });
    foreignDir = createCommittedCorpus({
      prefix: 'vat-resources-query-foreign-',
      directory: FOREIGN_PREFIX,
      files: { 'zzz.md': '# Zulu\n\n## Foreign Heading\n' },
    });
    storeDir = createTestTempDir('vat-resources-query-store-');

    // 🚨 The precondition the whole file rests on: the shared store now holds a
    // corpus the questions below are NOT about. Done once, in setup, so no test
    // depends on another having run first — the order dependency a suite-wide
    // shared cache otherwise buys.
    const warm = query(COUNT_REALIZATIONS, {
      cwd: foreignDir,
      env: storeEnv(),
    });
    expect(warm.status, warm.stderr).toBe(0);
  });

  afterAll(() => {
    cleanupTestTempDir(projectDir);
    cleanupTestTempDir(foreignDir);
    cleanupTestTempDir(storeDir);
  });

  it('answers a question about the blob tier, which no other resources command reports', () => {
    // The whole reason the verb exists. `vat resources scan` reports counts it
    // was written for; this reaches rows nothing surfaces. Headings are the
    // discriminator: they come from the blob stage, which the OTHER resources
    // lanes skip outright — so a non-zero count here proves this lane really
    // does derive content where its siblings deliberately do not.
    const { status, doc } = query('SELECT COUNT(*) AS n FROM blob_sections');

    expect(status).toBe(0);
    expect(doc['status']).toBe('success');
    expect(doc['rowCount']).toBe(1);
    const rows = doc['rows'] as { n: number }[];
    expect(rows[0]?.n).toBeGreaterThan(0);
  });

  it('gives the SAME answer with a store holding ANOTHER tree and with no store', () => {
    // 🚨 THE REGRESSION TEST. The store behind the second arm has been warmed by
    // a corpus this question is not about, so the two arms genuinely differ in
    // what the store could contribute.
    //
    // What it catches: the projection store is ONE database per VAT release,
    // shared by every root on the machine, and arbitrary SQL has no key
    // predicate — so a statement run against it answered from every repository
    // that ever warmed it. Against the pre-fix build this fixture's own three
    // rows become five, and on a developer machine 5,785.
    //
    // An UNFILTERED aggregate is the point. A `WHERE` clause narrow enough to
    // name this fixture's own files cannot see foreign rows, which is exactly
    // how the original suite passed.
    const withoutStore = query(COUNT_REALIZATIONS);
    const withStore = query(COUNT_REALIZATIONS, { env: storeEnv() });

    expect(withoutStore.status, withoutStore.stderr).toBe(0);
    expect(withStore.status, withStore.stderr).toBe(0);
    // The contamination was AVAILABLE. Without this the test could pass because
    // the directory stopped being shared, which is the vacuity it replaced.
    expect(readSharedStoreFile().includes(FOREIGN_PATH)).toBe(true);
    // This corpus is `docs/`, `docs/a.md`, `docs/b.md`. Stated absolutely as
    // well as compared, so two arms broken the same way cannot agree their way
    // to green.
    expect(withoutStore.doc['rows']).toStrictEqual([{ n: 3 }]);
    expect(withStore.doc['rows']).toStrictEqual(withoutStore.doc['rows']);
  });

  it('answers about THIS tree only, never about the other tree in the same store', () => {
    // The disclosure half of the same defect, asserted directly rather than
    // through a count. Every row this corpus has starts with `docs`; a row
    // starting with anything else came from the corpus that warmed the store,
    // and its link text, heading text and frontmatter are in the result set with
    // it.
    //
    // 🪤 No `isDirectory` filter. The predicate is prefix-only so the foreign
    // DIRECTORY row (`pkgs`) is caught too — an earlier version filtered
    // directories out and would have missed half the leak.
    const { status, doc, stderr } = query(
      `SELECT path FROM resource_realizations WHERE path NOT LIKE '${OWN_PREFIX}%' ORDER BY path`,
      { env: storeEnv() },
    );

    expect(status, stderr).toBe(0);
    // Same precondition, restated here rather than inherited: this is the
    // assertion of ABSENCE, and an absence is only meaningful once the thing
    // that could have been present is shown to exist.
    expect(readSharedStoreFile().includes(FOREIGN_PATH)).toBe(true);
    // Against the pre-fix build this is `[{ path: 'pkgs' }, { path: 'pkgs/zzz.md' }]`.
    expect(doc['rows']).toStrictEqual([]);
  });

  it('flips the cache tell from derived to store, in the directory it NAMED', () => {
    // 🔑 The claim the `population` field exists to make falsifiable. Two
    // correct runs produce identical ROWS, so the flip is the only observable
    // difference between a served population and a re-derived one.
    //
    // 🪤 The flip ALONE was vacuous. This fixture's tree hash is unique, so a
    // build that ignored `VAT_PROJECTION_STORE_DIR` entirely would still report
    // `derived` then `store` — from the developer's own live store, which it
    // would also be polluting. The store-location arms below are what make the
    // flip a statement about the directory this test named.
    const flipDir = safePath.join(storeDir, 'flip');
    const decoyTmp = safePath.join(storeDir, 'flip-default-location');
    const env = {
      ...storeEnv(),
      // Its OWN store directory, so the flip does not depend on which tests ran
      // first — the shared store above is already warm.
      VAT_PROJECTION_STORE_DIR: flipDir,
      ...tmpdirRedirect(decoyTmp),
    };
    const first = query(COUNT_BLOBS, { env });
    const second = query(COUNT_BLOBS, { env });

    expect(first.status, first.stderr).toBe(0);
    expect(second.status, second.stderr).toBe(0);
    expect(first.doc['population']).toBe('derived');
    expect(second.doc['population']).toBe('store');
    // And the answer did not move, which is what makes the flip a saving rather
    // than a difference.
    expect(second.doc['rows']).toStrictEqual(first.doc['rows']);
    // Where the store actually went. The positive half first, so the empty
    // second is an answer rather than a detector that never ran.
    expect(databasesUnder(flipDir)).toStrictEqual([PROJECTION_DATABASE]);
    expect(databasesUnder(decoyTmp)).toStrictEqual([]);
  });

  it('writes to the DEFAULT location when nothing names one, which is why the arm above means something', () => {
    // The positive control for `databasesUnder(decoyTmp)` being empty. Same
    // redirected temp root, same store selection, `VAT_PROJECTION_STORE_DIR`
    // withheld — and the database appears under it. Without this, "nothing was
    // written to the default location" is indistinguishable from "this suite
    // cannot see the default location at all".
    const decoyTmp = safePath.join(storeDir, 'default-location-control');
    const { status, stderr } = query(COUNT_BLOBS, {
      env: { ...storeSelectedEnv(), ...tmpdirRedirect(decoyTmp) },
    });

    expect(status, stderr).toBe(0);
    // `.vat-cache/<version>-dev-<digest>/projection-<shapeDigest>/projection.db`
    // — the middle segments are a namespace and a shape digest this suite has no
    // business pinning, which is why the shape is asserted and not the path.
    const found = databasesUnder(decoyTmp);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('.vat-cache/');
    expect(found[0]).toContain(`/${PROJECTION_DATABASE}`);
  });

  it('refuses a write at the engine and names the surface for a bad column', () => {
    // 🔑 The `WITH` prefix is deliberate — do NOT "simplify" it back to a bare
    // `DELETE`. That form is refused by the statement-KIND gate before it reaches
    // SQLite, which would leave this case asserting the gate's message and no
    // longer proving `PRAGMA query_only` is armed. This spelling is real SQLite
    // grammar, passes the kind gate on its first token, and is refused by the
    // ENGINE — which is the property under test.
    const write = query('WITH c(a) AS (VALUES (1)) DELETE FROM blobs');
    expect(write.status).toBe(2);
    expect(write.stderr).toContain('readonly database');

    const badColumn = query('SELECT contentHash FROM blobs');
    expect(badColumn.status).toBe(2);
    // The listing, which is what a user gets instead of a bare SQLite error.
    expect(badColumn.stderr).toContain('contentKey');
  });

  it('refuses a statement carrying a second statement', () => {
    // 🪤 SQLite compiles only the first and discards the rest WITHOUT error, so
    // the tail would be silently ignored. Nothing is destroyed; the caller's
    // intent is.
    const { status, stderr } = query('SELECT 1; DELETE FROM blobs');

    expect(status).toBe(2);
    expect(stderr).toContain('single statement');
  });

  it('refuses a second statement hidden behind a quoted IDENTIFIER', () => {
    // 🚨 The guard scanned `'`, `"`, `--` and `/* */` and knew nothing about
    // SQLite's other two identifier quotes. Given a backtick- or
    // bracket-quoted name containing an apostrophe, it walked in unaware, read
    // that apostrophe as opening a string, and swallowed the real `;` — so the
    // guard passed and the DELETE was discarded in silence, which is precisely
    // the intent-loss it exists to refuse.
    for (const sql of [
      "SELECT 1 AS `a'b`; DELETE FROM blobs WHERE 1=1",
      "SELECT 1 AS [a'b]; DELETE FROM blobs WHERE 1=1",
    ]) {
      const { status, stderr } = query(sql);
      expect(status, sql).toBe(2);
      expect(stderr, sql).toContain('single statement');
    }
  });

  it('accepts a legitimate identifier that merely CONTAINS a semicolon', () => {
    // The other direction of the same bug, and the control that stops the fix
    // being "refuse anything with a bracket in it". A `;` inside a quoted
    // identifier is not a separator.
    const { status, doc } = query('SELECT 1 AS [a;b]');

    expect(status).toBe(0);
    expect(doc['rowCount']).toBe(1);
  });
});
