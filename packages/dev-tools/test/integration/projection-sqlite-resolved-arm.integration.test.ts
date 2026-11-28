/**
 * The resolved-target arm of the `projection-sqlite-import-boundary` check (SPEC section 11):
 * a reference TypeScript resolves into `packages/projection-sqlite/`, under any demanded config,
 * from a file outside the check's importer list, is a finding. The specifier arms read only the
 * specifier and its lexical folding, so a `paths` alias reaching the backend escapes them; this arm
 * closes that gap. Its `examined` count is zero when no program was resolved, so a run whose
 * resolved graph is empty fails rather than passing over nothing.
 *
 * The check runs as shipped (its entry read from `vibe-agent-toolkit.config.yaml`), and its arms
 * are read apart through the check's own `with` text: `backend_imports` joined to `enabled` is the
 * specifier finding arm, `resolved_backend_imports` the resolved one.
 *
 * Integration tier: it runs the built `vat`.
 */

import { describe, expect, it } from 'vitest';

import { configOfShippedChecks, portTempDirs, runCheck, runChecksOverRepository } from '../check-port-differential.js';

const CHECK = { name: 'projection-sqlite-import-boundary', population: 'enabled' } as const;

/** Each arm's own findings, as `path:line`, through the check's `with` text. */
const ARMS_QUERY = {
  t1: 'SELECT b.path || \':\' || b.nodeLine AS v FROM backend_imports b JOIN enabled e ON e.root = b.root AND e.path = b.path',
  resolved: 'SELECT path || \':\' || nodeLine AS v FROM resolved_backend_imports',
} as const;

/** The resolved graph's own extent: its program files, and every file outside the backend that reaches into it. */
const GRAPH_QUERY = {
  programs: 'SELECT COUNT(*) AS v FROM ts_program_files',
  reaching: 'SELECT DISTINCT path AS v FROM ts_import_targets WHERE target GLOB \'packages/projection-sqlite/*\' AND path NOT GLOB \'packages/projection-sqlite/*\'',
} as const;

/** The workspace root: one program over every package's `src`, with a `paths` alias onto the backend's sources. */
const ROOT_MANIFEST = { name: 'acme-root', private: true, workspaces: ['packages/*'], scripts: { typecheck: 'tsc -p tsconfig.json' } };
const TSCONFIG = {
  compilerOptions: { module: 'esnext', moduleResolution: 'bundler', noEmit: true, paths: { '@backend/*': ['./packages/projection-sqlite/src/*'] } },
  include: ['packages/*/src/**/*.ts'],
};

/** A tree with no program: the same files, no config and no script invoking one. */
const UNCOMPILED: Readonly<Record<string, string>> = {
  'vibe-agent-toolkit.config.yaml': configOfShippedChecks([CHECK.name]),
  'package.json': `${JSON.stringify({ ...ROOT_MANIFEST, scripts: {} })}\n`,
  'packages/projection-sqlite/src/store.ts': 'export const store = 1;\n',
  'packages/projection-sqlite/src/index.ts': "export * from './store.js';\n",
  // One importer per glob, each a specifier reference, so the stale-glob arm stays quiet; the alias is
  // the control: an importer may reach the backend however it resolves.
  'packages/cli/src/utils/projection-store.ts': "import { store } from '../../../projection-sqlite/src/store.js';\nimport { store as aliased } from '@backend/store';\nexport const open = [store, aliased];\n",
  'packages/cli/test/store.test.ts': "import '../../projection-sqlite/src/store.js';\n",
  // Resolved only: the specifier arms see a bare specifier that names no backend. Reported where the
  // statement starts, as the specifier arm reports.
  'packages/resources/src/alias.ts': "export const before = 1;\nimport { // resolved only\n  store,\n} from '@backend/store';\nexport const used = store;\n",
  // Both arms: one finding.
  'packages/resources/src/relative.ts': "import { store } from '../../projection-sqlite/src/store.js'; // both\nexport const again = store;\n",
};

const COMPILED: Readonly<Record<string, string>> = {
  ...UNCOMPILED,
  'package.json': `${JSON.stringify(ROOT_MANIFEST)}\n`,
  'tsconfig.json': `${JSON.stringify(TSCONFIG)}\n`,
};

describe('the resolved-target arm of projection-sqlite-import-boundary', () => {
  const compiled = portTempDirs('vat-resolved-arm-', COMPILED, {});
  const uncompiled = portTempDirs('vat-resolved-arm-none-', UNCOMPILED, {});

  it('finds nothing over this repository, over a resolved graph that reaches the backend', async () => {
    const [answer] = await runChecksOverRepository([{ check: CHECK, queries: { ...ARMS_QUERY, ...GRAPH_QUERY } }]);
    if (answer === undefined) throw new Error('the repository run answered no check');

    expect(answer.findings).toStrictEqual([]);
    expect(answer.queried['resolved']).toStrictEqual([]);
    expect(answer.runFindings.filter((finding) => finding.startsWith('TS_FILE_NO_ROWS'))).toStrictEqual([]);
    expect(Number(answer.queried['programs']?.[0])).toBeGreaterThan(0);
    // Not blind: the one CLI module that injects the backend resolves into it, and is exempt.
    expect(answer.queried['reaching']).toContain('packages/cli/src/utils/projection-store.ts');
    expect(answer.examined).toBe(answer.population.length);
    expect(answer.examined).toBeGreaterThan(0);
  });

  it('reports a paths alias the specifier arms miss, at the statement, and a relative import both arms see once', async () => {
    const answer = await runCheck(compiled.corpus, compiled.cache, CHECK, ARMS_QUERY);

    expect(answer.runFindings).toStrictEqual([]);
    expect(answer.findings).toStrictEqual(['packages/resources/src/alias.ts:2', 'packages/resources/src/relative.ts:1']);
    // Red without the arm: the specifier arm holds only the relative import.
    expect(answer.queried['t1']).toStrictEqual(['packages/resources/src/relative.ts:1']);
    expect(answer.queried['resolved']?.toSorted()).toStrictEqual(['packages/resources/src/alias.ts:2', 'packages/resources/src/relative.ts:1']);
    expect(answer.messages.filter((message) => message.includes('"@backend/store"') && message.includes('tsconfig.json'))).toHaveLength(1);
    expect(answer.examined).toBe(answer.population.length);
  });

  it('examines nothing, and so fails, over a tree with no program', async () => {
    const answer = await runCheck(uncompiled.corpus, uncompiled.cache, CHECK);

    expect(answer.population.length).toBeGreaterThan(0);
    expect(answer.examined).toBe(0);
    expect(answer.runFindings.filter((finding) => finding.startsWith('RESOURCE_CHECK_EXAMINED_NOTHING'))).toHaveLength(1);
    // The alias is invisible without a program, so only the specifier finding is left.
    expect(answer.findings).toStrictEqual(['packages/resources/src/relative.ts:1']);
  });
});
