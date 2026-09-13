/**
 * The per-document OKF judgements, unit-tested against the parser's own output.
 *
 * `parsed` is built by running the real {@link parseFrontmatterSource} over a real
 * frontmatter body rather than by hand-shaping the object. Hand-shaping is what
 * hid the defect below: the shape `{ frontmatterSource: '- a', frontmatter:
 * undefined, frontmatterError: undefined }` is one nobody would think to write,
 * and it is the shape the parser actually produces for a YAML **sequence**.
 */

import { describe, expect, it } from 'vitest';

import { parseFrontmatterSource } from '../../src/frontmatter-source.js';
import { conceptFindings, indexFindings } from '../../src/okf/findings.js';

/** The document path every finding here must carry — silence has no path. */
const DOC = 'guides/onboarding.md';
const INDEX_DOC = 'index.md';
const NESTED_INDEX_DOC = 'guides/index.md';

/**
 * Exactly what `link-parser.ts` assembles: the raw block, plus whatever
 * `parseFrontmatterSource` made of it.
 *
 * @param source - A frontmatter block's YAML body, delimiters excluded
 * @returns The `parsed` view the findings functions consume
 */
function parsedFrom(source: string) {
  return { frontmatterSource: source, ...parseFrontmatterSource(source) };
}

/**
 * Every top-level YAML shape that is not a mapping.
 *
 * 🔑 The MECHANISM, not the one instance in the report. `parseFrontmatterSource`
 * returns a bare `{}` — no `frontmatter`, no `frontmatterError` — for all four,
 * so all four reach the findings functions looking exactly like a document with
 * no frontmatter keys, which is indistinguishable from a conformant one.
 */
const NON_MAPPING_BLOCKS: ReadonlyArray<readonly [string, string]> = [
  ['a sequence of scalars', '- one\n- two'],
  // The plausible author error: a list of typed entries where a mapping was meant.
  ['a sequence of mappings', '- type: guide\n- type: reference'],
  ['a bare scalar', 'just a title, unquoted and unkeyed'],
  ['a bare number', '42'],
];

/**
 * Blocks that parse to NULL: no keys, and nothing VAT failed to read.
 *
 * 🚨 These used to be reported as NOT_A_MAPPING because the test was on the
 * SOURCE ("non-blank") rather than on the VALUE. A comment-only block is the
 * common shape — `# note: add type later` — and telling its author to "remove the
 * dashes" sends them after a list that is not there. They are the §11.2
 * "carries no keys" case, exactly as an empty block is.
 */
const NULL_BLOCKS: ReadonlyArray<readonly [string, string]> = [
  ['a comment-only block', '# note to self'],
  ['a comment with blank lines around it', '\n# note: add type later\n\n'],
  ['an explicit null', 'null'],
  ['a tilde null', '~'],
];

describe('a frontmatter block that is not a YAML mapping', () => {
  // The premise the rest of this file rests on. If `parseFrontmatterSource` ever
  // starts reporting these as errors, the findings below become unreachable and
  // this assertion is the one that says so.
  it.each(NON_MAPPING_BLOCKS)('%s parses to neither frontmatter nor an error', (_name, source) => {
    const parsed = parsedFrom(source);
    expect(parsed.frontmatter).toBeUndefined();
    expect(parsed.frontmatterError).toBeUndefined();
    expect(parsed.frontmatterSource).toBe(source);
  });

  it.each(NON_MAPPING_BLOCKS)('is reported on a concept document — %s', (_name, source) => {
    const drafts = conceptFindings(DOC, parsedFrom(source));

    expect(drafts.map((d) => d.code)).toEqual(['OKF_FRONTMATTER_NOT_A_MAPPING']);
    expect(drafts[0]?.document).toBe(DOC);
  });

  it.each(NON_MAPPING_BLOCKS)('is reported on the bundle-root index.md — %s', (_name, source) => {
    // 🚨 The finding. VAT read a document, failed to understand its frontmatter,
    // and said NOTHING — the bundle came back clean. Silence about a document the
    // tool could not read is the worst answer available: it is indistinguishable
    // from conformance, and no path is named for anyone to go look at.
    const { drafts } = indexFindings(INDEX_DOC, parsedFrom(source), true);

    expect(drafts.map((d) => d.code)).toEqual(['OKF_FRONTMATTER_NOT_A_MAPPING']);
    expect(drafts[0]?.document).toBe(INDEX_DOC);
  });

  it.each(NON_MAPPING_BLOCKS)('is reported on a nested index.md — %s', (_name, source) => {
    const { drafts } = indexFindings(NESTED_INDEX_DOC, parsedFrom(source), false);

    expect(drafts.map((d) => d.code)).toEqual(['OKF_FRONTMATTER_NOT_A_MAPPING']);
    expect(drafts[0]?.document).toBe(NESTED_INDEX_DOC);
  });

  it('never claims a version was declared, because none could be read', () => {
    // `okf_version` cannot be read out of a sequence, so the report must not
    // carry one — reporting `declaredOkfVersion` here would publish a value the
    // document does not contain.
    const inspection = indexFindings(INDEX_DOC, parsedFrom('- okf_version: "0.2"'), true, '0.2');

    expect(inspection.declaredOkfVersion).toBeUndefined();
  });
});

