/**
 * A run reads and writes stored facts through its one reader (`run.stored.of(store)`,
 * `stored-reads.ts`): the rule `local/fact-store-access-boundary` says so at desk time, everywhere
 * but the files `FACT_STORE_ACCESSORS` in `eslint.config.js` names.
 *
 * Two halves. The rule fires, through the repo's own config, on a second reader in `resources` and
 * in the CLI. And the exemption list is held both ways against the tree: every file that reaches
 * the port is exempt, and every exempt glob matches such a file, so a stale exemption fails here
 * instead of standing open. The files are found by running the rule itself, enabled everywhere.
 *
 * Integration tier: it loads the repo's whole ESLint config and parses the tree.
 */

import { resolveFromImportMeta } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { exemptionDrift, filesTheRuleReports, importRootEslintConfig, syntaxRuleLinter } from '../eslint-clean-files.js';

/** The one `eslint.config.js` export this file reads: the globs exempt from the boundary rule. */
const { FACT_STORE_ACCESSORS } = await importRootEslintConfig<{
  readonly FACT_STORE_ACCESSORS: readonly string[];
}>();

const REPO_ROOT = resolveFromImportMeta(import.meta.url, '..', '..', '..', '..');
const RULE = 'local/fact-store-access-boundary';
const MEMBERS = ['readBlobFacts', 'readExtent', 'writeBlobFacts', 'writeExtent'];
/** Text in a specifier that may name the resources testing helpers: the package's, or a relative `testing` one. */
const TESTING_SPECIFIERS = ['resources/testing', '/testing/', '/testing.js'];

const lint = syntaxRuleLinter(REPO_ROOT, [RULE]);
const SECOND_READER = 'export const rows = (store: { readBlobFacts(k: string[]): unknown }) => store.readBlobFacts([]);\n';

describe('the fact store access boundary', () => {
  it.each(['packages/resources/src/projection/merge.ts', 'packages/cli/src/utils/projection-query.ts'])(
    'fires on a second reader in %s',
    async (file) => {
      const findings = await lint(file, SECOND_READER);

      expect(findings).toHaveLength(1);
      expect(findings[0]).toContain(`${RULE}: `);
    },
  );

  it('is silent in the run reader', async () => {
    expect(await lint('packages/resources/src/projection/stored-reads.ts', SECOND_READER)).toEqual([]);
  });

  it('exempts exactly the files that reach the port, both ways', async () => {
    const reported = await filesTheRuleReports(REPO_ROOT, RULE, (_file, text) => MEMBERS.some((member) => text.includes(member)) || TESTING_SPECIFIERS.some((specifier) => text.includes(specifier)));

    expect(exemptionDrift(reported, FACT_STORE_ACCESSORS)).toEqual({ unexempted: [], unused: [] });
  });
});
