/**
 * `TS_VERSION_SKEW` through the real CLI: `vat resources query` over two small
 * workspaces answers one root-level `ts_import_conditions` row, and none; the statement is never
 * refused for it; and a spawned run with the `node:fs` read probe opens no path under any
 * `node_modules/typescript`, though every fixture commits one (so a step that read the project's
 * package would find it). The range sweep (every range shape, tags, protocols, `*` and its
 * spellings) is the unit test, `packages/resources/test/ts-version-skew.test.ts`; the pinned major
 * is read from the vendored module the CLI loads, never written here.
 *
 * Red, seeded once each and reverted: a step that reads the
 * project's `node_modules/typescript/package.json` failed the probe assertion; a step that throws
 * a refusal when it emits a skew row failed the "never refuses" assertions.
 */

import { pathToFileURL } from 'node:url';

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { answeredRows, countedQuery, DATA_CONFIG, freshDataArm } from '../helpers/data-rows.js';
import { probedReads, readProbeEnv } from '../helpers/fs-read-probe.js';
import { commitTestFixture, writeCorpus } from '../test-helpers.js';

import { createSuiteContext } from './test-common.js';

const CONDITIONS_SQL = 'SELECT config, path, ordinal, code, pinnedMajor, declaredMajors, manifests FROM ts_import_conditions ORDER BY code';

/** A committed stand-in for the project's own compiler, which no run may open. */
const PROJECT_TYPESCRIPT: Readonly<Record<string, string>> = {
  'node_modules/typescript/package.json': '{"name": "typescript", "version": "5.9.3"}\n',
  'node_modules/typescript/lib/typescript.js': 'throw new Error("the project\'s own typescript was loaded");\n',
};

/** @returns A workspace root manifest (a pnpm workspace of `packages/*`) plus the member manifests given */
function workspace(members: Readonly<Record<string, Record<string, unknown>>>, root: Record<string, unknown> = {}): Record<string, string> {
  const files: Record<string, string> = {
    'vibe-agent-toolkit.config.yaml': DATA_CONFIG,
    'README.md': '# Workspace\n',
    'package.json': `${JSON.stringify({ name: 'root', private: true, packageManager: 'pnpm@9.0.0', ...root })}\n`,
    'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
    ...PROJECT_TYPESCRIPT,
  };
  for (const [dir, manifest] of Object.entries(members)) {
    const name = '@acme/' + dir;
    files[`packages/${dir}/package.json`] = `${JSON.stringify({ name, version: '1.0.0', ...manifest })}\n`;
  }
  return files;
}

/** @returns A manifest fragment declaring `typescript` at `range` in `devDependencies` */
function declaring(range: string): Record<string, unknown> {
  return { devDependencies: { typescript: range } };
}

interface SkewCase {
  readonly name: string;
  readonly files: Record<string, string>;
  /** The one row's `declaredMajors` and `manifests`, or undefined for no row. */
  readonly row: { readonly declaredMajors: string; readonly manifests: number } | undefined;
}

/** The vendored TypeScript's major, from the built loader the CLI calls. */
const { loadVendoredTypeScript } = (await import(pathToFileURL(safePath.resolve(import.meta.dirname, '../../../resources/dist/vendored-typescript.js')).href)) as { loadVendoredTypeScript: () => Promise<{ version: string }> };
const pinnedMajor = Number((await loadVendoredTypeScript()).version.split('.')[0]);

const CASES: readonly SkewCase[] = [
  {
    name: 'a manifest on the major before the pinned one and one on it: one row, one manifest',
    files: workspace({ a: declaring(`^${String(pinnedMajor - 1)}.0.0`), b: declaring(`~${String(pinnedMajor)}.0.0`) }),
    row: { declaredMajors: `${String(pinnedMajor - 1)},${String(pinnedMajor)}`, manifests: 1 },
  },
  { name: 'every manifest on the pinned major, a tag, or none: no row', files: workspace({ a: declaring(`^${String(pinnedMajor)}.0.0`), b: declaring('latest'), c: {} }), row: undefined },
];

const context = createSuiteContext('vat-ts-version-skew-', import.meta.url);
const cwds = new Map<string, string>();
beforeAll(() => {
  context.setup();
  for (const { name, files } of CASES) {
    const cwd = writeCorpus(safePath.join(context.createTempDir(), 'ws'), files);
    commitTestFixture(cwd);
    cwds.set(name, cwd);
  }
});
afterAll(() => context.cleanup());

describe('TS_VERSION_SKEW through vat resources query', () => {
  it.each(CASES)('$name', async ({ name, row }) => {
    const cwd = cwds.get(name) ?? '';
    const probeDir = context.createTempDir();
    const run = await countedQuery(context, cwd, freshDataArm(context, true), CONDITIONS_SQL, readProbeEnv(probeDir, cwd));
    expect(run.status, `a skew never refuses a statement: ${run.stderr}`).toBe(0);
    expect(answeredRows(run)).toEqual(row === undefined ? [] : [{
      config: null, path: null, ordinal: null, code: 'TS_VERSION_SKEW', pinnedMajor, declaredMajors: row.declaredMajors, manifests: row.manifests,
    }]);
    const { reads, dumps } = probedReads(probeDir);
    expect(dumps, 'the probe dumped').toBeGreaterThan(0);
    expect([...reads.keys()].filter((path) => path.includes('node_modules/typescript')), 'reads of the project\'s own typescript').toEqual([]);
  });
});
