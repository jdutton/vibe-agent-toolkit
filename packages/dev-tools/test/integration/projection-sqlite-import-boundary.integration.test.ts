/**
 * Only the CLI imports the storage backend, `@vibe-agent-toolkit/projection-sqlite`: the rule
 * `local/projection-sqlite-import-boundary` says so at desk time, everywhere but the files
 * `PROJECTION_SQLITE_IMPORTERS` in `eslint.config.js` names.
 *
 * Two halves. The rule fires, through the repo's own config, on every import shape a file in
 * `resources` could use. And the exemption list is held both ways against the tree: every file
 * that imports the backend is exempt, and every exempt glob matches a file that imports it, so
 * a stale exemption fails here instead of standing open. Importers are found by running the rule
 * itself, enabled on every file with no exemption, so the test and the rule cannot disagree on
 * what an import of the backend is: there is one predicate, and it is the rule's.
 *
 * Integration tier: it loads the repo's whole ESLint config and parses the tree.
 */

import { resolveFromImportMeta } from '@vibe-agent-toolkit/utils';
import picomatch from 'picomatch';
import { describe, expect, it } from 'vitest';

import { exemptionDrift, filesTheRuleReports, importRootEslintConfig, syntaxRuleLinter } from '../eslint-clean-files.js';

/** The one `eslint.config.js` export this file reads: the globs exempt from the boundary rule. */
const { PROJECTION_SQLITE_IMPORTERS } = await importRootEslintConfig<{
  readonly PROJECTION_SQLITE_IMPORTERS: readonly string[];
}>();

const REPO_ROOT = resolveFromImportMeta(import.meta.url, '..', '..', '..', '..');
const BACKEND = '@vibe-agent-toolkit/projection-sqlite';
/** Whether a repo-relative file lies in the backend's own package. */
const inBackendPackage = picomatch('packages/projection-sqlite/**');
const RULE = 'local/projection-sqlite-import-boundary';

const lint = syntaxRuleLinter(REPO_ROOT, [RULE]);

/** Every shape a module can name the backend in. */
const SHAPES: ReadonlyArray<readonly [shape: string, code: string]> = [
  ['a static import', `import { openSqliteFactStore } from '${BACKEND}';\nexport const open = openSqliteFactStore;\n`],
  ['an import type', `import type { RunDatabase } from '${BACKEND}';\nexport type Handle = RunDatabase;\n`],
  ['an import()', `export const load = (): Promise<unknown> => import('${BACKEND}');\n`],
  ['a type-position import', `export type Handle = import('${BACKEND}').RunDatabase;\n`],
  ['an export-from', `export { hydrateRunDatabase } from '${BACKEND}';\n`],
  ['a relative import of its source', "import { hydrateRunDatabase } from '../../../projection-sqlite/src/run-database.js';\nexport const open = hydrateRunDatabase;\n"],
  ['a relative import type of its barrel', "import type { RunDatabase } from '../../../projection-sqlite/src/index.js';\nexport type Handle = RunDatabase;\n"],
];

/**
 * Every script under a package's `src` or `test` that imports the backend, repo-relative: each file
 * the rule reports when it is enabled everywhere, exemptions included.
 */
function backendImporters(): Promise<string[]> {
  // Only a narrowing, never the verdict: a file outside the package reaches into it only through a
  // specifier that spells its directory or package name, and every file inside it is linted.
  return filesTheRuleReports(REPO_ROOT, RULE, (file, text) => inBackendPackage(file) || text.includes('projection-sqlite'));
}

describe('the projection-sqlite import boundary', () => {
  it.each(SHAPES)('fires on %s in resources', async (_shape, code) => {
    const findings = await lint('packages/resources/src/projection/second-backend.ts', code);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain(`${RULE}: `);
  });

  it('is silent in the one CLI module that injects the backend', async () => {
    const [, code] = SHAPES[0] ?? ['', ''];
    expect(await lint('packages/cli/src/utils/projection-store.ts', code)).toEqual([]);
  });

  it('exempts exactly the files that import the backend, both ways', async () => {
    // Every importer is exempt (the lint says the same from the other side), and every exemption is
    // in use: a glob that matches no importer is a stale hole.
    expect(exemptionDrift(await backendImporters(), PROJECTION_SQLITE_IMPORTERS)).toEqual({ unexempted: [], unused: [] });
  });
});
