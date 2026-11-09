/**
 * Which turbo tasks read a workspace package's built output, and whether turbo
 * runs the task that PRODUCES that output before each of them.
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
 * - **The reaches** — test files are read by `built-output-scan.ts` (syntax, not
 *   spelling); package scripts are shell text, scanned for a word that starts
 *   `../<dir>/dist` or `packages/<dir>/dist`.
 * - **Who reads** — a reach in a test file belongs to the tier task of every
 *   test file that imports it, directly or through other helpers, in whichever
 *   package that test lives; a reach in a script belongs to every turbo task
 *   whose command runs that script.
 * - **Who produces** — the task of the reached package whose declared `outputs`
 *   cover the path most specifically (`dist/skills/**` → `build:skills` over
 *   `dist/**` → `build`).
 * - **The ordering** — turbo's own task graph (`turbo run … --dry=json`):
 *   `^build`, package overrides and transitive edges mean what turbo says.
 *
 * Anything that cannot be decided — a reach with no reader task, a path no
 * task produces, a test in a tier its package has no script for, a package
 * segment that is not static — is a finding, never a pass.
 */

import { compareCodeUnits, safePath, toForwardSlashAnyPlatform } from '@vibe-agent-toolkit/utils';

import { scanTestTree, type FileReach, type TestTreeScan } from './built-output-scan.js';
import { nonDeletedGitListing } from './comment-density.js';
import { safeExecResult } from './common.js';
import type { WorkspaceGraph } from './workspace-graph.js';

/** One task in turbo's dry-run graph — a task a package actually has. */
export interface TurboTask {
  readonly package: string;
  readonly task: string;
  readonly command: string;
  readonly dependencies: readonly string[];
  readonly outputs: readonly string[];
}

/** turbo's task graph: task id → the task. */
export type TurboTaskGraph = ReadonlyMap<string, TurboTask>;

/** A reader of built output, attributed to the turbo task that runs it. */
interface AttributedReach {
  readonly site: string;
  readonly task: string;
  /** Manifest name of the package whose output it reads. */
  readonly pkg: string;
  readonly subpath: string;
}

/** A finding: where, and what is wrong there. */
export interface EdgeProblem {
  readonly site: string;
  readonly message: string;
}

const SYSTEM = 'test:system';
const INTEGRATION = 'test:integration';

/** The turbo tasks the graph is read for: every task that reads or produces built output here. */
const SCANNED_TASKS = ['build', 'build:skills', 'test:unit', INTEGRATION, SYSTEM] as const;

/**
 * turbo's placeholder `command` for a task the package has no script for: the
 * dry run lists `<pkg>#test:system` for EVERY package, with this command when
 * the package cannot run it.
 */
const NONEXISTENT = '<NONEXISTENT>';

