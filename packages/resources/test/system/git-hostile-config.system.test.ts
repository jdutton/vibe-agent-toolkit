/**
 * **Hostile-but-legal git configuration**, over real repositories built here.
 *
 * `RunContentCache.#byHint` is keyed on `(git blob OID, parserKind)`. Git hashes
 * the **cleaned** content; `computeContentKey` hashes the **raw working-tree
 * bytes**. One OID can therefore name two different byte strings in one tree at
 * one instant, and a hint hit hands the second path the first path's content
 * *and* the first path's key.
 *
 * `projection/content-cache.ts` records that divergence as a table of
 * measurements in prose. This file is its executable form. Every fixture below
 * is **verified against `git cat-file blob` before anything downstream is
 * asserted** — a fixture that silently failed to diverge would make every
 * assertion after it vacuous, which is the single most likely way a suite like
 * this lies — and the projection is then run twice over the same tree: once
 * with `VAT_EXTENT_SOURCE=git` (the only enumerator that offers a hint) and once
 * without. A claim that holds in **both** arms is a claim about the reader; a
 * claim that holds in only one is a claim about the hint.
 *
 * ## What is pinned here as WRONG, not as correct
 *
 * **A per-path clean/smudge filter makes the hint serve the wrong characters.**
 * Two paths whose working-tree text genuinely differs (`# TOKEN` vs
 * `# REPLACED`) collapse to one blob under the git source, and the projection
 * then describes `dirB/same.md` with a heading it does not have. This is the gap
 * `content-cache.ts` predicts, reproduced end to end. The `eol` case is the same
 * mechanism in a milder form: a 22-byte CRLF file described by a 19-byte blob.
 *
 * ## What is pinned here as a capability, on a fixture that used to pin its absence
 *
 * **A `working-tree-encoding=UTF-16` checkout reads exactly like its UTF-8
 * twin.** `readContentWithKey` used to call `bytes.toString('utf-8')`
 * unconditionally, so the checkout decoded to NUL-interleaved mojibake and the
 * blob stage's NUL test refused the parse: no blob row, no section, no
 * reference. It now decodes through `decodeTextContent`, the pure `utils`
 * primitive at `@vibe-agent-toolkit/utils/text`,
 * which reads the encoding off the BOM. The contrast against the UTF-8 twin is
 * kept and inverted — it was the proof of the gap, and it is now the proof of
 * the fix, which is a stronger assertion than either side alone (a suite that
 * only checked the UTF-16 side could pass on a projection that had stopped
 * parsing anything).
 *
 * The content KEY still differs between the twins, and must: it is computed over
 * the raw working-tree bytes, and 40 bytes of BOM-prefixed UTF-16 are not 19
 * bytes of UTF-8. Decoding changes what VAT reads, never what a parse is filed
 * under. (Which byte order git re-materializes is the host's business and is not
 * asserted — see the BOM assertion in section 3.)
 *
 * ## What is pinned as surprising-but-correct
 *
 * - Line endings are **not** measurement-inert. Membership, discovered links,
 *   heading titles and every count survive CRLF, but the content key, the byte
 *   counts, the token estimates and the reference character offsets all move.
 * - A committed symlink is reported by the **git extent contributor** — every
 *   shape of it, resolving or not — and reaches no projection VAT actually
 *   builds: no population lane registers that contributor (`resource-population
 *   .ts` and `inventory-population.ts` register the filesystem extent only), and
 *   the filesystem extent drops symlinks under either enumerator. Broken and
 *   circular links resolve to `symlinkResolves: false` without hanging or
 *   throwing, and a link whose target is outside the corpus root resolves and is
 *   read.
 * - A Git-LFS pointer with no LFS installed is an ordinary 130-byte markdown
 *   document, and its `version https://...` line becomes a real external
 *   reference the document does not actually contain.
 *
 * ## What this run may not have demonstrated
 *
 * Three sections need a host capability — a POSIX host for symlinks and
 * `working-tree-encoding`, a POSIX `sed` for a clean/smudge filter, `git lfs`
 * for the genuinely-tracked LFS arm. An unmet gate skips a section, and a
 * skipped section is not a passing one: {@link HOST_GATES} carries each gate's
 * requirement and the findings lost with it, the gated `describe` titles state
 * their requirement so a skipped suite reads its own reason in the report, and a
 * top-level `beforeAll` warns for every unmet gate. Without that, a Windows run
 * reports success having never once demonstrated that the hint serves wrong
 * characters.
 */

/* eslint-disable security/detect-non-literal-fs-filename -- controlled temp fixture trees */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';

import {
  GitTracker,
  mkdirSyncReal,
  normalizedTmpdir,
  resetProjectRootCaches,
  safePath,
  toForwardSlash,
} from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { computeContentKey, readContentWithKey } from '../../src/content-key.js';
import { ParseCache } from '../../src/parse-cache.js';
import { populateBlobs } from '../../src/projection/blob-population.js';
import { RunContentCache, type ContentCacheStats } from '../../src/projection/content-cache.js';
import { FilesystemExtentContributor } from '../../src/projection/contributors/filesystem-extent.js';
import { GitExtentContributor } from '../../src/projection/contributors/git-extent.js';
import {
  crawlSourceFor,
  EXTENT_SOURCE_ENV,
  EXTENT_SOURCE_FILESYSTEM,
  EXTENT_SOURCE_GIT,
  type CrawlSourceKind,
} from '../../src/projection/crawl-source.js';
import { ProjectionBuilder, type Projection } from '../../src/projection/projection.js';
import type { ResourceRealizationRow } from '../../src/schemas/projection-resources.js';

/**
 * A content-addressed parse cache would serve a previous run's facts from a
 * shared temp directory, so every derivation below is performed for real.
 */
const NO_CACHE = new ParseCache({ enabled: false });

/** One heading and one outbound link, so a parse has something to report. 19 bytes as LF. */
const DOC = '# Doc\n\n[b](./b.md)\n';

/** The two paths every shared-OID fixture plants, byte-identical when authored. */
const PATH_A = 'dirA/same.md';
const PATH_B = 'dirB/same.md';

/** The attributes file every scoped mechanism below is configured through. */
const GITATTRIBUTES = '.gitattributes';

/** Git's mode for a symlink; its blob holds the target STRING, not file bytes. */
const GIT_MODE_SYMLINK = '120000';

/** Windows needs elevated privilege for symlinks; these divergences are POSIX-observable. */
const IS_WINDOWS = process.platform === 'win32';

/**
 * Whether a POSIX `sed` is on PATH — a clean/smudge filter needs a real executable.
 *
 * @returns True when `sed` ran and did what was asked of it
 */
function sedAvailable(): boolean {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- capability probe, deliberately from PATH
  const probe = spawnSync('sed', ['-e', 's/a/b/'], { input: 'a\n', encoding: 'utf-8' });
  return probe.status === 0 && probe.stdout === 'b\n';
}

/**
 * Whether real `git lfs` is installed. Never a failure — only a skip.
 *
 * @returns True when the `lfs` subcommand exists
 */
