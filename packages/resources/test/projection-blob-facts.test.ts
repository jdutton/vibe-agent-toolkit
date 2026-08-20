import { describe, expect, it } from 'vitest';

import { type ParseResult, parseMarkdownContent } from '../src/link-parser.js';
import { blobConditionsFor, blobRowFor } from '../src/projection/blob-facts.js';
import { BlobRowSchema } from '../src/schemas/projection-blobs.js';

// Hoisted: sonarjs/no-duplicate-string blocks a literal used 3+ times.
const CONTENT_KEY = `markdown.${'a'.repeat(64)}`;
const MISSING_END_TAG = 'missing-end-tag';

/**
 * A minimal ParseResult. Widen per test rather than restating the whole shape.
 *
 * No `as ParseResult` cast: the five fields below are exactly the required ones
 * (`links`, `headings`, `content`, `sizeBytes`, `estimatedTokenCount`), so this
 * typechecks honestly. A cast here would let a later field addition go unnoticed.
 */
function parseResult(overrides: Partial<ParseResult> = {}): ParseResult {
  return {
    content: '# Title\n',
    sizeBytes: 8,
    links: [],
    headings: [],
    estimatedTokenCount: 2,
    ...overrides,
  };
}

describe('blobRowFor', () => {
  it('takes bytes from the caller, never from content.length', () => {
    // The two diverge on malformed UTF-8 — decoding is many-to-one — which is
    // why ParseFactRow records sizeBytes and decodedLength separately.
    const row = blobRowFor(CONTENT_KEY, 4096, parseResult({ content: 'ab' }));
    expect(row.bytes).toBe(4096);
  });

  it('defaults the three measures to zero when the parse omitted them', () => {
    const row = blobRowFor(CONTENT_KEY, 8, parseResult());
    expect(row.wordCount).toBe(0);
    expect(row.proseCharacters).toBe(0);
    expect(row.codeBlockCharacters).toBe(0);
  });

  it('carries the measures through when the parse supplied them', () => {
    const row = blobRowFor(CONTENT_KEY, 8, parseResult({
      contentMeasures: { wordCount: 3, proseCharacters: 6, codeBlockCharacters: 2 },
    }));
    expect(row.wordCount).toBe(3);
    expect(row.proseCharacters).toBe(6);
    expect(row.codeBlockCharacters).toBe(2);
  });

  it('nulls frontmatter rather than emitting an empty object', () => {
    // Null and {} are different states: no frontmatter block versus an empty one.
    expect(blobRowFor(CONTENT_KEY, 8, parseResult()).frontmatter).toBeNull();
  });

  it('counts every heading in the tree, not just its roots', () => {
    // ParseResult.headings is a TREE (buildHeadingTree), so `.length` is the
    // number of ROOT headings. Parsing for real rather than hand-building the
    // tree is what makes this able to detect the flat-count mistake: the
    // document below has three headings nested under one root, so a `.length`
    // implementation reports 1 and this assertion goes red.
    const parsed = parseMarkdownContent('# Top\n\n## A\n\n### Deep\n', 24);
    expect(parsed.headings).toHaveLength(1);

    const row = blobRowFor(CONTENT_KEY, 24, parsed);
    expect(row.headingCount).toBe(3);
    // One section per heading — this must equal blobSectionsFor(...).length.
    expect(row.sectionCount).toBe(row.headingCount);
  });

  it('produces a row the shipped schema accepts', () => {
    expect(() => BlobRowSchema.parse(blobRowFor(CONTENT_KEY, 8, parseResult()))).not.toThrow();
  });
});

describe('blobConditionsFor', () => {
  it('emits nothing for a clean parse', () => {
    expect(blobConditionsFor(CONTENT_KEY, parseResult())).toEqual([]);
  });

  it('distinguishes an absent list from an empty one by emitting nothing for both', () => {
    // Absent vs empty is a real contract distinction at the ParseResult layer
    // (HTML leaves unresolvedReferences undefined; markdown always populates it).
    // It is NOT a distinction at the condition layer — both mean "no condition" —
    // and that collapse is deliberate and recorded here so it cannot drift silently.
    const absent = blobConditionsFor(CONTENT_KEY, parseResult());
    const empty = blobConditionsFor(CONTENT_KEY, parseResult({ unresolvedReferences: [] }));
    expect(absent).toEqual(empty);
  });

  it('keys every condition to the blob it came from', () => {
    const rows = blobConditionsFor(CONTENT_KEY, parseResult({
      parseErrors: [{ message: MISSING_END_TAG, line: 3 }],
    }));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.blob).toBe(CONTENT_KEY);
    expect(rows[0]?.line).toBe(3);
  });

  it('nulls the line for a diagnostic that carries none', () => {
    // HtmlParseError.line is OPTIONAL, but BlobConditionRow.line is
    // `number | null` — absent must become null, never undefined, or the
    // strict schema rejects the row.
    const rows = blobConditionsFor(CONTENT_KEY, parseResult({
      parseErrors: [{ message: MISSING_END_TAG }],
    }));
    expect(rows[0]?.line).toBeNull();
  });

  it('classifies an unresolved reference apart from an HTML parse error', () => {
    const rows = blobConditionsFor(CONTENT_KEY, parseResult({
      parseErrors: [{ message: MISSING_END_TAG, line: 3 }],
      unresolvedReferences: [{ label: 'nope', line: 7 }],
    }));
    expect(rows.map((row) => row.code)).toEqual(['HTML_PARSE_ERROR', 'UNRESOLVED_REFERENCE']);
    expect(rows.map((row) => row.severity)).toEqual(['warning', 'warning']);
    expect(rows[1]?.message).toBe('nope');
    expect(rows[1]?.line).toBe(7);
  });
});
