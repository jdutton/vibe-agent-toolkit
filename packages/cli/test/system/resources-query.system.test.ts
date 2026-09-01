/**
 * `vat resources query` end to end.
 *
 * ## What only a spawn can prove here
 *
 * The payload's shape and the failure wording are pinned as pure unit tests
 * (`test/commands/resources-query-payload.test.ts`). What is left for a spawn is
 * everything the unit tests cannot reach: that a real tree populates, that the
 * blob tier is actually there to query, that the engine refuses a write, and —
 * the one this file exists for — that the **cache tell flips** when a store is
 * put behind the same question.
 *
 * ## 🔑 The cache tell needs two runs and a git repository
 *
 * A projection store is keyed on `git write-tree`, so a corpus outside a
 * repository is refused a key and populates uncached — the command says so on
 * stderr rather than silently declining. The fixture therefore commits, and the
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

let projectDir: string;

/**
 * Where this suite's stores live — OUTSIDE the corpus, deliberately.
 *
 * 🪤 A store under `projectDir` is a member of the tree it is caching. Writing
 * it changes the working tree, which changes `git write-tree`, which changes the
 * store key — so every run misses, the cache tell never flips, and the database
 * file itself shows up as a row in `resource_realizations`. Both symptoms are
 * confusing and neither points at the cause.
 */
let storeDir: string;

/** The store this suite writes, kept beneath the fixture so cleanup takes it. */
function storeEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    VAT_PROJECTION_STORE: 'sqlite',
    // 🪤 `VAT_PROJECTION_STORE_DIR`, and nothing else works. This read
    // `XDG_CACHE_HOME` + `HOME` and its comment claimed isolation it did not
    // have: `defaultStoreDirectory()` is under `tmpdir()` and consults neither,
    // so every run in this suite was writing into the developer's own store —
    // and the "first run is derived" arm survived only because the fixture's
    // tree hash happened to be unique, not because of anything here.
    VAT_PROJECTION_STORE_DIR: safePath.join(storeDir, 'shared'),
  };
}

/** Run the verb and parse its document, failing loudly if it did not produce one. */
function query(sql: string, env?: NodeJS.ProcessEnv): { status: number | null; doc: Record<string, unknown>; stderr: string } {
  const result = executeCli(binPath, ['resources', 'query', sql], {
    cwd: projectDir,
    ...(env === undefined ? {} : { env }),
  });
  const doc = (yaml.parse(result.stdout) ?? {}) as Record<string, unknown>;
  return { status: result.status, doc, stderr: result.stderr };
}

describe('vat resources query', () => {
  beforeAll(() => {
    projectDir = createTestTempDir('vat-resources-query-');
    storeDir = createTestTempDir('vat-resources-query-store-');
    fs.mkdirSync(safePath.join(projectDir, 'docs'), { recursive: true });
    fs.writeFileSync(
      safePath.join(projectDir, 'docs/a.md'),
      '# Alpha\n\n## Beta\n\nSee [b](./b.md).\n',
      'utf-8',
    );
    fs.writeFileSync(safePath.join(projectDir, 'docs/b.md'), '# Bravo\n', 'utf-8');
    // Committed, so `git write-tree` can key a store — see the header.
    const git = (args: string[]): void => {
      // eslint-disable-next-line sonarjs/no-os-command-from-path -- fixture setup
      spawnSync('git', args, { cwd: projectDir });
    };
    git(['init', '--quiet']);
    git(['add', '-A']);
    git(['-c', 'user.name=VAT Fixture', '-c', 'user.email=fixture@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture']);
  });

  afterAll(() => {
    cleanupTestTempDir(projectDir);
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

  it('gives the SAME answer with a store and without one', () => {
    // 🚨 THE REGRESSION TEST. This is the assertion whose absence let a real
    // defect ship: the suite compared store-to-store and used a `WHERE path =`
    // filter that masked everything else, so nothing ever held the two
    // configurations against each other.
    //
    // What it caught: the projection store is ONE database per VAT release,
    // shared by every root on the machine, and arbitrary SQL has no key
    // predicate — so a statement ran against it answered from every repository
    // on the box. Measured on this two-file fixture before the fix:
    // `COUNT(*) FROM resource_realizations` returned 3 with no store and
    // **5,779** with one, and `WHERE path LIKE 'packages/%'` returned files from
    // a different repository entirely.
    //
    // An UNFILTERED aggregate is the point. A `WHERE` clause narrow enough to
    // name this fixture's own files cannot see foreign rows, which is exactly
    // how the original suite passed.
    const sql = 'SELECT COUNT(*) AS n FROM resource_realizations';
    const withoutStore = query(sql);
    const withStore = query(sql, storeEnv());

    expect(withoutStore.status).toBe(0);
    expect(withStore.status).toBe(0);
    expect(withStore.doc['rows']).toStrictEqual(withoutStore.doc['rows']);
  });

  it('answers about THIS tree only, never about another repository', () => {
    // The disclosure half of the same defect, asserted directly rather than
    // through a count. This fixture has two markdown files under `docs/`; a row
    // whose path starts with anything else came from a corpus this command was
    // not pointed at, and its link text, heading text and frontmatter are in the
    // result set with it.
    const { status, doc } = query(
      "SELECT path FROM resource_realizations WHERE path NOT LIKE 'docs/%' AND isDirectory = 0",
      storeEnv(),
    );

    expect(status).toBe(0);
    expect(doc['rows']).toStrictEqual([]);
  });

  it('flips the cache tell from derived to store on the second run', () => {
    // 🔑 The claim the `population` field exists to make falsifiable. Two
    // correct runs produce identical ROWS, so the flip is the only observable
    // difference between a served population and a re-derived one.
    // Its OWN store directory, so the flip does not depend on which tests ran
    // first. Sharing one with the tests above made this fail the moment another
    // test warmed it — an order dependency that is invisible in isolation and is
    // exactly what a suite-wide shared cache buys.
    const env = { ...storeEnv(), VAT_PROJECTION_STORE_DIR: safePath.join(storeDir, 'flip') };
    const first = query('SELECT COUNT(*) AS n FROM blobs', env);
    const second = query('SELECT COUNT(*) AS n FROM blobs', env);

    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(first.doc['population']).toBe('derived');
    expect(second.doc['population']).toBe('store');
    // And the answer did not move, which is what makes the flip a saving rather
    // than a difference.
    expect(second.doc['rows']).toStrictEqual(first.doc['rows']);
  });

  it('refuses a write at the engine and names the surface for a bad column', () => {
    const write = query('DELETE FROM blobs');
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
