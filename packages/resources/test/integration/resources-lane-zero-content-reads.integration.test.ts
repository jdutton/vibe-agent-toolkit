/**
 * **The resources lane reads no file's CONTENT. Pinned, not asserted in prose.**
 *
 * `buildResourcePopulation` consumes four realization columns — `isDirectory`,
 * `exists`, `gitignored`, `path` — every one of which `lstat` and the ignore
 * oracle already answer. It skips the blob stage outright and discards the
 * `Projection`. So a byte it reads is a byte read for nobody, and the ruling is
 * flat: **every file-content read this lane performs under the crawl root is a
 * bug.** Measured before the fix, on an 8,548-file monorepo, that was ~1,684 ms
 * of a 13,714 ms cold run spent SHA-256-ing 152.9 MB nothing consumed.
 *
 * `contentDemand: 'deferred'` (see `resource-population.ts`) is the fix. This
 * file is the gate that stops it coming back, and it deliberately does not watch
 * the fix: it watches the *property*, so a stray `readFile` added anywhere in the
 * lane's call graph fails here even though the demand policy is untouched.
 *
 * ## The seam, and the three ways of building it that do not work
 *
 * The instrument is an **`--import` preload that patches `node:fs` and
 * `node:fs/promises` through `createRequire`**, injected into a child process
 * that runs nothing but the lane. Measured on node v24.13.1:
 *
 * - 🪤 **Builtin ESM namespace objects are frozen.** `import * as fs from
 *   'node:fs'` then `fs.readFile = …` throws `TypeError: Cannot assign to read
 *   only property`. The obvious ESM-authored preload does not merely miss calls,
 *   it fails to load. `createRequire` hands back the mutable CJS object, and ESM
 *   *named* imports are live bindings against exactly that object — so patching
 *   it catches `import { readFile } from 'node:fs'` too.
 * - `require('node:fs').promises === require('node:fs/promises')` is `true`, so
 *   one patch covers both halves and patching "both" would double every count.
 * - ⛔ `node --permission` is genuinely unbypassable and is still **unusable
 *   here**: it denies `readdir` and `readFile` with the same `ERR_ACCESS_DENIED`,
 *   and this rule has to permit the first while forbidding the second.
 * - ⛔ A vitest spy, or a wrapper around `readContentWithKey`, is bypassable by a
 *   reference captured before the spy installed and by any direct `readFile`. It
 *   could be a redundant second signal; it could not be the primary seam.
 *
 * ## Why the assertion is path-scoped rather than a global zero
 *
 * Merely loading the module graph emits content-read events from Node's own
 * loader. A literal "this process read nothing" would trip on Node itself. So
 * every event is resolved against the crawl root and only the ones **under it**
 * are counted — which is also the honest statement of the rule, since the rule is
 * about the corpus.
 *
 * ## Why `readdir` is a separate sink, asserted rather than ignored
 *
 * Enumeration is the lane's job. A gate that tripped on `readdir` would be
 * unusable, and a gate that quietly folded `readdir` into "content" would go
 * green the day the crawl stopped crawling. So directory routes go to their own
 * sink, {@link SINK_LEAKAGE_ARM} proves nothing leaks from it into the content
 * sink, and the lane arm asserts the directory sink is **non-empty** — the
 * measurement's own non-vacuity check.
 *
 * ## What this instrument CANNOT see — read this before trusting a green
 *
 * Every one of these is a real hole, and none of them is closed by this file:
 *
 * | route | why it escapes |
 * |---|---|
 * | a subprocess (`cat`, `git cat-file`) | reads happen in another process image; the preload is not in it |
 * | CJS `require()` of a JSON or data file | **measured on v24.13.1: recorded nothing.** The module loader does not reach the public `fs` object |
 * | dynamic `import()` of JSON (`with { type: 'json' }`) | **measured on v24.13.1: recorded nothing** — contrary to the note this gate was specified from, which listed it as catchable. Same cause as the row above |
 * | `process.binding('fs')` and other internal bindings | below the public surface being patched |
 * | a reference captured BEFORE the preload installs | `--import` runs first, so this needs another preload ordered ahead of it |
 * | `Bun.file()` | a different runtime's API entirely; the driver is spawned with node for this reason |
 * | a worker created with explicit `execArgv: []` | opts that worker out of the inherited `--import` |
 *
 * Worker threads created *normally* ARE covered — verified — and that verification
 * cost one real trap: the dump filename must carry `threadId` as well as `pid`,
 * because a worker shares its parent's pid and the second dump silently
 * overwrote the first.
 */

