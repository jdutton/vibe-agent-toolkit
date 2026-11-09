/**
 * Which turbo tasks read a workspace package's built output, and whether turbo
 * runs a task that PRODUCES that output before each of them.
 *
 * A task that runs `node ../cli/dist/bin/vat.js`, or a test that spawns the
 * cli's `dist/bin.js`, reads a dozen packages' `dist/`. Only a turbo edge makes
 * turbo produce them first — and folds their hash into the reader's, so a
 * rebuilt dependency re-runs it instead of replaying a cached verdict. Without
 * one, a cold run reads a missing `dist/` and a warm one a stale one. Such an
 * edge is either a workspace dependency (so `^build` covers it) or an explicit
 * `<pkg>#<task>` entry in `turbo.json`.
 *
 * Every half is derived, never listed by hand:
 *
 * - **The reaches** — test files and their helpers are read by
 *   `built-output-scan.ts` (syntax, not spelling); package scripts word by word,
 *   each word judged as that scan judges a path, from the package's directory.
 *   A script that runs a bin by name (`vat …`) is out of scope: a bin resolves
 *   only through a declared dependency, which `^build` already orders.
 * - **Who reads** — a reach in a test file belongs to the tier task of every
 *   test file that loads it, directly or through other helpers, and a reach in
 *   a vitest setup file to every test it runs before; a reach in a script
 *   belongs to every turbo task whose command runs that script. A script word
 *   after a `cd` resolves from a directory the rule cannot know.
 * - **Who produces** — every task of the reached package whose declared
 *   `outputs` cover the path and whose `excludedOutputs` (turbo's `!` globs) do
 *   not, each glob matched whole: `dist/**\/*.d.ts` does not cover `dist/bin.js`.
 *   Any one of them, ordered first, is enough. A directory read whole needs a
 *   `<dir>/**` output at or above it, and, for each output tree below it, one
 *   ordered task covering that tree.
 * - **The ordering** — turbo's own task graph (`turbo run … --dry=json`):
 *   `^build`, package overrides and transitive edges mean what turbo says. A
 *   task reading what it produces itself is ordered.
 *
 * And because a `<pkg>#<task>` entry REPLACES the generic task rather than
 * merging with it, every `<pkg>#test:<tier>` entry of the root `turbo.json`, and
 * every tier a package's own `turbo.json` redefines, must match the root's
 * generic `test:<tier>`: the same `env`, `outputs` and `cache`, and at least its
 * `dependsOn` and `inputs` (an omitted or empty `inputs` is `$TURBO_DEFAULT$`).
 * An override adds inputs only to hash what its suite reads outside its package.
 *
 * Anything that cannot be decided — a path the scan cannot resolve, a reach no
 * test loads, a sibling reach no task runs, a path no task produces, a test in
 * a tier its package has no script for — is a finding, never a pass.
 */

import { readFileSync } from 'node:fs';

import { compareCodeUnits, safePath, toForwardSlashAnyPlatform } from '@vibe-agent-toolkit/utils';
import picomatch from 'picomatch';
import ts from 'typescript';

import { judgeScriptWord, scanTestTree, type FileReach, type TestTreeScan } from './built-output-scan.js';
import { nonDeletedGitListing } from './comment-density.js';
import { safeExecResult } from './common.js';
import type { WorkspaceGraph } from './workspace-graph.js';

/** A task definition as `turbo.json` declares it, its defaults filled in. */
export interface TaskDefinition {
  readonly outputs: readonly string[];
  readonly cache: boolean;
  readonly dependsOn: readonly string[];
  /** `["$TURBO_DEFAULT$"]` where none, or an empty list, is declared. */
  readonly inputs: readonly string[];
  readonly env: readonly string[];
}

/** One task in turbo's dry-run graph — a task a package actually has. */
export interface TurboTask {
  readonly package: string;
  readonly task: string;
  readonly command: string;
  readonly dependencies: readonly string[];
  /** The output globs, less turbo's `!` exclusions. */
  readonly outputs: readonly string[];
  /** The `!` output globs, without the `!`. */
  readonly excludedOutputs: readonly string[];
}

