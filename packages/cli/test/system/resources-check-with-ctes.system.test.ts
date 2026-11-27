/**
 * A check's `with:` end to end: CTE definitions VAT prepends to both `sql` and `examined`, so a
 * derived population is written once and the `examined` statement can count it.
 *
 * Without `with:`, an `examined` statement cannot see the CTEs of its `sql` and the check is
 * RESOURCE_CHECK_BROKEN ("no such table"). The second case proves the composed check reports exactly
 * what the same check with its population written out twice reports, so `with:` changes the
 * spelling and nothing else.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import yaml from 'yaml';

import { useScratchTmpdir } from '../helpers/scratch-tmpdir.js';

import { cleanupTestTempDir, fs, getBinPath, safePath } from './test-common.js';
import { createMarkdownGitFixture, executeCli } from './test-helpers/index.js';

useScratchTmpdir('vat-scratch-cli-with-');

const binPath = getBinPath(import.meta.url);

/** The population, once: every routed data file whose facts were read. */
const POP = "pop AS (SELECT path FROM data__routes WHERE state = 'facts')";
const MANIFESTS = ['package.json', 'packages/a/package.json', 'packages/b/package.json'];

let projectDir: string;

/** One spawn's exit status and parsed document. */
interface CheckRun {
  readonly status: number | null;
  readonly doc: Record<string, unknown>;
}

/**
 * Write `resources.checks` and run the verb.
 *
 * @param checks - The checks map, as an object
 * @returns The run
 */
function runChecks(checks: Record<string, Record<string, string>>): CheckRun {
  fs.writeFileSync(
    safePath.join(projectDir, 'vibe-agent-toolkit.config.yaml'),
    yaml.stringify({ resources: { checks } }),
    'utf-8',
  );
  const result = executeCli(binPath, ['resources', 'check'], { cwd: projectDir });
  return { status: result.status, doc: (yaml.parse(result.stdout) ?? {}) as Record<string, unknown> };
}

/** The published cost entry of one declared check. */
function costOf(run: CheckRun, name: string): Record<string, unknown> | undefined {
  const checks = ((run.doc['data'] ?? {}) as Record<string, unknown>)['checks'] as Record<string, unknown>[] | undefined;
  return checks?.find((entry) => entry['name'] === name);
}

/** The codes and messages of every finding, in order. */
function findingsOf(run: CheckRun): Array<{ code: unknown; message: unknown; location: unknown }> {
  return ((run.doc['findings'] ?? []) as Record<string, unknown>[])
    .map((finding) => ({ code: finding['code'], message: finding['message'], location: finding['location'] }));
}

describe('a check with with:', () => {
  beforeAll(() => {
    projectDir = createMarkdownGitFixture('vat-check-with-');
    for (const manifest of MANIFESTS) {
      fs.mkdirSync(safePath.join(projectDir, safePath.join(manifest, '..')), { recursive: true });
      fs.writeFileSync(safePath.join(projectDir, manifest), JSON.stringify({ name: manifest }), 'utf-8');
    }
  });

  afterAll(() => {
    cleanupTestTempDir(projectDir);
  });

  it('lets examined count a population defined once (the repro answers)', () => {
    const run = runChecks({
      demo: { description: 'demo', with: POP, sql: 'SELECT path FROM pop WHERE 0', examined: 'SELECT COUNT(*) FROM pop' },
    });

    expect(findingsOf(run)).toStrictEqual([]);
    expect(run.status).toBe(0);
    expect(costOf(run, 'demo')).toMatchObject({ rows: 0, examined: MANIFESTS.length });
    expect(costOf(run, 'demo')).not.toHaveProperty('broken');
  });

  it('without with:, the same examined statement is broken: it cannot see the CTE', () => {
    const run = runChecks({
      demo: { description: 'demo', sql: `WITH ${POP} SELECT path FROM pop WHERE 0`, examined: 'SELECT COUNT(*) FROM pop' },
    });

    expect(costOf(run, 'demo')).toMatchObject({ broken: true });
    expect(findingsOf(run).map((finding) => finding.code)).toContain('RESOURCE_CHECK_BROKEN');
  });

  it('reports the same rows and examined count as the population written twice', () => {
    const violations = "SELECT path FROM pop WHERE path LIKE 'packages/%' ORDER BY path";
    const counted = "SELECT COUNT(*) FROM pop WHERE path LIKE 'packages/%'";
    const composed = runChecks({
      pkg: { description: 'A package manifest', with: POP, sql: violations, examined: counted },
    });
    const duplicated = runChecks({
      pkg: { description: 'A package manifest', sql: `WITH ${POP} ${violations}`, examined: `WITH ${POP} ${counted}` },
    });

    expect(findingsOf(composed)).toStrictEqual(findingsOf(duplicated));
    expect(findingsOf(composed).map((finding) => finding.location)).toStrictEqual(['packages/a/package.json', 'packages/b/package.json']);
    expect(costOf(composed, 'pkg')).toMatchObject({ rows: 2, examined: 2 });
    expect(costOf(duplicated, 'pkg')).toMatchObject({ rows: 2, examined: 2 });
  });

  it('merges with: into a statement\'s own WITH', () => {
    const run = runChecks({
      merged: {
        description: 'merged',
        with: POP,
        sql: "WITH pkgs AS (SELECT path FROM pop WHERE path LIKE 'packages/%') SELECT path FROM pkgs WHERE 0",
        examined: "WITH pkgs AS (SELECT path FROM pop WHERE path LIKE 'packages/%') SELECT COUNT(*) FROM pkgs",
      },
    });

    expect(findingsOf(run)).toStrictEqual([]);
    expect(costOf(run, 'merged')).toMatchObject({ rows: 0, examined: 2 });
  });

  it('refuses a CTE name defined in both with: and the statement, as a config error', () => {
    const run = runChecks({
      clash: { description: 'clash', with: POP, sql: 'WITH pop AS (SELECT 1) SELECT * FROM pop WHERE 0' },
    });

    const error = (run.doc['error'] ?? {}) as Record<string, unknown>;
    expect(run.status).not.toBe(0);
    expect(error['code']).toBe('CONFIG_INVALID');
    expect(error['message']).toContain('resources.checks.clash.with: The CTE "pop" is defined both in `with`'
      + ' and in the statement\'s own WITH in `sql`');
  });
});
