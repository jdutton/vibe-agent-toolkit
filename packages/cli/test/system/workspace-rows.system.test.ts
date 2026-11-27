/**
 * The workspace relations through the real CLI: `vat resources query` over a tiny pnpm workspace
 * answers `workspace_packages` and `workspace_dependencies` alike store off and store on (cold and
 * warm); a row set evicted before the workspace step's declared read takes the lane's one retry;
 * and a refused step refuses a statement naming its relation, a CTE in its name refused too.
 *
 * Counted (spec 6.4), over the pnpm layout whose `.npmrc` decides the link
 * (`../helpers/workspace-rows.ts`):
 * - **warm unchanged:** nothing extracted, no data file read (by the `node:fs` probe or the content
 *   counters), and `rowSet.rows.decoded` exactly the head rows plus the declared reads' rows, none
 *   decoded twice;
 * - **secrets (6.1):** an `.npmrc` holding a sentinel in `_authToken`, `_auth`, `_password` and a
 *   `[section]`: after cold and warm runs store on and a run store off, the sentinel is in no byte of
 *   any file under the arms' cache and temp directories (the store, its WAL and SHM, a run database),
 *   nor in a report or on stderr; and the file's `data__nodes` are the root and
 *   `link-workspace-packages` alone.
 */

import { readdirSync, readFileSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TEST_EVICT_ROW_SET_BEFORE_DECLARED_READ_ENV } from '../../src/utils/projection-store.js';
import { answeredRows, countedQuery, countersOf, DATA_CONFIG, freshDataArm, type CountedQuery, type DataArm } from '../helpers/data-rows.js';
import { probedReads, readProbeEnv } from '../helpers/fs-read-probe.js';
import { layoutFiles, NPMRC_ON, PNPM_NPMRC_ON, routedPairsOf } from '../helpers/workspace-rows.js';
import { commitTestFixture, writeCorpus } from '../test-helpers.js';

import { createSuiteContext } from './test-common.js';

const PACKAGES_SQL = 'SELECT root, path, dir, name, version, private, workspaceRoot FROM workspace_packages ORDER BY path';
const DEPENDENCIES_SQL = 'SELECT path, field, name, range, targetPath, protocol FROM workspace_dependencies ORDER BY path, field, name';

/** A pnpm workspace: two members, one linking the other by `workspace:*`, one by a plain range `.npmrc` links. */
const PNPM_TREE: Readonly<Record<string, string>> = {
  'vibe-agent-toolkit.config.yaml': DATA_CONFIG,
  'README.md': '# Workspace\n',
  'package.json': '{"name": "root", "private": true, "packageManager": "pnpm@9.0.0"}\n',
  'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
  '.npmrc': 'link-workspace-packages=true\n',
  'packages/a/package.json': '{"name": "a", "version": "1.0.0", "dependencies": {"b": "workspace:*", "c": "^1.0.0", "react": "^18.0.0"}}\n',
  'packages/b/package.json': '{"name": "b", "version": "1.0.0"}\n',
  'packages/c/package.json': '{"name": "c", "version": "1.1.0"}\n',
};

/** A value no file but the secret `.npmrc` holds. */
const SENTINEL = 'npmrc-sentinel-6f0c2a9e';

/** An `.npmrc` of credentials, the setting among them, and a section. */
const SECRET_NPMRC = [
  `//registry.npmjs.org/:_authToken=${SENTINEL}`,
  `_auth=${SENTINEL}`,
  `_password=${SENTINEL}`,
  NPMRC_ON,
  '[section]',
  `key=${SENTINEL}`,
  '',
].join('\n');

/** `.npmrc`'s node rows, by pointer. */
const NPMRC_NODES_SQL = "SELECT n.pointer AS pointer FROM data__nodes n JOIN data__routes r ON r.blob = n.blob AND r.variant = n.variant WHERE r.path = '.npmrc' ORDER BY n.ordinal";