/* eslint-disable security/detect-non-literal-fs-filename -- every path here is a temp fixture this file created */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  compareCodeUnits,
  mkdirSyncReal,
  normalizedTmpdir,
  safePath,
  toForwardSlash,
} from '@vibe-agent-toolkit/utils';
import {
  runGitOrThrow,
} from '@vibe-agent-toolkit/utils/git';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EXTENT_SOURCE_ENV, EXTENT_SOURCE_FILESYSTEM, EXTENT_SOURCE_GIT } from '../../src/projection/crawl-source.js';

/** Markdown files the corpus holds, all tracked and none ignored. */
const TRACKED_DOC_COUNT = 8;

/** The one gitignored file, so `deferGitignored` and `deferred` stay distinguishable. */
const IGNORED_FILE = 'dist/bundle.js';

/** The env var naming the crawl root the preload scopes its attribution to. */
const GATE_ROOT_ENV = 'VAT_FS_GATE_ROOT';

/** The env var naming the dump-file prefix the preload writes on exit. */
const GATE_OUT_ENV = 'VAT_FS_GATE_OUT';

/** Identity for the fixture commit, so no developer's git identity is needed. */
const COMMIT_CONFIG = [
  '-c',
  'user.name=VAT Fixture',
  '-c',
  'user.email=fixture@example.invalid',
  '-c',
  'commit.gpgsign=false',
];

/**
 * The one path git plumbing legitimately copies, and the only content event the
 * git-sourced arm is allowed to produce.
 *
 * Pinned by identity rather than waived by a predicate: `.git/` is
 * `NEVER_CRAWL_GLOBS` territory and belongs to no extent, so `git write-tree`
 * against a throwaway index is not a corpus read — but an allowance shaped like
 * "ignore anything under `.git`" would hide the next one too.
 */
const GIT_PLUMBING_READ = 'copyFileSync .git/index';

/** What the spawned driver should do. */
type DriverMode = 'lane' | 'lane-with-stray-read' | 'readdir-only';

/** The arm proving directory routes never reach the content sink. */
const SINK_LEAKAGE_ARM: DriverMode = 'readdir-only';

/** The stray file the positive-control arm reads — a real corpus member. */
const STRAY_TARGET = 'docs/d1.md';

/** One `(method, path)` the preload attributed under the crawl root. */
interface GateRow {
  readonly method: string;
  readonly path: string;
  readonly count: number;
}

/** One arm's merged dump. */
interface GateDump {
  /** `"<method> <path>"` for every content-read event under the root. */
  readonly content: readonly string[];
  /** The same, for directory-listing events. */
  readonly directory: readonly string[];
  /** What the driver reported, so a degenerate crawl cannot pass quietly. */
  readonly paths: number | null;
}

let corpusRoot = '';
let workDir = '';
let laneArm: GateDump;
let gitArm: GateDump;
let strayArm: GateDump;
let leakageArm: GateDump;

/** This file's directory, the anchor for the built entry points below. */
const here = safePath.resolve(fileURLToPath(import.meta.url), '..');

/** Built entry point of the package under test. */
const RESOURCES_DIST = safePath.resolve(here, '../../dist/index.js');

/**
 * Built `@vibe-agent-toolkit/utils/git` entry, which supplies `GitTracker`.
 *
 * 🪤 This path is a STRING, so nothing typechecks it and no import-rewriting
 * sweep can see it. The driver below is generated source, and a wrong entry here
 * surfaces only as the child exiting 1 with `does not provide an export named`.
 * Point it at the entry that actually exports the symbol, not at the barrel.
 */
const UTILS_GIT_DIST = safePath.resolve(here, '../../../utils/dist/git.js');

