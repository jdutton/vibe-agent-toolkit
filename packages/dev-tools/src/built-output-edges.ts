/**
 * Which turbo tasks reach into ANOTHER workspace package's built `dist/`, and
 * whether turbo orders that package's `build` before each of them.
 *
 * A task that runs `node ../cli/dist/bin/vat.js`, or a test that spawns
 * `packages/cli/dist/bin.js`, reads a dozen packages' `dist/`. Only a turbo edge
 * makes turbo build them first — and folds their hash into the task's, so a
 * rebuilt dependency re-runs it instead of replaying a cached verdict. Without
 * one, a cold run executes against a missing `dist/` and a warm one against a
 * stale one. Such an edge is either a workspace dependency (so `^build` covers
 * it) or an explicit `<pkg>#<task>` entry in `turbo.json`.
 *
 * Both halves are derived, never listed by hand:
 *
 * - **The reaches** — every package script, and every test file under
 *   `packages/<dir>/test/` (or a `src/**\/*.test.*`), is scanned for a path that
 *   starts at another package's `dist/`: `../<dir>/dist…` (any number of `../`),
 *   `packages/<dir>/dist…`, or the segment form `'..', '<dir>', 'dist'`. A test
 *   file's task is its vitest tier, read off its name (`*.system.test.*`,
 *   `*.integration.test.*`, else unit; a helper takes the tier of the
 *   `test/system/` or `test/integration/` directory it sits in).
 * - **The ordering** — turbo's own task graph (`turbo run … --dry=json`), not a
 *   reading of `turbo.json`: `^build`, package overrides and transitive edges
 *   mean exactly what turbo says they mean, with no second implementation of its
 *   rules to drift.
 */

import { readFileSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';

import { nonDeletedGitListing } from './comment-density.js';
import { safeExecSync } from './common.js';
import type { WorkspaceGraph } from './workspace-graph.js';

/** One place a task reaches another package's built output. */
export interface BuiltOutputReach {
  /** Where the reach is written: a repo-relative test file, or `packages/<dir>/package.json` + script. */
  readonly site: string;
  /** The turbo task that executes the site, e.g. `@vibe-agent-toolkit/resources#test:system`. */
  readonly task: string;
  /** The build it needs ordered first, e.g. `@vibe-agent-toolkit/cli#build`. */
  readonly build: string;
}

/** turbo's task graph: task id → the task ids it directly depends on. */
export type TurboTaskGraph = ReadonlyMap<string, readonly string[]>;

const UNIT = 'test:unit';
const INTEGRATION = 'test:integration';
const SYSTEM = 'test:system';

/** The turbo tasks whose sites this module scans. */
const SCANNED_TASKS = ['build', 'build:skills', UNIT, INTEGRATION, SYSTEM] as const;

// A path that starts at `<dir>/dist`, through `../` hops or from the repo root.
/** In source, the path must be where a string literal starts — a fake `/repo/packages/…` is not a reach. */
const SOURCE_REACH = /['"`](?:(?:\.\.\/)+|packages\/)([a-z0-9][a-z0-9-]*)\/dist(?=$|[\s/'"`])/g;
/** In a script, a shell word starts it. */
const SCRIPT_REACH = /(?:^|[\s'"])(?:(?:\.\.\/)+|packages\/)([a-z0-9][a-z0-9-]*)\/dist(?=$|[\s/'"])/g;
/** The segment form, `…, '..', '<dir>', 'dist'`: the segment before `<dir>` climbs out. */
const SEGMENT_REACH = /['"]\.\.['"]\s*,\s*['"]([a-z0-9][a-z0-9-]*)['"]\s*,\s*['"]dist['"]/g;

/** A test-tree source file vitest can load, outside fixture and golden trees. */
const TEST_SOURCE = /^packages\/([^/]+)\/(?:test\/.+\.[cm]?[jt]s|src\/.+\.test\.[cm]?[jt]s)$/;
const NOT_TEST_CODE = /\/(?:fixtures|golden)\//;

/** The package directory names `text` reaches into, in first-seen order. */
function reachedDirs(text: string, patterns: readonly RegExp[], dirs: ReadonlySet<string>): string[] {
  const found = new Set<string>();
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const dir = match[1];
      if (dir !== undefined && dirs.has(dir)) found.add(dir);
    }
  }
  return [...found];
}

/** The vitest tier — and so the turbo task — that runs `rel`. */
function testTierOf(rel: string): typeof UNIT | typeof INTEGRATION | typeof SYSTEM {
  const base = rel.slice(rel.lastIndexOf('/') + 1);
  if (/\.system\.test\.[cm]?[jt]s$/.test(base)) return SYSTEM;
  if (/\.integration\.test\.[cm]?[jt]s$/.test(base)) return INTEGRATION;
  if (/\.test\.[cm]?[jt]s$/.test(base)) return UNIT;
  if (rel.includes('/test/system/')) return SYSTEM;
  if (rel.includes('/test/integration/')) return INTEGRATION;
  return UNIT;
}

/**
 * Every reach written in a package script. A script turbo runs as its own task
 * (`build:skills`) is that task; any other runs inside `build`.
 */
export function findScriptReaches(graph: WorkspaceGraph, taskGraph: TurboTaskGraph): BuiltOutputReach[] {
  const dirs = new Set(graph.packages.map((pkg) => pkg.dir));
  const nameOf = new Map(graph.packages.map((pkg) => [pkg.dir, pkg.name] as const));
  return graph.packages.flatMap((pkg) =>
    Object.entries((pkg.manifest['scripts'] ?? {}) as Record<string, string>).flatMap(([script, text]) => {
      const task = taskGraph.has(`${pkg.name}#${script}`) ? `${pkg.name}#${script}` : `${pkg.name}#build`;
      return reachedDirs(text, [SCRIPT_REACH], dirs).map((dir) => ({
        site: `packages/${pkg.dir}/package.json (script "${script}")`,
        task,
        build: `${nameOf.get(dir) ?? dir}#build`,
      }));
    }),
  );
}

/**
 * The files under `packages/` in the working tree: tracked plus
 * untracked-not-ignored, so a test added in this change is seen before it is
 * committed.
 */
export function workingTreePackageFiles(repoRoot: string): string[] {
  return nonDeletedGitListing(repoRoot, ['packages'], ['--cached', '--others', '--exclude-standard']);
}

/** Every reach written in a test file among `files` (repo-relative, forward slashes). */
export function findTestReaches(repoRoot: string, graph: WorkspaceGraph, files: readonly string[]): BuiltOutputReach[] {
  const dirs = new Set(graph.packages.map((pkg) => pkg.dir));
  const nameOf = new Map(graph.packages.map((pkg) => [pkg.dir, pkg.name] as const));
  const reaches: BuiltOutputReach[] = [];
  for (const rel of files) {
    const owner = TEST_SOURCE.exec(rel)?.[1];
    const ownerName = owner === undefined ? undefined : nameOf.get(owner);
    if (ownerName === undefined || NOT_TEST_CODE.test(rel)) continue;
    const text = readFileSync(safePath.join(repoRoot, rel), 'utf8');
    for (const dir of reachedDirs(text, [SOURCE_REACH, SEGMENT_REACH], dirs)) {
      reaches.push({ site: rel, task: `${ownerName}#${testTierOf(rel)}`, build: `${nameOf.get(dir) ?? dir}#build` });
    }
  }
  return reaches;
}

/** Whether turbo runs `target` before `from`: `target` is in `from`'s dependency closure. */
function orders(taskGraph: TurboTaskGraph, from: string, target: string): boolean {
  const seen = new Set<string>();
  const pending = [...(taskGraph.get(from) ?? [])];
  for (let task = pending.pop(); task !== undefined; task = pending.pop()) {
    if (task === target) return true;
    if (seen.has(task)) continue;
    seen.add(task);
    pending.push(...(taskGraph.get(task) ?? []));
  }
  return false;
}

/**
 * Why each reach is unordered, one message per reach turbo does not order.
 * A task or build turbo does not know is a finding, never a pass: a reach from
 * a task nothing runs, or into a package with no build, guards nothing.
 */
export function unorderedReaches(reaches: readonly BuiltOutputReach[], taskGraph: TurboTaskGraph): Array<{ site: string; message: string }> {
  const problems: Array<{ site: string; message: string }> = [];
  for (const { site, task, build } of reaches) {
    if (!taskGraph.has(task)) {
      problems.push({ site, message: `reaches ${build}'s output, but turbo has no ${task} task to run it.` });
    } else if (!taskGraph.has(build)) {
      problems.push({ site, message: `${task} reaches the built output of a package turbo has no ${build} task for.` });
    } else if (!orders(taskGraph, task, build)) {
      problems.push({
        site,
        message:
          `${task} executes ${build.replace('#build', '')}'s built dist/, but turbo does not order ${build} before it, ` +
          'so a cold run reads a missing dist/ and a warm one a stale one. Add a `workspace:*` devDependency when that ' +
          `makes no cycle (then \`^build\` covers it); otherwise add "${build}" to a "${task}" entry's dependsOn in turbo.json.`,
      });
    }
  }
  return problems;
}

/** turbo's dry-run JSON, as far as this module reads it. */
interface TurboDryRun {
  readonly tasks: ReadonlyArray<{ readonly taskId: string; readonly dependencies: readonly string[] }>;
}

function isTurboDryRun(value: unknown): value is TurboDryRun {
  const tasks = (value as { tasks?: unknown } | null)?.tasks;
  return (
    Array.isArray(tasks) &&
    tasks.every((task: { taskId?: unknown; dependencies?: unknown }) =>
      typeof task.taskId === 'string' && Array.isArray(task.dependencies) && task.dependencies.every((dep) => typeof dep === 'string'),
    )
  );
}

/**
 * turbo's task graph for {@link SCANNED_TASKS} across every package, from turbo
 * itself. Throws when turbo does not answer with the graph — a rule with no
 * graph has checked nothing.
 */
export function readTurboTaskGraph(repoRoot: string): TurboTaskGraph {
  // The repo's own turbo, through its node launcher: `turbo` on PATH exists only
  // under `bun run`, and may be another version.
  const launcher = safePath.join(repoRoot, 'node_modules', 'turbo', 'bin', 'turbo');
  const stdout = safeExecSync(process.execPath, [launcher, 'run', ...SCANNED_TASKS, '--dry=json'], {
    cwd: repoRoot,
    encoding: 'utf8',
    // The graph is ~2 MB; spawnSync's 1 MiB default truncates rather than failing.
    maxBuffer: 64 * 1024 * 1024,
  });
  const parsed: unknown = JSON.parse(String(stdout));
  if (!isTurboDryRun(parsed) || parsed.tasks.length === 0) {
    throw new Error('`turbo run --dry=json` returned no task graph');
  }
  return new Map(parsed.tasks.map((task) => [task.taskId, task.dependencies] as const));
}