const context = createSuiteContext('vat-workspace-rows-', import.meta.url);
let cwd = '';
let refusedCwd = '';
let npmrcCwd = '';
let secretCwd = '';
beforeAll(() => {
  context.setup();
  npmrcCwd = writeCorpus(safePath.join(context.createTempDir(), 'npmrc'), layoutFiles(PNPM_NPMRC_ON));
  commitTestFixture(npmrcCwd);
  secretCwd = writeCorpus(safePath.join(context.createTempDir(), 'secret'), { ...layoutFiles(PNPM_NPMRC_ON), '.npmrc': SECRET_NPMRC });
  commitTestFixture(secretCwd);
  cwd = safePath.join(context.createTempDir(), 'pnpm');
  writeCorpus(cwd, PNPM_TREE);
  commitTestFixture(cwd);
  refusedCwd = safePath.join(context.createTempDir(), 'refused');
  writeCorpus(refusedCwd, { ...PNPM_TREE, 'pnpm-workspace.yaml': 'packages:\n  - packages/*\npackages:\n  - libs/*\n' });
  commitTestFixture(refusedCwd);
});
afterAll(() => context.cleanup());

const EXPECTED_PACKAGES = [
  { path: 'package.json', dir: '.', name: 'root', version: null, private: 1, workspaceRoot: 1 },
  { path: 'packages/a/package.json', dir: 'packages/a', name: 'a', version: '1.0.0', private: null, workspaceRoot: 0 },
  { path: 'packages/b/package.json', dir: 'packages/b', name: 'b', version: '1.0.0', private: null, workspaceRoot: 0 },
  { path: 'packages/c/package.json', dir: 'packages/c', name: 'c', version: '1.1.0', private: null, workspaceRoot: 0 },
];

const EXPECTED_DEPENDENCIES = [
  { path: 'packages/a/package.json', field: 'dependencies', name: 'b', range: 'workspace:*', targetPath: 'packages/b/package.json', protocol: 'workspace' },
  { path: 'packages/a/package.json', field: 'dependencies', name: 'c', range: '^1.0.0', targetPath: 'packages/c/package.json', protocol: 'npm' },
  { path: 'packages/a/package.json', field: 'dependencies', name: 'react', range: '^18.0.0', targetPath: null, protocol: 'npm' },
];

/** @returns The rows without their root id, which is the run's own */
function rootless(rows: readonly Record<string, unknown>[]): Array<Record<string, unknown>> {
  return rows.map(({ root: _root, ...rest }) => rest);
}

describe('the workspace relations through vat resources query', () => {
  it.each([
    { name: 'store off', storeOff: true },
    { name: 'store on', storeOff: false },
  ])('$name: workspace_packages and workspace_dependencies, cold and warm alike', async ({ storeOff }) => {
    const arm: DataArm = freshDataArm(context, storeOff);
    const cold = await countedQuery(context, cwd, arm, PACKAGES_SQL);
    expect(rootless(answeredRows(cold))).toEqual(EXPECTED_PACKAGES);
    const warm = await countedQuery(context, cwd, arm, PACKAGES_SQL);
    expect(answeredRows(warm)).toEqual(answeredRows(cold));
    if (!storeOff) expect(countersOf(warm.counters, ['rowSet.extracted'])['rowSet.extracted'], 'a warm run extracts nothing').toBe(0);
    expect(answeredRows(await countedQuery(context, cwd, arm, DEPENDENCIES_SQL))).toEqual(EXPECTED_DEPENDENCIES);
  });

  // Red, seeded once and reverted: the step swallowing the eviction and answering no rows (so the
  // lane never retries) failed this test and the next, 2 failures.
  it('store on: a row set evicted before the step\'s declared read retries once, extracting it again, and answers the same', async () => {
    const unseeded = await countedQuery(context, cwd, freshDataArm(context, false), PACKAGES_SQL);
    const seeded = await countedQuery(context, cwd, freshDataArm(context, false), PACKAGES_SQL, { [TEST_EVICT_ROW_SET_BEFORE_DECLARED_READ_ENV]: '1' });
    expect(rootless(answeredRows(seeded))).toEqual(EXPECTED_PACKAGES);
    const extracted = (run: typeof seeded): number => countersOf(run.counters, ['rowSet.extracted'])['rowSet.extracted'];
    expect(extracted(seeded), 'the retry extracts exactly the evicted row set again').toBe(extracted(unseeded) + 1);
  });

  it('store on: evicted again on the retry, the run refuses', async () => {
    const run = await countedQuery(context, cwd, freshDataArm(context, false), PACKAGES_SQL, { [TEST_EVICT_ROW_SET_BEFORE_DECLARED_READ_ENV]: '1,2' });
    expect(run.status).not.toBe(0);
    expect((run.document['error'] as { message: string }).message).toContain('It happened again on the run\'s one retry');
  });

  it('a refused step refuses a statement naming its relation, naming the code and the file', async () => {
    const run = await countedQuery(context, refusedCwd, freshDataArm(context, true), PACKAGES_SQL);
    expect(run.status).not.toBe(0);
    const error = run.document['error'] as { code: string; message: string };
    expect(error.code).toBe('INPUT_UNREADABLE');
    expect(error.message).toContain('WORKSPACE_DUPLICATE_KEY');
    expect(error.message).toContain('pnpm-workspace.yaml');
    // data__values over the same file still answers.
    const values = await countedQuery(context, refusedCwd, freshDataArm(context, true), 'SELECT pointer, value FROM data__values WHERE path = \'pnpm-workspace.yaml\' AND pointer = \'/packages/0\'');
    expect(answeredRows(values)).toEqual([{ pointer: '/packages/0', value: 'libs/*' }]);
  });

  it('a CTE named after a workspace relation is refused', async () => {
    const run = await countedQuery(context, cwd, freshDataArm(context, true), 'WITH workspace_packages AS (SELECT 1 AS x) SELECT x FROM workspace_packages');
    expect(run.status).not.toBe(0);
    expect((run.document['error'] as { message: string }).message).toContain('reserved relation name');
  });
});

