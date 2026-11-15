/**
 * The storage port's retired names appear nowhere but the change record.
 *
 * The store port was renamed and the SQL surface moved off it onto a run
 * database. A rename leaves its old spelling in prose — a docstring that says
 * `ProjectionStore.readExtent`, a README that imports a factory no longer
 * exported — and nothing that compiles reads prose. So the whole repository is
 * searched, by whole word, for each retired name: the changelog and its
 * fragments may record them, and this file must name them; the type probe may
 * spell the two old type names it proves no longer import, and nothing else.
 *
 * Integration tier: it spawns `git grep` over the working tree.
 */

import { spawnSync } from 'node:child_process';

import { resolveFromImportMeta } from '@vibe-agent-toolkit/utils';
import { gitExecutable } from '@vibe-agent-toolkit/utils/testing';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolveFromImportMeta(import.meta.url, '..', '..', '..', '..');

/** This file, repo-relative: it has to spell the names it searches for. */
const SELF = 'packages/dev-tools/test/integration/retired-store-names.integration.test.ts';

/** The names the storage port change retired. */
const RETIRED_NAMES = [
  'ProjectionStore',
  'SqlQueryableStore',
  'openSqliteProjectionStore',
  'openEphemeralProjectionStore',
  'openEphemeralQueryStore',
];

/** The type probe that proves the old type names no longer import: it has to spell them to import them. */
const IMPORT_PROBE = 'packages/cli/test/integration/fact-store-port.integration.test.ts';

/** The retired names the import probe spells, and only those: any other in that file is a hit. */
const SPELLED_BY_PROBE: ReadonlySet<string> = new Set(['ProjectionStore', 'SqlQueryableStore']);

/** Where every retired name may still appear: the record of the change, and this file. */
const EXCLUDED_PATHSPECS = [':(exclude).changes', ':(exclude,glob)**/CHANGELOG.md', `:(exclude)${SELF}`];

/**
 * Every `path:line:text` hit for a whole-word name, tracked and untracked files
 * alike (ignored files excluded), outside the change record.
 *
 * @param name - The word to search for
 * @returns The hits, empty when there are none
 * @throws When `git grep` fails rather than finding nothing
 */
function hitsFor(name: string): string[] {
  const excluded = SPELLED_BY_PROBE.has(name) ? [...EXCLUDED_PATHSPECS, `:(exclude)${IMPORT_PROBE}`] : EXCLUDED_PATHSPECS;
  const result = spawnSync(
    gitExecutable(),
    ['grep', '--untracked', '-n', '-w', '-F', '-e', name, '--', '.', ...excluded],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  // 1 is "no match"; anything else but 0 is git failing, which must not read as clean.
  if (result.status === 1) return [];
  if (result.status !== 0) throw new Error(`git grep failed (${String(result.status)}): ${result.stderr}`);
  return result.stdout.split('\n').filter((line) => line !== '');
}

describe('the storage port change left no retired name behind', () => {
  it('finds the current port name, so the search itself works', () => {
    expect(hitsFor('FactStore').length).toBeGreaterThan(0);
  });

  it.each(RETIRED_NAMES)('`%s` appears only in the change record', (name) => {
    expect(hitsFor(name)).toEqual([]);
  });
});