describe('the blocks that are NOT this finding', () => {
  // The controls. Without these, the assertions above would also pass if the new
  // finding fired on everything.
  it('an EMPTY block is a missing type, not an unreadable block', () => {
    // `---\n---` parses to `{}` by rule, and "no keys" is a true reading of it.
    // A non-mapping block is different: it HAS content that VAT could not use.
    expect(conceptFindings(DOC, parsedFrom('')).map((d) => d.code)).toEqual(['OKF_TYPE_MISSING']);
    expect(indexFindings(INDEX_DOC, parsedFrom(''), true).drafts).toEqual([]);
  });

  it('a WHITESPACE-ONLY block is treated the same as an empty one', () => {
    expect(conceptFindings(DOC, parsedFrom('   \n  ')).map((d) => d.code)).toEqual(['OKF_TYPE_MISSING']);
    expect(indexFindings(INDEX_DOC, parsedFrom('   \n  '), true).drafts).toEqual([]);
  });

  it.each(NULL_BLOCKS)('a block that parses to null is "no keys", not "not a mapping" — %s', (_name, source) => {
    // The premise, stated: the parser itself sees no mapping and no error here,
    // which is the same shape a sequence arrives in. Only the VALUE tells them
    // apart, so the judge must ask for it.
    expect(parsedFrom(source).frontmatter).toBeUndefined();
    expect(parsedFrom(source).frontmatterError).toBeUndefined();

    expect(conceptFindings(DOC, parsedFrom(source)).map((d) => d.code)).toEqual(['OKF_TYPE_MISSING']);
    expect(indexFindings(INDEX_DOC, parsedFrom(source), true).drafts).toEqual([]);
  });

  it('an absent block is still OKF_FRONTMATTER_MISSING', () => {
    expect(conceptFindings(DOC, {}).map((d) => d.code)).toEqual(['OKF_FRONTMATTER_MISSING']);
  });

  it('an unparseable block is still OKF_FRONTMATTER_UNPARSEABLE', () => {
    const parsed = parsedFrom('a: [1,\nb: 2');
    expect(parsed.frontmatterError).toBeDefined();
    expect(conceptFindings(DOC, parsed).map((d) => d.code)).toEqual(['OKF_FRONTMATTER_UNPARSEABLE']);
  });

  it('a real mapping still reaches the type rules', () => {
    expect(conceptFindings(DOC, parsedFrom('type: guide'))).toEqual([]);
    expect(conceptFindings(DOC, parsedFrom('title: T')).map((d) => d.code)).toEqual(['OKF_TYPE_MISSING']);
    expect(conceptFindings(DOC, parsedFrom('type: 3')).map((d) => d.code)).toEqual(['OKF_TYPE_INVALID']);
  });

  it('a real mapping still reaches the index rules', () => {
    const root = indexFindings(INDEX_DOC, parsedFrom('okf_version: "0.2"'), true, '0.2');
    expect(root.drafts).toEqual([]);
    expect(root.declaredOkfVersion).toBe('0.2');

    const nested = indexFindings(NESTED_INDEX_DOC, parsedFrom('okf_version: "0.2"'), false);
    expect(nested.drafts.map((d) => d.code)).toEqual(['OKF_INDEX_FRONTMATTER_NOT_PERMITTED']);
  });
});