function lfsAvailable(): boolean {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- capability probe, deliberately from PATH
  return spawnSync('git', ['lfs', 'version'], { encoding: 'utf-8' }).status === 0;
}

/** One host capability a section needs, and what the suite loses without it. */
interface HostGate {
  /** What the host must provide, phrased to read inside a `describe` title. */
  readonly requirement: string;
  /** Whether this host provides it. */
  readonly met: boolean;
  /** What goes undemonstrated when it does not — the reason the skip matters. */
  readonly lost: string;
}

/**
 * Every host capability this file gates a section on.
 *
 * Skips here are legitimate — none of these divergences is observable on a host
 * that cannot produce them — but a silent skip turns a section that never ran
 * into a section that passed. On Windows sections 3, 4 and 5 all vanish while
 * 1, 2, 6 and 7 stay green, *including* the two "sound hint hit" tests, so the
 * suite would report success having never demonstrated the unsound one. Each
 * gate therefore states its own requirement in the `describe` title it guards
 * (so a skipped suite carries its reason in the report) and is warned about by
 * name in the top-level `beforeAll` below.
 */
const HOST_GATES: Record<'utf16' | 'filter' | 'symlinks' | 'lfs', HostGate> = {
  utf16: {
    requirement: 'a POSIX host',
    met: !IS_WINDOWS,
    lost:
      'section 3 — that a `working-tree-encoding=UTF-16` checkout reads exactly'
      + ' like its UTF-8 twin. This is the only end-to-end proof that'
      + ' `decodeTextContent` reaches the projection, so without it nothing here'
      + ' demonstrates that VAT can read a UTF-16 document',
  },
  filter: {
    requirement: 'a POSIX host with `sed` on PATH',
    met: !IS_WINDOWS && sedAvailable(),
    lost:
      'section 4 — that the hint serves one path the OTHER path\'s characters'
      + ' (DEFECT). This is the finding the suite exists for; without it nothing'
      + ' here demonstrates an unsound hint hit at all',
  },
  symlinks: {
    requirement: 'a POSIX host',
    met: !IS_WINDOWS,
    lost: 'section 5 — what the extents do with committed symlinks',
  },
  lfs: {
    requirement: '`git lfs` installed',
    met: lfsAvailable(),
    lost:
      "section 6's genuinely-tracked arm — that a real LFS checkout keeps the"
      + ' pointer in the blob while the tree holds the document. The'
      + ' no-LFS-installed arm still runs and carries that case',
  },
};

/**
 * A `describe` title that carries its gate's requirement.
 *
 * Vitest reports a skipped suite by name and nothing else, so the requirement
 * has to be *in* the name for the report to say why the suite did not run.
 *
 * @param title - What the section is about
 * @param gate - The gate it is guarded by
 * @returns The title with its requirement appended
 */
function gatedTitle(title: string, gate: HostGate): string {
  return `${title} — requires ${gate.requirement}`;
}

beforeAll(() => {
  for (const [name, gate] of Object.entries(HOST_GATES)) {
    if (gate.met) continue;
    console.warn(
      `git-hostile-config: GATE "${name}" UNMET — this host does not provide ${gate.requirement}.`
      + ` NOT DEMONSTRATED BY THIS RUN: ${gate.lost}.`,
    );
  }
});

/** What a fixture repository hands back. */
interface Fixture {
  /** Temp root holding both the repository and its redirected `HOME`. */
  readonly base: string;
  /** The repository working tree. */
  readonly repo: string;
  /** Run git inside the repo under the isolated environment, throwing on failure. */
  readonly git: (...args: readonly string[]) => string;
}

/**
 * Create a fully isolated repository.
 *
 * Isolation is belt **and** braces, because the two halves cover different
 * commands. `GIT_CONFIG_NOSYSTEM` plus a redirected `HOME`, `XDG_CONFIG_HOME`
 * and `GIT_CONFIG_GLOBAL` keep the developer's own config out of the commands
 * run *here*. The commands **VAT** runs do not inherit that environment at all,
 * so the repo-local `core.autocrlf` / `core.eol` settings are what decide the
 * result for them — repo-local config outranks global and system alike. Without
 * the second half a developer with `core.autocrlf=input` silently gets a
 * different answer from CI.
 *
 * @param prefix - Temp-directory prefix, for readable failure output
 * @returns The fixture's roots and its git runner
 */
function newRepo(prefix: string): Fixture {
  const base = toForwardSlash(mkdtempSync(safePath.join(normalizedTmpdir(), prefix)));
  const repo = safePath.join(base, 'repo');
  const home = safePath.join(base, 'home');
  mkdirSyncReal(repo, { recursive: true });
  mkdirSyncReal(home, { recursive: true });

  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: safePath.join(home, '.config'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: safePath.join(home, '.gitconfig'),
    GIT_TERMINAL_PROMPT: '0',
  };

  const git = (...args: readonly string[]): string => {
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- fixture setup uses git from PATH, as every git fixture in this package does
    const result = spawnSync('git', [...args], { cwd: repo, env, encoding: 'utf-8' });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')} exited ${String(result.status)}\n${result.stderr}`);
    }
    return result.stdout;
  };

  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'VAT Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');
  git('config', 'core.eol', 'lf');
  return { base, repo, git };
}

/**
 * Write a fixture file, creating its parents.
 *
 * Takes `Buffer | string` rather than reusing `writeFileIn`, because two of these
 * fixtures are defined by their raw bytes — a UTF-16 document and a synthesized
 * LFS pointer — and a helper that only accepts a decoded string cannot express
 * the first of them at all.
 *
 * @param root - Root the path is relative to
 * @param relativePath - Root-relative, forward-slashed
 * @param contents - Exact bytes to write
 */
function plant(root: string, relativePath: string, contents: Buffer | string): void {
  const absolute = safePath.resolve(root, relativePath);
  mkdirSyncReal(safePath.resolve(absolute, '..'), { recursive: true });
  writeFileSync(absolute, contents);
}

/**
 * Commit everything, then force git to re-materialize the working tree.
 *
 * The **smudge** half of every mechanism here — `eol=crlf`, `working-tree-
 * encoding`, `filter.*.smudge` — runs only on checkout. A fixture that merely
 * wrote and committed leaves a working tree git never touched, so it would
 * diverge from nothing and prove nothing.
 *
 * @param fixture - The repository to commit and re-check-out
 */
function commitAndRematerialize(fixture: Fixture): void {
  fixture.git('add', '-A');
  fixture.git('commit', '-qm', 'fixture');
  for (const tracked of fixture.git('ls-files').split('\n').filter(Boolean)) {
    rmSync(safePath.join(fixture.repo, tracked), { force: true });
  }
  fixture.git('checkout', '--', '.');
}

/**
 * `git ls-files -s` parsed into `path` to `{ mode, oid }`.
 *
 * @param fixture - Repository to inspect
 * @returns The index, keyed by repository-relative path
 */