/**
 * A node executable to spawn the driver with.
 *
 * `process.execPath` is bun under some of this repo's runners, and bun does not
 * honour node's `--import` preload. Falling back to `node` on PATH keeps the
 * instrument working wherever vitest happens to be hosted.
 *
 * @returns Path or bare name of a node binary
 */
function nodeExecutable(): string {
  return basename(process.execPath).startsWith('node') ? process.execPath : 'node';
}

/**
 * The preload, as JavaScript.
 *
 * Generated rather than committed for the reason the neighbouring I/O-cost test
 * generates its driver: a committed `.mjs` under `test/` is outside the
 * TypeScript program and outside ESLint's, so it would be the one file in this
 * package nothing checks. Held here it is at least reviewed as part of the gate
 * it belongs to.
 *
 * @returns Source of the `--import` preload
 */
function preloadSource(): string {
  return [
    "import { createRequire } from 'node:module';",
    'const require = createRequire(import.meta.url);',
    // The mutable CJS objects. An ESM namespace import would be frozen — see the
    // file docstring — and assigning to it throws rather than silently missing.
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const { threadId } = require('node:worker_threads');",
    `const ROOT = path.resolve(process.env[${JSON.stringify(GATE_ROOT_ENV)}] ?? '');`,
    `const OUT = process.env[${JSON.stringify(GATE_OUT_ENV)}] ?? '';`,
    "const TAG = Symbol.for('vat.resources.gate.wrapped');",
    'const content = new Map();',
    'const dir = new Map();',
    // An fd remembers the path it was opened on, so a read taken through a bare
    // descriptor still names a file rather than landing as an unattributable
    // number.
    'const fdPaths = new Map();',
    'let realRoot = ROOT;',
    'try { realRoot = fs.realpathSync.native(ROOT); } catch { realRoot = ROOT; }',
    // Both spellings, because a macOS temp root is reached as /var and resolves
    // to /private/var, and a scope that knew only one of them would report a
    // confident zero.
    'function underRoot(p) {',
    "  if (typeof p !== 'string') return null;",
    '  let abs;',
    '  try { abs = path.resolve(p); } catch { return null; }',
    '  for (const base of [ROOT, realRoot]) {',
    "    if (abs === base) return '.';",
    // Forward slashes always: every assertion in this file names a path as
    // `docs/d1.md`, and on Windows `path.relative` answers `docs\d1.md`, so a
    // native separator here turns each of them into a failure about nothing.
    // Hand-rolled rather than `toForwardSlash()` because this source is a string
    // evaluated in a child process that has no access to the workspace.
    "    if (abs.startsWith(base + path.sep)) return path.relative(base, abs).split(path.sep).join('/');",
    '  }',
    '  return null;',
    '}',
    'function record(sink, method, rel) {',
    String.raw`  const key = method + '\t' + rel;`,
    '  sink.set(key, (sink.get(key) ?? 0) + 1);',
    '}',
    'function wrap(owner, name, sink, onResult) {',
    '  const original = owner == null ? undefined : owner[name];',
    "  if (typeof original !== 'function' || original[TAG] === true) return;",
    '  const wrapped = function (...args) {',
    '    const rel = underRoot(args[0]);',
    '    if (rel !== null) record(sink, name, rel);',
    '    const result = original.apply(this, args);',
    '    return onResult === undefined ? result : onResult(result, rel);',
    '  };',
    '  wrapped[TAG] = true;',
    '  owner[name] = wrapped;',
    '}',
    "for (const name of ['readFile', 'readFileSync', 'createReadStream', 'copyFile', 'copyFileSync']) wrap(fs, name, content);",
    // `fs.promises` IS `node:fs/promises`, so this is the whole promise half.
    "for (const name of ['readFile', 'copyFile']) wrap(fs.promises, name, content);",
    "wrap(fs, 'openSync', content, (result, rel) => {",
    "  if (rel !== null && typeof result === 'number') fdPaths.set(result, rel);",
    '  return result;',
    '});',
    'const realClose = fs.closeSync;',
    'fs.closeSync = function (fd) { fdPaths.delete(fd); return realClose.apply(this, [fd]); };',
    "wrap(fs.promises, 'open', content, (result, rel) => {",
    '  if (rel === null) return result;',
    '  return result.then((handle) => {',
    "    for (const method of ['readFile', 'read', 'readv', 'createReadStream']) {",
    '      const original = handle[method];',
    "      if (typeof original !== 'function') continue;",
    "      handle[method] = function (...inner) { record(content, 'handle.' + method, rel); return original.apply(this, inner); };",
    '    }',
    '    return handle;',
    '  });',
    '});',
    "for (const name of ['readSync', 'readvSync', 'read', 'readv']) {",
    '  const original = fs[name];',
    "  if (typeof original !== 'function' || original[TAG] === true) continue;",
    '  const wrapped = function (...args) {',
    '    const rel = fdPaths.get(args[0]);',
    '    if (rel !== undefined) record(content, name, rel);',
    '    return original.apply(this, args);',
    '  };',
    '  wrapped[TAG] = true;',
    '  fs[name] = wrapped;',
    '}',
    // The separate sink. Enumeration is the lane's JOB; a gate that counted it
    // as a content read would be unusable.
    "for (const name of ['readdir', 'readdirSync', 'opendir', 'opendirSync']) wrap(fs, name, dir);",
    "for (const name of ['readdir', 'opendir']) wrap(fs.promises, name, dir);",
    'function rows(sink) {',
    '  const out = [];',
    '  for (const [key, count] of sink) {',
    String.raw`    const tab = key.indexOf('\t');`,
    '    out.push({ method: key.slice(0, tab), path: key.slice(tab + 1), count });',
    '  }',
    '  return out;',
    '}',
    // 🪤 `threadId` as well as `pid`: a worker thread shares its parent's pid, so
    // a pid-only filename silently overwrote one arm's dump with the other's.
    "process.on('exit', () => {",
    "  if (OUT === '') return;",
    '  const dump = { content: rows(content), directory: rows(dir) };',
    "  fs.writeFileSync(OUT + '.' + String(process.pid) + '-' + String(threadId) + '.json', JSON.stringify(dump), 'utf-8');",
    '});',
  ].join('\n');
}

