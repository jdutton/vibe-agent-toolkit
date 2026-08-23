import type { TextProvenance } from '@vibe-agent-toolkit/utils/text';
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

/**
 * The decode provenance a clean UTF-8 read produces. Widen per test.
 *
 * A helper rather than a shared constant so a test that mutates it cannot leak
 * into the next one, and typed as `TextProvenance` rather than cast, so a fourth
 * field on the decoder's result surfaces here as a compile error.
 */
function decoding(overrides: Partial<TextProvenance> = {}): TextProvenance {
  return { encoding: 'utf-8', encodingSource: 'assumed', replacementCharacters: 0, ...overrides };
}

describe('blobRowFor', () => {
  it('carries the decode provenance through to the row, unaltered', () => {
    // These three are not derivable from the parse: by the time a ParseResult
    // exists the bytes are a string and the encoding question has been answered
    // and discarded. If they are not copied here they exist nowhere.
    const row = blobRowFor(CONTENT_KEY, 40, decoding({
      encoding: 'utf-16le',
      encodingSource: 'bom',
    }), parseResult());
    expect(row.encoding).toBe('utf-16le');
    expect(row.encodingSource).toBe('bom');
    expect(row.replacementCharacters).toBe(0);
  });

  it('carries a non-zero replacement count, which is the whole signal', () => {
    const row = blobRowFor(CONTENT_KEY, 17, decoding({ replacementCharacters: 5 }), parseResult());
    expect(row.replacementCharacters).toBe(5);
    // Positive control on the absence assertions above: the row is a real row,
    // not an empty object that would satisfy any `toBe(0)`.
    expect(row.contentKey).toBe(CONTENT_KEY);
    expect(row.encodingSource).toBe('assumed');
  });

  it('takes bytes from the caller, never from content.length', () => {
    // The two diverge on malformed UTF-8 — decoding is many-to-one — which is
    // why ParseFactRow records sizeBytes and decodedLength separately.
    const row = blobRowFor(CONTENT_KEY, 4096, decoding(), parseResult({ content: 'ab' }));
    expect(row.bytes).toBe(4096);
  });

  it('defaults the three measures to zero when the parse omitted them', () => {
    const row = blobRowFor(CONTENT_KEY, 8, decoding(), parseResult());
    expect(row.wordCount).toBe(0);
    expect(row.proseCodeUnits).toBe(0);
    expect(row.codeBlockCodeUnits).toBe(0);
  });

  it('carries the measures through when the parse supplied them', () => {
    const row = blobRowFor(CONTENT_KEY, 8, decoding(), parseResult({
      contentMeasures: { wordCount: 3, proseCodeUnits: 6, codeBlockCodeUnits: 2 },
    }));
    expect(row.wordCount).toBe(3);
    expect(row.proseCodeUnits).toBe(6);
    expect(row.codeBlockCodeUnits).toBe(2);
  });

  it('nulls frontmatter rather than emitting an empty object', () => {
    // Null and {} are different states: no frontmatter block versus an empty one.
    expect(blobRowFor(CONTENT_KEY, 8, decoding(), parseResult()).frontmatter).toBeNull();
  });

  it('counts every heading in the tree, not just its roots', () => {
    // ParseResult.headings is a TREE (buildHeadingTree), so `.length` is the
    // number of ROOT headings. Parsing for real rather than hand-building the
    // tree is what makes this able to detect the flat-count mistake: the
    // document below has three headings nested under one root, so a `.length`
    // implementation reports 1 and this assertion goes red.
    const parsed = parseMarkdownContent('# Top\n\n## A\n\n### Deep\n', 24);
    expect(parsed.headings).toHaveLength(1);

    const row = blobRowFor(CONTENT_KEY, 24, decoding(), parsed);
    expect(row.headingCount).toBe(3);
    // One section per heading — this must equal blobSectionsFor(...).length.
    expect(row.sectionCount).toBe(row.headingCount);
  });

  it('produces a row the shipped schema accepts', () => {
    expect(() => BlobRowSchema.parse(blobRowFor(CONTENT_KEY, 8, decoding(), parseResult()))).not.toThrow();
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
