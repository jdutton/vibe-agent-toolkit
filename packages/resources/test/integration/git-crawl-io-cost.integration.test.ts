/**
 * **What a git-sourced crawl costs in filesystem calls, pinned.**
 *
 * `crawl-source.ts` sells {@link GitCrawlSource} as a *cost model*: the two
 * implementations must return the same set, and the git one is worth having only
 * because it answers the same question for less. Parity is already pinned next
 * door (`crawl-source-parity.integration.test.ts`). Nothing pinned the cost — so
 * a change that kept the population identical while reintroducing a per-file
 * `stat` would pass every existing test and delete the entire reason the git
 * source exists. This file is that missing half.
 *
 * ## The property
 *
 * For a repository of N files, {@link GitCrawlSource.enumerate} must cost a
 * **constant** number of filesystem operations — a handful of git spawns and a
 * bounded walk of ignored territory — never a number that grows with N. Every
 * column the enumeration owes its caller is answerable from git without touching
 * the filesystem:
 *
 * | column | how git already knows |
 * |---|---|
 * | `exists` | true by construction — `git add -A` stages deletions, so the tree holds only files that exist |
 * | `isDirectory` | false by construction — git never lists directories |
 * | `isSymlink` | mode `120000` on the index entry |
 * | `gitignored` | false by construction — `--exclude-standard` already removed them |
 * | `pathLower`, `basenameLower`, `dir`, `depth`, `ext` | string math over `path` |
 * | `mtime`, `contentKey`, `symlinkResolves` | **nullable** in `projection-resources.ts`, and read by almost nothing |
 *
 * ## How it is measured, and why through a child process
 *
 * The instrument is the lab's existing I/O counter
 * (`packages/lab/src/facets/io/counter.cts`), injected with
 * `NODE_OPTIONS=--require`. It has to load *before* anything else: an ESM named
 * import of `node:fs/promises` snapshots its bindings at instantiation, so a
 * counter that patched `fs` after the code under test was imported would report
 * a confident zero. That is also why this is an integration test and not a unit
 * test with a spy — the measurement cannot be taken in the vitest worker that
 * imported the module.
 *
 * ## Why every number here is a DELTA against an import-only arm
 *
 * Loading `@vibe-agent-toolkit/resources` is itself ~1,350 user-class filesystem
 * calls (≈500 `readFileSync` and ≈846 `realpathSync`, all of it CommonJS module
 * resolution inside `node_modules`). At the fixture sizes below that noise is
 * larger than the entire signal, and it happens to sit near the file count — the
 * exact shape of a threshold that looks calibrated and measures nothing. So a
 * second arm imports the same module graph and crawls nothing, and every figure
 * asserted here is `crawl arm − import-only arm`. Module-load cost cancels; only
 * the crawl survives.
 *
 * ## Measured, on this fixture (macOS, node 24, git 2.x)
 *
 * `enumerate()` costs **19 operations — identically at 300, 500 and 1,200
 * files**: 8 `child_process.spawnSync` (git), and 11 `fs` calls (4 `existsSync`,
 * 3 `readdirSync`, 1 each of `copyFileSync`, `lstatSync`, `statSync`,
 * `unlinkSync`) belonging to git's temp-index handling and the bounded walk of
 * the one ignored directory. Not one of them is per-file. The equality of the
 * two sizes is what this file leans on; the absolute ceiling is a coarse
 * tripwire derived from the fixture rather than a fitted constant.
 *
 * The **extent** built on that enumeration is measured here too, and it is where
 * the per-path cost used to reappear. Once {@link EnumeratedPath.shape} carried
 * git's mode bits through to the realization, the same 1,200-file arm went from
 * **1,205 `lstatSync` to 4** — total 2,449 → 1,248 operations, i.e. −49% — while
 * the 300-file arm went 305 → 4. The residual 4 are git's temp-index handling
 * and the bounded walk of the one ignored directory, and they do not move with
 * the corpus, which is exactly the property the assertions state.
 */

