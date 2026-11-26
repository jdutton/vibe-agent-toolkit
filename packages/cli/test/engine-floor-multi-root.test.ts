/**
 * The repo's engine-floor check over a run holding more than one root.
 *
 * `vat resources check` takes one path, so its system test
 * (`test/system/engine-floor-check.system.test.ts`) can only build one root and cannot tell a
 * per-root join from a CROSS JOIN. These cases run the SAME statement, read from the repo's own
 * `vibe-agent-toolkit.config.yaml` at test time, over a run database hydrated with rows for several
 * roots, so the statement cannot drift from what the test pins.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { hydrateRunDatabase } from '@vibe-agent-toolkit/projection-sqlite';
import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';
import yaml from 'yaml';

const CHECK_NAME = 'engine-floor-agreement';
const CONFIG_PATH = safePath.join(fileURLToPath(new URL('../../..', import.meta.url)), 'vibe-agent-toolkit.config.yaml');
const ROOT = 'package.json';

const ROOT_ABSENT =
  'Root package.json is not routed (absent, git-ignored, or excluded from the data instance), so there is no floor to derive and the rule cannot run.';
const ROOT_NO_FLOOR =
  'Root package.json declares no engines.node. Every other manifest is checked against it, so there is no floor to derive and the rule cannot run.';
const NO_PACKAGES = 'No packages/<name>/package.json is routed, so the floor is checked against nothing.';

/** The shipped check's SQL, as the repo's own config declares it. */
function shippedSql(): string {
  const config = yaml.parse(readFileSync(CONFIG_PATH, 'utf-8')) as {
    resources?: { checks?: Record<string, { sql?: unknown }> };
  };
  const sql = config.resources?.checks?.[CHECK_NAME]?.sql;
  if (typeof sql !== 'string') throw new Error(`vibe-agent-toolkit.config.yaml declares no resources.checks.${CHECK_NAME}.sql`);
  return sql;
}

/** One routed manifest: its root, its path, and its `engines.node` (absent when `undefined`). */
interface Manifest {
  readonly root: string;
  readonly path: string;
  readonly node?: string;
}

function routeRow({ root, path }: Manifest): Record<string, unknown> {
  return { root, path, blob: null, variant: 'json', state: 'facts', code: null };
}

function valueRow(root: string, path: string, pointer: string, key: string | null, depth: number, type: string, value: string | null): Record<string, unknown> {
  return { root, path, variant: 'json', doc: 0, pointer, key, depth, type, value, lexeme: null, line: 1 };
}

/** The `data__values` nodes of one manifest: the document, and `/engines/node` when it declares one. */
function valueRows({ root, path, node }: Manifest): Record<string, unknown>[] {
  const rows = [valueRow(root, path, '', null, 1, 'object', null)];
  if (node !== undefined) {
    rows.push(
      valueRow(root, path, '/engines', 'engines', 2, 'object', null),
      valueRow(root, path, '/engines/node', 'node', 3, 'string', node),
    );
  }
  return rows;
}

/**
 * Run the shipped check over `roots`, each routing `manifests`.
 *
 * @returns The findings as `[path, problem]`, sorted: a statement with no ORDER BY promises no order
 */
async function runCheck(roots: readonly string[], manifests: readonly Manifest[]): Promise<string[][]> {
  const database = hydrateRunDatabase({
    rootId: roots[0] ?? 'run',
    relations: new Map([
      ['roots', { rows: roots.map((id) => ({ id, path: `/abs/${id}` })) }],
      ['data__routes', { rows: manifests.map((m) => routeRow(m)) }],
      ['data__values', { rows: manifests.flatMap((m) => valueRows(m)) }],
    ]),
  });
  try {
    return database
      .query(shippedSql())
      .map((row) => [String(row['path']), String(row['problem'])])
      .sort((a, b) => a.join('\n').localeCompare(b.join('\n')));
  } finally {
    await database.close();
  }
}

function disagrees(shown: string, floor: string): string {
  return `engines.node is "${shown}" but the root manifest declares "${floor}". Every package in this monorepo ships one floor; change the root and all packages together, never one of them.`;
}

function undeclared(floor: string): string {
  return `Published package declares no engines.node. Adopters get no install-time signal about the Node floor. Add "engines": { "node": "${floor}" } to match the root manifest.`;
}

// Root A ships >=22, root B ships >=20. Each agrees with itself, so any finding is one root read
// against the other's floor. They share package paths on purpose: `packages/x` declares in A and
// not in B, so a join that loses the root equality sees A's declaration as B's.
const TWO_AGREEING_ROOTS: readonly Manifest[] = [
  { root: 'A', path: ROOT, node: '>=22' },
  { root: 'A', path: 'packages/x/package.json', node: '>=22' },
  { root: 'A', path: 'packages/y/package.json', node: '>=22' },
  { root: 'B', path: ROOT, node: '>=20' },
  { root: 'B', path: 'packages/x/package.json' },
  { root: 'B', path: 'packages/y/package.json', node: '>=20' },
];

describe('engine-floor-agreement over more than one root', () => {
  it('compares each package only with its own root floor', async () => {
    expect(await runCheck(['A', 'B'], TWO_AGREEING_ROOTS)).toEqual([['packages/x/package.json', undeclared('>=20')]]);
  });

  it('a root routing packages but no root manifest is its own root-absent finding', async () => {
    const rootC: Manifest = { root: 'C', path: 'packages/z/package.json', node: '>=22' };
    expect(await runCheck(['A', 'B', 'C'], [...TWO_AGREEING_ROOTS, rootC])).toEqual([
      [ROOT, ROOT_ABSENT],
      ['packages/x/package.json', undeclared('>=20')],
    ]);
  });

  it('a root routing nothing at all is a root-absent finding too', async () => {
    expect(await runCheck(['A', 'B', 'D'], TWO_AGREEING_ROOTS)).toEqual([
      [ROOT, ROOT_ABSENT],
      ['packages/x/package.json', undeclared('>=20')],
    ]);
  });

  it('one root that disagrees with itself is found at its own manifest only', async () => {
    const manifests = [...TWO_AGREEING_ROOTS, { root: 'B', path: 'packages/w/package.json', node: '>=22' }];
    expect(await runCheck(['A', 'B'], manifests)).toEqual([
      ['packages/w/package.json', disagrees('>=22', '>=20')],
      ['packages/x/package.json', undeclared('>=20')],
    ]);
  });

  it('a root manifest with no floor is a finding even when another root declares one', async () => {
    const rootE: Manifest = { root: 'E', path: ROOT };
    expect(await runCheck(['A', 'B', 'E'], [...TWO_AGREEING_ROOTS, rootE])).toEqual([
      [ROOT, ROOT_NO_FLOOR],
      ['packages/x/package.json', undeclared('>=20')],
    ]);
  });

  it('a root floor with no package of its own is a finding even when another root has packages', async () => {
    const rootF: Manifest = { root: 'F', path: ROOT, node: '>=22' };
    expect(await runCheck(['A', 'B', 'F'], [...TWO_AGREEING_ROOTS, rootF])).toEqual([
      ['packages', NO_PACKAGES],
      ['packages/x/package.json', undeclared('>=20')],
    ]);
  });
});
