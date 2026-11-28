/**
 * The `tsconfig_*` relations through the built CLI (`vat resources query` and `vat resources check`):
 * the tsconfig resolve step run by the data stage over the run's git content and parse dispatcher,
 * its refusals published under every `tsconfig_*` name, and the TypeScript version that answered
 * published in the document's `data` and on stderr.
 *
 * Proved here, over one repository of sub-projects built once for the suite (each sub-project's own
 * `vibe-agent-toolkit.config.yaml` makes it the analysis root, so `..` leaves it):
 * - **the answer and its version**, store off, cold and warm, for query and check;
 * - **the shared-base decode** (spec 7.1): three configs extend one chain three deep; store on, cold
 *   and warm, `rowSet.rows.decoded` is the routed pairs' head rows plus the node rows of exactly the
 *   files the step read, and `store.rows.decoded.repeated` is zero;
 * - **every PR4a refusal** (spec 7.6), each with exactly one outcome: an unrouted and an `exclude`d
 *   `extends` target (`DATA_REQUEST_UNROUTED` naming config, target and reason); a gitignored and a
 *   `node_modules` `extends` target (`TSCONFIG_PARSE_ERRORS`, with the TS code TypeScript gives); an
 *   `extends`, a `../shared/**` include, a reference and a `-p` outside the root (each its
 *   `*_OUTSIDE_ROOT` code); TS18003 for ignored-only inputs on a clean and a built tree and for a
 *   non-existent include directory; a vendored-TypeScript load failure (`ParserUnavailableError`).
 *
 * `git` off `PATH` and outside a work tree are in `git-content.system.test.ts`, run for a `tsconfig_*`
 * statement beside `git_content`. The deep-config seed and the main-thread module list are in
 * `module-load-budget.integration.test.ts`, which reads what each thread loaded.
 */