/* eslint-disable security/detect-non-literal-fs-filename -- every path here is a temp fixture this file created */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  mkdirSyncReal,
  normalizedTmpdir,
  safePath,
  toForwardSlash,
} from '@vibe-agent-toolkit/utils';
import {
  runGitOrThrow,
} from '@vibe-agent-toolkit/utils/git';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Files the fixture starts with.
 *
 * Three hundred rather than a handful, and the user's own caveat is the reason:
 * with three files, git's fixed startup cost dominates and "fewer operations
 * than files" is either meaningless or accidentally false. At 300 the measured
 * constant (19) is a seventieth of the file count, so the gap is unmistakable.
 */
const BASE_FILE_COUNT = 300;

/** Files added before the second measurement — the scaling control. */
const GROWTH_FILE_COUNT = 900;

/** Files present for the second measurement. */
const GROWN_FILE_COUNT = BASE_FILE_COUNT + GROWTH_FILE_COUNT;

/**
 * Directories the files are spread across, held FIXED as the corpus grows.
 *
 * The growth arm adds files to the directories that already exist. If it added
 * directories too, a source whose cost scaled with the directory count would be
 * indistinguishable from one whose cost scaled with the file count, and the
 * comparison would no longer isolate what it claims to.
 */
const DIRECTORY_COUNT = 20;

/** The counter's name for the call this change exists to remove. */
const LSTAT = 'fs.lstatSync';

/** The one gitignored subtree, so the bounded ignored-territory walk really runs. */
const IGNORED_DIR = 'ignored';

/** Identity used for the fixture commits, so a developer's own git identity is never needed. */
const COMMIT_CONFIG = [
  '-c',
  'user.name=VAT Fixture',
  '-c',
  'user.email=fixture@example.invalid',
  '-c',
  'commit.gpgsign=false',
];

/** What the driver child process should do after importing. */
type DriverMode = 'import-only' | 'enumerate' | 'extent';

/** One measured run, already net of the import-only arm where the field says so. */
interface Measurement {
  /** Paths the driver reported, or `null` when it printed none. */
  readonly paths: number | null;
  /** `child_process.*` calls. */
  readonly spawns: number;
  /** `fs.*` calls. */
  readonly fsOps: number;
  /** `spawns + fsOps`. */
  readonly total: number;
  /** Per-method counts, for a legible failure. */
  readonly perMethod: ReadonlyMap<string, number>;
  /** Loader-class calls — nonzero proves the counter was actually active. */
  readonly loaderCalls: number;
}

let fixtureRoot = '';
let workDir = '';
let importOnly: Measurement;
let smallCrawl: Measurement;
let grownCrawl: Measurement;
let smallExtent: Measurement;
let grownExtent: Measurement;

/** This file's directory, the anchor for every in-repo path below. */
const here = safePath.resolve(fileURLToPath(import.meta.url), '..');

/** Built entry point of the package under measurement. */
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
 * The lab's I/O counter, as emitted.
 *
 * Reached by path rather than by import: it is CommonJS by necessity
 * (`--require` accepts nothing else) and `@vibe-agent-toolkit/lab` is a private
 * package this one does not depend on. `bun run build` builds the whole
 * workspace before integration tests, so it is present in the gate; a developer
 * running this file alone gets the explicit message below rather than a
 * mystifying spawn failure.
 */
const COUNTER = safePath.resolve(here, '../../../lab/dist/facets/io/counter.cjs');

/**
 * A node executable to spawn the driver with.
 *
 * `process.execPath` is bun under some of this repo's runners, and bun does not
 * honour `NODE_OPTIONS=--require` the way the counter needs. Falling back to
 * `node` on PATH keeps the instrument working wherever vitest happens to be
 * hosted.
 *
 * @returns Path or bare name of a node binary
 */
function nodeExecutable(): string {
  return basename(process.execPath).startsWith('node') ? process.execPath : 'node';
}

/**
 * Run git in the fixture, throwing on failure.
 *
 * @param args - Arguments after the `git` executable
 * @returns Trimmed stdout
 */
function git(args: readonly string[]): string {
  return runGitOrThrow([...args], { cwd: fixtureRoot });
}

/**
 * Add `count` files, distributed round-robin over the fixed directories.
 *
 * @param from - First file index, so a second call cannot overwrite the first's files
 * @param count - How many to create
 */
