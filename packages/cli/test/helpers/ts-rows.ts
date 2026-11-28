/**
 * The `ts` instance's system proofs, shared: one small committed corpus holding every variant
 * (`ts`, `dts`, `tsx`, `js`) and every import kind a reader most often meets, a gitignored `.ts` file
 * planted after the commit (git content only: never routed), a statement dumping every `ts` relation
 * at once, and the corpus's answer projected to the columns that decide it.
 *
 * Blob-keyed rows (`ts__files`, `ts__imports`, `ts__import_names`, `ts__exports`) are read back by
 * path through the same dump's `ts__routes`, so an answer names files, never content keys.
 */

import { expect } from 'vitest';

import { commitTestFixture, writeCorpus } from '../test-helpers.js';

import { dumpSqlOf, DUMPED_RELATIONS, relationRows } from './cache-differential.js';
import { DATA_CONFIG } from './data-rows.js';

// ── The corpus ──────────────────────────────────────────────────────────────

/** A check over `ts_imports`, so `vat resources check` demands the instance too. */
export const TS_CHECK_CONFIG = [
  DATA_CONFIG.trimEnd(),
  '  checks:',
  '    builtin-imports:',
  '      description: Every source file importing a Node builtin',
  '      sql: "SELECT DISTINCT path FROM ts_imports WHERE builtin = 1 ORDER BY path"',
  '      severity: warning',
  '',
].join('\n');

/**
 * A config declaring a `ts` block.
 *
 * @param block - The block's YAML lines, indented under `ts:`
 * @returns The config's text
 */
export function tsBlockConfig(block: readonly string[]): string {
  return [DATA_CONFIG.trimEnd(), '  extractors:', '    ts:', ...block.map((line) => `      ${line}`), ''].join('\n');
}

/** The committed source files, one or more per variant. */
const SOURCE_FILES: Readonly<Record<string, string>> = {
  'src/index.ts': "import { b } from './b.js';\nimport type { Shape } from '@acme/types';\nexport { b };\nexport const a: Shape = { b };\n",
  'src/b.ts': "import fs from 'node:fs';\nexport const b = fs.existsSync('.');\n",
  'types/env.d.ts': "declare module '@acme/env' {\n  export const region: string;\n}\n",
  'web/app.tsx': "import React from 'react';\nexport const App = () => <div>{React.version}</div>;\n",
  'lib/util.js': "const path = require('node:path');\nmodule.exports = { join: path.join };\n",
};

/** The gitignored source file planted after the commit: realized by a filesystem crawl, never routed. */
export const IGNORED_SOURCE = 'ignored/gen.ts';

/** A file TypeScript refuses to parse: the defect a run reports as one `TS_FILE_NO_ROWS` finding. */
export const BROKEN_SOURCE = 'src/broken.ts';

/**
 * Write the corpus under `root`, commit it, then plant the ignored source file.
 *
 * @param root - An empty directory
 * @param options - The corpus's variations
 * @param options.config - The project config's text
 * @param options.broken - Whether to commit {@link BROKEN_SOURCE} too
 */
export function writeTsCorpus(root: string, options: { readonly config: string; readonly broken?: boolean }): void {
  writeCorpus(root, {
    'vibe-agent-toolkit.config.yaml': options.config,
    '.gitignore': 'ignored/\n',
    'README.md': '# Fixture\n',
    ...SOURCE_FILES,
    ...(options.broken === true ? { [BROKEN_SOURCE]: 'export const = ;\n' } : {}),
  });
  commitTestFixture(root);
  writeCorpus(root, { [IGNORED_SOURCE]: 'export const generated = 1;\n' });
}

/** The clean corpus's routed `ts` pairs: one row set per source file, every file's bytes distinct. */
export const TS_ROUTED_PAIRS = Object.keys(SOURCE_FILES).length;

// ── The census ──────────────────────────────────────────────────────────────

/** Every `ts` relation: its tables, `ts__routes` and `ts_imports`. */
const TS_DUMPED = DUMPED_RELATIONS.filter((relation) => relation.name.startsWith('ts__') || relation.name === 'ts_imports');

