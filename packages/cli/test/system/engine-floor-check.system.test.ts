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
  /** A `resources.extractors.data` block for the case's config, when the case re-routes a file. */
  data?: Readonly<Record<string, readonly string[]>>;
  /** The check's findings as `[location, problem]`, in order; `broken` when the check must not run. */
  expected: ReadonlyArray<readonly [string, string]> | { broken: string };
}

// The messages, written out in full: a case pins what a finding SAYS, not only where it is.
const ROOT_ABSENT =
  'Root package.json is not routed (absent, git-ignored, or excluded from the data instance), so there is no floor to derive and the rule cannot run.';
const ROOT_NO_FLOOR =
  'Root package.json declares no engines.node. Every other manifest is checked against it, so there is no floor to derive and the rule cannot run.';
const NO_PACKAGES = 'No packages/<name>/package.json is routed, so the floor is checked against nothing.';

function disagrees(shown: string, floor = FLOOR): string {
  return `engines.node is "${shown}" but the root manifest declares "${floor}". Every package in this monorepo ships one floor; change the root and all packages together, never one of them.`;
}

function undeclared(floor = FLOOR): string {
  return `Published package declares no engines.node. Adopters get no install-time signal about the Node floor. Add "engines": { "node": "${floor}" } to match the root manifest.`;
}