function stagedIndex(fixture: Fixture): Map<string, { mode: string; oid: string }> {
  const entries = new Map<string, { mode: string; oid: string }>();
  for (const line of fixture.git('ls-files', '-s').split('\n').filter(Boolean)) {
    // `<mode> <oid> <stage>\t<path>` — the tab is the only separator a path
    // cannot contain, so it is found before anything else is split.
    const tab = line.indexOf('\t');
    if (tab === -1) throw new Error(`unparseable ls-files line: ${line}`);
    const columns = line.slice(0, tab).split(/\s+/);
    entries.set(line.slice(tab + 1), { mode: columns[0] ?? '', oid: columns[1] ?? '' });
  }
  return entries;
}

/**
 * The committed bytes behind an OID — the other half of every divergence proof.
 *
 * `spawnSync` without `encoding`, so stdout stays a Buffer: the whole point is a
 * byte comparison, and decoding here would destroy the evidence.
 *
 * @param fixture - Repository to read from
 * @param oid - Blob object id
 * @returns The blob's raw bytes
 */
function blobBytes(fixture: Fixture, oid: string): Buffer {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- fixture inspection uses git from PATH
  const result = spawnSync('git', ['cat-file', 'blob', oid], { cwd: fixture.repo });
  if (result.status !== 0) throw new Error(`git cat-file blob ${oid} failed`);
  return result.stdout;
}

/**
 * Raw working-tree bytes of a fixture path.
 *
 * @param fixture - Repository to read from
 * @param relativePath - Repository-relative path
 * @returns The bytes on disk, undecoded
 */
function worktreeBytes(fixture: Fixture, relativePath: string): Buffer {
  return readFileSync(safePath.join(fixture.repo, relativePath));
}

/** One projection run, plus what its content cache did while producing it. */
interface Arm {
  readonly projection: Projection;
  readonly stats: ContentCacheStats;
  /** The enumerator that actually ran — not the one the environment asked for. */
  readonly extentSource: CrawlSourceKind;
}

/**
 * Populate a root through the `filesystem` extent and derive its blobs.
 *
 * Assembled by hand rather than through `populate()` for one reason: `populate()`
 * constructs its own {@link RunContentCache} and never surfaces it, and
 * {@link ContentCacheStats.hintHits} is the only number that says whether the
 * cross-path route was taken at all. Every other step is the driver's own
 * sequence, in the driver's own order.
 *
 * The contributor is constructed with its default content demand — the one
 * `buildInventoryPopulation` registers, which is the lane the hint is live in.
 * `buildResourcePopulation` registers `'deferred'` and consumes no hint.
 *
 * @param root - Repository working tree to populate
 * @param useGitSource - Whether to ask for {@link EXTENT_SOURCE_GIT}, the only
 *   enumerator that offers a content hint
 * @returns The projection, the cache's statistics, and the enumerator that ran
 */
async function runArm(root: string, useGitSource: boolean): Promise<Arm> {
  // Set inside the test, never in the ambient environment: `vitest.setup.js`
  // deletes every `VAT_*` variable before any test module loads.
  //
  // ⚠️ BOTH arms name their enumerator. Leaving the walk arm unset used to mean
  // "the filesystem enumerator" only because that was the default; once git
  // became the default, an unset arm silently became a SECOND git arm and every
  // A/B claim in this file collapsed into A/A — two identical measurements
  // asserted to differ. Naming it is what keeps the two arms two arms.
  process.env[EXTENT_SOURCE_ENV] = useGitSource ? EXTENT_SOURCE_GIT : EXTENT_SOURCE_FILESYSTEM;
  // `gitFindRoot` memoizes per directory, including the `null` recorded by a walk
  // that climbed through this path before the repository existed.
  resetProjectRootCaches();

  const tracker = new GitTracker(root);
  await tracker.initialize({ includeUntracked: true });
  const cache = new RunContentCache();
  const builder = new ProjectionBuilder(root, tracker, cache);
  const contribution = await new FilesystemExtentContributor().contribute(builder.base(), null);
  for (const row of contribution.contexts) builder.addContext(row);
  for (const row of contribution.resources) builder.addResource(row);
  for (const row of contribution.realizations) builder.addRealization(row);
  await populateBlobs(builder, { parseCache: NO_CACHE });

  return {
    projection: builder.build(),
    stats: cache.stats,
    extentSource: crawlSourceFor(root).kind,
  };
}

/** Both arms of one root, in both directions of the switch. */
interface Arms {
  /** `VAT_EXTENT_SOURCE` unset: the walk, which offers no hint. */
  readonly walk: Arm;
  /** `VAT_EXTENT_SOURCE=git`: the only enumerator that offers one. */
  readonly git: Arm;
}

/**
 * Run one root under both enumerators, walk first.
 *
 * @param root - Repository working tree to populate twice
 * @returns Both arms
 */
async function runBothArms(root: string): Promise<Arms> {
  const walk = await runArm(root, false);
  const git = await runArm(root, true);
  return { walk, git };
}

/**
 * The realization for one root-relative path.
 *
 * @param projection - Projection to read
 * @param relativePath - Root-relative, forward-slashed
 * @returns The row
 * @throws When the path was not enumerated at all
 */
function realizationOf(projection: Projection, relativePath: string): ResourceRealizationRow {
  const row = projection.resourceRealizations.find((candidate) => candidate.path === relativePath);
  if (row === undefined) throw new Error(`no realization for ${relativePath}`);
  return row;
}

/**
 * The content key one path was realized under.
 *
 * @param projection - Projection to read
 * @param relativePath - Root-relative, forward-slashed
 * @returns The key, or the empty string when the row carries none
 */
function keyOf(projection: Projection, relativePath: string): string {
  return realizationOf(projection, relativePath).contentKey ?? '';
}

/**
 * Every enumerated file path, sorted — the membership claim.
 *
 * @param projection - Projection to read
 * @returns Root-relative file paths, ascending by code unit
 */
function membership(projection: Projection): string[] {
  return projection.resourceRealizations
    .filter((row) => !row.isDirectory)
    .map((row) => row.path)
    .sort((left, right) => (left < right ? -1 : 1));
}

/**
 * The reference tokens one blob's parse discovered, in ordinal order.
 *
 * @param projection - Projection to read
 * @param contentKey - The blob's key
 * @returns Raw reference tokens
 */
function referencesOf(projection: Projection, contentKey: string): string[] {
  return projection.blobReferences
    .filter((row) => row.blob === contentKey)
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((row) => row.rawRef);
}

/**
 * The blob row for a content key, or undefined when the stage derived none.
 *
 * @param projection - Projection to read
 * @param contentKey - The blob's key
 * @returns The row, if any
 */
function blobOf(
  projection: Projection,
  contentKey: string,
): Projection['blobs'][number] | undefined {
  return projection.blobs.find((row) => row.contentKey === contentKey);
}

/**
 * Section titles one blob's parse produced, in ordinal order.
 *
 * @param projection - Projection to read
 * @param contentKey - The blob's key
 * @returns Heading titles
 */
function sectionTitlesOf(projection: Projection, contentKey: string): string[] {
  return projection.blobSections
    .filter((row) => row.blob === contentKey)
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((row) => row.title);
}

