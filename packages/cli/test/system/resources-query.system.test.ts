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

/** The store this suite writes, kept beneath the fixture so cleanup takes it. */
function storeEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    VAT_PROJECTION_STORE: 'sqlite',
    // Beneath the fixture, so the suite never reads or writes the developer's
    // own store — a shared one would make the first run a HIT and delete the
    // only arm that proves the flip.
    XDG_CACHE_HOME: safePath.join(projectDir, '.cache'),
    HOME: projectDir,
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

  it('answers with no store selected, from an in-memory database', () => {
    // The capability rule: an answer must not depend on whether a cache
    // happened to exist. With no `VAT_PROJECTION_STORE` the same SQL runs
    // against an ephemeral store built from the same projection.
    const { status, doc } = query("SELECT path FROM resource_realizations WHERE path = 'docs/a.md'");

    expect(status).toBe(0);
    expect(doc['engine']).toBe('ephemeral');
    // An ephemeral engine can only ever have derived — there is nothing to hit.
    expect(doc['population']).toBe('derived');
    expect(doc['rowCount']).toBe(1);
  });

  it('flips the cache tell from derived to store on the second run', () => {
    // 🔑 The claim the `population` field exists to make falsifiable. Two
    // correct runs produce identical ROWS, so the flip is the only observable
    // difference between a served population and a re-derived one.
    const env = storeEnv();
    const first = query('SELECT COUNT(*) AS n FROM blobs', env);
    const second = query('SELECT COUNT(*) AS n FROM blobs', env);

    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(first.doc['engine']).toBe('sqlite');
    expect(second.doc['engine']).toBe('sqlite');
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
});