/** Names both stored-row consumers the step feeds: the members and every dependency. */
const BOTH_SQL = 'SELECT path, name, range, targetPath FROM workspace_dependencies ORDER BY path, field, name';

/** Per routed path: its node rows (shadowed included) and its condition rows, as the store holds them. */
const ROWS_PER_PATH_SQL = [
  'SELECT r.path AS path,',
  '(SELECT count(*) FROM data__nodes n WHERE n.blob = r.blob AND n.variant = r.variant) AS nodes,',
  '(SELECT count(*) FROM data__conditions c WHERE c.blob = r.blob AND c.variant = r.variant) AS conditions',
  'FROM data__routes r ORDER BY r.path',
].join(' ');

/** The files the step reads under the npmrc layout: the root's three inputs and the members (never `ignored` or `test`). */
const DECLARED_READS: ReadonlySet<string> = new Set(['package.json', 'pnpm-workspace.yaml', '.npmrc', 'packages/a/package.json', 'packages/b/package.json', 'packages/c/package.json']);

/** The rows the step decodes: every declared read's nodes, and pnpm-workspace.yaml's conditions too (the one file whose duplicate keys it judges). */
function declaredRowsOf(perPath: readonly Record<string, unknown>[]): number {
  return perPath
    .filter((row) => DECLARED_READS.has(String(row['path'])))
    .reduce((sum, row) => sum + Number(row['nodes']) + (row['path'] === 'pnpm-workspace.yaml' ? Number(row['conditions']) : 0), 0);
}