/** What {@link plantTwinPaths} observed, so each scenario can state its own divergence. */
interface TwinPaths {
  /** The OID both paths landed on. */
  readonly oid: string;
  /** The committed bytes behind it. */
  readonly blob: Buffer;
  /** Working-tree bytes at {@link PATH_A}. */
  readonly onDiskA: Buffer;
  /** Working-tree bytes at {@link PATH_B}. */
  readonly onDiskB: Buffer;
}

/**
 * Plant the twin paths and prove they really did land on one blob OID.
 *
 * Returns the *observed* bytes rather than asserting them, so each scenario
 * states its own expected divergence and a fixture that quietly stopped
 * diverging fails in that scenario rather than inside a shared helper.
 *
 * @param fixture - Repository to plant into
 * @param content - Authored content for both paths
 * @returns The shared OID, the committed bytes, and each path's worktree bytes
 * @throws When the two paths did not commit, or did not share an OID
 */
function plantTwinPaths(fixture: Fixture, content: string): TwinPaths {
  plant(fixture.repo, PATH_A, content);
  plant(fixture.repo, PATH_B, content);
  commitAndRematerialize(fixture);

  const index = stagedIndex(fixture);
  const entryA = index.get(PATH_A);
  const entryB = index.get(PATH_B);
  if (entryA === undefined || entryB === undefined) throw new Error('twin paths were not committed');
  if (entryA.oid !== entryB.oid) {
    throw new Error(`twin paths did not share an OID: ${entryA.oid} vs ${entryB.oid}`);
  }

  return {
    oid: entryA.oid,
    blob: blobBytes(fixture, entryA.oid),
    onDiskA: worktreeBytes(fixture, PATH_A),
    onDiskB: worktreeBytes(fixture, PATH_B),
  };
}

// ---------------------------------------------------------------------------
// 1. `.gitattributes` `text eol=crlf` against `eol=lf` — one OID, two byte strings
// ---------------------------------------------------------------------------

