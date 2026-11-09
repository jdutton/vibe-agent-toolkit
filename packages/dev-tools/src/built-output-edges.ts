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
 *   test file that loads it, directly or through other helpers; a reach in a
 *   script belongs to every turbo task whose command runs that script.
 * - **Who produces** — every task of the reached package whose declared
 *   `outputs` (less its `excludedOutputs`) cover the path. Any one of them,
 *   ordered first, is enough. A read that may reach past its static part (a
 *   non-static tail, a directory read whole) also needs, for each task whose
 *   outputs lie under that part, one ordered task covering them.
 * - **The ordering** — turbo's own task graph (`turbo run … --dry=json`):
 *   `^build`, package overrides and transitive edges mean what turbo says. A
 *   task reading what it produces itself is ordered.
 *
 * And because a `<pkg>#<task>` entry REPLACES the generic task rather than
 * merging with it, every `<pkg>#test:<tier>` entry must carry the generic
 * tier's `env`, `outputs`, `inputs` and `dependsOn`, and its `cache`.
 *
 * Anything that cannot be decided — a path the scan cannot resolve, a reach no
 * test loads, a sibling reach no task runs, a path no task produces, a test in
 * a tier its package has no script for — is a finding, never a pass.
 */

import { readFileSync } from 'node:fs';

import { compareCodeUnits, safePath, toForwardSlashAnyPlatform } from '@vibe-agent-toolkit/utils';
import ts from 'typescript';

import { judgeScriptWord, scanTestTree, type FileReach, type TestTreeScan } from './built-output-scan.js';
import { nonDeletedGitListing } from './comment-density.js';
import { safeExecResult } from './common.js';
import type { WorkspaceGraph } from './workspace-graph.js';

/** What turbo resolved a task's definition to, as far as this module compares it. */
export interface ResolvedDefinition {
  readonly outputs: readonly string[];
  readonly cache: boolean;
  readonly dependsOn: readonly string[];
  readonly inputs: readonly string[];
  readonly env: readonly string[];
}

/** One task in turbo's dry-run graph — a task a package actually has. */
export interface TurboTask {
  readonly package: string;
  readonly task: string;
  readonly command: string;
  readonly dependencies: readonly string[];
  readonly outputs: readonly string[];
  readonly excludedOutputs: readonly string[];
  readonly definition: ResolvedDefinition;
}

