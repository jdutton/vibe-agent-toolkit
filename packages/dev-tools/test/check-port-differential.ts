/**
 * The proof that a `resources.checks` entry ported from an ESLint rule's usage is exactly as strong
 * as that usage (SPEC section 11): over one tree, the `(file, line)` set the rule reports through
 * ESLint's own API equals the check's findings, and the files the check examines equal the files
 * ESLint's config resolution enables the rule for (`isPathIgnored`, `calculateConfigForFile`), both
 * ways. Parameterized by rule and check, so each port supplies only its ESLint configuration, its
 * tree and the name of the check's population relation.
 *
 * The check runs as the `vat resources check` it ships as, from the built CLI, and its entry is
 * READ from the repository's own `vibe-agent-toolkit.config.yaml`, so a proof exercises the shipped
 * statement, never a copy of it.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { mkdirSyncReal, normalizedTmpdir, resolveFromImportMeta, safePath, VAT_CACHE_DIR_ENV } from '@vibe-agent-toolkit/utils';
import { createTempDir, gitExecutable, removeTempDir } from '@vibe-agent-toolkit/utils/testing';
import { ESLint, type Linter } from 'eslint';
import { afterAll, beforeAll, expect } from 'vitest';
import yaml from 'yaml';

import { checkoutVatCacheDir } from '../src/run-vat.js';

import { NO_TYPED_PROGRAM } from './eslint-clean-files.js';

/** The repository root. */
export const REPO_ROOT = resolveFromImportMeta(import.meta.url, '..', '..', '..');

const CONFIG_FILE = 'vibe-agent-toolkit.config.yaml';
const VAT_BIN = safePath.join(REPO_ROOT, 'packages/cli/dist/bin/vat.js');

/** The one order both sides of a proof sort in. */
export function byText(left: string, right: string): number {
  return left.localeCompare(right);
}

/** One `resources.checks` entry, as far as the proof reads it. */
interface ShippedCheck {
  readonly description: string;
  readonly severity?: string;
  readonly with?: string;
  readonly examined?: string;
  readonly sql: string;
}

/**
 * The entry `name` of the repository's `resources.checks`, read from the file at run time.
 *
 * @param name - The check's key
 * @returns The entry as the file declares it
 */
function shippedCheck(name: string): ShippedCheck {
  const config = yaml.parse(readFileSync(safePath.join(REPO_ROOT, CONFIG_FILE), 'utf-8')) as {
    resources?: { checks?: Record<string, ShippedCheck> };
  };
  const check = config.resources?.checks?.[name];
  if (check === undefined) throw new Error(`${CONFIG_FILE} declares no resources.checks.${name}`);
  return check;
}

/**
 * The repository's root `eslint-config-support.js`, loaded as a module. Plain JavaScript with no
 * declaration file, so the caller names, as `T`, exactly the exports it reads.
 */
export async function importEslintConfigSupport<T extends object>(): Promise<T> {
  return (await import(pathToFileURL(safePath.join(REPO_ROOT, 'eslint-config-support.js')).href)) as T;
}

/**
 * Write `files` under `root` and commit them as a fresh git repository: the check reads git
 * content only, so a file merely on disk would be invisible to it by accident.
 *
 * @param root - An empty directory
 * @param files - Root-relative path to text
 * @param forced - Files a `.gitignore` of the tree ignores, tracked anyway (`git add -f`)
 */