const CASES: readonly FloorCase[] = [
  { name: 'an agreeing tree is silent', files: {}, expected: [] },
  {
    name: 'a published package that disagrees is a finding at its manifest',
    files: { [PKG_B]: { name: 'b', engines: { node: '>=20' } } },
    expected: [[PKG_B, disagrees('>=20')]],
  },
  {
    name: 'a number that reads the same as a string floor disagrees',
    files: { [PKG_B]: { name: 'b', engines: { node: 22 } }, [ROOT]: { private: true, engines: { node: '22' } } },
    expected: [[PKG_A, disagrees(FLOOR, '22')], [PKG_B, disagrees('22', '22')]],
  },
  {
    // The message shows a number as written, not as the double it reads as (`2.5`, `10.0`). Equality is
    // by value, as `!==` is: `10` agrees with `1e1`.
    name: 'a number is shown as its source lexeme, in the finding and as the floor',
    files: {
      [ROOT]: '{ "private": true, "engines": { "node": 1e1 } }\n',
      [PKG_A]: '{ "name": "a", "engines": { "node": 2.50 } }\n',
      [PKG_B]: { name: 'b' },
      'packages/c/package.json': '{ "name": "c", "engines": { "node": 10 } }\n',
    },
    expected: [[PKG_A, disagrees('2.50', '1e1')], [PKG_B, undeclared('1e1')]],
  },
  {
    // `true` and `1` are both stored as INTEGER 1; only their JSON type tells them apart.
    name: 'equality is by JSON type as well as value',
    files: {
      [ROOT]: { private: true, engines: { node: 1 } },
      [PKG_A]: { name: 'a', engines: { node: 1 } },
      [PKG_B]: { name: 'b', engines: { node: true } },
    },
    expected: [[PKG_B, disagrees('true', '1')]],
  },
  {
    // The TS rule's `!==`: two arrays are never the same value, however they read.
    name: 'an array engines.node never agrees, even with an array floor',
    files: { [ROOT]: { private: true, engines: { node: [] } }, [PKG_A]: { name: 'a', engines: { node: [] } } },
    expected: [[PKG_A, disagrees('array', 'array')]],
  },
  {
    name: 'a null engines.node disagrees',
    files: { [PKG_B]: { name: 'b', engines: { node: null } } },
    expected: [[PKG_B, disagrees('null')]],
  },
  {
    // The TS rule's `!==` again: null is the one JSON value with no SQL value, and it equals itself.
    name: 'a null engines.node agrees with a null floor',
    files: { [ROOT]: { private: true, engines: { node: null } }, [PKG_A]: { name: 'a', engines: { node: null } } },
    expected: [],
  },
  {
    name: 'a published package with no engines.node is a finding',
    files: { [PKG_B]: { name: 'b' } },
    expected: [[PKG_B, undeclared()]],
  },
  {
    name: 'a private package may omit engines',
    files: { [PKG_B]: { name: 'b', private: true } },
    expected: [],
  },
  {
    name: 'a private package that declares a floor must agree',
    files: { [PKG_B]: { name: 'b', private: true, engines: { node: '>=18' } } },
    expected: [[PKG_B, disagrees('>=18')]],
  },
  {
    name: 'only private: true exempts a package, not the string "true"',
    files: { [PKG_B]: { name: 'b', private: 'true' } },
    expected: [[PKG_B, undeclared()]],
  },
  {
    // `1` is stored as INTEGER 1, the same value as `true`; only the JSON type refuses it.
    name: 'only private: true exempts a package, not the number 1',
    files: { [PKG_B]: { name: 'b', private: 1 } },
    expected: [[PKG_B, undeclared()]],
  },
  {
    name: 'only packages/<name>/package.json one level deep is checked',
    files: { 'packages/a/nested/package.json': { name: 'n', engines: { node: '>=1' } } },
    expected: [],
  },
  {
    name: 'a root that declares no floor is one finding at package.json',
    files: { [ROOT]: { private: true }, [PKG_B]: { name: 'b', engines: { node: '>=20' } } },
    expected: [[ROOT, ROOT_NO_FLOOR]],
  },
  {
    // With no floor there is nothing to check packages against, so an empty packages/ is not a second finding.
    name: 'a root that declares no floor over no packages is still one finding',
    files: { [ROOT]: { private: true }, [PKG_A]: null },
    expected: [[ROOT, ROOT_NO_FLOOR]],
  },
  {
    name: 'an absent root is one finding at package.json',
    files: { [ROOT]: null },
    expected: [[ROOT, ROOT_ABSENT]],
  },
  {
    name: 'an absent root over no packages is still one finding',
    files: { [ROOT]: null, [PKG_A]: null },
    expected: [[ROOT, ROOT_ABSENT]],
  },
  {
    name: 'a root floor with no package manifest to check is a finding',
    files: { [PKG_A]: null },
    expected: [['packages', NO_PACKAGES]],
  },
  {
    // A `jsonc` glob changes how a manifest is read, not whether it is one: the rule still applies.
    name: 'a manifest routed as JSONC is still checked',
    files: { [PKG_B]: { name: 'b', engines: { node: '>=20' } } },
    data: { jsonc: [ROOT, PKG_B] },
    expected: [[PKG_B, disagrees('>=20')]],
  },
  {
    // JSON.parse refuses a BOM, so the TS rule reported this manifest; the data instance decodes it.
    name: 'a manifest with a UTF-8 BOM is read and checked',
    files: { [PKG_B]: `\uFEFF${manifest({ name: 'b', engines: { node: '>=20' } })}` },
    expected: [[PKG_B, disagrees('>=20')]],
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
  evidence?: { problem?: unknown };
  reason?: unknown;
}

/** Write the case's tree under a fresh git repository and run `vat resources check` over it. */
function runCase(dir: string, { files, data }: FloorCase): { status: number | null; findings: Finding[]; stdout: string } {
  const resources = { checks: { [CHECK_NAME]: shippedCheck() }, ...(data === undefined ? {} : { extractors: { data } }) };
  const tree: Record<string, string> = { [CONFIG_FILE]: yaml.stringify({ resources }) };
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

  it.each(CASES)('$name', (floorCase) => {
    const { expected } = floorCase;
    dir = createTestTempDir('vat-engine-floor-');
    const { status, findings, stdout } = runCase(dir, floorCase);
    const ours = findings.filter((f) => f.code === `CUSTOM:${CHECK_NAME}`);

    if (Array.isArray(expected)) {
      expect(ours.map((f) => [f.location, f.evidence?.problem]), stdout).toStrictEqual(expected);
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
