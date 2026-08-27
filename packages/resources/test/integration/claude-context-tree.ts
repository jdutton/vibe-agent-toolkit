/* eslint-disable security/detect-non-literal-fs-filename -- every path written below is joined onto a caller-supplied `mkdtemp` root and the relative paths come from a test's own literal fixture map */
/**
 * A REAL on-disk Claude tree, built once per integration suite.
 *
 * ## Why this is shared rather than written twice
 *
 * Two suites need the same three steps — `mkdtemp`, write a `{path: content}`
 * map, run {@link buildClaudeContextPopulation} — and they need them for
 * different reasons: `claude-context-population.integration.test.ts` asserts on
 * the TABLES the lane produced, `claude-context-query.integration.test.ts`
 * asserts on the ANSWER `whatLoadsAt` computes from them. A second copy of the
 * tree builder would be a second place for the two to diverge on the one thing
 * they must agree about — that both are looking at a tree a real harness could
 * load — and this repo's duplication gate is a hard merge blocker besides.
 *
 * ## ⛔ Not `claudeContextFixture`
 *
 * `test/helpers/claude-context-fixture.ts` assembles a projection in memory
 * against a corpus root that deliberately does NOT exist, which is what makes
 * "the query never touches the filesystem" a falsifiable claim there. This
 * helper is its opposite number and exists for the three defect classes the
 * in-memory route cannot see: a stale `dist/`, a mis-keyed parameter set, and a
 * membership/provenance disagreement that only a real enumeration can produce.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { GitTracker, runGitOrThrow } from '@vibe-agent-toolkit/utils/git';
import { afterAll, beforeAll } from 'vitest';

import { buildClaudeContextPopulation } from '../../src/projection/claude-context-population.js';
import type { Projection } from '../../src/projection/projection.js';

/** A populated tree, and the temp directory it lives in. */
export interface ClaudeContextTree {
  /** Absolute path of the `mkdtemp` root — pass it back to {@link removeClaudeContextTree}. */
  readonly dir: string;
  readonly projection: Projection;
}

/**
 * Write a `{root-relative path: content}` map to a fresh temp tree and populate it.
 *
 * @param files - Root-relative, forward-slashed paths to file contents. Parent
 *   directories are created; nothing else is written, so the tree contains
 *   exactly what the caller declared
 * @param options - How the tree is populated
 * @param options.git - `git init` the tree and hand the lane a real
 *   {@link GitTracker}. ⛔ Required to observe anything about ignored paths at
 *   all: outside a repository nothing is ignored, so a lane that declines the
 *   gitignored half and one that realizes it agree for the wrong reason. No
 *   commit is made — `GitTracker` falls back to `git check-ignore`, which reads
 *   `.gitignore` directly
 * @returns The temp directory and the projection the lane derived from it
 */
export async function buildClaudeContextTree(
  files: Readonly<Record<string, string>>,
  options: { git?: boolean } = {},
): Promise<ClaudeContextTree> {
  // `normalizedTmpdir`, not `os.tmpdir()`: on Windows the raw value can be an
  // 8.3 short name (`RUNNER~1`), which does not compare equal to the long path
  // every realization row is stated against.
  const dir = await mkdtemp(safePath.join(normalizedTmpdir(), 'vat-claude-context-'));

  for (const [relativePath, content] of Object.entries(files)) {
    const absolute = safePath.join(dir, relativePath);
    await mkdir(safePath.resolve(absolute, '..'), { recursive: true });
    await writeFile(absolute, content);
  }

  let gitTracker: GitTracker | undefined;
  if (options.git === true) {
    // No output suppression is needed or available: `runGitOrThrow` CAPTURES
    // stdout/stderr rather than inheriting them, so `git init`'s banner never
    // reaches the test reporter. `GitRunOptions` has no `stdio` passthrough on
    // purpose — it pins the repository via `cwd` after scrubbing the ambient git
    // environment, which a raw `stdio` handoff would sit beside misleadingly.
    runGitOrThrow(['init'], { cwd: dir });
    gitTracker = new GitTracker(dir);
    await gitTracker.initialize();
  }

  const projection = await buildClaudeContextPopulation({
    root: dir,
    onBlobPopulation: () => undefined,
    ...(gitTracker !== undefined && { gitTracker }),
  });
  return { dir, projection };
}

/**
 * Remove a tree {@link buildClaudeContextTree} created.
 *
 * @param dir - The temp directory, or undefined when `beforeAll` never got that far
 */
export async function removeClaudeContextTree(dir: string | undefined): Promise<void> {
  if (dir === undefined) return;
  await rm(dir, { recursive: true, force: true });
}

/** A live handle to the tree a {@link setupClaudeContextTree} suite is running against. */
export interface ClaudeContextTreeHandle {
  /** The populated projection. ⛔ Throws if read before `beforeAll` has run. */
  readonly projection: () => Projection;
  /** Absolute path of the temp root, or undefined if `beforeAll` never got that far. */
  readonly dir: () => string | undefined;
}

/**
 * Register the `beforeAll`/`afterAll` pair that owns one on-disk tree for a suite.
 *
 * Both integration suites need the identical five-line lifecycle, and a third
 * copy tripped the duplication gate — which is a merge blocker here, so this is
 * the fix rather than a baseline bump.
 *
 * ⚠️ **Both hooks take a 60s timeout deliberately.** A recursive `rm` over a temp
 * tree has exceeded Vitest's 10s hook default on Windows CI, which fails the
 * whole file for a reason unrelated to what it tests. One suite had the timeout
 * and the other did not; consolidating here is what stops that divergence
 * recurring, and it is why the teardown timeout is not "tidied away" as
 * excessive.
 *
 * @param files - Root-relative, forward-slashed paths to file contents
 * @returns Accessors for the projection and temp directory
 */
export function setupClaudeContextTree(
  files: Readonly<Record<string, string>>,
): ClaudeContextTreeHandle {
  let treeDir: string | undefined;
  let projection: Projection | undefined;

  beforeAll(async () => {
    const tree = await buildClaudeContextTree(files);
    treeDir = tree.dir;
    projection = tree.projection;
  }, 60_000);

  afterAll(async () => {
    await removeClaudeContextTree(treeDir);
  }, 60_000);

  return {
    projection: (): Projection => {
      // An explicit refusal, not a `!`: reading this from a `describe` body
      // rather than a test runs BEFORE `beforeAll`, and an undefined projection
      // would otherwise surface as an unrelated property error much later.
      if (projection === undefined) throw new Error('tree not built yet — read it inside a test');
      return projection;
    },
    dir: (): string | undefined => treeDir,
  };
}

/**
 * Order two root-relative paths by UTF-16 code point.
 *
 * ⚠️ Deliberately NOT `String.localeCompare`, which `sonarjs/no-alphabetical-sort`
 * demands by default: it is ICU- and locale-dependent, so an expectation sorted
 * with it would order differently on a differently-configured machine — and in
 * both suites here the sorted array IS the expectation. The shipped code refuses
 * it on the same ground (`claude-context-query.ts`, `claude-context-ancestry.ts`,
 * `claude-import-extent.ts`), so the tests must too, or a green assertion would
 * be comparing two different orderings.
 *
 * Lives beside the tree builder rather than in each suite: it is the second
 * thing both integration suites need and the duplication gate is a merge
 * blocker.
 *
 * @param left - One root-relative path
 * @param right - The other
 * @returns Negative, zero or positive, per the `Array#sort` contract
 */
export function byCodePoint(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