/** A test tier's definition as one package entry gives it. */
export interface TierOverride {
  /** Where the entry is: `turbo.json ("<pkg>#<tier>")` or `packages/<dir>/turbo.json ("<tier>")`. */
  readonly site: string;
  readonly task: string;
  readonly definition: TaskDefinition;
}

/** The root `turbo.json`'s generic test tiers, and every package entry that redefines one. */
export interface TierDefinitions {
  readonly generic: ReadonlyMap<string, TaskDefinition>;
  readonly overrides: readonly TierOverride[];
}

/** turbo's task graph, and the test-tier definitions its package entries must keep. */
export interface TurboTaskGraph {
  /** Task id → the task. */
  readonly tasks: ReadonlyMap<string, TurboTask>;
  readonly tiers: TierDefinitions;
}

/** A reader of built output, attributed to the turbo task that runs it. */
interface AttributedReach {
  readonly site: string;
  readonly task: string;
  /** Manifest name of the package whose output it reads. */
  readonly pkg: string;
  readonly subpath: string;
  readonly open: boolean;
}

/** A finding: where, and what is wrong there. */
export interface EdgeProblem {
  readonly site: string;
  readonly message: string;
}

const SYSTEM = 'test:system';
const INTEGRATION = 'test:integration';
const UNIT = 'test:unit';
const TIERS: ReadonlySet<string> = new Set([UNIT, INTEGRATION, SYSTEM]);

/**
 * turbo's placeholder `command` for a task the package has no script for: the
 * dry run lists `<pkg>#test:system` for EVERY package, with this command when
 * the package cannot run it.
 */
const NONEXISTENT = '<NONEXISTENT>';

/** A script run by name: `bun run x`, `npm run x`, and bun's `bun x` shorthand (only a name `scripts` has counts). */
const RUN_SCRIPT = /\b(?:(?:bun|npm|pnpm|yarn)\s+run|bun)\s+([\w:.-]+)/g;
/** What separates a script's words: whitespace, quotes, and the shell's operators. */
const SCRIPT_WORD_BREAK = /[\s'"`;&|()<>=]+/;

/**
 * The files the rule reads, in the working tree (tracked plus
 * untracked-not-ignored): everything under `packages/`, and the vitest setup
 * files at the root.
 */
export function workingTreeScanFiles(repoRoot: string): string[] {
  return nonDeletedGitListing(repoRoot, ['packages', 'vitest.*setup.*', '*global-setup.*', '*globalSetup.*'], ['--cached', '--others', '--exclude-standard']);
}

/** The vitest tier — and so the turbo task name — that runs a test file. */
function testTierOf(rel: string): string {
  if (/\.system\.test\.[cm]?[jt]sx?$/.test(rel)) return SYSTEM;
  if (/\.integration\.test\.[cm]?[jt]sx?$/.test(rel)) return INTEGRATION;
  return UNIT;
}

/** The test-tree files `entry` loads: itself and everything it imports, transitively. */
function closureOf(entry: string, imports: TestTreeScan['imports']): Set<string> {
  const seen = new Set<string>();
  const pending = [entry];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    pending.push(...(imports.get(file) ?? []));
  }
  return seen;
}

