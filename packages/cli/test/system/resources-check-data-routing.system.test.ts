/**
 * `vat resources check` and `vat resources query` over a `data` routing an adopter's check authoring
 * tripped on: an `include` glob that matches nothing, beside a file that exists and is valid JSON
 * but that no route covers.
 *
 * - The inert glob is a `DATA_INCLUDE_GLOB_INERT` warning naming it, never a refusal of every
 *   `data__*` statement (it used to be `CONFIG_INVALID`, which broke every check reading the instance).
 * - A `data__values` read of an unrouted path selects zero rows, which is a check's pass. The check
 *   asserts its own input is present with an `examined` count over `data__routes`, so a file that
 *   falls out of routing fails it as `RESOURCE_CHECK_EXAMINED_NOTHING` instead of passing quietly;
 *   routed, the same check is examined and reports its violation.
 * - `resources.validation.severity` resolves the warning on both verbs, so `ignore` silences it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import yaml from 'yaml';

import { useScratchTmpdir } from '../helpers/scratch-tmpdir.js';
import { commitTestFixture, writeCorpus } from '../test-helpers.js';

import { cleanupTestTempDir, createTestTempDir, getBinPath } from './test-common.js';
import { executeCli } from './test-helpers/index.js';

useScratchTmpdir('vat-scratch-data-routing-');

const binPath = getBinPath(import.meta.url);

/** The glob that matches nothing, and the file no route covers. */
const INERT_GLOB = 'tools/no-such-waiver.json';
const UNROUTED = 'schemas/golden.schema.json';

/** The check: no title in the golden schema, which asserts that the schema is routed at all. */
const CONFIG = {
  resources: {
    include: ['**/*.md'],
    extractors: { data: { include: [INERT_GLOB] } },
    checks: {
      'golden-has-no-title': {
        description: 'The golden schema declares no title',
        sql: `SELECT path FROM data__values WHERE path = '${UNROUTED}' AND pointer = '/title'`,
        examined: `SELECT COUNT(*) FROM data__routes WHERE path = '${UNROUTED}' AND state = 'facts'`,
      },
    },
  },
};

/** The same project with the golden schema routed: the check's input is present. */
const ROUTED_CONFIG = {
  resources: { ...CONFIG.resources, extractors: { data: { include: [INERT_GLOB, UNROUTED] } } },
};

/** The same project with the warning set to `ignore`. */
const IGNORED_CONFIG = {
  resources: { ...CONFIG.resources, validation: { severity: { DATA_INCLUDE_GLOB_INERT: 'ignore' } } },
};

/** A statement naming a `data__*` relation. */
const DATA_STATEMENT = "SELECT path, value FROM data__values WHERE pointer = '/name'";

let root: string;
let routedRoot: string;
let ignoredRoot: string;

/** A committed fixture under `config`. */
function fixtureUnder(config: unknown): string {
  const dir = createTestTempDir('vat-check-data-routing-');
  writeCorpus(dir, {
    'README.md': '# Data routing\n',
    'package.json': '{"name": "a"}\n',
    [UNROUTED]: '{"title": "Golden"}\n',
    'vibe-agent-toolkit.config.yaml': yaml.stringify(config),
  });
  commitTestFixture(dir);
  return dir;
}

beforeAll(() => {
  root = fixtureUnder(CONFIG);
  routedRoot = fixtureUnder(ROUTED_CONFIG);
  ignoredRoot = fixtureUnder(IGNORED_CONFIG);
});

afterAll(() => {
  for (const dir of [root, routedRoot, ignoredRoot]) cleanupTestTempDir(dir);
});

/** The findings of a report on stdout, by code. */
function findingsOf(stdout: string): Array<{ code: string; severity: string; message: string; check?: string }> {
  const document = yaml.parseAllDocuments(stdout)[0]?.toJSON() as { findings?: Array<{ code: string; severity: string; message: string; check?: string }> };
  return document.findings ?? [];
}

describe('a data include glob that matches nothing', () => {
  it('check: names the glob as a warning, and the checks reading the instance still run', () => {
    const result = executeCli(binPath, ['resources', 'check'], { cwd: root });
    const findings = findingsOf(result.stdout);

    expect(findings.filter((finding) => finding.code === 'DATA_INCLUDE_GLOB_INERT')).toEqual([
      expect.objectContaining({ severity: 'warning', message: expect.stringContaining(`glob "${INERT_GLOB}"`) as unknown }),
    ]);
    expect(findings.map((finding) => finding.code)).not.toContain('RESOURCE_CHECK_BROKEN');
    // The unrouted file: zero violation rows, and the check's own examined count refuses the pass.
    expect(findings.filter((finding) => finding.code === 'RESOURCE_CHECK_EXAMINED_NOTHING').map((finding) => finding.check)).toEqual(['golden-has-no-title']);
    expect(result.status).toBe(1);
  });

  it('query: answers the routed files, and says the glob on stderr with its code', () => {
    const result = executeCli(binPath, ['resources', 'query', DATA_STATEMENT], { cwd: root });
    const document = yaml.parseAllDocuments(result.stdout)[0]?.toJSON() as { data?: { rows?: unknown[] } };

    expect(result.status).toBe(0);
    expect(document.data?.rows).toEqual([{ path: 'package.json', value: 'a' }]);
    expect(result.stderr).toContain(`glob "${INERT_GLOB}"`);
    expect(result.stderr).toContain('DATA_INCLUDE_GLOB_INERT');
  });

  it('query: says nothing of the glob for a statement that names no data__ relation', () => {
    const result = executeCli(binPath, ['resources', 'query', 'SELECT path FROM resource_realizations ORDER BY path'], { cwd: root });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toContain('DATA_INCLUDE_GLOB_INERT');
    expect(result.stderr).not.toContain(INERT_GLOB);
  });

  it('severity ignore silences the warning on check and on query', () => {
    const check = executeCli(binPath, ['resources', 'check'], { cwd: ignoredRoot });
    expect(findingsOf(check.stdout).map((finding) => finding.code)).not.toContain('DATA_INCLUDE_GLOB_INERT');

    const query = executeCli(binPath, ['resources', 'query', DATA_STATEMENT], { cwd: ignoredRoot });
    expect(query.status, query.stderr).toBe(0);
    expect(query.stderr).toBe('');
  });
});

describe('the examined: recipe, with its input routed', () => {
  it('check: the routed file is examined, so the check reports its violation rather than examined-nothing', () => {
    const result = executeCli(binPath, ['resources', 'check'], { cwd: routedRoot });
    const findings = findingsOf(result.stdout).filter((finding) => finding.check === 'golden-has-no-title');

    expect(findings.map((finding) => finding.code)).not.toContain('RESOURCE_CHECK_EXAMINED_NOTHING');
    expect(findings.map((finding) => finding.code), 'the violation, under the check\'s own code').toEqual(['CUSTOM:golden-has-no-title']);
    expect(result.status).toBe(1);
  });
});
