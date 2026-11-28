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

import { spawn, spawnSync } from 'node:child_process';
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

/**
 * One run of the built `vat` over `root`, as its JSON document. Asynchronous, so a caller can lint
 * while the CLI runs in its own process.
 */
async function vat(root: string, cacheDir: string, args: readonly string[]): Promise<{ readonly status: number; readonly document: VatDocument }> {
  const child = spawn(process.execPath, [VAT_BIN, ...args, '--format', 'json'], {
    cwd: root,
    env: { ...process.env, [VAT_CACHE_DIR_ENV]: cacheDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf-8').on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding('utf-8').on('data', (chunk: string) => { stderr += chunk; });
  const status = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? -1));
  });
  try {
    return { status, document: JSON.parse(stdout) as VatDocument };
  } catch (error) {
    throw new Error(`vat ${args.join(' ')} wrote no JSON document (exit ${status}): ${String(error)}\n${stdout}\n${stderr}`);
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
 * @param queries - Further statements to answer in the same query, by tag: each selects ONE column, aliased `v`
 * @returns The check's findings, population and the run's other findings, and each further answer under `queried`
 */
export async function runCheck(
  root: string,
  cacheDir: string,
  check: PortedCheck,
  queries: Readonly<Record<string, string>> = {},
): Promise<CheckAnswer> {
  const { document } = await vat(root, cacheDir, ['resources', 'check', '--check', check.name]);
  return answerOf(document, check, await taggedQuery(root, cacheDir, shippedWith(check.name), populationQueries(check, queries)));
}

/** A ported check: its key in `resources.checks`, and the CTE of its `with` that holds the files it examines. */
interface PortedCheck {
  readonly name: string;
  readonly population: string;
}

/** The check's population statement, tagged `population`, beside the caller's further statements. */
function populationQueries(check: PortedCheck, queries: Readonly<Record<string, string>>): Record<string, string> {
  return { population: `SELECT DISTINCT path AS v FROM ${check.population}`, ...queries };
}

/**
 * @param document - The `vat resources check` document of a run that evaluated the check
 * @param check - The check
 * @param tagged - Its population and the further statements, as {@link taggedQuery} answered them
 * @returns What the check said
 */
function answerOf(document: VatDocument, check: PortedCheck, tagged: Record<string, readonly string[]>): CheckAnswer {
  const code = `CUSTOM:${check.name}`;
  const findings = document.findings ?? [];
  const own = findings.filter((finding) => finding.code === code);
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
async function taggedQuery(root: string, cacheDir: string, ctes: string, statements: Readonly<Record<string, string>>): Promise<Record<string, readonly string[]>> {
  const union = Object.entries(statements).map(([tag, select]) => `SELECT '${tag}' AS tag, CAST(v AS TEXT) AS v FROM (${select})`).join(' UNION ALL ');
  const rows = await vatQuery(root, cacheDir, `WITH ${ctes} ${union}`);
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
async function vatQuery(root: string, cacheDir: string, sql: string): Promise<ReadonlyArray<Record<string, unknown>>> {
  const { status, document } = await vat(root, cacheDir, ['resources', 'query', sql]);
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

/** The tree, the configuration and the files a rules' side asks about. */
interface RuleSidesOptions {
  /** The tree's root. */
  readonly root: string;
  /** The repository's flat config. */
  readonly baseConfig: Linter.Config[];
  /** The usage the port replaced, as flat-config blocks. */
  readonly blocks: readonly Linter.Config[];
  /** Each rule, as the config names it, with the files to ask about, relative to the root. */
  readonly candidates: Readonly<Record<string, readonly string[]>>;
}

/**
 * One ESLint instance under `baseConfig` (the repository's own flat config, so its global ignores
 * and git-ignored patterns decide) with `blocks` laid over it, running only the rules named in
 * `candidates`, with no typed program, and each rule's enabled files among its candidates. A
 * candidate no longer on disk (a deletion the git index still lists) is not asked about.
 */
async function enabledUnder(options: RuleSidesOptions): Promise<{ readonly eslint: ESLint; readonly populations: Record<string, string[]> }> {
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
  return { eslint, populations };
}

/**
 * Each rule's reports, `file:line`, over the files `blocks` enable it for, the union linted once.
 *
 * @param options - The tree, the configuration and the files to ask about
 * @returns Each rule's reports
 */
export async function ruleReports(options: RuleSidesOptions): Promise<Record<string, string[]>> {
  const { eslint, populations } = await enabledUnder(options);
  return rulesReports(eslint, options.root, populations);
}

/**
 * The rules' sides over one tree: each rule's enabled files under `blocks` (the deleted usage), and
 * its reports in them.
 *
 * The reports are linted here, or read from `reportedUnder`: an earlier {@link ruleReports} under
 * blocks that enable each rule, with the SAME options, for a superset of these files, which a
 * caller lints while something else it needs first is still running. A rule's reports in a file
 * depend on the file and the rule's options alone, never on which other files a block's `ignores`
 * leaves out, so the reports in these files are exactly those of that superset that fall in them.
 *
 * @param options - The tree, the configuration and the files to ask about
 * @param reportedUnder - Each rule's reports over a superset of its enabled files, the same options in force
 * @returns Each rule's enabled files and its reports in them
 */
export async function ruleSides(options: RuleSidesOptions, reportedUnder?: Readonly<Record<string, readonly string[]>>): Promise<Record<string, RuleSide>> {
  const { eslint, populations } = await enabledUnder(options);
  const reports = reportedUnder ?? await rulesReports(eslint, options.root, populations);
  return Object.fromEntries(Object.entries(populations).map(([rule, population]) => {
    const enabled = new Set(population);
    const within = (reports[rule] ?? []).filter((report) => enabled.has(report.slice(0, report.lastIndexOf(':'))));
    return [rule, { population, reports: within }];
  }));
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
function repositoryCacheDir(): string {
  return checkoutVatCacheDir(process.env, REPO_ROOT, normalizedTmpdir());
}

/**
 * Each check's answer over this repository, in the checkout's own cache, from ONE `vat resources
 * check` run: a run evaluates every declared check whichever `--check` it names, so one run without
 * it answers them all and populates the store once. Each check's population, and its further
 * statements, are then read by one `vat resources query` per check (each check's own `with`, which
 * may name the same CTE as another's), over that warm store.
 *
 * @param checks - Each check, with the further statements to answer beside its population, by tag (see {@link runCheck})
 * @returns Each check's answer, in the order given
 */
export async function runChecksOverRepository(
  checks: ReadonlyArray<{ readonly check: PortedCheck; readonly queries?: Readonly<Record<string, string>> }>,
): Promise<CheckAnswer[]> {
  const cacheDir = repositoryCacheDir();
  const { document } = await vat(REPO_ROOT, cacheDir, ['resources', 'check']);
  // One query at a time: each reads the store the run left, and none runs beside another.
  return checks.reduce<Promise<CheckAnswer[]>>(async (earlier, { check, queries = {} }) => {
    const answers = await earlier;
    const tagged = await taggedQuery(REPO_ROOT, cacheDir, shippedWith(check.name), populationQueries(check, queries));
    return [...answers, answerOf(document, check, tagged)];
  }, Promise.resolve([]));
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
