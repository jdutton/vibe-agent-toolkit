/**
 * The repo's Node engine-floor rule, run as the `vat resources check` it ships as.
 *
 * The rule is a `resources.checks` entry in the repo's own `vibe-agent-toolkit.config.yaml`, a SQL
 * statement over `data__values`. Each case below writes a small manifest tree and a config whose
 * checks block is READ FROM that file, so a case exercises the shipped statement, never a copy of
 * it that could drift.
 */

import { spawnSync } from 'node:child_process';

import { gitExecutable } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, describe, expect, it } from 'vitest';
import yaml from 'yaml';

import { useScratchTmpdir } from '../helpers/scratch-tmpdir.js';

import {
  cleanupTestTempDir,
  createTestTempDir,
  fs,
  getBinPath,
  getMonorepoRoot,
  safePath,
  writeFileTree,
} from './test-common.js';
import { executeCli } from './test-helpers/index.js';

useScratchTmpdir('vat-scratch-engine-floor-');

const binPath = getBinPath(import.meta.url);
const CHECK_NAME = 'engine-floor-agreement';
const CONFIG_FILE = 'vibe-agent-toolkit.config.yaml';
const FLOOR = '>=22.13.0';
const ROOT = 'package.json';
const PKG_A = 'packages/a/package.json';
const PKG_B = 'packages/b/package.json';

/** The shipped check, as the repo's own config declares it. */
function shippedCheck(): unknown {
  const text = fs.readFileSync(safePath.join(getMonorepoRoot(import.meta.url), CONFIG_FILE), 'utf-8');
  const config = yaml.parse(text) as { resources?: { checks?: Record<string, unknown> } };
  const check = config.resources?.checks?.[CHECK_NAME];
  if (check === undefined) throw new Error(`${CONFIG_FILE} declares no resources.checks.${CHECK_NAME}`);
  return check;
}

/** A manifest's text: an object as JSON, a string verbatim (so a case can write one that does not parse). */
function manifest(content: Record<string, unknown> | string): string {
  return typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`;
}

/** The tree every case starts from: a root floor and one published package that agrees. */
const AGREEING: Readonly<Record<string, Record<string, unknown> | string | null>> = {
  [ROOT]: { name: 'root', private: true, engines: { node: FLOOR } },
  [PKG_A]: { name: 'a', engines: { node: FLOOR } },
};

interface FloorCase {
  name: string;
  /** Files changed from {@link AGREEING}; `null` removes one. */
  files: Readonly<Record<string, Record<string, unknown> | string | null>>;
  /** The locations of the check's findings, in order; `broken` when the check must not run. */
  expected: readonly string[] | { broken: string };
}

const CASES: readonly FloorCase[] = [
  { name: 'an agreeing tree is silent', files: {}, expected: [] },
  {
    name: 'a published package that disagrees is a finding at its manifest',
    files: { [PKG_B]: { name: 'b', engines: { node: '>=20' } } },
    expected: [PKG_B],
  },
  {
    name: 'a number that reads the same as a string floor disagrees',
    files: { [PKG_B]: { name: 'b', engines: { node: 22 } }, [ROOT]: { private: true, engines: { node: '22' } } },
    expected: [PKG_A, PKG_B],
  },
  {
    // `true` and `1` are both stored as INTEGER 1; only their JSON type tells them apart.
    name: 'equality is by JSON type as well as value',
    files: {
      [ROOT]: { private: true, engines: { node: 1 } },
      [PKG_A]: { name: 'a', engines: { node: 1 } },
      [PKG_B]: { name: 'b', engines: { node: true } },
    },
    expected: [PKG_B],
  },
  {
    // The TS rule's `!==`: two arrays are never the same value, however they read.
    name: 'an array engines.node never agrees, even with an array floor',
    files: { [ROOT]: { private: true, engines: { node: [] } }, [PKG_A]: { name: 'a', engines: { node: [] } } },
    expected: [PKG_A],
  },
  {
    name: 'a null engines.node disagrees',
    files: { [PKG_B]: { name: 'b', engines: { node: null } } },
    expected: [PKG_B],
  },
  {
    name: 'a published package with no engines.node is a finding',
    files: { [PKG_B]: { name: 'b' } },
    expected: [PKG_B],
  },
  {
    name: 'a private package may omit engines',
    files: { [PKG_B]: { name: 'b', private: true } },
    expected: [],
  },
  {
    name: 'a private package that declares a floor must agree',
    files: { [PKG_B]: { name: 'b', private: true, engines: { node: '>=18' } } },
    expected: [PKG_B],
  },
  {
    name: 'only private: true exempts a package',
    files: { [PKG_B]: { name: 'b', private: 'true' } },
    expected: [PKG_B],
  },
  {
    name: 'only packages/<name>/package.json one level deep is checked',
    files: { 'packages/a/nested/package.json': { name: 'n', engines: { node: '>=1' } } },
    expected: [],
  },
  {
    name: 'a root that declares no floor is one finding at package.json',
    files: { [ROOT]: { private: true }, [PKG_B]: { name: 'b', engines: { node: '>=20' } } },
    expected: [ROOT],
  },
  {
    name: 'an absent root is one finding at package.json',
    files: { [ROOT]: null },
    expected: [ROOT],
  },
  {
    name: 'a root floor with no package manifest to check is a finding',
    files: { [PKG_A]: null },
    expected: ['packages'],
  },
  {
    name: 'an unparseable package manifest breaks the check',
    files: { [PKG_B]: '{ "name": "b", ' },
    expected: { broken: 'INPUT_UNREADABLE' },
  },
];

/** One finding, as the check document carries it. */
interface Finding {
  code: string;
  location?: string;
  reason?: unknown;
}

/** Write the case's tree under a fresh git repository and run `vat resources check` over it. */
function runCase(dir: string, files: FloorCase['files']): { status: number | null; findings: Finding[]; stdout: string } {
  const tree: Record<string, string> = {
    [CONFIG_FILE]: yaml.stringify({ resources: { checks: { [CHECK_NAME]: shippedCheck() } } }),
  };
  for (const [path, content] of Object.entries({ ...AGREEING, ...files })) {
    if (content !== null) tree[path] = manifest(content);
  }
  writeFileTree(dir, tree);
  spawnSync(gitExecutable(), ['init', '--quiet'], { cwd: dir });
  const result = executeCli(binPath, ['resources', 'check'], { cwd: dir });
  const doc = (yaml.parse(result.stdout) ?? {}) as { findings?: Finding[] };
  return { status: result.status, findings: doc.findings ?? [], stdout: result.stdout };
}

describe(`the shipped ${CHECK_NAME} check`, () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir !== undefined) cleanupTestTempDir(dir);
    dir = undefined;
  });

  it.each(CASES)('$name', ({ files, expected }) => {
    dir = createTestTempDir('vat-engine-floor-');
    const { status, findings, stdout } = runCase(dir, files);
    const ours = findings.filter((f) => f.code === `CUSTOM:${CHECK_NAME}`);

    if (Array.isArray(expected)) {
      expect(ours.map((f) => f.location), stdout).toStrictEqual(expected);
      expect(status, stdout).toBe(expected.length === 0 ? 0 : 1);
      return;
    }
    const { broken } = expected as { broken: string };
    expect(status, stdout).toBe(1);
    expect(ours, stdout).toStrictEqual([]);
    const brokenFinding = findings.find((f) => f.code === 'RESOURCE_CHECK_BROKEN');
    expect(JSON.stringify(brokenFinding?.reason), stdout).toContain(broken);
  });
});