describe('.gitattributes eol=crlf beside eol=lf', () => {
  let fixture: Fixture;
  let planted: TwinPaths;
  let arms: Arms;

  beforeAll(async () => {
    fixture = newRepo('vat-hostile-eol-');
    plant(fixture.repo, GITATTRIBUTES, 'dirA/*.md text eol=lf\ndirB/*.md text eol=crlf\n');
    planted = plantTwinPaths(fixture, DOC);
    arms = await runBothArms(fixture.repo);
  });

  afterAll(() => {
    delete process.env[EXTENT_SOURCE_ENV];
    rmSync(fixture.base, { recursive: true, force: true });
  });

  // -- Fixture validity: without these, everything below is vacuous ------------

  it('really did produce one OID naming two different working-tree byte strings', () => {
    expect(planted.blob).toHaveLength(19);
    expect(planted.onDiskA.toString('utf-8')).toBe('# Doc\n\n[b](./b.md)\n');
    expect(planted.onDiskB.toString('utf-8')).toBe('# Doc\r\n\r\n[b](./b.md)\r\n');
    expect(planted.onDiskA).toHaveLength(19);
    expect(planted.onDiskB).toHaveLength(22);
  });

  it('ran two different enumerators, so the two arms are two measurements', () => {
    expect(arms.walk.extentSource).toBe('filesystem');
    expect(arms.git.extentSource).toBe('git');
    expect(arms.walk.stats.hintHits).toBe(0);
    expect(arms.git.stats.hintHits).toBe(1);
  });

  // -- What the reader does, independent of the hint ---------------------------

  it('enumerates the same membership under either enumerator', () => {
    expect(membership(arms.walk.projection)).toEqual([GITATTRIBUTES, PATH_A, PATH_B]);
    expect(membership(arms.git.projection)).toEqual(membership(arms.walk.projection));
  });

  /**
   * FINDING — line endings are NOT unobservable, contrary to the reasoning this
   * suite was written to check.
   *
   * `lineStartOffsets` works in UTF-16 code units of the *decoded* string, and a
   * CRLF document decodes with the `\r` still in it, so every byte-derived and
   * offset-derived column moves. Nothing here is wrong: the offsets are
   * self-consistent with the content they were computed from, and content and
   * offsets travel together through `parse-cache.ts` rehydration. But "changes
   * nothing observable" is not what the projection says, and this is the
   * assertion that says so.
   */
  it('gives the CRLF twin its own content key and its own byte-derived facts', () => {
    const keyA = keyOf(arms.walk.projection, PATH_A);
    const keyB = keyOf(arms.walk.projection, PATH_B);
    expect(keyA).not.toBe(keyB);

    expect(blobOf(arms.walk.projection, keyA)?.bytes).toBe(19);
    expect(blobOf(arms.walk.projection, keyB)?.bytes).toBe(22);
    expect(blobOf(arms.walk.projection, keyA)?.tokenEstimate).toBe(5);
    expect(blobOf(arms.walk.projection, keyB)?.tokenEstimate).toBe(6);

    // The character offsets shift by the two carriage returns preceding the link.
    const offsets = (key: string): number[] => arms.walk.projection.blobReferences
      .filter((row) => row.blob === key)
      .map((row) => row.startOffset);
    expect(offsets(keyA)).toEqual([7]);
    expect(offsets(keyB)).toEqual([9]);
  });

  it('discovers the same links, headings and counts on both twins', () => {
    const keyA = keyOf(arms.walk.projection, PATH_A);
    const keyB = keyOf(arms.walk.projection, PATH_B);

    expect(referencesOf(arms.walk.projection, keyA)).toEqual(['./b.md']);
    expect(referencesOf(arms.walk.projection, keyB)).toEqual(['./b.md']);
    expect(sectionTitlesOf(arms.walk.projection, keyA)).toEqual(['Doc']);
    expect(sectionTitlesOf(arms.walk.projection, keyB)).toEqual(['Doc']);

    const semantic = (key: string): unknown => {
      const row = blobOf(arms.walk.projection, key);
      return {
        words: row?.wordCount,
        links: row?.linkCount,
        headings: row?.headingCount,
        sections: row?.sectionCount,
      };
    };
    expect(semantic(keyB)).toEqual(semantic(keyA));
  });

  // -- FINDING: what the hint does to the same tree ----------------------------

  /**
   * FINDING, pinned as WRONG. Under the git enumerator the two paths collapse
   * onto one content key — the one hashed from the **LF** twin — so the
   * projection describes a 22-byte file with a 19-byte blob whose reference
   * offsets belong to the other file. No condition row records it and nothing in
   * the key can be read to detect it. This is `content-cache.ts`'s "well-formed
   * entry, wrong contents", end to end.
   */
  it('collapses both twins onto the LF twin key under the git enumerator (DEFECT)', () => {
    const keyA = keyOf(arms.git.projection, PATH_A);
    const keyB = keyOf(arms.git.projection, PATH_B);
    expect(keyB).toBe(keyA);
    // The surviving key is the one hashed from dirA's bytes: the tree snapshot is
    // ordered, so the lexicographically first path reads first and populates the
    // hint, and the second is served from it.
    expect(keyA).toBe(computeContentKey(planted.onDiskA, 'markdown'));

    // The projection now claims 19 bytes for a file that is 22 bytes on disk.
    expect(blobOf(arms.git.projection, keyB)?.bytes).toBe(19);
    expect(worktreeBytes(fixture, PATH_B)).toHaveLength(22);
    // And it is silent about it.
    expect(arms.git.projection.blobConditions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. `core.autocrlf=true`, no attributes — the Windows installer default
// ---------------------------------------------------------------------------

describe('core.autocrlf=true with no attributes', () => {
  let fixture: Fixture;
  let planted: TwinPaths;
  let arms: Arms;

  beforeAll(async () => {
    fixture = newRepo('vat-hostile-autocrlf-');
    fixture.git('config', 'core.autocrlf', 'true');
    planted = plantTwinPaths(fixture, DOC);
    arms = await runBothArms(fixture.repo);
  });

  afterAll(() => {
    delete process.env[EXTENT_SOURCE_ENV];
    rmSync(fixture.base, { recursive: true, force: true });
  });

  it('really did clean CRLF out of the blob while leaving it on disk', () => {
    expect(planted.blob).toHaveLength(19);
    expect(planted.onDiskA).toHaveLength(22);
    expect(planted.onDiskB).toHaveLength(22);
  });

  /**
   * The setting is repository-wide, so it moves **both** paths the same way. The
   * blob diverges from the working tree, but the two working-tree byte strings do
   * not diverge from each other — which is exactly the condition under which a
   * hint hit is sound. Pinned because "the OID differs from the bytes" is not the
   * dangerous property on its own; "one OID, two byte strings" is.
   */
  it('is a sound hint hit — one OID, one byte string, one blob in both arms', () => {
    expect(arms.git.stats.hintHits).toBe(1);
    expect(arms.walk.stats.hintHits).toBe(0);

    const key = computeContentKey(planted.onDiskA, 'markdown');
    for (const arm of [arms.walk, arms.git]) {
      expect(keyOf(arm.projection, PATH_A)).toBe(key);
      expect(keyOf(arm.projection, PATH_B)).toBe(key);
      expect(blobOf(arm.projection, key)?.bytes).toBe(22);
      expect(referencesOf(arm.projection, key)).toEqual(['./b.md']);
      expect(sectionTitlesOf(arm.projection, key)).toEqual(['Doc']);
    }
  });

  it('saves the read it claims to save, and holds fewer bytes for it', () => {
    expect(arms.git.stats.misses).toBe(arms.walk.stats.misses - 1);
    expect(arms.git.stats.bytesHeld).toBeLessThan(arms.walk.stats.bytesHeld);
    // Both arms still hold one entry per (path, parserKind): a hint hit files the
    // second path's entry against bytes already counted.
    expect(arms.git.stats.entries).toBe(arms.walk.stats.entries);
  });
});

// ---------------------------------------------------------------------------
// 3. `working-tree-encoding=UTF-16` — nothing to do with the hint
// ---------------------------------------------------------------------------

// A Windows checkout of a `working-tree-encoding` path additionally interacts
// with the platform's own eol handling; the property here is POSIX-observable.
describe.skipIf(!HOST_GATES.utf16.met)(gatedTitle('working-tree-encoding=UTF-16', HOST_GATES.utf16), () => {
  const DOC_PATH = 'doc.md';
  let fixture: Fixture;
  let onDisk: Buffer;
  let arms: Arms;
  /** The UTF-8 control's repository, torn down with the UTF-16 one. */
  let utf8Twin: Fixture;
  /**
   * The same document, same path, same VAT code path — only the working-tree
   * encoding differs. A separate repository rather than a second path in the
   * same tree, deliberately: the UTF-16 path's *cleaned* blob is byte-identical
   * to a UTF-8 twin's, so a twin in this tree would share its OID and drag the
   * hint into a section that is about the reader, not the hint.
   */
  let utf8Control: Arm;

  beforeAll(async () => {
    fixture = newRepo('vat-hostile-utf16-');
    plant(fixture.repo, GITATTRIBUTES, '*.md working-tree-encoding=UTF-16\n');
    // Authored in UTF-16LE **with a BOM**: git refuses to clean a UTF-16 path
    // that has none ("BOM is required in ... if encoded as UTF-16"), so a fixture
    // written as UTF-8 never commits at all and would prove nothing.
    plant(
      fixture.repo,
      DOC_PATH,
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(DOC, 'utf16le')]),
    );
    commitAndRematerialize(fixture);
    onDisk = worktreeBytes(fixture, DOC_PATH);
    arms = await runBothArms(fixture.repo);

    utf8Twin = newRepo('vat-hostile-utf16-control-');
    plant(utf8Twin.repo, DOC_PATH, DOC);
    commitAndRematerialize(utf8Twin);
    utf8Control = await runArm(utf8Twin.repo, false);
  });

  afterAll(() => {
    delete process.env[EXTENT_SOURCE_ENV];
    rmSync(fixture.base, { recursive: true, force: true });
    rmSync(utf8Twin.base, { recursive: true, force: true });
  });

  it('really did store UTF-8 while leaving UTF-16 on disk', () => {
    const oid = stagedIndex(fixture).get(DOC_PATH)?.oid ?? '';
    expect(blobBytes(fixture, oid).toString('utf-8')).toBe(DOC);
    expect(blobBytes(fixture, oid)).toHaveLength(19);
    expect(onDisk).toHaveLength(40);
    // Observed, and not what an author would guess: the fixture is written
    // little-endian (`fffe`), and git re-materializes plain `UTF-16` with a BOM
    // whose byte order is GIT'S choice, not the file's. Which one it picks is not
    // portable — macOS produced BIG-endian (`feff`) here, ubuntu little-endian
    // (`fffe`) — and neither is wrong, because the attribute names a charset and
    // says nothing about byte order. Pinning one of them pinned the host.
    //
    // What is portable, and what this test is actually about, is that the
    // worktree holds BOM-prefixed UTF-16 while the blob holds UTF-8. Both BOMs
    // are still asserted exactly, so a re-materialization that dropped the BOM or
    // wrote UTF-8 to disk still fails.
    expect([[0xfe, 0xff], [0xff, 0xfe]]).toContainEqual([...onDisk.subarray(0, 2)]);
  });

  /**
   * The fix, at its source. `readContentWithKey` used to call
   * `bytes.toString('utf-8')` unconditionally — no BOM check, no encoding
   * detection — and handed the rest of the projection two replacement
   * characters followed by NUL-interleaved ASCII. It now decodes through
   * `decodeTextContent`, which reads the encoding off the BOM.
   *
   * `readContentWithKey` is asked for the real thing here rather than being
   * described while a `Buffer.toString` the test performed itself is asserted
   * on: an assertion over bytes this test decoded would pass no matter what the
   * reader did, which is the single most likely way a decoder test lies.
   *
   * The KEY assertion is the load-bearing half. It must stay over the RAW
   * on-disk bytes — 40 of them, UTF-16BE — and not over the 19 bytes the
   * decoded characters would re-encode to. `content-key.ts` measures why: the
   * key's preimage cannot move when the decode improves, or every cached parse
   * in existence is filed under a stale name.
   */
  it('decodes the document at the READ, and still keys the raw bytes', async () => {
    const keyed = await readContentWithKey(safePath.join(fixture.repo, DOC_PATH), 'markdown');

    // The document, as authored. Not a BOM, not a NUL, not a replacement
    // character — the three symptoms the old decode produced, each named so a
    // regression cannot half-pass.
    expect(keyed.content).toBe(DOC);
    expect(keyed.content.startsWith('\u{FEFF}')).toBe(false);
    expect(keyed.content).not.toContain('\u{0}');
    expect(keyed.content).not.toContain('\u{FFFD}');
    // The bytes were read whole and keyed over: 40 raw bytes, keyed as 40, even
    // though the characters they carry re-encode to 19.
    expect(keyed.byteLength).toBe(onDisk.byteLength);
    expect(keyed.byteLength).toBe(40);
    expect(Buffer.byteLength(keyed.content, 'utf-8')).toBe(19);
    expect(keyed.key).toBe(computeContentKey(onDisk, 'markdown'));
    // And NOT the key its UTF-8 twin gets. Same document, different bytes,
    // different identity — which is the whole reason the preimage is bytes.
    expect(keyed.key).not.toBe(computeContentKey(Buffer.from(DOC), 'markdown'));
  });

  /**
   * The fix, as the projection sees it. A UTF-16 checkout now yields the same
   * facts as its UTF-8 twin: one heading, one link, one section titled `Doc`,
   * one reference to `./b.md`, and no condition row at all.
   *
   * Both sides are asserted, and the contrast is what makes the test worth
   * having. The UTF-16 side on its own would pass on a projection that had
   * stopped deriving blobs for *every* document; only "these two agree, and the
   * agreement is non-empty" says the reader learned an encoding. The assertions
   * are therefore written against the twin's values rather than against
   * literals, so a change that guts one side cannot leave the other looking
   * healthy.
   *
   * ## What deliberately does NOT match: the content key
   *
   * The two documents have different bytes on disk (40 vs 19) and therefore
   * different keys, asserted here as a non-equality. That is the raw-bytes
   * preimage doing its job — see `content-key.ts`. Two encodings of one document
   * are two documents as far as the cache is concerned, and collapsing them
   * would mean a key that is a function of the decoder, which is exactly what
   * the preimage rule forbids.
   *
   * ## What this fix took away
   *
   * The old refusal was loud — `BLOB_NOT_TEXT`, naming the path — and that
   * loudness was the whole consolation for the gap. It is now gone, because
   * there is nothing to refuse. The cost of losing it is recorded where it
   * lands: `RunContentCache.#byHint` in `projection/content-cache.ts`, whose
   * `working-tree-encoding` divergence case used to be caught by this very
   * refusal and is now served as plausible text instead.
   */
  it('reads a UTF-16 document exactly as it reads its UTF-8 twin', () => {
    // The same document, read from UTF-8 bytes: parsed, with facts.
    const utf8Key = keyOf(utf8Control.projection, DOC_PATH);
    expect(utf8Key).toBe(computeContentKey(Buffer.from(DOC), 'markdown'));
    const twin = blobOf(utf8Control.projection, utf8Key);
    expect(twin?.headingCount).toBe(1);
    expect(twin?.linkCount).toBe(1);
    expect(sectionTitlesOf(utf8Control.projection, utf8Key)).toEqual(['Doc']);
    expect(referencesOf(utf8Control.projection, utf8Key)).toEqual(['./b.md']);
    expect(utf8Control.projection.blobConditions).toEqual([]);

    // The same document, read from UTF-16 bytes: the same facts, under either
    // enumerator, and no refusal where the rows should be.
    for (const arm of [arms.walk, arms.git]) {
      const key = keyOf(arm.projection, DOC_PATH);
      // Keyed over the RAW 40 on-disk bytes, so NOT the twin's key. Same
      // document, two encodings, two identities — by design.
      expect(key).toBe(computeContentKey(onDisk, 'markdown'));
      expect(key).not.toBe(utf8Key);

      const blob = blobOf(arm.projection, key);
      expect(blob).toBeDefined();
      // Against the twin's numbers, not against literals: an assertion of `1`
      // on both sides passes even if both sides broke the same way.
      expect(blob?.headingCount).toBe(twin?.headingCount);
      expect(blob?.linkCount).toBe(twin?.linkCount);
      expect(blob?.sectionCount).toBe(twin?.sectionCount);
      expect(sectionTitlesOf(arm.projection, key)).toEqual(
        sectionTitlesOf(utf8Control.projection, utf8Key),
      );
      expect(referencesOf(arm.projection, key)).toEqual(
        referencesOf(utf8Control.projection, utf8Key),
      );

      // No condition row of any code — `BLOB_NOT_TEXT` is what used to be here,
      // and asserting the whole (empty) list rather than that one code means a
      // refusal arriving under a different code cannot slip past.
      expect(arm.projection.blobConditions.filter((row) => row.blob === key)).toEqual([]);

      // The one measure that legitimately differs: `bytes` is the raw byte
      // count, so it is the on-disk 40 rather than the twin's 19. Pinned, so
      // "the two agree" above is never read as "the two are identical".
      expect(blob?.bytes).toBe(onDisk.byteLength);
      expect(twin?.bytes).toBe(DOC.length);
    }
  });

  it('is not a hint problem — the two blobs in this tree have two different OIDs', () => {
    const index = stagedIndex(fixture);
    const documentOid = index.get(DOC_PATH)?.oid;
    const attributesOid = index.get(GITATTRIBUTES)?.oid;
    expect(documentOid).toMatch(/^[0-9a-f]{40}$/);
    expect(attributesOid).toMatch(/^[0-9a-f]{40}$/);
    expect(documentOid).not.toBe(attributesOid);
    expect(arms.git.stats.hintHits).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Clean/smudge filters DIFFERING between two directories — the predicted gap
// ---------------------------------------------------------------------------

// A clean/smudge filter needs a real POSIX `sed`. The skip is legitimate — a
// host that cannot run the filter cannot produce the divergence — but it is the
// most consequential one in this file, so `HOST_GATES.filter` names what is lost
// and the top-level `beforeAll` warns when it goes unmet.
describe.skipIf(!HOST_GATES.filter.met)(gatedTitle('a clean/smudge filter on one directory only', HOST_GATES.filter), () => {
  const AUTHORED = '# TOKEN\n\n[b](./b.md)\n';
  let fixture: Fixture;
  let planted: TwinPaths;
  let arms: Arms;

  beforeAll(async () => {
    fixture = newRepo('vat-hostile-filter-');
    plant(fixture.repo, GITATTRIBUTES, 'dirA/*.md !filter\ndirB/*.md filter=demo\n');
    // Clean is the inverse of smudge, so dirB's *cleaned* form is byte-identical
    // to dirA's authored form and the two paths land on one OID.
    fixture.git('config', 'filter.demo.clean', "sed 's/REPLACED/TOKEN/g'");
    fixture.git('config', 'filter.demo.smudge', "sed 's/TOKEN/REPLACED/g'");
    planted = plantTwinPaths(fixture, AUTHORED);
    arms = await runBothArms(fixture.repo);
  });

  afterAll(() => {
    delete process.env[EXTENT_SOURCE_ENV];
    rmSync(fixture.base, { recursive: true, force: true });
  });

  it('really did put genuinely different TEXT behind one OID', () => {
    expect(planted.blob.toString('utf-8')).toBe(AUTHORED);
    expect(planted.onDiskA.toString('utf-8')).toBe(AUTHORED);
    expect(planted.onDiskB.toString('utf-8')).toBe('# REPLACED\n\n[b](./b.md)\n');
  });

  it("reads each path's own text when no hint is offered", () => {
    const keyA = keyOf(arms.walk.projection, PATH_A);
    const keyB = keyOf(arms.walk.projection, PATH_B);
    expect(keyA).not.toBe(keyB);
    expect(sectionTitlesOf(arms.walk.projection, keyA)).toEqual(['TOKEN']);
    expect(sectionTitlesOf(arms.walk.projection, keyB)).toEqual(['REPLACED']);
  });

  /**
   * FINDING, and the one this suite was written for. `content-cache.ts` predicts
   * it and it is real: under `VAT_EXTENT_SOURCE=git` the hint collapses the two
   * paths, and the projection asserts that `dirB/same.md` has a heading called
   * `TOKEN`. The file on disk says `REPLACED`. Nothing in the projection can be
   * read to detect it — no condition, no differing key, not even a byte-count
   * mismatch to notice.
   */
  it('serves dirB the OTHER path characters under the git enumerator (DEFECT)', () => {
    expect(arms.git.stats.hintHits).toBe(1);

    const keyA = keyOf(arms.git.projection, PATH_A);
    const keyB = keyOf(arms.git.projection, PATH_B);
    expect(keyB).toBe(keyA);
    expect(keyB).toBe(computeContentKey(planted.onDiskA, 'markdown'));

    // The heading the projection publishes for dirB...
    expect(sectionTitlesOf(arms.git.projection, keyB)).toEqual(['TOKEN']);
    // ...is not the heading dirB has.
    expect(worktreeBytes(fixture, PATH_B).toString('utf-8')).toContain('# REPLACED');
    // `REPLACED` has vanished from the projection entirely.
    expect(arms.git.projection.blobSections.map((row) => row.title)).not.toContain('REPLACED');
    expect(arms.git.projection.blobConditions).toEqual([]);
    // One fewer blob than the tree actually contains.
    expect(arms.git.projection.blobs).toHaveLength(arms.walk.projection.blobs.length - 1);
  });
});

// ---------------------------------------------------------------------------
// 5. Symlinks — inside, outside, broken, circular
// ---------------------------------------------------------------------------

describe.skipIf(!HOST_GATES.symlinks.met)(gatedTitle('committed symlinks', HOST_GATES.symlinks), () => {
  /** A committed regular file — the resolving link's target, and the control. */
  const TARGET = 'target.md';
  /** A link to a file inside the tree. */
  const LINK_INSIDE = 'inside-link.md';
  /** A link whose target is outside the corpus root entirely. */
  const LINK_OUTSIDE = 'outside-link.md';
  /** A link to a path that does not exist. */
  const LINK_BROKEN = 'broken-link.md';
  /** One half of a circular pair. */
  const LOOP_A = 'loop-a.md';
  /** The other half. */
  const LOOP_B = 'loop-b.md';

  let fixture: Fixture;
  let arms: Arms;
  let gitExtentRows: readonly ResourceRealizationRow[];

  beforeAll(async () => {
    fixture = newRepo('vat-hostile-symlink-');
    writeFileSync(safePath.join(fixture.base, 'outside.md'), '# outside\n');
    plant(fixture.repo, TARGET, '# target\n');
    symlinkSync(TARGET, safePath.join(fixture.repo, LINK_INSIDE));
    symlinkSync(safePath.join(fixture.base, 'outside.md'), safePath.join(fixture.repo, LINK_OUTSIDE));
    symlinkSync('nowhere.md', safePath.join(fixture.repo, LINK_BROKEN));
    symlinkSync(LOOP_B, safePath.join(fixture.repo, LOOP_A));
    symlinkSync(LOOP_A, safePath.join(fixture.repo, LOOP_B));
    fixture.git('add', '-A');
    fixture.git('commit', '-qm', 'fixture');

    arms = await runBothArms(fixture.repo);

    // The git extent is the only contributor that reports a committed symlink —
    // and it is registered by no population lane (`resource-population.ts` and
    // `inventory-population.ts` both register the filesystem extent only), so it
    // is driven directly here. What follows is a claim about the contributor, not
    // about any projection VAT builds today.
    resetProjectRootCaches();
    const tracker = new GitTracker(fixture.repo);
    await tracker.initialize({ includeUntracked: true });
    const builder = new ProjectionBuilder(fixture.repo, tracker, new RunContentCache());
    gitExtentRows = (await new GitExtentContributor().contribute(builder.base(), null)).realizations;
  });

  afterAll(() => {
    delete process.env[EXTENT_SOURCE_ENV];
    rmSync(fixture.base, { recursive: true, force: true });
  });

  it('committed all four link shapes as mode-120000 entries', () => {
    const links = [...stagedIndex(fixture)]
      .filter(([, entry]) => entry.mode === GIT_MODE_SYMLINK)
      .map(([path]) => path)
      .sort((left, right) => (left < right ? -1 : 1));
    expect(links).toEqual([
      LINK_BROKEN,
      LINK_INSIDE,
      LOOP_A,
      LOOP_B,
      LINK_OUTSIDE,
    ]);
  });

  /**
   * The filesystem extent has never contained a symlink's own path: the walk runs
   * `followSymlinks: false`, and `GitCrawlSource` drops mode-`120000` entries
   * outright so re-sourcing does not import the divergence.
   */
  it('is invisible to the filesystem extent under either enumerator', () => {
    expect(membership(arms.walk.projection)).toEqual([TARGET]);
    expect(membership(arms.git.projection)).toEqual([TARGET]);
  });

  it('reports every link, resolving or not, through the git extent — and none hangs', () => {
    const byPath = new Map(gitExtentRows.map((row) => [row.path, row]));
    const paths = [...byPath.keys()].sort((left, right) => (left < right ? -1 : 1));
    expect(paths).toEqual([
      LINK_BROKEN,
      LINK_INSIDE,
      LOOP_A,
      LOOP_B,
      LINK_OUTSIDE,
      TARGET,
    ]);

    const shape = (path: string): unknown => {
      const row = byPath.get(path);
      return {
        isSymlink: row?.isSymlink,
        resolves: row?.symlinkResolves,
        exists: row?.exists,
        state: row?.contentState,
      };
    };

    // A link inside the tree: resolves, and its bytes are read and keyed.
    expect(shape(LINK_INSIDE)).toEqual({
      isSymlink: true, resolves: true, exists: true, state: 'keyed',
    });
    // A link pointing OUTSIDE the corpus root also resolves and is read.
    // `collectRealization` follows it, so content from outside the tree enters
    // the projection. Consistent with identity resolving symlinks, and worth
    // knowing before anyone treats the corpus root as a containment boundary.
    expect(shape(LINK_OUTSIDE)).toEqual({
      isSymlink: true, resolves: true, exists: true, state: 'keyed',
    });
    // A dangling link: present (`lstat` succeeded) but unresolvable, and no key.
    expect(shape(LINK_BROKEN)).toEqual({
      isSymlink: true, resolves: false, exists: true, state: 'none',
    });
    // A circular pair: `statSync` throws ELOOP, which is caught. No hang, no throw.
    expect(shape(LOOP_A)).toEqual({
      isSymlink: true, resolves: false, exists: true, state: 'none',
    });
    expect(shape(LOOP_B)).toEqual({
      isSymlink: true, resolves: false, exists: true, state: 'none',
    });
    // The control: the regular file is not mislabelled by any of the above.
    expect(shape(TARGET)).toEqual({
      isSymlink: false, resolves: null, exists: true, state: 'keyed',
    });
  });
});

// ---------------------------------------------------------------------------
// 6. Git-LFS pointer files
// ---------------------------------------------------------------------------

describe('a Git-LFS pointer file', () => {
  const POINTER_PATH = 'big.md';
  const POINTER = [
    'version https://git-lfs.github.com/spec/v1',
    'oid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393',
    'size 12345',
    '',
  ].join('\n');

  let fixture: Fixture;
  let arm: Arm;

  beforeAll(async () => {
    fixture = newRepo('vat-hostile-lfs-');
    plant(fixture.repo, POINTER_PATH, POINTER);
    commitAndRematerialize(fixture);
    arm = await runArm(fixture.repo, true);
  });

  afterAll(() => {
    delete process.env[EXTENT_SOURCE_ENV];
    rmSync(fixture.base, { recursive: true, force: true });
  });

  /**
   * With no LFS filter installed the pointer *is* the file, so this is the shape
   * every VAT run over an LFS repository without `git lfs` sees. It is not inert:
   * the pointer's `version` line is a bare URL, and the lexer reports it as a real
   * outbound reference — a link the document does not have.
   */
  it('is read as an ordinary 130-byte markdown document, links and all', () => {
    const key = keyOf(arm.projection, POINTER_PATH);
    expect(key).toBe(computeContentKey(Buffer.from(POINTER), 'markdown'));
    expect(blobOf(arm.projection, key)?.bytes).toBe(130);
    expect(blobOf(arm.projection, key)?.headingCount).toBe(0);
    expect(referencesOf(arm.projection, key)).toEqual(['https://git-lfs.github.com/spec/v1']);
    expect(arm.projection.blobConditions).toEqual([]);
  });

  /**
   * The genuinely-LFS-tracked arm. Skipped, never failed, when `git lfs` is
   * absent — which it was on the machine this was written on, so the assertion
   * above is what carries the case there.
   */
  it.skipIf(!HOST_GATES.lfs.met)(gatedTitle('keeps the pointer in the blob while the tree holds real bytes', HOST_GATES.lfs), () => {
    const lfsRepo = newRepo('vat-hostile-lfs-real-');
    try {
      lfsRepo.git('lfs', 'install', '--local');
      lfsRepo.git('lfs', 'track', '*.md');
      plant(lfsRepo.repo, POINTER_PATH, DOC);
      commitAndRematerialize(lfsRepo);

      const oid = stagedIndex(lfsRepo).get(POINTER_PATH)?.oid ?? '';
      // The committed blob is the pointer; the working tree is the document.
      expect(blobBytes(lfsRepo, oid).toString('utf-8')).toContain('git-lfs.github.com/spec/v1');
      expect(worktreeBytes(lfsRepo, POINTER_PATH).toString('utf-8')).toBe(DOC);
    } finally {
      rmSync(lfsRepo.base, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 7. The cross-path hint route itself
// ---------------------------------------------------------------------------

describe('the cross-path hint counter', () => {
  let fixture: Fixture;
  let planted: TwinPaths;
  let arms: Arms;

  beforeAll(async () => {
    fixture = newRepo('vat-hostile-hint-');
    planted = plantTwinPaths(fixture, DOC);
    arms = await runBothArms(fixture.repo);
  });

  afterAll(() => {
    delete process.env[EXTENT_SOURCE_ENV];
    rmSync(fixture.base, { recursive: true, force: true });
  });

  it('shares one blob between two paths that genuinely share an OID', () => {
    // No filters and no attributes here, so the twins are byte-identical on disk
    // as well as in the index — the honest, sound case the hint exists for.
    //
    // CONSTRUCTION CONTROL, not a measurement: `newRepo` sets `core.autocrlf=false`
    // and `core.eol=lf` and this fixture plants no `.gitattributes`, so the two
    // paths cannot diverge and these two lines can only fail if `newRepo` itself
    // regresses. That is worth pinning — every scenario above rests on it — but
    // nobody should read it as evidence about the hint.
    expect(planted.onDiskA).toEqual(planted.onDiskB);
    expect(planted.onDiskA).toEqual(planted.blob);
  });

  /**
   * The counter is called `hintHits`. There is no `sharedByHint` field on
   * {@link ContentCacheStats}; this is the only place the cross-path route is
   * observable, and it is counted separately from an ordinary `hits` precisely
   * because its soundness rests on something outside the cache.
   */
  it('counts the cross-path serve as hintHits, never as hits, and skips the read', () => {
    // The `hits` in each arm are the blob stage coming back for the bytes the
    // extent already read — one per derived blob, one blob here. It is the
    // `misses` and `bytesHeld` that the hint moves.
    expect(arms.git.stats).toEqual({
      hits: 1,
      misses: 1,
      hintHits: 1,
      entries: 2,
      bytesHeld: planted.onDiskA.length,
    });
    // Same tree, no hint offered: two reads, and twice the bytes held for one
    // blob's worth of content.
    expect(arms.walk.stats).toEqual({
      hits: 1,
      misses: 2,
      hintHits: 0,
      entries: 2,
      bytesHeld: planted.onDiskA.length * 2,
    });
  });

  it('serves content that is correct here, and the same key either way', () => {
    const expected = computeContentKey(planted.onDiskA, 'markdown');
    for (const arm of [arms.walk, arms.git]) {
      expect(keyOf(arm.projection, PATH_A)).toBe(expected);
      expect(keyOf(arm.projection, PATH_B)).toBe(expected);
      expect(referencesOf(arm.projection, expected)).toEqual(['./b.md']);
      expect(sectionTitlesOf(arm.projection, expected)).toEqual(['Doc']);
    }
  });
});