/** The manifest name of the package a `packages/<dir>/…` path sits in. */
function ownerOf(rel: string, nameOf: ReadonlyMap<string, string>): string | undefined {
  return nameOf.get(/^packages\/([^/]+)\//.exec(rel)?.[1] ?? '');
}

/** The setup files that run before `entry`: the root's, and its own package's. */
function setupsOf(entry: string, setups: readonly string[]): string[] {
  const dir = /^packages\/[^/]+\//.exec(entry)?.[0] ?? '';
  return setups.filter((setup) => !setup.startsWith('packages/') || setup.startsWith(dir));
}

/**
 * Each reach of the scan, once per tier task of every test that loads its file
 * or runs after it as a setup file. A test whose tier task its package does not
 * have, and a reach no test loads, are findings.
 */
function attributeTestReaches(scan: TestTreeScan, graph: WorkspaceGraph, tasks: TurboTaskGraph['tasks']): { reaches: AttributedReach[]; problems: EdgeProblem[] } {
  const nameOf = new Map(graph.packages.map((pkg) => [pkg.dir, pkg.name] as const));
  const bySite = new Map<string, FileReach[]>();
  for (const reach of scan.reaches) bySite.set(reach.site, [...(bySite.get(reach.site) ?? []), reach]);
  const reaches: AttributedReach[] = [];
  const problems: EdgeProblem[] = [];
  const loaded = new Set<string>();
  for (const entry of scan.entries) {
    const task = `${ownerOf(entry, nameOf) ?? '?'}#${testTierOf(entry)}`;
    if (!tasks.has(task)) {
      problems.push({ site: entry, message: `is a ${testTierOf(entry)} test, but turbo has no ${task} task: no script runs it.` });
      continue;
    }
    const loads = [entry, ...setupsOf(entry, scan.setups)].flatMap((root) => [...closureOf(root, scan.imports)]);
    for (const file of new Set(loads)) {
      loaded.add(file);
      for (const reach of bySite.get(file) ?? []) {
        reaches.push({ site: reach.at, task, pkg: nameOf.get(reach.dir) ?? reach.dir, subpath: reach.subpath, open: reach.open });
      }
    }
  }
  for (const reach of scan.reaches.filter(({ site }) => !loaded.has(site))) {
    problems.push({
      site: reach.at,
      message: `reads ${reach.dir}'s ${reach.subpath}, but no test file loads ${reach.site} through relative imports the rule can follow, so no tier task is known to read it. Import it statically from the tests that use it.`,
    });
  }
  return { reaches, problems };
}

/** The scripts a command runs by name, transitively through `scripts`. */
function scriptsRunBy(command: string, scripts: Readonly<Record<string, string>>): Set<string> {
  const run = new Set<string>();
  const pending = [command];
  for (let text = pending.pop(); text !== undefined; text = pending.pop()) {
    for (const match of text.matchAll(RUN_SCRIPT)) {
      const name = match[1] ?? '';
      if (run.has(name) || scripts[name] === undefined) continue;
      run.add(name);
      pending.push(scripts[name]);
    }
  }
  return run;
}

/** One script of one package: its text, where a finding points, and the turbo tasks that run it. */
interface ScriptSite {
  readonly pkg: WorkspaceGraph['packages'][number];
  readonly text: string;
  readonly site: string;
  readonly runners: readonly string[];
}

/** The reaches one script's words make, once per task that runs it, and what cannot be judged. */
function judgeScript({ pkg, text, site, runners }: ScriptSite, graph: WorkspaceGraph, nameOf: ReadonlyMap<string, string>): { reaches: AttributedReach[]; problems: EdgeProblem[] } {
  const reaches: AttributedReach[] = [];
  const problems: EdgeProblem[] = [];
  // A script runs in its package's directory until a `cd` moves it somewhere the rule cannot follow.
  let cwd: string | undefined = pkg.dir;
  for (const word of text.split(SCRIPT_WORD_BREAK).filter((part) => part !== '')) {
    if (word === 'cd' || word === 'pushd') cwd = undefined;
    const verdict = judgeScriptWord(word, cwd, graph);
    if (verdict === undefined) continue;
    if ('unresolved' in verdict) {
      problems.push({ site, message: `\`${word}\` builds a dist/ path, but ${verdict.unresolved}, so no rule can tell whose build it reads.` });
      continue;
    }
    const reached = nameOf.get(verdict.reach.dir) ?? verdict.reach.dir;
    // A script nothing runs through turbo (`clean`) reading its OWN output orders nothing and needs nothing.
    if (runners.length === 0 && reached !== pkg.name) problems.push({ site, message: `reads ${reached}'s built output, but no turbo task runs this script, so nothing orders it.` });
    for (const task of runners) reaches.push({ site, task, pkg: reached, ...verdict.reach });
  }
  return { reaches, problems };
}

/** Each reach written in a package script, once per turbo task that runs the script. */
function attributeScriptReaches(graph: WorkspaceGraph, tasks: TurboTaskGraph['tasks']): { reaches: AttributedReach[]; problems: EdgeProblem[] } {
  const nameOf = new Map(graph.packages.map((pkg) => [pkg.dir, pkg.name] as const));
  const reaches: AttributedReach[] = [];
  const problems: EdgeProblem[] = [];
  for (const pkg of graph.packages) {
    const scripts = (pkg.manifest['scripts'] ?? {}) as Record<string, string>;
    const own = [...tasks.entries()].filter(([, task]) => task.package === pkg.name);
    for (const [script, text] of Object.entries(scripts)) {
      const runners = own.filter(([, task]) => task.task === script || scriptsRunBy(task.command, scripts).has(script)).map(([id]) => id);
      const judged = judgeScript({ pkg, text, site: `packages/${pkg.dir}/package.json (script "${script}")`, runners }, graph, nameOf);
      reaches.push(...judged.reaches);
      problems.push(...judged.problems);
    }
  }
  return { reaches, problems };
}

/** Whether `path` is `dir` or inside it; every path is inside the package root (`''`). */
function within(path: string, dir: string): boolean {
  const normal = toForwardSlashAnyPlatform(path);
  return dir === '' || normal === dir || normal.startsWith(`${dir}/`);
}

/**
 * Whether one output glob matches a file, the glob read whole. An output
 * written with a leading `!` is an exclusion turbo lists apart (`excludedOutputs`):
 * in `outputs` it would name a file called `!…`, so it matches nothing here.
 */
function matchesFile(glob: string, path: string): boolean {
  return !glob.startsWith('!') && picomatch(glob, { dot: true })(toForwardSlashAnyPlatform(path));
}

/** The directory an output glob holds whole (`<dir>/**`), or `undefined` for any narrower glob (`dist/**\/*.d.ts`). */
function treeOf(glob: string): string | undefined {
  if (glob.startsWith('!')) return undefined;
  const { base, glob: rest } = picomatch.scan(glob);
  return rest === '**' || rest === '**/*' ? base : undefined;
}

/** Whether one output glob holds everything under `dir`. */
function holdsTree(glob: string, dir: string): boolean {
  const tree = treeOf(glob);
  return tree !== undefined && within(dir, tree);
}

/** Whether a task produces `path` — a file, or a directory read whole — and does not exclude it. */
function covers(task: TurboTask, { path, tree }: NeededPath): boolean {
  const holds = tree ? holdsTree : matchesFile;
  return task.outputs.some((glob) => holds(glob, path)) && !task.excludedOutputs.some((glob) => holds(glob, path));
}

/** Whether turbo runs `target` before `from`: `target` is in `from`'s dependency closure, or is `from` itself. */
function orders(tasks: TurboTaskGraph['tasks'], from: string, target: string): boolean {
  if (from === target) return true;
  const seen = new Set<string>();
  const pending = [...(tasks.get(from)?.dependencies ?? [])];
  for (let task = pending.pop(); task !== undefined; task = pending.pop()) {
    if (task === target) return true;
    if (seen.has(task)) continue;
    seen.add(task);
    pending.push(...(tasks.get(task)?.dependencies ?? []));
  }
  return false;
}

/** A path a reach needs produced: a file, or a directory it reads whole. */
interface NeededPath {
  readonly path: string;
  readonly tree: boolean;
}

/**
 * The paths a reach needs produced: the file it reads, or — when it reads a
 * directory whole — that directory and every output tree of the package below it.
 */
function neededPaths(tasks: readonly TurboTask[], { subpath, open }: AttributedReach): NeededPath[] {
  if (!open) return [{ path: subpath, tree: false }];
  const trees = tasks.flatMap((task) => task.outputs.map(treeOf)).filter((tree): tree is string => tree !== undefined && tree !== subpath && tree !== '' && within(tree, subpath));
  return [subpath, ...new Set(trees)].map((path) => ({ path, tree: true }));
}

/** One problem per path a reach needs that no task turbo runs first produces. */
function unorderedReaches(reaches: readonly AttributedReach[], tasks: TurboTaskGraph['tasks']): EdgeProblem[] {
  const problems: EdgeProblem[] = [];
  for (const reach of reaches) {
    const { site, task, pkg } = reach;
    const own = [...tasks.entries()].filter(([, candidate]) => candidate.package === pkg);
    for (const needed of neededPaths(own.map(([, candidate]) => candidate), reach)) {
      const { path } = needed;
      const producers = own.filter(([, candidate]) => covers(candidate, needed)).map(([id]) => id);
      if (producers.length === 0) {
        problems.push({ site, message: `${task} reads ${pkg}'s ${path}, but no turbo task of ${pkg} declares an output covering it.` });
      } else if (!producers.some((id) => orders(tasks, task, id))) {
        problems.push({
          site,
          message:
            `${task} reads ${pkg}'s ${path}, which ${producers.join(' or ')} produces, but turbo orders none of them before it, ` +
            'so a cold run reads a missing output and a warm one a stale one. Order one: a `workspace:*` devDependency when ' +
            `the producer is \`build\` and that makes no cycle; otherwise "${producers[0] ?? ''}" in a "${task}" entry's dependsOn in turbo.json.`,
        });
      }
    }
  }
  return problems;
}

/** What `actual` lacks of `expected`. */
function missing(expected: readonly string[], actual: readonly string[]): string[] {
  return expected.filter((item) => !actual.includes(item));
}

/**
 * Every package entry that differs from the generic test tier it redefines:
 * `env`, `outputs` and `cache` must equal the generic's, and `dependsOn` and
 * `inputs` must keep all of it. Checked both ways — an entry that adds an env
 * var or an output splits or widens what the tier caches, not only one that
 * drops one.
 */
function overrideDrift({ generic, overrides }: TierDefinitions): EdgeProblem[] {
  const problems: EdgeProblem[] = [];
  for (const { site, task, definition: got } of overrides) {
    const want = generic.get(task);
    if (want === undefined) {
      problems.push({ site, message: `redefines "${task}", but the root turbo.json has no generic "${task}" to compare it with.` });
      continue;
    }
    for (const key of ['env', 'outputs'] as const) {
      const lost = missing(want[key], got[key]);
      const added = missing(got[key], want[key]);
      if (lost.length > 0 || added.length > 0) {
        problems.push({ site, message: `sets ${key} ${JSON.stringify(got[key])}, the generic "${task}" ${JSON.stringify(want[key])}: a package entry replaces the generic one, so keep them equal.` });
      }
    }
    for (const key of ['inputs', 'dependsOn'] as const) {
      const lost = missing(want[key], got[key]);
      if (lost.length > 0) problems.push({ site, message: `drops the generic "${task}" ${key} ${JSON.stringify(lost)}: a package entry replaces the generic one, so repeat them.` });
    }
    if (want.cache !== got.cache) problems.push({ site, message: `sets cache ${String(got.cache)}, the generic "${task}" ${String(want.cache)}: a package entry replaces the generic one, so repeat it.` });
  }
  return problems;
}

/**
 * Every finding of the rule: unresolvable paths and unparseable files, unrunnable
 * tests, reaches with no reader or producer, reaches turbo does not order, and
 * test-tier overrides that drop the generic definition.
 */
export function findBuiltOutputEdgeProblems(repoRoot: string, graph: WorkspaceGraph, taskGraph: TurboTaskGraph, files: readonly string[]): EdgeProblem[] {
  const scan = scanTestTree(repoRoot, graph, files);
  const tests = attributeTestReaches(scan, graph, taskGraph.tasks);
  const scripts = attributeScriptReaches(graph, taskGraph.tasks);
  const problems = [
    ...scan.findings,
    ...tests.problems,
    ...scripts.problems,
    ...unorderedReaches([...scripts.reaches, ...tests.reaches], taskGraph.tasks),
    ...overrideDrift(taskGraph.tiers),
  ];
  const unique = new Map(problems.map((problem) => [`${problem.site}\0${problem.message}`, problem] as const));
  return [...unique.values()].sort((a, b) => compareCodeUnits(a.site, b.site) || compareCodeUnits(a.message, b.message));
}

/** One dry-run node, as far as this module reads it. */
interface DryRunTask {
  readonly taskId: string;
  readonly task: string;
  readonly package: string;
  readonly command: string;
  readonly dependencies: readonly string[];
  /** `null` for a task declared with `outputs: []`. */
  readonly outputs: readonly string[] | null;
  readonly excludedOutputs: readonly string[] | null;
}

const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');
const isStringArrayOrNull = (value: unknown): boolean => value === null || isStringArray(value);

function isDryRunTask(value: unknown): value is DryRunTask {
  if (typeof value !== 'object' || value === null) return false;
  const task = value as Record<string, unknown>;
  return (
    ['taskId', 'task', 'package', 'command'].every((key) => typeof task[key] === 'string') &&
    isStringArray(task['dependencies']) &&
    isStringArrayOrNull(task['outputs']) &&
    isStringArrayOrNull(task['excludedOutputs'])
  );
}

/** Whether `value` is a turbo dry run with at least one well-formed task. */
export function isTurboDryRun(value: unknown): value is { tasks: DryRunTask[] } {
  const tasks = (value as { tasks?: unknown } | null)?.tasks;
  return Array.isArray(tasks) && tasks.length > 0 && tasks.every(isDryRunTask);
}

/**
 * The tasks in `turbo run … --dry=json` output, without the placeholder nodes
 * turbo lists for tasks a package does not have.
 *
 * @throws When the text is not JSON or not a dry run with tasks — a rule with
 *   no graph has checked nothing
 */
export function parseTurboDryRun(stdout: string): TurboTaskGraph['tasks'] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`turbo --dry=json printed no JSON: ${JSON.stringify(stdout.slice(0, 200))}`);
  }
  if (!isTurboDryRun(parsed)) {
    throw new Error('turbo --dry=json printed no task graph (no `tasks`, or a task missing its id, command, dependencies or outputs)');
  }
  const real = parsed.tasks.filter((task) => task.command !== NONEXISTENT);
  return new Map(
    real.map(({ taskId, task, package: pkg, command, dependencies, outputs, excludedOutputs }) => [
      taskId,
      { task, package: pkg, command, dependencies, outputs: outputs ?? [], excludedOutputs: excludedOutputs ?? [] },
    ] as const),
  );
}

