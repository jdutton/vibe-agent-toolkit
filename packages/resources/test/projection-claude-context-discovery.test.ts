/**
 * `discoverableFrom` — the complement of `whatLoadsAt`.
 *
 * Every fixture goes through {@link claudeContextFixture}, which runs the
 * SHIPPED lexer and parser, so `syntacticForm`, `inCodeSpan` and `inFence` are
 * whatever the real producers compute. A hand-written `{rawRef, syntacticForm}`
 * pair is precisely the shape that once left the `@`-following path green while
 * never resolving a real token, and this lens keys on three such columns.
 */

import { describe, expect, it } from 'vitest';

import { discoverableFrom } from '../src/projection/claude-context-discovery.js';
import { whatLoadsAt, type LoadedContextAnswer } from '../src/projection/claude-context-query.js';

import {
  claudeContextFixture,
  type ClaudeContextFixtureOptions,
} from './helpers/claude-context-fixture.js';

/** The root instruction file every fixture loads. */
const ROOT_CLAUDE_MD = 'CLAUDE.md';

/** A doc the root links to but never imports — the canonical discoverable. */
const GUIDE = 'docs/guide.md';

/** A second doc, for ordering and multi-citation cases. */
const OTHER = 'docs/other.md';

/**
 * The answer and its complement for one tree, queried at the root.
 *
 * ⚠️ `whatLoadsAt`'s answer is threaded through rather than recomputed inside
 * the helper, because the lens takes it as its authority for the loaded set —
 * the two reading one answer is the property the disjointness rule rests on.
 *
 * @param files - Root-relative path → markdown source
 * @param at - The path to query, defaulting to the corpus root
 * @param options - Passed through to the fixture, for the `deferred` case
 * @returns The loaded answer and the discoverable set derived from it
 */
async function lensAt(
  files: Record<string, string>,
  at = '',
  options: ClaudeContextFixtureOptions = {},
) {
  const projection = await claudeContextFixture(files, options);
  const answer = whatLoadsAt(projection, at);
  if (answer.kind !== 'answer') throw new Error(`fixture query answered ${answer.kind} at "${at}"`);
  return { answer: answer as LoadedContextAnswer, lens: discoverableFrom(projection, answer) };
}

/** The discoverable paths, in the order the lens returned them. */
function pathsOf(lens: { rows: readonly { path: string }[] }): string[] {
  return lens.rows.map((row) => row.path);
}