/** One statement dumping every `ts` relation as `(relation, row)` pairs. */
export const TS_DUMP_SQL = dumpSqlOf(TS_DUMPED);

/** A dump's `ts` answer, by relation: each row projected to the columns that decide it, by path. */
type TsAnswer = Readonly<Record<string, readonly string[]>>;

/** The columns each relation's answer keeps, after its path. */
const ANSWER_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  ts__routes: ['variant', 'state', 'code'],
  ts__files: ['variant', 'moduleSyntax', 'hasJsx'],
  ts__imports: ['ordinal', 'kind', 'specifier', 'typeOnly', 'line', 'column'],
  ts__import_names: ['import', 'imported', 'local', 'typeOnly'],
  ts__exports: ['name', 'kind', 'local'],
  ts_imports: ['ordinal', 'kind', 'specifier', 'package', 'builtin'],
};

/**
 * The `ts` answer of one dump document. Every relation the dump names must hold a row.
 *
 * @param document - A `vat resources query` document over {@link TS_DUMP_SQL}
 * @returns Each relation's rows as `path|column|...` lines, sorted
 */
export function tsAnswerOf(document: Record<string, unknown>): TsAnswer {
  const rowsOf = (relation: string): Array<Record<string, unknown>> => relationRows(document, relation).map((row) => JSON.parse(row) as Record<string, unknown>);
  // A blob names one path in this corpus: every source file's bytes differ.
  const pathOfBlob = new Map(rowsOf('ts__routes').map((route) => [route['blob'], route['path']] as const));
  const answer = Object.fromEntries(Object.entries(ANSWER_COLUMNS).map(([relation, columns]) => {
    const lines = rowsOf(relation).map((row) => [row['path'] ?? pathOfBlob.get(row['blob']), ...columns.map((column) => row[column])].map(String).join('|'));
    return [relation, lines.toSorted((left, right) => left.localeCompare(right))];
  }));
  const empty = Object.entries(answer).filter(([, lines]) => lines.length === 0).map(([relation]) => relation);
  expect(empty, 'ts relations with no row').toStrictEqual([]);
  return answer;
}

/** {@link tsAnswerOf} over the clean corpus, read off each file above. */
export const CLEAN_TS_ANSWER: TsAnswer = {
  ts__routes: [
    'lib/util.js|js|facts|null',
    'src/b.ts|ts|facts|null',
    'src/index.ts|ts|facts|null',
    'types/env.d.ts|dts|facts|null',
    'web/app.tsx|tsx|facts|null',
  ],
  ts__files: [
    'lib/util.js|js|0|0',
    'src/b.ts|ts|1|0',
    'src/index.ts|ts|1|0',
    'types/env.d.ts|dts|0|0',
    'web/app.tsx|tsx|1|1',
  ],
  ts__imports: [
    'lib/util.js|0|require|node:path|0|1|22',
    'src/b.ts|0|import|node:fs|0|1|16',
    'src/index.ts|0|import|./b.js|0|1|19',
    'src/index.ts|1|import|@acme/types|1|2|28',
    'types/env.d.ts|0|ambient|@acme/env|0|1|16',
    'web/app.tsx|0|import|react|0|1|19',
  ],
  ts__import_names: [
    'lib/util.js|0|*|path|0',
    'src/b.ts|0|default|fs|0',
    'src/index.ts|0|b|b|0',
    'src/index.ts|1|Shape|Shape|1',
    'web/app.tsx|0|default|React|0',
  ],
  ts__exports: [
    'lib/util.js|null|assignment|null',
    'src/b.ts|b|declaration|b',
    'src/index.ts|a|declaration|a',
    'src/index.ts|b|local|b',
    'web/app.tsx|App|declaration|App',
  ],
  ts_imports: [
    'lib/util.js|0|require|node:path|null|1',
    'src/b.ts|0|import|node:fs|null|1',
    'src/index.ts|0|import|./b.js|null|0',
    'src/index.ts|1|import|@acme/types|@acme/types|0',
    'types/env.d.ts|0|ambient|@acme/env|@acme/env|0',
    'web/app.tsx|0|import|react|react|0',
  ],
};