import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { mkdirSyncReal, resolveFromImportMeta, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { answeredRows, countedQuery, countersOf, DATA_CONFIG, freshDataArm, refusalOf, type CountedQuery } from '../helpers/data-rows.js';
import { commitTestFixture, writeCorpus } from '../test-helpers.js';

import { createSuiteContext, executeCli, isolatedScratchEnv } from './test-common.js';

/** The version of the TypeScript VAT vendors, read off the built copy: what every answer must name. */
const VENDORED_VERSION = (createRequire(import.meta.url)(resolveFromImportMeta(import.meta.url, '../../../resources/dist/vendor/typescript.cjs')) as { version: string }).version;

/** The stderr line a run that parsed configs writes. */
const VERSION_LINE = `tsconfig_* relations answered by VAT's vendored TypeScript ${VENDORED_VERSION}`;

const FILES_SQL = 'SELECT config, path FROM tsconfig_files ORDER BY config, path';

/** A build script compiling `project`. */
function buildPackage(project = 'tsconfig.json'): string {
  const build = `tsc -p ${project}`;
  return `${JSON.stringify({ name: 'fixture', private: true, scripts: { build } })}\n`;
}

/** A sub-project: its config, a README so the population is not empty, a build script and the files given. */
function subProject(files: Readonly<Record<string, string>>, config = DATA_CONFIG): Record<string, string> {
  return { 'vibe-agent-toolkit.config.yaml': config, 'README.md': '# Fixture\n', 'package.json': buildPackage(), 'src/a.ts': 'export const a = 1;\n', ...files };
}

/** @returns `value` as a config's text */
function config(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Prefix every path of `files` with `dir/`. */
function under(dir: string, files: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(files).map(([path, text]) => [`${dir}/${path}`, text]));
}

/** The shared-base project: three packages each extending a chain three deep. */
const SHARED_BASE: Readonly<Record<string, string>> = {
  'vibe-agent-toolkit.config.yaml': DATA_CONFIG,
  'README.md': '# Shared base\n',
  'package.json': `${JSON.stringify({ name: 'root', private: true, scripts: { a: 'tsc -p packages/a', b: 'tsc -p packages/b', c: 'tsc -p packages/c' } })}\n`,
  ...Object.fromEntries(['a', 'b', 'c'].flatMap((name) => [
    [`packages/${name}/tsconfig.json`, config({ extends: '../../configs/tsconfig.lib.json', compilerOptions: { outDir: `dist-${name}` } })],
    [`packages/${name}/src/index.ts`, `export const ${name} = 1;\n`],
  ])),
  'configs/tsconfig.lib.json': config({ extends: './tsconfig.mid.json' }),
  'configs/tsconfig.mid.json': config({ extends: './tsconfig.base.json' }),
  'configs/tsconfig.base.json': config({ compilerOptions: { strict: true }, include: ['${configDir}/src'] }),
};

/** The configs and package files the step reads over {@link SHARED_BASE}: every routed pair. */
const SHARED_BASE_READS = Object.keys(SHARED_BASE).filter((path) => path.endsWith('.json'));

/** A config yaml that routes `configs/**` away from the data instance. */
const EXCLUDING_CONFIG = `${DATA_CONFIG}  extractors:\n    data:\n      exclude:\n        - "configs/**"\n`;

/** A check over `tsconfig_files`, so `vat resources check` demands the family too. */
const CHECK_CONFIG = `${DATA_CONFIG}  checks:\n    ts-members:\n      description: Every file a config compiles\n      sql: "SELECT path FROM tsconfig_files ORDER BY path"\n      severity: warning\n`;

/** Every sub-project of the suite's repository, by directory. */
const PROJECTS: Readonly<Record<string, Record<string, string>>> = {
  basic: subProject({ 'tsconfig.json': config({ include: ['src'] }) }, CHECK_CONFIG),
  shared: { ...SHARED_BASE },
  unrouted: subProject({ 'tsconfig.json': config({ extends: './base.json', include: ['src'] }), 'base.json': config({}) }),
  excluded: subProject({ 'tsconfig.json': config({ extends: './configs/tsconfig.base.json', include: ['src'] }), 'configs/tsconfig.base.json': config({}) }, EXCLUDING_CONFIG),
  ignored: subProject({ 'tsconfig.json': config({ extends: './gen/tsconfig.base.json', include: ['src'] }) }),
  modules: subProject({ 'tsconfig.json': config({ extends: '@fixture/tsconfig/tsconfig.json', include: ['src'] }) }),
  'outside-extends': subProject({ 'tsconfig.json': config({ extends: '../shared-configs/tsconfig.json', include: ['src'] }) }),
  'outside-include': subProject({ 'tsconfig.json': config({ include: ['src', '../shared-configs/**/*'] }) }),
  'outside-reference': subProject({ 'tsconfig.json': config({ include: ['src'], references: [{ path: '../shared-configs' }] }) }),
  'outside-p': { ...subProject({ 'tsconfig.json': config({ include: ['src'] }) }), 'package.json': buildPackage('../shared-configs/tsconfig.json') },
  'ignored-only': subProject({ 'tsconfig.json': config({ include: ['gen/**/*'] }) }),
  'no-include-dir': subProject({ 'tsconfig.json': config({ include: ['nope/**/*'] }) }),
};

const context = createSuiteContext('vat-tsconfig-rows-', import.meta.url);
let repo = '';

/** @returns The sub-project's absolute directory */
function project(name: keyof typeof PROJECTS): string {
  return safePath.join(repo, name);
}

beforeAll(() => {
  context.setup();
  repo = safePath.join(context.createTempDir(), 'repo');
  writeCorpus(repo, {
    '.gitignore': 'gen/\nnode_modules/\n',
    'shared-configs/tsconfig.json': config({ include: ['*.ts'] }),
    'shared-configs/s.ts': 'export const s = 1;\n',
    ...Object.fromEntries(Object.entries(PROJECTS).flatMap(([dir, files]) => Object.entries(under(dir, files)))),
  });
  // Present on disk, never git content: a gitignored base, and a package's base under node_modules.
  writeCorpus(repo, {
    'ignored/gen/tsconfig.base.json': config({}),
    'modules/node_modules/@fixture/tsconfig/package.json': `${JSON.stringify({ name: '@fixture/tsconfig', version: '1.0.0' })}\n`,
    'modules/node_modules/@fixture/tsconfig/tsconfig.json': config({}),
  });
  commitTestFixture(repo);
});
afterAll(() => context.cleanup());

/** The document's `data` block. */
function dataOf(document: Record<string, unknown>): Record<string, unknown> {
  return (document['data'] ?? {}) as Record<string, unknown>;
}

/** One store-off query of `sql` in a sub-project. */
function storeOffQuery(name: keyof typeof PROJECTS, sql = FILES_SQL, env: Readonly<Record<string, string>> = {}): Promise<CountedQuery> {
  return countedQuery(context, project(name), freshDataArm(context, true), sql, env);
}

describe('the tsconfig_* relations answer, with the TypeScript version that answered (system test)', () => {
  it('store off, cold and warm: the same rows; the version in data and on stderr', async () => {
    const arm = freshDataArm(context, false);
    const runs = [
      await countedQuery(context, project('basic'), freshDataArm(context, true), FILES_SQL),
      await countedQuery(context, project('basic'), arm, FILES_SQL),
      await countedQuery(context, project('basic'), arm, FILES_SQL),
    ];
    expect(dataOf(runs[2]?.document ?? {})['population'], 'premise: the warm run is served from the store').toBe('store');
    for (const run of runs) {
      expect(answeredRows(run)).toEqual([{ config: 'tsconfig.json', path: 'src/a.ts' }]);
      expect(dataOf(run.document)['typescriptVersion']).toBe(VENDORED_VERSION);
      expect(run.stderr).toContain(VERSION_LINE);
      expect(countersOf(run.counters, ['resolve.tsconfig.configs', 'resolve.tsconfig.waves'])).toEqual({ 'resolve.tsconfig.configs': 1, 'resolve.tsconfig.waves': 1 });
    }
    // A tsconfig_* demand served its extent checks the tree is listable, as a git_content one does.
    expect(runs.map((run) => run.counters['git.listings'])).toEqual([0, 0, 1]);
  });

  it('a run naming no tsconfig_* relation publishes no version and loads no TypeScript', async () => {
    const run = await storeOffQuery('basic', 'SELECT path FROM resource_realizations ORDER BY path');
    expect(answeredRows(run).length).toBeGreaterThan(0);
    expect(dataOf(run.document)).not.toHaveProperty('typescriptVersion');
    expect(run.stderr).not.toContain('vendored TypeScript');
    expect(run.counters['resolve.tsconfig.waves']).toBe(0);
  });

  it('vat resources check publishes the version too, and the check reads the rows', async () => {
    const scratch = context.createTempDir();
    for (const dir of ['home/.claude', 'tmp']) mkdirSyncReal(safePath.join(scratch, dir), { recursive: true });
    const result = await executeCli(context.binPath, ['resources', 'check', '--format', 'json'], {
      cwd: project('basic'),
      env: { ...isolatedScratchEnv(scratch), VAT_CACHE_DIR: context.createTempDir(), VAT_PROJECTION_STORE: 'off' },
    });
    const document = JSON.parse(result.stdout) as { data?: Record<string, unknown>; findings?: Array<Record<string, unknown>> };
    expect((document.findings ?? []).filter((finding) => finding['check'] === 'ts-members').map((finding) => finding['location']), `${result.stdout}\n${result.stderr}`).toEqual(['src/a.ts']);
    expect(document.data?.['typescriptVersion']).toBe(VENDORED_VERSION);
    expect(result.stderr).toContain(VERSION_LINE);
  });
});

/** Per routed path: its node rows. */
const NODES_PER_PATH_SQL = 'SELECT r.path AS path, (SELECT count(*) FROM data__nodes n WHERE n.blob = r.blob AND n.variant = r.variant) AS nodes FROM data__routes r ORDER BY r.path';

describe('the shared-base decode (system test)', () => {
  // Red, seeded in the step's unit test (every wave re-reading all demanded configs): the same
  // equality there failed, 7 against 16.
  it('store on, cold and warm: the head rows plus the node rows of exactly the files read, none twice', async () => {
    const perPath = answeredRows(await storeOffQuery('shared', NODES_PER_PATH_SQL));
    expect(perPath.map((row) => row['path']), 'premise: every json file is routed').toEqual(SHARED_BASE_READS.toSorted((a, b) => a.localeCompare(b)));
    const nodesRead = perPath.reduce((sum, row) => sum + Number(row['nodes']), 0);
    const pairs = perPath.length;
    const arm = freshDataArm(context, false);
    const cold = await countedQuery(context, project('shared'), arm, FILES_SQL);
    const warm = await countedQuery(context, project('shared'), arm, FILES_SQL);
    expect(dataOf(warm.document)['population'], 'premise: the warm run is served from the store').toBe('store');
    for (const [name, run] of [['cold', cold], ['warm', warm]] as const) {
      expect(answeredRows(run).map((row) => row['config']), name).toEqual(['packages/a/tsconfig.json', 'packages/b/tsconfig.json', 'packages/c/tsconfig.json']);
      expect(countersOf(run.counters, ['rowSet.rows.decoded', 'store.rows.decoded.repeated', 'resolve.tsconfig.waves']), name).toEqual({
        'rowSet.rows.decoded': pairs + nodesRead,
        'store.rows.decoded.repeated': 0,
        // The package.json read, the demanded configs, then one per extends level.
        'resolve.tsconfig.waves': 4,
      });
    }
    expect(countersOf(warm.counters, ['rowSet.extracted', 'rowSet.storeServed'])).toEqual({ 'rowSet.extracted': 0, 'rowSet.storeServed': pairs });
  });
});

describe('every PR4a refusal, with exactly one outcome (system test)', () => {
  it.each([
    { name: 'unrouted', reason: 'no rule of resources.extractors.data routes it', target: 'base.json' },
    { name: 'excluded', reason: 'resources.extractors.data.exclude routes it away', target: 'configs/tsconfig.base.json' },
  ] as const)('an $name extends target: DATA_REQUEST_UNROUTED naming the config, the target and the reason', async ({ name, reason, target }) => {
    const { code, message } = refusalOf(await storeOffQuery(name));
    expect(code).toBe('INPUT_UNREADABLE');
    expect(message).toContain('This statement reads tsconfig_files');
    expect(message).toContain('DATA_REQUEST_UNROUTED:');
    expect(message).toContain(`'tsconfig.json' needs '${target}' (jsonc)`);
    expect(message).toContain(reason);
  });

  it.each([
    // A relative `.json` target TypeScript cannot read is TS5083; a package name it cannot find, TS6053.
    { name: 'ignored', ts: 'TS5083' },
    { name: 'modules', ts: 'TS6053' },
  ] as const)('a $name extends target is no file: TSCONFIG_PARSE_ERRORS ($ts)', async ({ name, ts }) => {
    const { code, message } = refusalOf(await storeOffQuery(name));
    expect(code).toBe('INPUT_UNREADABLE');
    expect(message).toContain(`TSCONFIG_PARSE_ERRORS: TypeScript parses 'tsconfig.json' with errors (${ts})`);
  });

  it.each([
    { name: 'outside-extends', code: 'TSCONFIG_EXTENDS_OUTSIDE_ROOT' },
    { name: 'outside-include', code: 'TSCONFIG_INPUTS_OUTSIDE_ROOT' },
    { name: 'outside-reference', code: 'TSCONFIG_REFERENCE_OUTSIDE_ROOT' },
    { name: 'outside-p', code: 'TSCONFIG_INVOKED_OUTSIDE_ROOT' },
  ] as const)('$name: $code, naming the analysis-root remedy', async ({ name, code }) => {
    const refusal = refusalOf(await storeOffQuery(name));
    expect(refusal.code).toBe('INPUT_UNREADABLE');
    expect(refusal.message).toContain(`${code}:`);
    expect(refusal.message).toContain('the analysis root is the directory of the nearest vibe-agent-toolkit.config.yaml');
  });

  it('TS18003: ignored-only inputs on a clean and a built tree, and a non-existent include directory', async () => {
    const expected = { code: 'INPUT_UNREADABLE', message: expect.stringContaining('TSCONFIG_PARSE_ERRORS: TypeScript parses \'tsconfig.json\' with errors (TS18003)') };
    expect(refusalOf(await storeOffQuery('ignored-only'))).toEqual(expected);
    // The build writes the inputs; they are ignored, so never git content.
    writeCorpus(project('ignored-only'), { 'gen/out.ts': 'export const out = 1;\n' });
    expect(refusalOf(await storeOffQuery('ignored-only'))).toEqual(expected);
    expect(refusalOf(await storeOffQuery('no-include-dir'))).toEqual(expected);
  });

  it('a vendored TypeScript that cannot load: ParserUnavailableError, and nothing answers', async () => {
    // A module hook, inherited by the parse worker, that fails the import of the vendored file.
    const hooks = safePath.join(context.createTempDir(), 'fail-vendored-typescript.mjs');
    writeFileSync(hooks, [
      'export async function resolve(specifier, context, next) {',
      "  if (specifier.endsWith('vendor/typescript.cjs')) throw new Error('vendored TypeScript removed by the test');",
      '  return next(specifier, context);',
      '}',
      '',
    ].join('\n'));
    const register = safePath.join(context.createTempDir(), 'register.mjs');
    writeFileSync(register, `import { register } from 'node:module';\nimport { pathToFileURL } from 'node:url';\nregister(pathToFileURL(${JSON.stringify(hooks)}));\n`);
    const run = await storeOffQuery('basic', FILES_SQL, { NODE_OPTIONS: `--import=${pathToFileURL(register).href}` });
    // A broken VAT install, never the tree's fault: the CLI publishes it as its own internal error.
    expect(refusalOf(run)).toEqual({ code: 'INTERNAL_ERROR', message: expect.stringContaining('Cannot load VAT\'s typescript parser module') });
    expect(refusalOf(run).message).toContain('vendored TypeScript removed by the test');
    expect(run.stderr).not.toContain(VERSION_LINE);
  });
});