function writeCommittedTree(root: string, files: Readonly<Record<string, string>>, forced: Readonly<Record<string, string>> = {}): void {
  for (const [relative, text] of Object.entries({ ...files, ...forced })) {
    const absolute = safePath.join(root, relative);
    mkdirSyncReal(safePath.join(absolute, '..'), { recursive: true });
    writeFileSync(absolute, text);
  }
  const git = (args: string[]): void => {
    const result = spawnSync(gitExecutable(), ['-C', root, ...args], { encoding: 'utf-8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  };
  git(['init', '-q', '-b', 'main']);
  git(['add', '-A']);
  const ignored = Object.keys(forced);
  if (ignored.length > 0) git(['add', '-f', '--', ...ignored]);
  git(['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-q', '-m', 'tree']);
}

/**
 * The text of a config declaring exactly the shipped checks `names`.
 *
 * @param names - The checks' keys in the repository's config
 * @returns The config's YAML
 */
export function configOfShippedChecks(names: readonly string[]): string {
  return yaml.stringify({ resources: { checks: Object.fromEntries(names.map((name) => [name, shippedCheck(name)])) } });
}

/** One run of the built `vat` over `root`, as its JSON document. */
function vat(root: string, cacheDir: string, args: readonly string[]): { readonly status: number; readonly document: VatDocument } {
  const result = spawnSync(process.execPath, [VAT_BIN, ...args, '--format', 'json'], {
    cwd: root,
    env: { ...process.env, [VAT_CACHE_DIR_ENV]: cacheDir },
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const status = result.status ?? -1;
  try {
    return { status, document: JSON.parse(result.stdout) as VatDocument };
  } catch (error) {
    throw new Error(`vat ${args.join(' ')} wrote no JSON document (exit ${status}): ${String(error)}\n${result.stdout}\n${result.stderr}`);
  }
}

/** A `vat resources check` or `query` document, as far as the proof reads it. */
interface VatDocument {
  readonly status?: string;
  readonly findings?: ReadonlyArray<{ readonly code: string; readonly message?: string; readonly location?: string; readonly line?: number }>;
  readonly data?: {
    readonly rows?: ReadonlyArray<Record<string, unknown>>;
    readonly checks?: ReadonlyArray<{ readonly name: string; readonly examined?: number }>;
  } | null;
}

/** What a check said over one tree. */
export interface CheckAnswer {
  /** Its findings, as `path:line`, sorted. */
  readonly findings: readonly string[];
  /** Its findings' messages, sorted. */
  readonly messages: readonly string[];
  /** The files its population relation holds, sorted. */
  readonly population: readonly string[];
  /** Every other finding of the run (a `TS_FILE_NO_ROWS`, say), as `code path`. */
  readonly runFindings: readonly string[];
  /** The `examined` count the check published. */
  readonly examined: number | undefined;
  /** What each extra statement named by the caller answered, in the order the query gave, by its tag. */
  readonly queried: Readonly<Record<string, readonly string[]>>;
}

/**
 * Run the check `name` over `root` as `vat resources check --check`, and read its population
 * relation, and any further statements the caller names, through ONE `vat resources query` over the
 * same store: a tagged `UNION ALL`, with the check's own `with` text.
 *
 * @param root - The tree, whose config declares the check
 * @param cacheDir - The `VAT_CACHE_DIR` both runs use
 * @param check - The check's key and the CTE of its `with` that holds the files it examines
 * @param check.name - The check's key
 * @param check.population - The CTE's name
 * @param queries - Further statements to answer in the same query, by tag: each selects ONE column, aliased `v`
 * @returns The check's findings, population and the run's other findings, and each further answer under `queried`
 */
export function runCheck(
  root: string,
  cacheDir: string,
  check: { readonly name: string; readonly population: string },
  queries: Readonly<Record<string, string>> = {},
): CheckAnswer {
  const code = `CUSTOM:${check.name}`;
  const { document } = vat(root, cacheDir, ['resources', 'check', '--check', check.name]);
  const findings = document.findings ?? [];
  const own = findings.filter((finding) => finding.code === code);
  const tagged = taggedQuery(root, cacheDir, shippedWith(check.name), { population: `SELECT DISTINCT path AS v FROM ${check.population}`, ...queries });
  const { population, ...queried } = tagged;
  return {
    findings: own.map((finding) => `${finding.location ?? '?'}:${finding.line ?? '?'}`).toSorted(byText),
    messages: own.map((finding) => finding.message ?? '').toSorted(byText),
    population: (population ?? []).toSorted(byText),
    queried,
    runFindings: findings.filter((finding) => finding.code !== code).map((finding) => `${finding.code} ${finding.location ?? ''}`),
    examined: document.data?.checks?.find((entry) => entry.name === check.name)?.examined,
  };
}

/**
 * Several one-column statements answered by ONE `vat resources query`: each is tagged and the
 * statements joined with `UNION ALL`, so one process and one store read serve them all.
 *
 * @param root - The tree
 * @param cacheDir - The `VAT_CACHE_DIR` the run uses
 * @param ctes - The `with` text every statement may read
 * @param statements - Each answer's tag and its `SELECT` of one column aliased `v`
 * @returns The values under each tag, in the order the query answered; a tag whose statement answers nothing is an empty list
 */
function taggedQuery(root: string, cacheDir: string, ctes: string, statements: Readonly<Record<string, string>>): Record<string, readonly string[]> {
  const union = Object.entries(statements).map(([tag, select]) => `SELECT '${tag}' AS tag, CAST(v AS TEXT) AS v FROM (${select})`).join(' UNION ALL ');
  const rows = vatQuery(root, cacheDir, `WITH ${ctes} ${union}`);
  const answers: Record<string, string[]> = Object.fromEntries(Object.keys(statements).map((tag) => [tag, []]));
  for (const row of rows) answers[String(row['tag'])]?.push(String(row['v']));
  return answers;
}

/**
 * The `with` text of the shipped check `name`: its CTEs, for a query that reads them.
 *
 * @param name - The check's key
 * @returns The text; a check declaring none throws
 */
function shippedWith(name: string): string {
  const { with: ctes } = shippedCheck(name);
  if (ctes === undefined) throw new Error(`resources.checks.${name} declares no with`);
  return ctes;
}

/**
 * The rows `vat resources query` answers `sql` with over `root`.
 *
 * @param root - The tree
 * @param cacheDir - The `VAT_CACHE_DIR` the run uses
 * @param sql - The statement
 * @returns Its rows; a refused or failed query throws
 */
export function vatQuery(root: string, cacheDir: string, sql: string): ReadonlyArray<Record<string, unknown>> {
  const { status, document } = vat(root, cacheDir, ['resources', 'query', sql]);
  const rows = document.data?.rows;
  if (status !== 0 || rows === undefined) throw new Error(`the query failed (exit ${status}): ${JSON.stringify(document)}`);
  return rows;
}

/** Whether a resolved rule setting is on: its severity, alone or first in an array, is not off. */
function isEnabled(setting: unknown): boolean {
  const severity: unknown = Array.isArray(setting) ? setting[0] : setting;
  return severity !== undefined && severity !== 0 && severity !== 'off';
}

/**
 * The files of `candidates` ESLint enables `rule` for under `eslint`'s configuration: not ignored
 * (`isPathIgnored`, which carries the global ignores), and the rule on in the config resolved for
 * the file (`calculateConfigForFile`).
 *
 * @param eslint - The configured instance
 * @param root - The tree's root, which `candidates` are relative to
 * @param candidates - The files to ask about
 * @param rule - The rule, as the config names it
 * @returns The enabled files, sorted
 */
async function ruleEnabledFiles(eslint: ESLint, root: string, candidates: readonly string[], rule: string): Promise<string[]> {
  const verdicts = await Promise.all(candidates.map(async (file) => {
    const absolute = safePath.join(root, file);
    if (await eslint.isPathIgnored(absolute)) return undefined;
    const config = (await eslint.calculateConfigForFile(absolute)) as { rules?: Record<string, unknown> } | undefined;
    return isEnabled(config?.rules?.[rule]) ? file : undefined;
  }));
  return verdicts.filter((file): file is string => file !== undefined).toSorted(byText);
}

/**
 * Every `(file, line)` each rule of `populations` reports, as `path:line`, from one lint of the
 * union of the files they are enabled for. A file that does not parse throws: its silence would
 * read as clean.
 *
 * @param eslint - The configured instance, filtered to the rules
 * @param root - The tree's root
 * @param populations - Each rule's enabled files, relative to the root
 * @returns Each rule's reports, sorted
 */
async function rulesReports(eslint: ESLint, root: string, populations: Readonly<Record<string, readonly string[]>>): Promise<Record<string, string[]>> {
  const union = [...new Set(Object.values(populations).flat())];
  const results = await eslint.lintFiles(union.map((file) => safePath.join(root, file)));
  const reports: Record<string, string[]> = Object.fromEntries(Object.keys(populations).map((rule) => [rule, []]));
  for (const result of results) {
    const file = safePath.relative(root, result.filePath);
    const fatal = result.messages.find((message) => message.fatal === true);
    if (fatal !== undefined) throw new Error(`${file}: ${fatal.message}`);
    for (const message of result.messages) {
      reports[message.ruleId ?? '']?.push(`${file}:${message.line}`);
    }
  }
  return Object.fromEntries(Object.entries(reports).map(([rule, lines]) => [rule, lines.toSorted(byText)]));
}

/**
 * Two sets held both ways: what only the check has, and what only the rule has. Both are empty
 * exactly when the port is as strong as the usage it replaces.
 *
 * @param check - The check's side
 * @param rule - The rule's side
 * @returns The two differences
 */
export function bothWays(check: readonly string[], rule: readonly string[]): { readonly onlyCheck: readonly string[]; readonly onlyRule: readonly string[] } {
  const checkSet = new Set(check);
  const ruleSet = new Set(rule);
  return { onlyCheck: check.filter((each) => !ruleSet.has(each)), onlyRule: rule.filter((each) => !checkSet.has(each)) };
}

/**
 * The `local` plugin object a flat config registers. A block laid over that config must reuse it:
 * flat config refuses a second object under one plugin name.
 *
 * @param config - The flat config
 * @returns The plugin
 */
export function localPlugin(config: readonly Linter.Config[]): ESLint.Plugin {
  const plugin = config.find((block) => block.plugins?.['local'] !== undefined)?.plugins?.['local'];
  if (plugin === undefined) throw new Error('the config registers no local plugin');
  return plugin;
}

/**
 * The `path:line` of every line of `files` carrying `marker`: in a corpus, the lines a rule must
 * report are marked in their own text.
 *
 * @param files - Path to text
 * @param marker - The mark
 * @returns The marked lines, sorted
 */
export function markedLines(files: Readonly<Record<string, string>>, marker: string): string[] {
  return Object.entries(files).flatMap(([path, text]) => text.split('\n').flatMap((line, index) => (line.includes(marker) ? [`${path}:${index + 1}`] : []))).toSorted(byText);
}

/** The rule's side of a proof over one tree. */
export interface RuleSide {
  /** The files ESLint enables the rule for ({@link ruleEnabledFiles}). */
  readonly population: string[];
  /** What the rule reports in them ({@link rulesReports}). */
  readonly reports: string[];
}

/**
 * The rules' sides over one tree: one ESLint instance under `baseConfig` (the repository's own
 * flat config, so its global ignores and git-ignored patterns decide) with `blocks` (the deleted
 * usage) laid over it, running only the rules named in `candidates`, with no typed program, and
 * linting the union of the files they are enabled for once. A candidate no longer on disk (a
 * deletion the git index still lists) is not asked about.
 *
 * @param options - The tree, the configuration and the files to ask about
 * @param options.root - The tree's root
 * @param options.baseConfig - The repository's flat config
 * @param options.blocks - The usage the port replaced, as flat-config blocks
 * @param options.candidates - Each rule, as the config names it, with the files to ask about, relative to the root
 * @returns Each rule's enabled files and its reports in them
 */
export async function ruleSides(options: {
  readonly root: string;
  readonly baseConfig: Linter.Config[];
  readonly blocks: readonly Linter.Config[];
  readonly candidates: Readonly<Record<string, readonly string[]>>;
}): Promise<Record<string, RuleSide>> {
  const { root, baseConfig, blocks, candidates } = options;
  const rules = new Set(Object.keys(candidates));
  const eslint = new ESLint({
    cwd: root,
    overrideConfigFile: true,
    baseConfig,
    ruleFilter: ({ ruleId }) => rules.has(ruleId),
    overrideConfig: [NO_TYPED_PROGRAM, ...blocks],
  });
  const populations = Object.fromEntries(await Promise.all(Object.entries(candidates).map(async ([rule, files]) => [
    rule,
    await ruleEnabledFiles(eslint, root, files, rule),
  ] as const)));
  const reports = await rulesReports(eslint, root, populations);
  return Object.fromEntries(Object.entries(populations).map(([rule, population]) => [rule, { population, reports: reports[rule] ?? [] }]));
}

/** The corpus and cache directories of one port proof, filled in by the `beforeAll` {@link portTempDirs} registers. */
interface PortDirs {
  corpus: string;
  cache: string;
}

/**
 * Register, in the calling suite, the `beforeAll` that creates a corpus directory and a cache
 * directory, commits the corpus into the first, and the `afterAll` that removes both. Call it first
 * in the suite, so the suite's own `beforeAll` runs after it.
 *
 * @param prefix - The temp directory name prefix
 * @param files - The corpus, root-relative path to text
 * @param forced - The corpus files a `.gitignore` ignores, tracked anyway
 * @returns The directories, valid once the suite's hooks have run
 */
export function portTempDirs(prefix: string, files: Readonly<Record<string, string>>, forced: Readonly<Record<string, string>>): PortDirs {
  const dirs: PortDirs = { corpus: '', cache: '' };
  beforeAll(() => {
    dirs.corpus = createTempDir(prefix);
    dirs.cache = createTempDir(`${prefix}cache-`);
    writeCommittedTree(dirs.corpus, files, forced);
  });
  afterAll(() => {
    removeTempDir(dirs.corpus);
    removeTempDir(dirs.cache);
  });
  return dirs;
}

/** The cache directory of this checkout: the repository arms read and write its own store. */
export function repositoryCacheDir(): string {
  return checkoutVatCacheDir(process.env, REPO_ROOT, normalizedTmpdir());
}

/**
 * The check's answer over this repository, in the checkout's own cache.
 *
 * @param check - The check's key and the CTE of its `with` that holds the files it examines
 * @param check.name - The check's key
 * @param check.population - The CTE's name
 * @param queries - Further statements answered in the same query, by tag (see {@link runCheck})
 * @returns The check's answer
 */
export function runCheckOverRepository(check: { readonly name: string; readonly population: string }, queries: Readonly<Record<string, string>> = {}): CheckAnswer {
  return runCheck(REPO_ROOT, repositoryCacheDir(), check, queries);
}

/**
 * Assert the repository arm of a proof: the check's answer over this repository equals the rule's
 * side both ways, in findings and in the files each examines, and neither is empty.
 *
 * @param answer - The check's answer over the repository
 * @param rule - The rule's side over the same tree
 */
export function expectRepositoryArm(answer: CheckAnswer, rule: RuleSide): void {
  expect(answer.runFindings.filter((finding) => finding.startsWith('TS_FILE_NO_ROWS'))).toStrictEqual([]);
  expect(bothWays(answer.findings, rule.reports)).toStrictEqual({ onlyCheck: [], onlyRule: [] });
  expect(bothWays(answer.population, rule.population)).toStrictEqual({ onlyCheck: [], onlyRule: [] });
  expect(answer.examined).toBe(answer.population.length);
  expect(answer.population.length).toBeGreaterThan(0);
}