function addFiles(from: number, count: number): void {
  for (let index = from; index < from + count; index++) {
    const directory = `dir-${String(index % DIRECTORY_COUNT).padStart(2, '0')}`;
    const file = safePath.resolve(fixtureRoot, directory, `file-${String(index).padStart(5, '0')}.md`);
    mkdirSyncReal(safePath.resolve(file, '..'), { recursive: true });
    writeFileSync(file, `# fixture file ${String(index)}\n`, 'utf-8');
  }
}

/**
 * The ESM source of the driver the counter is injected into.
 *
 * Generated rather than committed because it must import the package's BUILT
 * entry point by absolute URL: a committed `.ts` driver would be resolved by
 * vitest's transform pipeline, and the child process has none.
 *
 * @param mode - What the driver should do after importing
 * @returns JavaScript source
 */
function driverSource(mode: DriverMode): string {
  const resources = pathToFileURL(RESOURCES_DIST).href;
  const utils = pathToFileURL(UTILS_GIT_DIST).href;
  return [
    `import { GitCrawlSource, FilesystemExtentContributor, ProjectionBuilder, RunContentCache } from ${JSON.stringify(resources)};`,
    `import { GitTracker } from ${JSON.stringify(utils)};`,
    `const root = ${JSON.stringify(toForwardSlash(fixtureRoot))};`,
    `const mode = ${JSON.stringify(mode)};`,
    'let paths = 0;',
    // The import-only arm still loads the whole graph above — ESM imports are
    // not elided for being unused — which is exactly what makes it a baseline.
    "if (mode === 'enumerate') {",
    '  paths = (await new GitCrawlSource(root).enumerate()).length;',
    "} else if (mode === 'extent') {",
    '  const tracker = new GitTracker(root);',
    '  await tracker.initialize({ includeUntracked: true });',
    '  const builder = new ProjectionBuilder({ root, gitTracker: tracker, contentCache: new RunContentCache() });',
    '  const contributor = new FilesystemExtentContributor((r) => new GitCrawlSource(r));',
    '  paths = (await contributor.contribute(builder.base(), null)).realizations.length;',
    '}',
    'process.stdout.write(`PATHS=${paths}\\n`);',
  ].join('\n');
}

/**
 * Sum every dump the counter left in a directory.
 *
 * Every file, never the first: the counter propagates into descendant processes,
 * and reading one dump of several reports a fraction while looking healthy. A
 * dump at an unknown version is refused rather than coerced — a format this file
 * cannot read would otherwise surface as a very low, very wrong number.
 *
 * @param directory - Where the counter was told to write
 * @param paths - What the driver reported enumerating
 * @returns The merged measurement
 */
function readDumps(directory: string, paths: number | null): Measurement {
  const perMethod = new Map<string, number>();
  let spawns = 0;
  let fsOps = 0;
  let loaderCalls = 0;
  let dumps = 0;

  for (const name of readdirSync(directory)) {
    if (!name.startsWith('io-') || !name.endsWith('.json')) continue;
    dumps++;
    const dump: unknown = JSON.parse(readFileSync(safePath.resolve(directory, name), 'utf-8'));
    const { rows } = dump as { rows: { cls: string; method: string; count: number }[] };
    // Refuse a dump this file cannot read, rather than counting zero rows and
    // publishing the result as "vat touched nothing". The check is on the SHAPE,
    // not on a version integer: the counter stamps none, because a number a
    // human has to remember to bump only ever refuses what the shape refuses
    // anyway, and stops refusing the moment somebody forgets.
    if (!Array.isArray(rows)) {
      throw new Error(
        `io counter dump '${name}' has no 'rows' array — this test cannot read it, and reading ` +
          'zero rows would report that vat touched nothing.',
      );
    }
    for (const row of rows) {
      if (row.cls === 'loader') {
        loaderCalls += row.count;
        continue;
      }
      perMethod.set(row.method, (perMethod.get(row.method) ?? 0) + row.count);
      if (row.method.startsWith('child_process.')) spawns += row.count;
      else fsOps += row.count;
    }
  }

  if (dumps === 0) {
    throw new Error(
      `the io counter wrote no dump to ${directory}. It was not active, so "no I/O" here would be a lie.`,
    );
  }
  return { paths, spawns, fsOps, total: spawns + fsOps, perMethod, loaderCalls };
}