/**
 * The driver, as JavaScript.
 *
 * Imports the BUILT entry points by absolute URL: the child has no vitest
 * transform pipeline, so a `.ts` driver would not load.
 *
 * @param mode - What the driver should do after importing
 * @returns Source of the driver module
 */
function driverSource(mode: DriverMode): string {
  const resources = pathToFileURL(RESOURCES_DIST).href;
  const utils = pathToFileURL(UTILS_GIT_DIST).href;
  return [
    `import { buildResourcePopulation } from ${JSON.stringify(resources)};`,
    `import { GitTracker } from ${JSON.stringify(utils)};`,
    "import { readFileSync, readdirSync } from 'node:fs';",
    `const root = ${JSON.stringify(toForwardSlash(corpusRoot))};`,
    `const mode = ${JSON.stringify(mode)};`,
    'let paths = null;',
    `if (mode === ${JSON.stringify(SINK_LEAKAGE_ARM)}) {`,
    // Nothing but enumeration, so "the content sink is empty" here is a
    // statement about the SEAM rather than about the lane.
    '  readdirSync(root);',
    "  readdirSync(root + '/docs');",
    '} else {',
    '  const tracker = new GitTracker(root);',
    '  await tracker.initialize({ includeUntracked: true });',
    '  paths = (await buildResourcePopulation({ root, gitTracker: tracker })).paths.length;',
    `  if (mode === 'lane-with-stray-read') readFileSync(root + '/' + ${JSON.stringify(STRAY_TARGET)}, 'utf-8');`,
    '}',
    'process.stdout.write(`PATHS=${paths === null ? -1 : paths}\\n`);',
  ].join('\n');
}

/** How many arms have run — the discriminator on each one's dump directory. */
let armIndex = 0;

/**
 * Run one arm under the preload and merge every dump it left.
 *
 * Every dump, never the first: the preload propagates into worker threads and
 * descendant node processes, and reading one of several reports a fraction while
 * looking healthy.
 *
 * @param mode - What the driver should do
 * @param environment - Extra environment for the child, e.g. the crawl selector
 * @returns The merged dump
 */