/** A word of a script that starts at a sibling's built output. */
const SCRIPT_REACH = /(?:\.\.|packages)\/([a-z0-9][a-z0-9-]*)\/(dist(?![^/\s'"])[^\s'"]*)/g;
/** A script run by name: `bun run x`, `npm run x`. */
const RUN_SCRIPT = /\b(?:bun|npm|pnpm|yarn)\s+run\s+([\w:.-]+)/g;

/** The files under `packages/` in the working tree: tracked plus untracked-not-ignored. */
export function workingTreePackageFiles(repoRoot: string): string[] {
  return nonDeletedGitListing(repoRoot, ['packages'], ['--cached', '--others', '--exclude-standard']);
}

/** The vitest tier — and so the turbo task name — that runs a test file. */
function testTierOf(rel: string): string {
  if (/\.system\.test\.[cm]?[jt]sx?$/.test(rel)) return SYSTEM;
  if (/\.integration\.test\.[cm]?[jt]sx?$/.test(rel)) return INTEGRATION;
  return 'test:unit';
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
 * A test whose tier task its package does not have is a finding.
 */
function attributeTestReaches(scan: TestTreeScan, graph: WorkspaceGraph, taskGraph: TurboTaskGraph): { reaches: AttributedReach[]; problems: EdgeProblem[] } {
  const nameOf = new Map(graph.packages.map((pkg) => [pkg.dir, pkg.name] as const));
  const bySite = new Map<string, FileReach[]>();
  for (const reach of scan.reaches) bySite.set(reach.site, [...(bySite.get(reach.site) ?? []), reach]);
  const reaches: AttributedReach[] = [];
  const problems: EdgeProblem[] = [];
  for (const entry of scan.entries) {
    const task = `${ownerOf(entry, nameOf) ?? '?'}#${testTierOf(entry)}`;
    if (!taskGraph.has(task)) {
      problems.push({ site: entry, message: `is a ${testTierOf(entry)} test, but turbo has no ${task} task: no script runs it.` });
      continue;
    }
    for (const file of closureOf(entry, scan.imports)) {
      for (const reach of bySite.get(file) ?? []) {
        reaches.push({ site: reach.site, task, pkg: nameOf.get(reach.dir) ?? reach.dir, subpath: reach.subpath });
      }
    }
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

/** The workspace packages (by name) whose `dist/` a script's text reads, with the path read. */
function scriptReachesOf(text: string, dirs: ReadonlyMap<string, string>): Array<{ pkg: string; subpath: string }> {
  return [...text.matchAll(SCRIPT_REACH)].flatMap((match) => {
    const pkg = dirs.get(match[1] ?? '');
    return pkg === undefined ? [] : [{ pkg, subpath: match[2] ?? 'dist' }];
  });
}

/** Each reach written in a package script, once per turbo task that runs the script. */
function attributeScriptReaches(graph: WorkspaceGraph, taskGraph: TurboTaskGraph): { reaches: AttributedReach[]; problems: EdgeProblem[] } {
  const dirs = new Map(graph.packages.map((pkg) => [pkg.dir, pkg.name] as const));
  const reaches: AttributedReach[] = [];
  const problems: EdgeProblem[] = [];
  for (const pkg of graph.packages) {
    const scripts = (pkg.manifest['scripts'] ?? {}) as Record<string, string>;
    const tasks = [...taskGraph.entries()].filter(([, task]) => task.package === pkg.name);
    for (const [script, text] of Object.entries(scripts)) {
      const site = `packages/${pkg.dir}/package.json (script "${script}")`;
      const runners = tasks.filter(([, task]) => task.task === script || scriptsRunBy(task.command, scripts).has(script)).map(([id]) => id);
      for (const { pkg: reached, subpath } of scriptReachesOf(text, dirs)) {
        if (runners.length === 0) problems.push({ site, message: `reads ${reached}'s built output, but no turbo task runs this script, so nothing orders it.` });
        for (const task of runners) reaches.push({ site, task, pkg: reached, subpath });
      }
    }
  }
  return { reaches, problems };
}

/** The leading segments of a glob that hold no glob syntax: `dist/skills/**` → `dist/skills`. */
function staticPrefix(glob: string): string {
  const segments = toForwardSlashAnyPlatform(glob.replace(/^\.\//, '')).split('/');
  const end = segments.findIndex((segment) => /[*?[\]{}!]/.test(segment));
  return segments.slice(0, end === -1 ? segments.length : end).join('/');
}

/**
 * The tasks of `pkg` whose outputs cover `subpath` most specifically. An output
 * covers a path inside its static prefix; a glob with no static prefix
 * (`*.tsbuildinfo`) names no directory and covers nothing.
 */
function producersOf(taskGraph: TurboTaskGraph, pkg: string, subpath: string): string[] {
  let best = 0;
  let producers: string[] = [];
  for (const [id, task] of taskGraph) {
    if (task.package !== pkg) continue;
    for (const prefix of task.outputs.map(staticPrefix)) {
      const covers = prefix !== '' && (subpath === prefix || toForwardSlashAnyPlatform(subpath).startsWith(`${prefix}/`));
      if (!covers || prefix.length < best) continue;
      producers = prefix.length > best ? [id] : [...new Set([...producers, id])];
      best = prefix.length;
    }
  }
  return producers;
}

/** Whether turbo runs `target` before `from`: `target` is in `from`'s dependency closure. */
function orders(taskGraph: TurboTaskGraph, from: string, target: string): boolean {
  const seen = new Set<string>();
  const pending = [...(taskGraph.get(from)?.dependencies ?? [])];
  for (let task = pending.pop(); task !== undefined; task = pending.pop()) {
    if (task === target) return true;
    if (seen.has(task)) continue;
    seen.add(task);
    pending.push(...(taskGraph.get(task)?.dependencies ?? []));
  }
  return false;
}

/** One problem per reach whose producing task turbo does not run first. */
function unorderedReaches(reaches: readonly AttributedReach[], taskGraph: TurboTaskGraph): EdgeProblem[] {
  const problems: EdgeProblem[] = [];
  for (const { site, task, pkg, subpath } of reaches) {
    const producers = producersOf(taskGraph, pkg, subpath);
    if (producers.length === 0) {
      problems.push({ site, message: `${task} reads ${pkg}'s ${subpath}, but no turbo task of ${pkg} declares an output covering it.` });
    }
    for (const producer of producers.filter((id) => !orders(taskGraph, task, id))) {
      problems.push({
        site,
        message:
          `${task} reads ${pkg}'s ${subpath}, which ${producer} produces, but turbo does not order ${producer} before it, ` +
          'so a cold run reads a missing output and a warm one a stale one. Add a `workspace:*` devDependency when that ' +
          `makes no cycle and the producer is a \`build\`; otherwise add "${producer}" to a "${task}" entry's dependsOn in turbo.json.`,
      });
    }
  }
  return problems;
}

/**
 * Every finding of the rule: unresolvable reaches, unrunnable tests, reaches
 * with no reader or producer, and reaches turbo does not order.
 */
export function findBuiltOutputEdgeProblems(
  repoRoot: string,
  graph: WorkspaceGraph,
  taskGraph: TurboTaskGraph,
  files: readonly string[],
): EdgeProblem[] {
  const scan = scanTestTree(repoRoot, graph, files);
  const tests = attributeTestReaches(scan, graph, taskGraph);
  const scripts = attributeScriptReaches(graph, taskGraph);
  const problems = [
    ...scan.unresolved.map(({ site, expression }) => ({
      site,
      message: `\`${expression}\` reads some package's dist/, but which one is not static, so no rule can tell whose build it needs. Make the package segment a literal.`,
    })),
    ...tests.problems,
    ...scripts.problems,
    ...unorderedReaches([...scripts.reaches, ...tests.reaches], taskGraph),
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
}

const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');

function isDryRunTask(value: unknown): value is DryRunTask {
  if (typeof value !== 'object' || value === null) return false;
  const task = value as Record<string, unknown>;
  return (
    ['taskId', 'task', 'package', 'command'].every((key) => typeof task[key] === 'string') &&
    isStringArray(task['dependencies']) &&
    (task['outputs'] === null || isStringArray(task['outputs']))
  );
}

/** Whether `value` is a turbo dry run with at least one well-formed task. */
export function isTurboDryRun(value: unknown): value is { tasks: DryRunTask[] } {
  const tasks = (value as { tasks?: unknown } | null)?.tasks;
  return Array.isArray(tasks) && tasks.length > 0 && tasks.every(isDryRunTask);
}

/**
 * The task graph in `turbo run … --dry=json` output, without the placeholder
 * nodes turbo lists for tasks a package does not have.
 *
 * @throws When the text is not JSON or not a dry run with tasks — a rule with
 *   no graph has checked nothing
 */
export function parseTurboDryRun(stdout: string): TurboTaskGraph {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`turbo --dry=json printed no JSON: ${JSON.stringify(stdout.slice(0, 200))}`);
  }
  if (!isTurboDryRun(parsed)) throw new Error('turbo --dry=json printed no task graph (no `tasks`, or a task missing its id, command, dependencies or outputs)');
  const real = parsed.tasks.filter((task) => task.command !== NONEXISTENT);
  return new Map(real.map(({ taskId, outputs, ...task }) => [taskId, { ...task, outputs: outputs ?? [] }] as const));
}

/** Longest tail of a tool's stderr worth carrying into a finding. */
const STDERR_TAIL = 2000;
/** turbo's dry run takes about a second; anything near this is hung. */
const TURBO_TIMEOUT_MS = 60_000;

/**
 * turbo's task graph for every package, from the repository's own turbo.
 *
 * @throws When turbo cannot be run, fails, times out, or prints no graph —
 *   carrying the tail of its stderr
 */
export function readTurboTaskGraph(repoRoot: string): TurboTaskGraph {
  // The repo's own turbo, through its node launcher: `turbo` on PATH exists only
  // under `bun run`, and may be another version.
  const launcher = safePath.join(repoRoot, 'node_modules', 'turbo', 'bin', 'turbo');
  const result = safeExecResult(process.execPath, [launcher, 'run', ...SCANNED_TASKS, '--dry=json'], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: TURBO_TIMEOUT_MS,
    // The graph is ~2 MB; spawnSync's 1 MiB default truncates rather than failing.
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error !== undefined || result.status !== 0) {
    const stderr = String(result.stderr).trim().slice(-STDERR_TAIL);
    const why = result.error?.message ?? `exit ${result.status.toString()}`;
    const detail = stderr === '' ? '' : `:\n${stderr}`;
    throw new Error(`turbo run --dry=json failed (${why})${detail}`);
  }
  return parseTurboDryRun(String(result.stdout));
}