/**
 * How many arms have been measured — the discriminator on each one's dump
 * directory.
 *
 * Not decorative. The counter's own notes name a reused dump directory as the
 * first of four ways to get a confident wrong number: nothing downstream can
 * tell a leftover dump from an earlier arm apart from a descendant of this one,
 * so a shared directory silently sums the arms. Caught here exactly that way —
 * the second `enumerate` arm reported 1,384 operations, precisely twice the
 * first arm plus its own.
 */
let armIndex = 0;

/**
 * Run one arm under the counter.
 *
 * @param mode - What the driver should do
 * @returns Its raw (not yet differenced) measurement
 */
function measure(mode: DriverMode): Measurement {
  armIndex++;
  const dumpDir = safePath.resolve(workDir, `dumps-${String(armIndex)}-${mode}`);
  const driver = safePath.resolve(workDir, `driver-${String(armIndex)}-${mode}.mjs`);
  mkdirSyncReal(dumpDir, { recursive: true });
  writeFileSync(driver, driverSource(mode), 'utf-8');

  const result = spawnSync(nodeExecutable(), [driver], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      // Quoted: node's NODE_OPTIONS parser splits on spaces, and a temp path
      // containing one would otherwise become two arguments.
      NODE_OPTIONS: `--require "${COUNTER}"`,
      VAT_LAB_IO_LOG: dumpDir,
    },
  });
  if (result.status !== 0) {
    throw new Error(`driver (${mode}) exited ${String(result.status)}:\n${result.stderr ?? ''}`);
  }
  const reported = /PATHS=(\d+)/.exec(result.stdout ?? '')?.[1];
  return readDumps(dumpDir, reported === undefined ? null : Number(reported));
}

/**
 * One arm net of the import-only arm.
 *
 * @param arm - The measured arm
 * @param baseline - The import-only arm
 * @returns The difference, per method and in total
 */
function netOfImports(arm: Measurement, baseline: Measurement): Measurement {
  const perMethod = new Map<string, number>();
  for (const [method, count] of arm.perMethod) {
    const delta = count - (baseline.perMethod.get(method) ?? 0);
    if (delta !== 0) perMethod.set(method, delta);
  }
  return {
    paths: arm.paths,
    spawns: arm.spawns - baseline.spawns,
    fsOps: arm.fsOps - baseline.fsOps,
    total: arm.total - baseline.total,
    perMethod,
    loaderCalls: arm.loaderCalls,
  };
}

/**
 * A measurement rendered for a failure message.
 *
 * @param measurement - What to render
 * @returns One line naming the total and its breakdown
 */
function describeMeasurement(measurement: Measurement): string {
  const breakdown = [...measurement.perMethod]
    .sort((a, b) => b[1] - a[1])
    .map(([method, count]) => `${method}=${String(count)}`)
    .join(' ');
  return `total=${String(measurement.total)} (spawns=${String(measurement.spawns)} fs=${String(measurement.fsOps)}) [${breakdown}]`;
}

