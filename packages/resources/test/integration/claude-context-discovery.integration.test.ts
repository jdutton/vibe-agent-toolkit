/**
 * `discoverableFrom` over a REAL populated tree, where content keys are real.
 *
 * ## Why this suite exists at all
 *
 * The unit suite builds its projection through `test/helpers/claude-context-fixture.ts`,
 * and that helper is the only place in the world where a `contentKey` is a
 * function of the PATH. Production keys bytes (`content-key.ts`: "two copies of
 * the same document in different trees share a key"), so two files with
 * identical content share one key — and any lens that walks `blob_references`
 * back to "the path that cited this" through a `contentKey → path` map is
 * many-to-one there and one-to-one in the fixture. That divergence is invisible
 * to every in-memory test by construction, which is exactly what this file is
 * for: the same lens, over bytes a real enumerator hashed.
 */

import { describe, expect, it } from 'vitest';

import { account } from '../../src/projection/claude-context-accounting.js';
import { discoverableFrom } from '../../src/projection/claude-context-discovery.js';
import { whatLoadsAt, type LoadedContextAnswer } from '../../src/projection/claude-context-query.js';

import { byCodePoint, setupClaudeContextTree } from './claude-context-tree.js';

/**
 * The tree: two `CLAUDE.md` files with BYTE-IDENTICAL content, at two depths.
 *
 * ⚠️ The identical bytes are the whole fixture. Both files carry the same
 * relative href `guide.md`, and a relative markdown href resolves against the
 * directory of the file that carried it — so the same reference row must be
 * attributed to BOTH citing paths and resolve to two DIFFERENT targets. A
 * content key cannot make that attribution: it names the bytes, and the bytes
 * are the same. If the lens routes through one, one of the two targets is lost
 * outright rather than merely mislabelled.
 *
 * The two guides carry different text so their own keys stay distinct; nothing
 * here depends on that, but a shared key there would make a failure ambiguous.
 */
const TREE: Record<string, string> = {
  'CLAUDE.md': '# Ctx\n\nsee [the guide](guide.md)\n',
  'sub/CLAUDE.md': '# Ctx\n\nsee [the guide](guide.md)\n',
  'guide.md': '# Root guide\n',
  'sub/guide.md': '# Sub guide\n',
};

/** The path queried, chosen so BOTH `CLAUDE.md` files are in the ancestry. */
const QUERIED_AT = 'sub';

const tree = setupClaudeContextTree(TREE);

/**
 * The loaded answer at {@link QUERIED_AT}, refusing anything that is not one.
 *
 * @returns `whatLoadsAt`'s answer
 */
function loadedAnswer(): LoadedContextAnswer {
  const answer = whatLoadsAt(tree.projection(), QUERIED_AT);
  if (answer.kind !== 'answer') throw new Error(`tree query answered ${answer.kind}`);
  return answer;
}

describe('discoverableFrom over a real tree', () => {
  it('attributes a reference to EVERY path that cited it, when two paths share content', () => {
    // 🪤 The defect this suite was written for. `blob_references` is keyed by
    // content key, and both `CLAUDE.md` files hash to the same one. Resolving
    // the reference against a single path drops the other target entirely —
    // `guide.md` disappears and `sub/guide.md` survives (or the reverse,
    // depending on realization order), and the surviving row's `citedBy` names
    // one citer instead of two.
    const answer = loadedAnswer();
    expect(answer.rows.map((row) => row.path).sort(byCodePoint))
      .toEqual(['CLAUDE.md', 'sub/CLAUDE.md']);

    const lens = discoverableFrom(tree.projection(), answer);

    expect(lens.rows.map((row) => row.path)).toEqual(['guide.md', 'sub/guide.md']);
    expect(lens.rows.map((row) => row.citedBy.map((citation) => citation.fromPath))).toEqual([
      ['CLAUDE.md'],
      ['sub/CLAUDE.md'],
    ]);
    // Both targets are realized, so both are vouchable and neither is counted
    // as a gap — a collapse would leave one of these wrong too.
    expect(lens.rows.every((row) => row.reach === 'realized')).toBe(true);
    expect(lens.totals.unrealizedRows).toBe(0);
    expect(lens.totals.discoverableTokens).toBeGreaterThan(0);
  });

  it('keeps the two lenses disjoint and leaves discoverable tokens out of the loaded totals', () => {
    // The two invariants the one-to-many fix must not cost: a target the
    // harness already loads never appears here, and the voluntary cost never
    // leaks into the figures `account` publishes as the session's charge.
    const answer = loadedAnswer();
    const lens = discoverableFrom(tree.projection(), answer);

    const loaded = new Set(answer.rows.map((row) => row.path));
    expect(lens.rows.filter((row) => loaded.has(row.path))).toEqual([]);

    const claudeMdIds = new Set(
      tree.projection().resourceTags.filter((row) => row.tag === 'claude-md').map((row) => row.resourceId),
    );
    expect(Object.keys(account(answer, claudeMdIds).totals)).not.toContain('discoverableTokens');
  });
});
