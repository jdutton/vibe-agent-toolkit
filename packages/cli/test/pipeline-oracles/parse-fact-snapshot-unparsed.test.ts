/**
 * A row that says `none` must not carry a parse.
 *
 * `parserKindForPath` answers `none` for every type that is neither prose nor
 * markup, and the registry honours that by branching on `isParsableContent`.
 * This oracle branched on `parserKind === 'html'` instead, so `none` fell into
 * the ELSE arm and was handed to `remark-parse` — and the row was then STAMPED
 * `parserKind: 'none'` while carrying remark's `links` and `headings`. The
 * artifact said the file was not parsed while showing parse output, which is
 * the one thing a snapshot used as a cache oracle may never do: the same key
 * would be filed with facts no lane that respects the discriminator can
 * reproduce.
 *
 * ## Why this is field-reachable and not a fixture curiosity
 *
 * The `resources` lane honours `config?.resources?.include`, and
 * `qa-snapshot capture` runs every lane over a real tree — so any adopter whose
 * include admits a non-prose type produced these lying rows. The shipped golden
 * cannot see it: all of its entries are md/html/htm, because the trap corpus
 * ships no VAT config and nothing there can type to `none`.
 *
 * ## Why a markdown control sits beside every `none` assertion
 *
 * Emptiness is the assertion, so a `parseOrNull` that had simply DIED — returned
 * `null`, or empty facts for everything — would satisfy the `none` half exactly.
 * The `.md` twin carries the same link and the same heading through the real
 * parser, so the suite distinguishes "the discriminator is honoured" from "the
 * parser stopped running".
 *
 * ⚠️ The two fixtures are deliberately NOT byte-identical. Blobs are
 * content-addressed and the parser kind is the only path-derived input to the
 * key, so identical bytes under a `.md` and a `.ts` name would be two DIFFERENT
 * keys today — but a regression that routes `.ts` back to markdown collapses
 * them into ONE row, and the suite would then be asserting about whichever path
 * happened to arrive first.
 */

import { describe, expect, it } from 'vitest';

import { captureParseFactSnapshot } from '../../src/pipeline-oracles/parse-fact-snapshot.js';
import type { ParseFactRow } from '../../src/pipeline-oracles/types.js';

import { setupCorpusFixture } from './helpers/corpus-fixture.js';

/**
 * One markdown document and one TypeScript one, carrying the SAME two
 * constructs — an inline link and an ATX-shaped line — by different routes.
 *
 * The `.ts` body puts its link inside a string literal, which is the shape the
 * audit found in the field: CommonMark makes a `.ts` body one lazy-continued
 * paragraph, so the code-fence protection never fires there and `[notreally]
 * (alink)` becomes a real reference row.
 */
const CORPUS = {
  'notes.md': '# Notes\n\nSee [notreally](alink) for the rest.\n',
  'strings.ts': '// # Heading-shaped comment\nexport const s = "[notreally](alink)";\n',
};

const fixture = setupCorpusFixture('vat-parse-fact-unparsed-', CORPUS);

/**
 * Capture the fixture corpus and index its rows by parser kind.
 *
 * Indexing by KIND rather than by path is what makes the assertions readable
 * against a content-keyed snapshot, which has no path column at all.
 *
 * @returns The row for each kind present, and the whole snapshot
 */
async function captureByKind(): Promise<{
  rows: readonly ParseFactRow[];
  byKind: Map<string, ParseFactRow>;
}> {
  const snapshot = await captureParseFactSnapshot(fixture.absolutePaths(), {
    corpusRoot: fixture.root(),
    corpus: 'unparsed-fixture',
  });
  return { rows: snapshot.rows, byKind: new Map(snapshot.rows.map((row) => [row.parserKind, row])) };
}

describe('a document no parser routes to', () => {
  it('is captured as a row, not skipped', async () => {
    const { rows, byKind } = await captureByKind();

    // The non-vacuity floor for everything below: both documents produced a
    // row, so an empty `links` on the `none` row is a parse that did not
    // happen rather than a document the capture never reached.
    expect(rows).toHaveLength(Object.keys(CORPUS).length);
    expect([...byKind.keys()].toSorted((a, b) => a.localeCompare(b))).toStrictEqual([
      'markdown',
      'none',
    ]);
  });

  it('carries the token estimate and byte size the bytes alone determine', async () => {
    const { byKind } = await captureByKind();
    const none = byKind.get('none');

    // The positive control for the emptiness assertions in the next test. A
    // `none` row is NOT the binary-refusal shape: it reports what the bytes
    // say, so `tokens: null` never reaches context accounting. Asserting the
    // exact byte length rather than `> 0` also pins that the row describes THIS
    // document and not some other arrival under a collapsed key.
    expect(none?.sizeBytes).toBe(Buffer.byteLength(CORPUS['strings.ts'], 'utf8'));
    expect(none?.estimatedTokenCount).toBeGreaterThan(0);
    expect(none?.decodedLength).toBe(CORPUS['strings.ts'].length);
  });

  it('carries no links and no headings, while its markdown twin carries both', async () => {
    const { byKind } = await captureByKind();

    // THE DEFECT. Under the else-branch the `none` row held remark's output —
    // one `markdown-link` to `alink` from inside a string literal, and one
    // heading from a `//` comment.
    expect(byKind.get('none')?.links).toStrictEqual([]);
    expect(byKind.get('none')?.headings).toStrictEqual([]);

    // The discriminator. Same link, same heading, in a document the parser DOES
    // route to — so the two empties above cannot be a parser that died.
    expect(byKind.get('markdown')?.links).toHaveLength(1);
    expect(byKind.get('markdown')?.headings).toHaveLength(1);
  });

  it('records the optional arrays as absent rather than empty', async () => {
    const { byKind } = await captureByKind();
    const states = new Map(
      (byKind.get('none')?.optionalArrays ?? []).map((fact) => [fact.field, fact.state]),
    );

    // `absent` and `empty` are different observations everywhere else in this
    // snapshot, and they must stay different here: the registry's unparsed
    // shape deliberately OMITS these keys rather than supplying `[]`, because
    // it computes neither a lexer scan nor content measures for a resource
    // whose metadata has nowhere to put them.
    expect(states.get('lexicalReferences')).toBe('absent');
    expect(states.get('anchors')).toBe('absent');
    expect(states.get('parseErrors')).toBe('absent');
    expect(states.get('unresolvedReferences')).toBe('absent');
    expect(byKind.get('none')?.contentMeasures).toBeNull();
  });
});