/** The default `inputs`: every file of the package that git does not ignore. */
const TURBO_DEFAULT = '$TURBO_DEFAULT$';

/** A declared task definition with turbo's defaults filled in; an omitted or empty `inputs` is `$TURBO_DEFAULT$`. */
function definitionOf(declared: Readonly<Record<string, unknown>>): TaskDefinition {
  const list = (key: string): readonly string[] => {
    const value = declared[key];
    return isStringArray(value) ? value : [];
  };
  const inputs = list('inputs');
  return { outputs: list('outputs'), cache: declared['cache'] !== false, dependsOn: list('dependsOn'), inputs: inputs.length === 0 ? [TURBO_DEFAULT] : inputs, env: list('env') };
}

/** One `turbo.json` text's tasks, as declared. */
type DeclaredTasks = ReadonlyMap<string, Readonly<Record<string, unknown>>>;

/**
 * The tasks of a `turbo.json` text (JSONC), by key, and the task names they define.
 *
 * @throws When it does not parse, or has no `tasks` object
 */
export function parseTurboConfig(text: string, file = 'turbo.json'): { names: string[]; tasks: DeclaredTasks } {
  const parsed = ts.parseConfigFileTextToJson(file, text);
  const config: unknown = parsed.config;
  const { error } = parsed;
  const tasks = (config as { tasks?: unknown } | undefined)?.tasks;
  if (error !== undefined || typeof tasks !== 'object' || tasks === null) {
    const detail = error === undefined ? '' : ': ' + ts.flattenDiagnosticMessageText(error.messageText, ' ');
    throw new Error(`${file} has no \`tasks\` object${detail}`);
  }
  const declared = new Map(Object.entries(tasks as Record<string, unknown>).map(([key, value]) => [key, (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>] as const));
  const names = [...new Set([...declared.keys()].map((key) => key.slice(key.indexOf('#') + 1)))].sort(compareCodeUnits);
  return { names, tasks: declared };
}

/** A package's own `turbo.json`, which extends the root's: each key it sets on a task replaces the root's. */
export interface PackageTurboConfig {
  readonly dir: string;
  readonly name: string;
  readonly tasks: DeclaredTasks;
}

/** The root's generic test tiers, and each `<pkg>#<tier>` entry of the root and tier of a package's `turbo.json`. */
export function tierDefinitions(root: DeclaredTasks, packages: readonly PackageTurboConfig[]): TierDefinitions {
  const generic = new Map([...TIERS].flatMap((tier) => {
    const declared = root.get(tier);
    return declared === undefined ? [] : [[tier, definitionOf(declared)] as const];
  }));
  const rootEntries = [...root].flatMap(([key, declared]): TierOverride[] => {
    const task = key.slice(key.indexOf('#') + 1);
    return key.includes('#') && TIERS.has(task) ? [{ site: `turbo.json ("${key}")`, task, definition: definitionOf(declared) }] : [];
  });
  const packageEntries = packages.flatMap(({ dir, name, tasks }) =>
    [...tasks].flatMap(([task, declared]): TierOverride[] => {
      if (!TIERS.has(task)) return [];
      const base = root.get(`${name}#${task}`) ?? root.get(task) ?? {};
      return [{ site: `packages/${dir}/turbo.json ("${task}")`, task, definition: definitionOf({ ...base, ...declared }) }];
    }),
  );
  return { generic, overrides: [...rootEntries, ...packageEntries] };
}

/** Every package's own `turbo.json`, with the package's name. */
function packageTurboConfigs(repoRoot: string): PackageTurboConfig[] {
  return nonDeletedGitListing(repoRoot, ['packages/*/turbo.json']).map((rel) => {
    const dir = /^packages\/([^/]+)\//.exec(rel)?.[1] ?? '';
    const manifest = JSON.parse(readFileSync(safePath.join(repoRoot, 'packages', dir, 'package.json'), 'utf8')) as { name?: unknown };
    if (typeof manifest.name !== 'string') throw new Error(`packages/${dir}/package.json has no name, so its turbo.json cannot be read`);
    return { dir, name: manifest.name, tasks: parseTurboConfig(readFileSync(safePath.join(repoRoot, rel), 'utf8'), rel).tasks };
  });
}

/** Longest tail of a tool's stderr worth carrying into a finding. */
const STDERR_TAIL = 2000;
/** turbo's dry run takes about a second; anything near this is hung. */
const TURBO_TIMEOUT_MS = 60_000;

/**
 * turbo's task graph for every task `turbo.json` declares, from the
 * repository's own turbo.
 *
 * @throws When turbo.json cannot be read, or turbo cannot be run, fails, times
 *   out, or prints no graph — carrying the tail of its stderr
 */
export function readTurboTaskGraph(repoRoot: string): TurboTaskGraph {
  const { names, tasks: declared } = parseTurboConfig(readFileSync(safePath.join(repoRoot, 'turbo.json'), 'utf8'));
  const tiers = tierDefinitions(declared, packageTurboConfigs(repoRoot));
  // The repo's own turbo, through its node launcher: `turbo` on PATH exists only
  // under `bun run`, and may be another version.
  const launcher = safePath.join(repoRoot, 'node_modules', 'turbo', 'bin', 'turbo');
  const result = safeExecResult(process.execPath, [launcher, 'run', ...names, '--dry=json'], {
    cwd: repoRoot,
    encoding: 'utf8',
    // On Windows this bounds the node launcher, not the turbo.exe it spawns.
    timeout: TURBO_TIMEOUT_MS,
    // The graph is several MB; spawnSync's 1 MiB default truncates rather than failing.
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error !== undefined || result.status !== 0) {
    const stderr = String(result.stderr).trim().slice(-STDERR_TAIL);
    const why = result.error?.message ?? `exit ${result.status.toString()}`;
    const detail = stderr === '' ? '' : `:\n${stderr}`;
    throw new Error(`turbo run --dry=json failed (${why})${detail}`);
  }
  return { tasks: parseTurboDryRun(String(result.stdout)), tiers };
}