function measure(mode: DriverMode, environment: Record<string, string> = {}): GateDump {
  armIndex++;
  const dumpDir = safePath.resolve(workDir, `dumps-${String(armIndex)}-${mode}`);
  const preload = safePath.resolve(workDir, `preload-${String(armIndex)}.mjs`);
  const driver = safePath.resolve(workDir, `driver-${String(armIndex)}-${mode}.mjs`);
  mkdirSyncReal(dumpDir, { recursive: true });
  // Written OUTSIDE the corpus on purpose: a driver or dump inside the crawl
  // root would be read by the harness itself and land in the sink as a finding
  // against the lane.
  writeFileSync(preload, preloadSource(), 'utf-8');
  writeFileSync(driver, driverSource(mode), 'utf-8');

  const result = spawnSync(nodeExecutable(), ['--import', pathToFileURL(preload).href, driver], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      ...environment,
      [GATE_ROOT_ENV]: corpusRoot,
      [GATE_OUT_ENV]: safePath.resolve(dumpDir, 'io'),
    },
  });
  if (result.status !== 0) {
    throw new Error(`driver (${mode}) exited ${String(result.status)}:\n${result.stderr ?? ''}`);
  }

  const reported = /PATHS=(-?\d+)/.exec(result.stdout ?? '')?.[1];
  const parsed = reported === undefined ? null : Number(reported);
  return readDumps(dumpDir, parsed === null || parsed < 0 ? null : parsed);
}

/**
 * Merge every dump in a directory into one arm's result.
 *
 * @param directory - Where the preload was told to write
 * @param paths - What the driver reported enumerating
 * @returns The merged dump, each event rendered `"<method> <path>"`
 * @throws When no dump was written, or one is not the shape this file writes —
 *   either would otherwise surface as a beautiful, meaningless zero
 */
function readDumps(directory: string, paths: number | null): GateDump {
  const content: string[] = [];
  const directoryEvents: string[] = [];
  let dumps = 0;

  for (const name of readdirSync(directory)) {
    if (!name.startsWith('io.') || !name.endsWith('.json')) continue;
    dumps++;
    const raw: unknown = JSON.parse(readFileSync(safePath.resolve(directory, name), 'utf-8'));
    const dump = raw as { content: GateRow[]; directory: GateRow[] };
    // Refuse a dump this file cannot read, on its SHAPE rather than on a version
    // integer. The preload above is generated by this same file, so the only way
    // the two disagree is an edit to one half — which moves the shape, and which
    // a number nobody is obliged to bump would not have caught.
    if (!Array.isArray(dump.content) || !Array.isArray(dump.directory)) {
      throw new Error(
        `gate dump '${name}' is not the shape this test writes. Refusing to read it: the numbers ` +
          'would be meaningless rather than merely wrong.',
      );
    }
    for (const row of dump.content) content.push(`${row.method} ${row.path}`);
    for (const row of dump.directory) directoryEvents.push(`${row.method} ${row.path}`);
  }

  if (dumps === 0) {
    throw new Error(
      `the fs gate wrote no dump to ${directory}. It was not active, so "no content reads" would be a lie.`,
    );
  }
  // Code units, never `localeCompare`: these are machine identifiers rendered
  // for equality, and a locale-dependent order makes the assertions below pass
  // or fail by environment.
  return {
    content: [...content].sort(compareCodeUnits),
    directory: [...directoryEvents].sort(compareCodeUnits),
    paths,
  };
}

/** Write one fixture file, creating its parent directory. */
function writeFixtureFile(relativePath: string, contents: string): void {
  const absolute = safePath.resolve(corpusRoot, relativePath);
  mkdirSyncReal(safePath.resolve(absolute, '..'), { recursive: true });
  writeFileSync(absolute, contents, 'utf-8');
}