beforeAll(() => {
  if (!existsSync(COUNTER)) {
    throw new Error(`io counter not found at ${COUNTER} — run \`bun run build\` first.`);
  }
  if (!existsSync(RESOURCES_DIST)) {
    throw new Error(`built resources entry not found at ${RESOURCES_DIST} — run \`bun run build\` first.`);
  }

  workDir = toForwardSlash(mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-crawl-io-work-')));
  fixtureRoot = toForwardSlash(mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-crawl-io-')));

  git(['init', '-b', 'main']);
  writeFileSync(safePath.resolve(fixtureRoot, '.gitignore'), `${IGNORED_DIR}/\n`, 'utf-8');
  // Ignored territory exists before the first measurement, so the bounded walk
  // the git source does over it is included in every number below rather than
  // being a cost this test never exercises.
  mkdirSyncReal(safePath.resolve(fixtureRoot, IGNORED_DIR, 'deep'), { recursive: true });
  writeFileSync(safePath.resolve(fixtureRoot, IGNORED_DIR, 'deep/buried.md'), '# buried\n', 'utf-8');

  addFiles(0, BASE_FILE_COUNT);
  git(['add', '-A']);
  git([...COMMIT_CONFIG, 'commit', '-m', 'fixture']);

  importOnly = measure('import-only');
  smallCrawl = netOfImports(measure('enumerate'), importOnly);
  // Measured at BOTH sizes, unlike the other extent arm, so the per-path
  // assertions below can say "constant" rather than "under a threshold". A
  // ceiling can be met by an implementation that stats a fixed fraction of the
  // corpus; equality across a 4× growth cannot.
  smallExtent = netOfImports(measure('extent'), importOnly);

  addFiles(BASE_FILE_COUNT, GROWTH_FILE_COUNT);
  git(['add', '-A']);
  git([...COMMIT_CONFIG, 'commit', '-m', 'grown']);

  grownCrawl = netOfImports(measure('enumerate'), importOnly);
  grownExtent = netOfImports(measure('extent'), importOnly);
}, 300_000);

afterAll(() => {
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describe('the measurement itself is not vacuous', () => {
  it('actually instrumented the child processes', () => {
    // A counter that failed to activate writes no dump (already refused in
    // `readDumps`) — but one that activated and attributed nothing would report
    // a beautiful zero. Loader calls are the proof it was watching.
    expect(importOnly.loaderCalls).toBeGreaterThan(0);
    expect(importOnly.total).toBeGreaterThan(0);
  });

  it('crawled a corpus of the size this file claims', () => {
    // `git ls-files` counts what git itself holds, independently of the loop
    // that wrote the files — so a fixture that silently stopped being large
    // fails here rather than passing the cost assertions trivially.
    const tracked = git(['ls-files']).split('\n').filter(Boolean).length;
    expect(tracked).toBe(GROWN_FILE_COUNT + 1); // + .gitignore

    expect(smallCrawl.paths).toBeGreaterThanOrEqual(BASE_FILE_COUNT);
    expect(grownCrawl.paths).toBeGreaterThanOrEqual(GROWN_FILE_COUNT);
    expect((grownCrawl.paths ?? 0) - (smallCrawl.paths ?? 0)).toBe(GROWTH_FILE_COUNT);
  });

  it('recorded a crawl that did something', () => {
    // Zero would mean the driver no-opped, which every "low I/O" assertion
    // below would happily accept.
    expect(smallCrawl.total).toBeGreaterThan(0);
  });
});

describe('GitCrawlSource.enumerate costs a constant, not a per-file toll', () => {
  it('spends far fewer operations than the corpus has files', () => {
    // The stated bar is `< fileCount`. The ceiling asserted is a quarter of it,
    // which the measurement supports with room to spare: 19 operations at 300,
    // 500 and 1,200 files. Expressed against the fixture rather than as a
    // literal, so growing the fixture cannot quietly relax it.
    expect(smallCrawl.total, describeMeasurement(smallCrawl)).toBeLessThan(BASE_FILE_COUNT / 4);
    expect(grownCrawl.total, describeMeasurement(grownCrawl)).toBeLessThan(BASE_FILE_COUNT / 4);
  });

  it('costs the same on 1,200 files as on 300', () => {
    // The load-bearing assertion, and the only one immune to platform constants:
    // whatever `enumerate()` spends, quadrupling the corpus must not change it.
    // A reintroduced per-file `stat` shows up here as +900 whatever the host.
    expect(grownCrawl.total, `${describeMeasurement(grownCrawl)} vs ${describeMeasurement(smallCrawl)}`)
      .toBe(smallCrawl.total);
  });

  it('never stats or reads a file per path', () => {
    // Named explicitly, because "the total did not move" would also hold for an
    // implementation that traded 900 stats for 900 reads.
    for (const method of [LSTAT, 'fs.statSync', 'fs.readFileSync', 'fs.promises.readFile']) {
      expect(grownCrawl.perMethod.get(method) ?? 0, `${method}: ${describeMeasurement(grownCrawl)}`)
        .toBeLessThan(BASE_FILE_COUNT / 4);
    }
  });
});

/**
 * **The gap, now half closed.** Enumeration is constant; the extent built on top
 * of it costs one *read* per path and no longer costs one *stat*.
 *
 * `FilesystemExtentContributor` calls `collectRealization` per enumerated path,
 * which used to `lstat` it (`projection/realizations.ts`) *and* read its bytes to
 * key them (`content-key.ts`) — measured at 1,225 `lstatSync` + 1,201
 * `fs.promises.readFile` for 1,224 paths, i.e. **~2 operations per path**, with
 * or without the git source. Two changes were named here as what would close it:
 *
 * 1. ✅ **Stop stat-ing — DONE.** `exists`, `isDirectory` and `isSymlink` are all
 *    derivable from the git entry (staged ⇒ exists; blob ⇒ not a directory; mode
 *    `120000` ⇒ symlink, and such an entry is not a member here at all), so
 *    {@link EnumeratedPath.shape} now carries them and the realization of a
 *    git-described path makes no `lstat`. `mtime` is nullable and simply stays
 *    null. The first two cases below are the guard, and they assert **equality
 *    across a 4× corpus growth** rather than a threshold: this is a cost-only
 *    change, so an output-level assertion could not have caught its revert.
 * 2. ❌ **Stop reading — NOT DONE.** `contentKey` is nullable too. Keying every
 *    file's bytes during enumeration is what remains of the ~2,400-operation
 *    extent; the extent could defer it to the consumers that actually need a key,
 *    exactly as `contentDemand: 'deferGitignored'` already defers it for the
 *    ignored half.
 *
 * So the total is still per-file, and `it.fails` still records that rather than a
 * green test recording a property the shipped code does not have. It is
 * deliberately NOT a red test: a permanently-failing gate teaches everyone to
 * ignore it. It flips to a genuine failure the moment someone closes (2), which
 * is when it should be promoted to `it`.
 */
describe('the extent built on the git source has not inherited its cost model', () => {
  it('enumerated the whole corpus at both sizes, so the assertions below are about cost', () => {
    expect(smallExtent.paths).toBeGreaterThanOrEqual(BASE_FILE_COUNT);
    expect(grownExtent.paths).toBeGreaterThanOrEqual(GROWN_FILE_COUNT);
    expect((grownExtent.paths ?? 0) - (smallExtent.paths ?? 0)).toBe(GROWTH_FILE_COUNT);
  });

  it('never stats a path git described, however many of them there are', () => {
    // The load-bearing assertion, and the only one immune to platform constants:
    // whatever the extent spends on `lstat`, quadrupling the corpus must not
    // change it. The residue is git's own temp-index handling plus the bounded
    // walk of the one ignored directory — paths `shape` is deliberately null for,
    // because they were walked rather than described.
    const stats = (measurement: Measurement): number =>
      measurement.perMethod.get(LSTAT) ?? 0;

    expect(
      stats(grownExtent),
      `${describeMeasurement(grownExtent)} vs ${describeMeasurement(smallExtent)}`,
    ).toBe(stats(smallExtent));
  });

  it('spends far fewer stats than the corpus has files', () => {
    // Named separately from the equality above because equality alone would also
    // hold for an implementation that stats a constant 5,000 times.
    expect(
      grownExtent.perMethod.get(LSTAT) ?? 0,
      describeMeasurement(grownExtent),
    ).toBeLessThan(BASE_FILE_COUNT / 4);
  });

  it('still reads one file per path — the half that is not closed', () => {
    // The negative control for the two cases above: they must not be passing
    // because the extent silently stopped doing per-path work altogether.
    const reads = (measurement: Measurement): number =>
      (measurement.perMethod.get('fs.promises.readFile') ?? 0)
      + (measurement.perMethod.get('fs.readFileSync') ?? 0);

    expect(reads(grownExtent) - reads(smallExtent), describeMeasurement(grownExtent))
      .toBeGreaterThanOrEqual(GROWTH_FILE_COUNT);
  });

  it.fails('spends fewer operations than the corpus has files — it does not, see above', () => {
    expect(grownExtent.total, describeMeasurement(grownExtent)).toBeLessThan(GROWN_FILE_COUNT);
  });
});