describe('discoverableFrom', () => {
  it('reports a doc the loaded CLAUDE.md LINKS to, naming where the link is', async () => {
    const { lens } = await lensAt({
      [ROOT_CLAUDE_MD]: `read the [guide](${GUIDE}) first\n`,
      [GUIDE]: 'guidance\n',
    });

    expect(lens.rows).toEqual([
      {
        path: GUIDE,
        resourceId: expect.any(String) as unknown as string,
        tokens: expect.any(Number) as unknown as number,
        bytes: expect.any(Number) as unknown as number,
        reach: 'realized',
        citedBy: [{ fromPath: ROOT_CLAUDE_MD, line: 1, text: 'guide' }],
      },
    ]);
  });

  it('EXCLUDES a target the harness already loads, so the two lenses partition', async () => {
    // ⛔ The disjointness rule, and the case that makes it matter: the same file
    // is both @-imported (so `whatLoadsAt` charges it) and linked in prose. It
    // must appear in exactly ONE answer. Counted in both, a reader adding the
    // two totals would double-charge it; counted in neither, it would vanish.
    const { answer, lens } = await lensAt({
      [ROOT_CLAUDE_MD]: `@${GUIDE}\n\nalso see [the guide](${GUIDE})\n`,
      [GUIDE]: 'guidance\n',
    });

    expect(answer.rows.map((row) => row.path)).toContain(GUIDE);
    expect(pathsOf(lens)).toEqual([]);
  });

  it('never reports a link authored inside a file NOTHING loads', async () => {
    // The one-hop bound, asserted as an absence. `docs/guide.md` is discoverable
    // and links onward to `docs/other.md`; a transitive walk would return both.
    // Only the first hop is the answer, because the second is reachable from a
    // file that is itself only reachable — which in a cross-linked corpus is the
    // whole tree, the same constant this lane removed from the rule classifier.
    const { lens } = await lensAt({
      [ROOT_CLAUDE_MD]: `see [guide](${GUIDE})\n`,
      [GUIDE]: `onward to [other](other.md)\n`,
      [OTHER]: 'other\n',
    });

    expect(pathsOf(lens)).toEqual([GUIDE]);
  });

  it('drops a link in a fence, in a code span, and a bare path in prose — all as bare-token', async () => {
    // 🪤 This test was VACUOUS in a first draft, and a mutation audit is what
    // caught it. The module guarded `inCodeSpan || inFence` and deleting that
    // guard broke nothing, because remark emits no link node inside code: the
    // fenced and spanned forms never become `markdown-link` at all. What they
    // become is a LEXER row, `bare-token`, carrying a mangled `rawRef` — see the
    // assertion below, which pins the actual mechanism rather than the guard
    // that appeared to be doing the work. The bare prose path is here for the
    // same rule: a mention is not an authored destination.
    const files = {
      [ROOT_CLAUDE_MD]:
        `a real [guide](${GUIDE})\n\nan inline \`[x](${OTHER})\` sample\n\n`
        + `\`\`\`md\n[y](${OTHER})\n\`\`\`\n\nbare ${OTHER} in prose\n`,
      [GUIDE]: 'guidance\n',
      [OTHER]: 'other\n',
    };
    const projection = await claudeContextFixture(files);
    const { lens } = await lensAt(files);

    expect(pathsOf(lens)).toEqual([GUIDE]);
    // The mechanism, asserted directly: exactly ONE row is a followed form, and
    // the three excluded ones are `bare-token`. If the lexer ever started
    // emitting `markdown-link` inside code, this fails HERE — which is the
    // notice the deleted guard was pretending to give.
    const forms = projection.blobReferences
      .filter((row) => row.rawRef.includes('other.md') || row.rawRef.includes('guide.md'))
      .map((row) => row.syntacticForm);
    expect(forms.filter((form) => form === 'markdown-link')).toHaveLength(1);
    expect(forms.filter((form) => form === 'bare-token')).toHaveLength(3);
  });

  it('drops a scheme-qualified reference rather than resolving it as a filename', async () => {
    // ⛔ `mailto:` is the case a `://` test misses. Handed to an RFC 3986 path
    // resolver it produces a plausible relative filename, which would then be
    // reported as an unrealized document — a fabricated broken link. The https
    // form is the negative control: if the guard were removed entirely, both
    // would appear, so a fixture with only one cannot tell the rules apart.
    const { lens } = await lensAt({
      [ROOT_CLAUDE_MD]:
        `[site](https://example.com/docs.md) and [mail](mailto:someone@example.com)`
        + ` and a real [guide](${GUIDE})\n`,
      [GUIDE]: 'guidance\n',
    });

    expect(pathsOf(lens)).toEqual([GUIDE]);
    expect(lens.totals.unrealizedRows).toBe(0);
  });

  it('reports a link to a path this projection does not realize as unrealized, never as broken', async () => {
    // ⛔ An absence, not a verdict. The row exists so the reader can see the
    // pointer; the reach says VAT cannot vouch for it; and no token is summed,
    // because a file nothing realized has no measured size.
    const { lens } = await lensAt({
      [ROOT_CLAUDE_MD]: 'see [gone](docs/gone.md)\n',
    });

    expect(lens.rows[0]).toMatchObject({
      path: 'docs/gone.md',
      resourceId: null,
      tokens: null,
      reach: 'unrealized',
    });
    expect(lens.totals.discoverableTokens).toBe(0);
    expect(lens.totals.unrealizedRows).toBe(1);
  });

  it('reports a link that climbs OUT of the corpus as outside-root, keeping the raw reference', async () => {
    // 🪤 `resolveLocalHref` cannot refuse this one: a RELATIVE reference has no
    // root to escape from, so it resolves happily to a path above the corpus.
    // The containment decision belongs to the caller that holds the root. The
    // raw reference is kept because there is no root-relative form to give, and
    // inventing one would name a path that does not exist.
    const { lens } = await lensAt({
      [ROOT_CLAUDE_MD]: 'see [outside](../elsewhere/notes.md)\n',
    });

    expect(lens.rows[0]).toMatchObject({
      path: '../elsewhere/notes.md',
      resourceId: null,
      reach: 'outside-root',
    });
    expect(lens.totals.outsideRootRows).toBe(1);
    expect(lens.totals.unrealizedRows).toBe(0);
  });

  it('collapses one target cited twice into ONE row carrying both citations', async () => {
    // Discoverability asks whether a target is FINDABLE, not how often it is
    // mentioned, so the row is per target. The citations are kept because they
    // are what makes the row checkable — and ordered, so two runs are diffable.
    const { lens } = await lensAt({
      [ROOT_CLAUDE_MD]: `[a](${GUIDE})\n\nand again [b](${GUIDE})\n`,
      [GUIDE]: 'guidance\n',
    });

    expect(lens.rows).toHaveLength(1);
    expect(lens.rows[0]?.citedBy).toEqual([
      { fromPath: ROOT_CLAUDE_MD, line: 1, text: 'a' },
      { fromPath: ROOT_CLAUDE_MD, line: 3, text: 'b' },
    ]);
  });

  it('orders citations from DIFFERENT files by path, not by whatever order blobs iterate in', async () => {
    // ⚠️ The single-file case above cannot prove the sort: within one blob,
    // encounter order already IS line order, so removing the comparator passes.
    // Across files it cannot — `blobReferences` is keyed by CONTENT HASH, so
    // iteration order is effectively arbitrary and would differ the moment a
    // byte of either file changed. `.claude/rules/style.md` sorts BEFORE
    // `CLAUDE.md` by code point ('.' < 'C'), which is the opposite of the order
    // the fixture declares them in — so an unsorted implementation has to get
    // lucky twice to pass this.
    //
    // ⚠️ The rule's href is `../../docs/guide.md`, not `docs/guide.md`, and the
    // difference is not cosmetic: a relative reference resolves against the
    // SOURCE FILE's directory, so the short form from `.claude/rules/` names
    // `.claude/rules/docs/guide.md` — a path that does not exist. A first draft
    // wrote the short form and got one citation instead of two, which looked
    // like a sorting bug and was a fixture that had misspelt the link.
    const rule = '.claude/rules/style.md';
    const { lens } = await lensAt({
      [ROOT_CLAUDE_MD]: `from the root: [r](${GUIDE})\n`,
      [rule]: `from a rule: [s](../../${GUIDE})\n`,
      [GUIDE]: 'guidance\n',
    });

    expect(lens.rows[0]?.citedBy.map((citation) => citation.fromPath))
      .toEqual([rule, ROOT_CLAUDE_MD]);
  });

  it('sums only what it can vouch for, and orders rows by code point', async () => {
    // The totals partition: every row lands in exactly one bucket, so a reader
    // can add the counts back to the row total and find nothing missing.
    const { lens } = await lensAt({
      [ROOT_CLAUDE_MD]:
        `[o](${OTHER}) [g](${GUIDE}) [x](docs/gone.md) [e](../out.md)\n`,
      [GUIDE]: 'guidance\n',
      [OTHER]: 'other\n',
    });

    // ⚠️ `docs/gone.md` before `docs/guide.md` — `go` < `gu` by code point, and
    // the ordering is asserted in the order the comparator really produces
    // rather than the order the fixture happens to list. An expectation written
    // to the authoring order passed only by accident and hid the comparator.
    expect(pathsOf(lens)).toEqual(['../out.md', 'docs/gone.md', GUIDE, OTHER]);
    expect(lens.totals.discoverableTokens).toBeGreaterThan(0);
    expect(lens.totals.unrealizedRows).toBe(1);
    expect(lens.totals.outsideRootRows).toBe(1);
    expect(lens.rows).toHaveLength(
      lens.totals.unrealizedRows + lens.totals.outsideRootRows
      + lens.rows.filter((row) => row.reach === 'realized').length,
    );
  });

  it('follows a reference DEFINITION once, not each use of its label', async () => {
    // `[text][ref]` carries a LABEL in `rawRef`, not a path — resolving it would
    // treat `ref` as a filename. The URL lives on the definition, which is
    // followed, so three uses of one definition yield one row and no row named
    // after the label.
    const { lens } = await lensAt({
      [ROOT_CLAUDE_MD]: `[one][g] [two][g] [three][g]\n\n[g]: ${GUIDE}\n`,
      [GUIDE]: 'guidance\n',
    });

    expect(pathsOf(lens)).toEqual([GUIDE]);
    expect(lens.rows[0]?.citedBy).toHaveLength(1);
  });

  it('COUNTS a realized target with no measured blob instead of summing it as zero', async () => {
    // ⛔ The `unknownTokenRows` counter, and it too was untested until a mutation
    // audit: every ordinary fixture file carries a blob, so `tokens ?? 0` passed
    // everywhere. A `deferred` realization is the real shape of the gap — the
    // file is enumerated, its content never read, so `contentKey` is null and
    // its size is UNKNOWN rather than zero. Summing it as zero would let a
    // reader take the total for complete, which is the one reading every
    // counter in this lane exists to prevent.
    const { lens } = await lensAt({
      [ROOT_CLAUDE_MD]: `see [guide](${GUIDE})\n`,
      [GUIDE]: 'guidance\n',
    }, '', { deferred: [GUIDE] });

    expect(lens.rows[0]).toMatchObject({ path: GUIDE, tokens: null, reach: 'realized' });
    expect(lens.totals.unknownTokenRows).toBe(1);
    expect(lens.totals.discoverableTokens).toBe(0);
  });

  it('resolves a SHARED blob from every citing path, not from the last one keyed', async () => {
    // 🪤 The defect this case exists for, and the reason it could not be written
    // until the fixture stopped keying blobs by path. `blob_references` is keyed
    // by CONTENT (`content-key.ts`: "two copies of the same document in
    // different trees share a key"), so two byte-identical `CLAUDE.md` files
    // share ONE set of reference rows. A `contentKey → path` map is therefore
    // many-to-one, and the collapse is not a mislabelling: a relative href
    // resolves against the SOURCE FILE's directory, so `guide.md` names a
    // DIFFERENT target from each citer. Attributing the rows to one path made
    // `guide.md` vanish from the answer entirely.
    //
    // ⚠️ The two files must be byte-identical for this to bite — change one
    // character of either and the keys diverge, the bug cannot occur, and the
    // test passes against the broken code.
    const shared = 'see [the guide](guide.md)\n';
    const { lens } = await lensAt({
      [ROOT_CLAUDE_MD]: shared,
      'sub/CLAUDE.md': shared,
      'guide.md': '# root guide\n',
      'sub/guide.md': '# sub guide\n',
    }, 'sub');

    expect(pathsOf(lens)).toEqual(['guide.md', 'sub/guide.md']);
    expect(lens.rows.map((row) => row.citedBy.map((citation) => citation.fromPath))).toEqual([
      [ROOT_CLAUDE_MD],
      ['sub/CLAUDE.md'],
    ]);
  });

  it('never attributes a shared blob to a path NOTHING loads, even though it shares the bytes', async () => {
    // The guard against over-correcting the case above. One-to-many must widen
    // the map only across LOADED paths: `a/CLAUDE.md` carries the same bytes as
    // the queried `b/CLAUDE.md` and so is filed under the same content key, but
    // it is not in this query's ancestry and the harness never loads it. Citing
    // it here would invent a reference from a file that is not in context, and
    // would manufacture `a/guide.md` as a target nothing points at.
    const shared = 'see [the guide](guide.md)\n';
    const { lens } = await lensAt({
      'a/CLAUDE.md': shared,
      'a/guide.md': '# a guide\n',
      'b/CLAUDE.md': shared,
      'b/guide.md': '# b guide\n',
    }, 'b');

    expect(pathsOf(lens)).toEqual(['b/guide.md']);
    expect(lens.rows[0]?.citedBy.map((citation) => citation.fromPath)).toEqual(['b/CLAUDE.md']);
  });

  it('refuses a projection with no root rather than answering nothing is discoverable', async () => {
    // ⛔ The same confident-zero refusal `whatLoadsAt` makes. An empty answer
    // for a tree nobody looked at is indistinguishable from a tree that links
    // nowhere, and this lens's whole output is a set of links.
    const projection = await claudeContextFixture({ [ROOT_CLAUDE_MD]: 'x\n' });
    const answer = whatLoadsAt(projection, '');
    if (answer.kind !== 'answer') throw new Error('fixture did not answer');

    expect(() => discoverableFrom({ ...projection, roots: [] }, answer))
      .toThrow(/projection with no root/);
  });
});