beforeAll(() => {
  if (!existsSync(RESOURCES_DIST)) {
    throw new Error(`built resources entry not found at ${RESOURCES_DIST} — run \`bun run build\` first.`);
  }

  workDir = toForwardSlash(mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-fs-gate-work-')));
  corpusRoot = toForwardSlash(mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-fs-gate-corpus-')));

  runGitOrThrow(['init', '-b', 'main'], { cwd: corpusRoot });
  for (let index = 1; index <= TRACKED_DOC_COUNT; index++) {
    writeFixtureFile(`docs/d${String(index)}.md`, `# doc ${String(index)}\n\n[l](./d1.md)\n`);
  }
  writeFixtureFile('.gitignore', 'dist/\n');
  // Gitignored, and load-bearing: under the incumbent `deferGitignored` policy
  // this file was the ONLY one already deferred, so a fixture without it could
  // not tell the two policies apart.
  writeFixtureFile(IGNORED_FILE, 'export const x = 1;\n');
  runGitOrThrow(['add', '-A'], { cwd: corpusRoot });
  runGitOrThrow([...COMMIT_CONFIG, 'commit', '-m', 'fixture'], { cwd: corpusRoot });

  // ⚠️ The filesystem extent is NAMED rather than left to the default. It used
  // to be the default, so an unset environment selected it — then git became the
  // default and this arm silently turned into a second copy of `gitArm`, taking
  // the git plumbing read with it. Two arms that measure the same thing cannot
  // show the difference this file exists to show, and the failure looked like
  // the filesystem extent had started reading `.git/index`.
  laneArm = measure('lane', { [EXTENT_SOURCE_ENV]: EXTENT_SOURCE_FILESYSTEM });
  gitArm = measure('lane', { [EXTENT_SOURCE_ENV]: EXTENT_SOURCE_GIT });
  strayArm = measure('lane-with-stray-read');
  leakageArm = measure(SINK_LEAKAGE_ARM);
}, 300_000);

afterAll(() => {
  if (corpusRoot) rmSync(corpusRoot, { recursive: true, force: true });
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describe('the instrument sees what it claims to see', () => {
  it('catches a single stray read the lane did not make', () => {
    // The whole gate rests on this. Without it, "zero content reads" is equally
    // consistent with a preload that never installed — and the seam it replaced
    // (an ESM namespace patch) fails exactly that way.
    expect(strayArm.content).toContain(`readFileSync ${STRAY_TARGET}`);
  });

  it('crawled a corpus of the size this file claims', () => {
    // `.gitignore` plus the docs; `dist/bundle.js` is declined by the consumer.
    expect(laneArm.paths).toBe(TRACKED_DOC_COUNT + 1);
    expect(gitArm.paths).toBe(TRACKED_DOC_COUNT + 1);
  });

  it('never files a directory listing as a content read', () => {
    // The arm that ONLY lists directories. If `readdir` leaked into the content
    // sink, the lane assertion below would be unsatisfiable and someone would
    // "fix" it by widening the rule.
    expect(leakageArm.directory.length).toBeGreaterThan(0);
    expect(leakageArm.content).toEqual([]);
  });
});

describe('buildResourcePopulation reads no file content under the crawl root', () => {
  it('reads nothing, while still enumerating', () => {
    // Equality, not a threshold: the lane has no budget of content reads to
    // spend. The directory assertion is what stops a crawl that stopped
    // crawling from passing this trivially.
    expect(laneArm.content, laneArm.content.join(' | ')).toEqual([]);
    expect(laneArm.directory.length).toBeGreaterThan(0);
  });

  it('reads nothing but git\'s own index when the git enumerator is selected', () => {
    // `GitCrawlSource` reaches the population through `git write-tree` against a
    // throwaway index, which copies `.git/index`. That is git plumbing, not a
    // corpus file — `.git/` is NEVER_CRAWL_GLOBS territory and belongs to no
    // extent — so it is pinned by identity here rather than waived by an
    // "anything under .git" predicate that would hide the next one too.
    expect(gitArm.content, gitArm.content.join(' | ')).toEqual([GIT_PLUMBING_READ]);
  });

  it('does not read the gitignored file either, which the old policy already skipped', () => {
    // Named separately so a regression to `deferGitignored` cannot half-pass:
    // that policy would still leave this row absent while every tracked file
    // reappeared above.
    expect(laneArm.content.some((event) => event.endsWith(IGNORED_FILE))).toBe(false);
  });
});