describe('the workspace relations, counted', () => {
  // Reds, each seeded once in `workspace-packages.ts` and reverted:
  // - `readMembers` reading `dataConditions` beside `dataNodes`: rowSet.rows.decoded 45 for 44, 1 failure;
  // - `workspaceDeclaration` reading `.npmrc` from disk (`readFileSync`) as well: "data files the warm
  //   run read from disk", ['.npmrc'], 1 failure.
  it('warm unchanged: nothing extracted, no data file read, the head rows and the declared reads\' rows each decoded once', async () => {
    const perPath = answeredRows(await countedQuery(context, npmrcCwd, freshDataArm(context, true), ROWS_PER_PATH_SQL));
    const pairs = routedPairsOf(PNPM_NPMRC_ON);
    expect(perPath, 'the routed pairs').toHaveLength(pairs);
    const arm = freshDataArm(context, false);
    const cold = await countedQuery(context, npmrcCwd, arm, BOTH_SQL);
    const probeDir = context.createTempDir();
    const warm = await countedQuery(context, npmrcCwd, arm, BOTH_SQL, readProbeEnv(probeDir, npmrcCwd));
    expect(answeredRows(warm)).toEqual(answeredRows(cold));
    // Positive control: `.npmrc` decides the link, so the step read it.
    expect(answeredRows(warm).find((row) => row['name'] === 'b' && row['range'] === '^1.0.0')?.['targetPath'], 'the plain range .npmrc links').toBe('packages/b/package.json');
    expect(countersOf(warm.counters, ['rowSet.extracted', 'rowSet.storeServed', 'rowSet.rows.decoded', 'store.rows.decoded.repeated', 'content.read', 'content.gitRead'])).toEqual({
      'rowSet.extracted': 0,
      'rowSet.storeServed': pairs,
      'rowSet.rows.decoded': pairs + declaredRowsOf(perPath),
      'store.rows.decoded.repeated': 0,
      'content.read': 0,
      'content.gitRead': 0,
    });
    const { reads, dumps } = probedReads(probeDir);
    expect(dumps, 'the probe dumped').toBeGreaterThan(0);
    const dataFiles = Object.keys(PNPM_NPMRC_ON.files);
    expect([...reads.keys()].filter((path) => dataFiles.includes(path)), 'data files the warm run read from disk').toEqual([]);
  });

  // Red, seeded once and reverted: `data-ini.ts` `keptOccurrences` storing every scalar key and reading
  // past a `[section]` (the allowlist and the section stop removed): "files holding the sentinel",
  // the store's `projection.db`, 1 failure (the report and data__nodes checks after it would fail too:
  // the nodes held `/~1~1registry.npmjs.org~1:_authToken`, `/_auth`, `/_password` and the section's key).
  it('secrets: no byte of an .npmrc credential reaches the store, a run database, a report or stderr', async () => {
    const on = freshDataArm(context, false);
    const off = freshDataArm(context, true);
    const runs: CountedQuery[] = [];
    for (const [arm, sql] of [[on, NPMRC_NODES_SQL], [on, BOTH_SQL], [on, NPMRC_NODES_SQL], [off, NPMRC_NODES_SQL]] as const) {
      // In order: cold, then warm over what cold stored.
      runs.push(await countedQuery(context, secretCwd, arm, sql));
    }
    const files = [on, off].flatMap((arm) => [...filesUnder(arm.cacheDir), ...filesUnder(arm.tmpDir)]);
    // Positive control: the scan reads the store's own bytes, where the allowlisted key is held.
    expect(files.filter((file) => file.endsWith('projection.db')), 'the store file').toHaveLength(1);
    expect(files.some((file) => readFileSync(file).includes('link-workspace-packages')), 'the stored key, found by the same scan').toBe(true);
    expect(files.filter((file) => readFileSync(file).includes(SENTINEL)), 'files holding the sentinel').toEqual([]);
    for (const run of runs) {
      expect(JSON.stringify(run.document), 'the report').not.toContain(SENTINEL);
      expect(run.stderr, 'stderr').not.toContain(SENTINEL);
    }
    for (const run of runs.filter((_run, index) => index !== 1)) {
      expect(answeredRows(run).map((row) => row['pointer']), '.npmrc\'s data__nodes').toEqual(['', '/link-workspace-packages']);
    }
    expect(answeredRows(runs[1] as CountedQuery).find((row) => row['name'] === 'b' && row['range'] === '^1.0.0')?.['targetPath'], 'the setting still read').toBe('packages/b/package.json');
  });
});

/** Every file under a directory, recursively; a symbolic link is refused (nothing here makes one, and a byte scan must not skip one). */
function filesUnder(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true }).flatMap((entry) => {
    if (entry.isSymbolicLink()) throw new Error(`a symbolic link under ${root}: ${entry.name}`);
    return entry.isFile() ? [safePath.join(entry.parentPath, entry.name)] : [];
  });
}
