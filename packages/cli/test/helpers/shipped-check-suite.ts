/**
 * A `resources.checks` entry of the repo's own `vibe-agent-toolkit.config.yaml`, run as the
 * `vat resources check` it ships as.
 *
 * Each case writes a small tree and a config whose checks block is READ FROM the repo's config at
 * run time, so a case exercises the shipped statement, never a copy of it that could drift.
 */

import { spawnSync } from 'node:child_process';

import { gitExecutable } from '@vibe-agent-toolkit/utils/testing';
import { expect, onTestFinished } from 'vitest';
import yaml from 'yaml';

import {
  cleanupTestTempDir,
  createTestTempDir,
  fs,
  getBinPath,
  getMonorepoRoot,
  safePath,
  writeFileTree,
} from '../system/test-common.js';
import { executeCli } from '../system/test-helpers/index.js';

import { useScratchTmpdir } from './scratch-tmpdir.js';

const CONFIG_FILE = 'vibe-agent-toolkit.config.yaml';
const binPath = getBinPath(import.meta.url);

/** A file's content: an object as JSON, a string verbatim (so a case can write one that does not parse), `null` for absent. */
export type CaseFile = Record<string, unknown> | string | null;
export type CaseTree = Readonly<Record<string, CaseFile>>;
/** A `resources.extractors.data` block: its glob lists, and `allowEmpty: true`. */
export type DataBlock = Readonly<Record<string, readonly string[] | true>>;

export interface ShippedCheckCase {
  name: string;
  /** Files changed from the suite's base tree; `null` removes one. */
  files: CaseTree;
  /** A `resources.extractors.data` block for the case's config, replacing the suite's, when the case re-routes a file. */
  data?: DataBlock;
  /** The suite's findings as `[location, problem]`, in order; `broken` when the check must not run. */
  expected: ReadonlyArray<readonly [string, string]> | { broken: string };
  /** The one finding outside the suite's checks that the case's tree must raise, failing the run whatever the checks find. */
  runFailsOn?: { readonly code: string; readonly location: string };
}

/** Text no data variant parses (JSON, JSONC or YAML): a mapping never closed. */
export const UNPARSEABLE = '{ "broken": ';

/**
 * A case whose `path` does not parse: the run fails on that file's one DATA_FILE_NO_ROWS finding, and
 * the suite's checks report only `expected`, their findings over the other files. A file with no rows
 * is never a subject of a check, so a check that reports one has taken its subjects from every routed
 * path instead of from `data__routes WHERE state = 'facts'`.
 */
export function brokenSubjectCase(
  name: string,
  path: string,
  rest: { files?: CaseTree; expected?: ReadonlyArray<readonly [string, string]> } = {},
): ShippedCheckCase {
  return {
    name,
    files: { ...rest.files, [path]: UNPARSEABLE },
    expected: rest.expected ?? [],
    runFailsOn: { code: 'DATA_FILE_NO_ROWS', location: path },
  };
}

interface ShippedCheckSuite {
  /** The `resources.checks` entries under test, by name; all of them run in every case. */
  checks: readonly string[];
  /** The tree every case starts from. */
  base: CaseTree;
  /** The `resources.extractors.data` block every case's config carries unless the case sets its own. */
  data?: DataBlock;
  cases: readonly ShippedCheckCase[];
  /** Names the suite's scratch and temp directories, so a leaked one names its suite. */
  prefix: string;
}

interface RepoConfig {
  resources?: { checks?: Record<string, unknown>; extractors?: { data?: DataBlock } };
}

/** The repo's own config, read at run time. */
function repoConfig(): RepoConfig {
  const text = fs.readFileSync(safePath.join(getMonorepoRoot(import.meta.url), CONFIG_FILE), 'utf-8');
  return yaml.parse(text) as RepoConfig;
}

/** The repo's own `resources.extractors.data` block, so a suite can run on the routing it ships. */
export function shippedDataBlock(): DataBlock {
  const data = repoConfig().resources?.extractors?.data;
  if (data === undefined) throw new Error(`${CONFIG_FILE} declares no resources.extractors.data`);
  return data;
}

/** The shipped checks, as the repo's own config declares them. */
function shippedChecks(names: readonly string[]): Record<string, unknown> {
  const config = repoConfig();
  const checks: Record<string, unknown> = {};
  for (const name of names) {
    const check = config.resources?.checks?.[name];
    if (check === undefined) throw new Error(`${CONFIG_FILE} declares no resources.checks.${name}`);
    checks[name] = check;
  }
  return checks;
}

/** A case file's text: an object as pretty JSON, a string verbatim. */
export function fileText(content: Record<string, unknown> | string): string {
  return typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`;
}

/** One finding, as the check document carries it. */
interface Finding {
  code: string;
  location?: string;
  evidence?: { problem?: unknown };
  reason?: unknown;
}

/** Write the case's tree under a fresh git repository and run `vat resources check` over it. */
function runCase(
  dir: string,
  suite: ShippedCheckSuite,
  { files, data = suite.data }: ShippedCheckCase,
): { status: number | null; findings: Finding[]; stdout: string } {
  const resources = { checks: shippedChecks(suite.checks), ...(data === undefined ? {} : { extractors: { data } }) };
  const tree: Record<string, string> = { [CONFIG_FILE]: yaml.stringify({ resources }) };
  for (const [path, content] of Object.entries({ ...suite.base, ...files })) {
    if (content !== null) tree[path] = fileText(content);
  }
  writeFileTree(dir, tree);
  spawnSync(gitExecutable(), ['init', '--quiet'], { cwd: dir });
  const result = executeCli(binPath, ['resources', 'check'], { cwd: dir });
  const doc = (yaml.parse(result.stdout) ?? {}) as { findings?: Finding[] };
  return { status: result.status, findings: doc.findings ?? [], stdout: result.stdout };
}

/**
 * The body of one case's test, for `it.each(suite.cases)('$name', shippedCheckTest(suite))` inside
 * the suite's `describe`: it pins the checks' findings, or their refusal. Call it in the `describe`
 * callback, so the scratch temp directory it registers covers exactly the suite's tests.
 */
export function shippedCheckTest(suite: ShippedCheckSuite): (checkCase: ShippedCheckCase) => void {
  useScratchTmpdir(`vat-scratch-${suite.prefix}-`);
  const codes = new Set(suite.checks.map((name) => `CUSTOM:${name}`));

  return (checkCase) => {
    const { expected } = checkCase;
    const dir = createTestTempDir(`vat-${suite.prefix}-`);
    onTestFinished(() => cleanupTestTempDir(dir));
    const { status, findings, stdout } = runCase(dir, suite, checkCase);
    const ours = findings.filter((f) => codes.has(f.code));

    if (Array.isArray(expected)) {
      expect(ours.map((f) => [f.location, f.evidence?.problem]), stdout).toStrictEqual(expected);
      const { runFailsOn } = checkCase;
      if (runFailsOn !== undefined) {
        const raised = findings.filter((f) => f.code === runFailsOn.code).map((f) => f.location);
        expect(raised, stdout).toStrictEqual([runFailsOn.location]);
      }
      expect(status, stdout).toBe(expected.length === 0 && runFailsOn === undefined ? 0 : 1);
      return;
    }
    const { broken } = expected as { broken: string };
    expect(status, stdout).toBe(1);
    expect(ours, stdout).toStrictEqual([]);
    const brokenFinding = findings.find((f) => f.code === 'RESOURCE_CHECK_BROKEN');
    expect(JSON.stringify(brokenFinding?.reason), stdout).toContain(broken);
  };
}
