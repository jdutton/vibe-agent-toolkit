/**
 * The query lane's wiring of the TypeScript resolve step (`ts_import_targets`, `ts_program_files`,
 * `ts_import_conditions`), in process and store off: a statement naming one demands the workspace,
 * tsconfig and resolve steps over both row-set instances and the run's git-content listing; the
 * step's rows reach the run database under the three names, and its refusal (the tsconfig family's
 * carried as it stands) refuses all three with the tsconfig family's code mapping; the three names
 * are reserved against a CTE, and a tree git gives no answer for refuses them with `git_content`.
 */

import type { TsResolveAnswer } from '@vibe-agent-toolkit/resources';
import { afterAll, describe, expect, it } from 'vitest';

import { planHydration } from '../../src/utils/projection-lenses.js';
import { RelationRefusedError, tsResolveRelations } from '../../src/utils/projection-query.js';
import { askOverRealized, cteRefusalOf, thrownBy } from '../helpers/data-stage-ask.js';
import { createTempDirTracker } from '../system/test-common.js';

const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-projection-ask-ts-resolve-');
afterAll(() => cleanupTempDirs());

const RESOLVE_NAMES = ['ts_import_conditions', 'ts_import_targets', 'ts_program_files'];
const ONE_ROOT = [{ id: 'root-1' }];

/** @returns The names, sorted */
function sorted(names: Iterable<string>): string[] {
  return [...names].toSorted((a, b) => a.localeCompare(b));
}

describe('planHydration: the resolve step\'s relations', () => {
  it.each(RESOLVE_NAMES)('%s demands the resolve step over both instances and the git-content listing, and hydrates no stored relation', (name) => {
    const plan = planHydration({ statements: [`SELECT * FROM ${name}`], roots: ONE_ROOT });
    expect(plan.rowSets).toStrictEqual({ tables: [], dataRoutes: false, dataValues: false, tsRoutes: false, tsImports: false, workspace: false, tsconfig: false, tsResolve: true });
    expect(plan.gitContent).toBe(true);
    expect(plan.relations).toStrictEqual([]);
    expect(plan.lenses).toStrictEqual([]);
  });
});

describe('tsResolveRelations', () => {
  it('writes the three relations\' rows and refuses nothing when the step answered', () => {
    const { rows, refusals } = tsResolveRelations({ outcome: 'rows', typescript: '6.0.3', rows: { targets: [], programFiles: [], conditions: [] } });
    expect(refusals.size).toBe(0);
    expect(rows).toStrictEqual({ tsImportTargets: [], tsProgramFiles: [], tsImportConditions: [] });
  });

  it('refuses all three with one refusal under the tsconfig family\'s mapping when the family refused', () => {
    const answer = (retryable: boolean): TsResolveAnswer => ({
      outcome: 'refused',
      typescript: null,
      refusal: { code: 'TSCONFIG_PARSE_ERRORS', root: 'r0', path: 'tsconfig.json', message: 'it has errors.', remedy: 'fix it', retryable },
    });
    const { rows, refusals } = tsResolveRelations(answer(false));
    expect(rows).toStrictEqual({});
    expect(sorted(refusals.keys())).toStrictEqual(RESOLVE_NAMES);
    expect(refusals.get('ts_import_targets')).toStrictEqual({ refusal: 'INPUT_UNREADABLE', refused: 'TSCONFIG_PARSE_ERRORS: it has errors. Fix: fix it.' });
    expect(tsResolveRelations(answer(true)).refusals.get('ts_program_files')?.refusal).toBe('RUN_INCOMPLETE');
  });

  it('is nothing when none of the three was demanded', () => {
    expect(tsResolveRelations(undefined)).toStrictEqual({ rows: {}, refusals: new Map() });
  });
});

describe('the resolve step\'s relations in the query lane', () => {
  it.each(RESOLVE_NAMES)('reserves %s against a CTE, since the step can refuse it', async (name) => {
    const refused = await cteRefusalOf(createTempDir(), name);
    expect(refused).toBeInstanceOf(RelationRefusedError);
    expect((refused as RelationRefusedError).refusal).toBe('USAGE_INVALID');
  });

  it('refuses all three with git_content outside a work tree, without running the tsconfig or resolve step', async () => {
    const statements = [...RESOLVE_NAMES.map((name) => `SELECT * FROM ${name}`), 'SELECT * FROM git_content'];
    const thrown = await askOverRealized({ root: createTempDir(), realized: [], statements }, (ask) => statements.map((sql) => thrownBy(() => ask(sql))));
    for (const refused of thrown) {
      expect(refused).toBeInstanceOf(RelationRefusedError);
      expect((refused as RelationRefusedError).refusal).toBe('INPUT_UNREADABLE');
      expect((refused as Error).message).toContain('not a git repository');
    }
  });
});
