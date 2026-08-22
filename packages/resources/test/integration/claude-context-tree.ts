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
 * @returns The temp directory and the projection the lane derived from it
 */
export async function buildClaudeContextTree(
  files: Readonly<Record<string, string>>,
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

  const projection = await buildClaudeContextPopulation({
    root: dir,
    onBlobPopulation: () => undefined,
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