/** turbo's task graph, and the `<pkg>#<task>` entries `turbo.json` declares. */
export interface TurboTaskGraph {
  /** Task id → the task. */
  readonly tasks: ReadonlyMap<string, TurboTask>;
  /** Every `<pkg>#<task>` key of `turbo.json`. */
  readonly overrides: readonly string[];
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

/** The files under `packages/` in the working tree: tracked plus untracked-not-ignored. */
export function workingTreePackageFiles(repoRoot: string): string[] {
  return nonDeletedGitListing(repoRoot, ['packages'], ['--cached', '--others', '--exclude-standard']);
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

/**
 * Each reach of the scan, once per tier task of every test that loads its file.
 * A test whose tier task its package does not have, and a reach no test loads,
 * are findings.
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
    for (const file of closureOf(entry, scan.imports)) {
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
  for (const word of text.split(SCRIPT_WORD_BREAK).filter((part) => part !== '')) {
    const verdict = judgeScriptWord(word, pkg.dir, graph);
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

/** The leading segments of a glob that hold no glob syntax: `dist/skills/**` → `dist/skills`. */
function staticPrefix(glob: string): string {
  const segments = toForwardSlashAnyPlatform(glob.replace(/^!?\.\//, '').replace(/^!/, '')).split('/');
  const end = segments.findIndex((segment) => /[*?[\]{}!]/.test(segment));
  return segments.slice(0, end === -1 ? segments.length : end).join('/');
}

/** Whether `path` is `prefix` or inside it. A glob with no static prefix (`*.tsbuildinfo`) names no directory and holds nothing. */
function within(path: string, prefix: string): boolean {
  const normal = toForwardSlashAnyPlatform(path);
  return prefix !== '' && (normal === prefix || normal.startsWith(`${prefix}/`));
}

/** Whether a task's outputs, less its excluded outputs, cover `path`. */
function covers(task: TurboTask, path: string): boolean {
  return task.outputs.some((glob) => within(path, staticPrefix(glob))) && !task.excludedOutputs.some((glob) => within(path, staticPrefix(glob)));
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

/**
 * The paths a reach needs produced: its static part, and — when it may reach
 * further — every output directory of the package that lies under it.
 */
function neededPaths(tasks: readonly TurboTask[], { subpath, open }: AttributedReach): string[] {
  if (!open) return [subpath];
  const under = tasks.flatMap((task) => task.outputs.map(staticPrefix)).filter((prefix) => prefix !== subpath && within(prefix, subpath));
  return [subpath, ...new Set(under)];
}

/** One problem per path a reach needs that no task turbo runs first produces. */
function unorderedReaches(reaches: readonly AttributedReach[], tasks: TurboTaskGraph['tasks']): EdgeProblem[] {
  const problems: EdgeProblem[] = [];
  for (const reach of reaches) {
    const { site, task, pkg } = reach;
    const own = [...tasks.entries()].filter(([, candidate]) => candidate.package === pkg);
    for (const path of neededPaths(own.map(([, candidate]) => candidate), reach)) {
      const producers = own.filter(([, candidate]) => covers(candidate, path)).map(([id]) => id);
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
 * Every `<pkg>#test:<tier>` entry that drops part of the generic tier's
 * definition: a package entry REPLACES the generic one, so what it does not
 * repeat is lost.
 */
function overrideDrift(graph: TurboTaskGraph): EdgeProblem[] {
  const overridden = new Set(graph.overrides);
  const problems: EdgeProblem[] = [];
  for (const id of graph.overrides) {
    const override = graph.tasks.get(id);
    if (override === undefined || !TIERS.has(override.task)) continue;
    const generic = [...graph.tasks.entries()].find(([other, task]) => task.task === override.task && !overridden.has(other))?.[1];
    if (generic === undefined) continue;
    const site = `turbo.json ("${id}")`;
    const { definition: want } = generic;
    const { definition: got } = override;
    for (const key of ['env', 'outputs', 'inputs', 'dependsOn'] as const) {
      const lost = missing(want[key], got[key]);
      if (lost.length > 0) problems.push({ site, message: `drops the generic "${override.task}" ${key} ${JSON.stringify(lost)}: a package entry replaces the generic one, so repeat them.` });
    }
    if (want.cache !== got.cache) problems.push({ site, message: `sets cache ${String(got.cache)}, the generic "${override.task}" ${String(want.cache)}: a package entry replaces the generic one, so repeat it.` });
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
    ...overrideDrift(taskGraph),
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
  readonly resolvedTaskDefinition: ResolvedDefinition;
}

const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');
const isStringArrayOrNull = (value: unknown): boolean => value === null || isStringArray(value);

function isResolvedDefinition(value: unknown): value is ResolvedDefinition {
  if (typeof value !== 'object' || value === null) return false;
  const definition = value as Record<string, unknown>;
  return typeof definition['cache'] === 'boolean' && ['outputs', 'dependsOn', 'inputs', 'env'].every((key) => isStringArray(definition[key]));
}

function isDryRunTask(value: unknown): value is DryRunTask {
  if (typeof value !== 'object' || value === null) return false;
  const task = value as Record<string, unknown>;
  return (
    ['taskId', 'task', 'package', 'command'].every((key) => typeof task[key] === 'string') &&
    isStringArray(task['dependencies']) &&
    isStringArrayOrNull(task['outputs']) &&
    isStringArrayOrNull(task['excludedOutputs']) &&
    isResolvedDefinition(task['resolvedTaskDefinition'])
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
    throw new Error('turbo --dry=json printed no task graph (no `tasks`, or a task missing its id, command, dependencies, outputs or resolved definition)');
  }
  const real = parsed.tasks.filter((task) => task.command !== NONEXISTENT);
  return new Map(
    real.map(({ taskId, task, package: pkg, command, dependencies, outputs, excludedOutputs, resolvedTaskDefinition }) => [
      taskId,
      { task, package: pkg, command, dependencies, outputs: outputs ?? [], excludedOutputs: excludedOutputs ?? [], definition: resolvedTaskDefinition },
    ] as const),
  );
}

/**
 * The task names and the `<pkg>#<task>` entries of a `turbo.json` text (JSONC).
 *
 * @throws When it does not parse, or has no `tasks` object
 */
export function parseTurboConfig(text: string): { names: string[]; overrides: string[] } {
  const parsed = ts.parseConfigFileTextToJson('turbo.json', text);
  const config: unknown = parsed.config;
  const { error } = parsed;
  const tasks = (config as { tasks?: unknown } | undefined)?.tasks;
  if (error !== undefined || typeof tasks !== 'object' || tasks === null) {
    const detail = error === undefined ? '' : ': ' + ts.flattenDiagnosticMessageText(error.messageText, ' ');
    throw new Error(`turbo.json has no \`tasks\` object${detail}`);
  }
  const keys = Object.keys(tasks);
  const names = [...new Set(keys.map((key) => key.slice(key.indexOf('#') + 1)))].sort(compareCodeUnits);
  return { names, overrides: keys.filter((key) => key.includes('#')) };
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
  const { names, overrides } = parseTurboConfig(readFileSync(safePath.join(repoRoot, 'turbo.json'), 'utf8'));
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
  return { tasks: parseTurboDryRun(String(result.stdout)), overrides };
}
