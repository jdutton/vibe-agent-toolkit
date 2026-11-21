import { describe, expect, it } from 'vitest';

import { encodeFrontmatterValue } from '../src/frontmatter-codec.js';
import {
  BlobConditionRowSchema,
  BlobReferenceRowSchema,
  BlobRowSchema,
  BlobSectionRowSchema,
} from '../src/schemas/projection-blobs.js';

const VALID_KEY = 'markdown.' + '0'.repeat(64);

describe('BlobRowSchema', () => {
  const minimalBlob = {
    contentKey: VALID_KEY,
    bytes: 10,
    encoding: 'utf-8',
    encodingSource: 'assumed',
    replacementCharacters: 0,
    tokenEstimate: 2,
    frontmatter: null,
    frontmatterValue: null,
    frontmatterError: null,
    frontmatterNotAMapping: false,
    anchors: [],
    wordCount: 1,
    proseCodeUnits: 10,
    codeBlockCodeUnits: 0,
    linkCount: 0,
    headingCount: 0,
    sectionCount: 0,
    findingCount: 0,
  };

  it('accepts a fully-populated row', () => {
    const row = {
      contentKey: VALID_KEY,
      bytes: 1024,
      encoding: 'utf-16be',
      encodingSource: 'bom',
      replacementCharacters: 3,
      tokenEstimate: 256,
      frontmatter: { status: 'accepted', sources: ['a.md', 'b.md'] },
      frontmatterValue: encodeFrontmatterValue({ status: 'accepted', sources: ['a.md', 'b.md'] }),
      frontmatterError: null,
      frontmatterNotAMapping: false,
      anchors: ['intro', 'usage'],
      wordCount: 150,
      proseCodeUnits: 900,
      codeBlockCodeUnits: 124,
      linkCount: 3,
      headingCount: 2,
      sectionCount: 2,
      findingCount: 0,
    };
    expect(BlobRowSchema.safeParse(row).success).toBe(true);
  });

  it('accepts a blob with no frontmatter block', () => {
    expect(BlobRowSchema.safeParse(minimalBlob).success).toBe(true);
  });

  it('requires the exact-frontmatter, not-a-mapping and anchor columns', () => {
    for (const missing of ['frontmatterValue', 'frontmatterNotAMapping', 'anchors']) {
      const row: Record<string, unknown> = { ...minimalBlob };
      delete row[missing];
      expect(BlobRowSchema.safeParse(row).success, missing).toBe(false);
    }
  });

  it('accepts a block that is valid YAML but not a mapping: no error, the flag set', () => {
    expect(BlobRowSchema.safeParse({ ...minimalBlob, frontmatterNotAMapping: true }).success).toBe(true);
  });

  it('rejects an unknown field', () => {
    const row = { ...minimalBlob, unexpectedField: 'nope' };
    expect(BlobRowSchema.safeParse(row).success).toBe(false);
  });

  it('rejects a malformed content key', () => {
    const row = { ...minimalBlob, contentKey: 'not-a-key' };
    expect(BlobRowSchema.safeParse(row).success).toBe(false);
  });
});

describe('BlobReferenceRowSchema', () => {
  const markdownLink = {
    blob: VALID_KEY,
    ordinal: 0,
    rawRef: './other.md',
    text: 'Other',
    line: 12,
    column: null,
    startOffset: 240,
    endOffset: 258,
    astIndex: 0,
    syntacticForm: 'markdown-link',
    hasExtension: true,
    leadingAt: false,
    slashCount: 1,
    variableExpansion: null,
    inCodeSpan: false,
    inFence: false,
  };

  it('accepts a markdown link with no column (AST-derived)', () => {
    expect(BlobReferenceRowSchema.safeParse(markdownLink).success).toBe(true);
  });

  it('requires every position column and astIndex to be present, never omitted', () => {
    // A column may be null (the parser supplied no position) but never absent:
    // an omitted column is a producer that forgot it, and the row would read
    // the same as one the parser could not place.
    for (const missing of ['line', 'startOffset', 'endOffset', 'astIndex']) {
      const row: Record<string, unknown> = { ...markdownLink };
      delete row[missing];
      expect(BlobReferenceRowSchema.safeParse(row).success, missing).toBe(false);
    }
  });

  it('accepts an AST-derived link the parser gave no position, kept with null position columns', () => {
    // A GFM autolink literal glued to text arrives with no position. It is still
    // a link the resource carries, so it is a row rather than a skip.
    const row = { ...markdownLink, line: null, startOffset: null, endOffset: null };
    expect(BlobReferenceRowSchema.safeParse(row).success).toBe(true);
  });

  it('accepts an @-prefixed token with a column (lexer-derived)', () => {
    const row = {
      ...markdownLink,
      ordinal: 1,
      rawRef: '@README.md',
      text: null,
      column: 1,
      astIndex: null,
      syntacticForm: 'at-prefixed',
      leadingAt: true,
      slashCount: 0,
    };
    expect(BlobReferenceRowSchema.safeParse(row).success).toBe(true);
  });

  it('accepts an @-prefixed token inside a fence — the fact the lens needs to NOT treat it as an import', () => {
    const row = { ...markdownLink, rawRef: '@docs/x.md', syntacticForm: 'at-prefixed', leadingAt: true, inFence: true };
    expect(BlobReferenceRowSchema.safeParse(row).success).toBe(true);
  });

  it('accepts each variable-expansion syntax', () => {
    for (const syntax of ['brace', 'bare', 'percent', 'powershell']) {
      const row = { ...markdownLink, syntacticForm: 'env-anchored', variableExpansion: syntax };
      expect(BlobReferenceRowSchema.safeParse(row).success).toBe(true);
    }
  });

  it('accepts a bare path-shaped token', () => {
    const row = {
      ...markdownLink,
      rawRef: 'packages/utils/src/index.ts',
      text: null,
      column: 34,
      syntacticForm: 'bare-token',
      slashCount: 3,
    };
    expect(BlobReferenceRowSchema.safeParse(row).success).toBe(true);
  });

  it('rejects a syntactic form outside the six', () => {
    expect(BlobReferenceRowSchema.safeParse({ ...markdownLink, syntacticForm: 'wikilink' }).success).toBe(false);
  });

  it('rejects a nodeType column — syntacticForm subsumes it', () => {
    expect(BlobReferenceRowSchema.safeParse({ ...markdownLink, nodeType: 'link' }).success).toBe(false);
  });

  it('rejects a resolved target — resolution is a lens question, never a blob fact', () => {
    expect(BlobReferenceRowSchema.safeParse({ ...markdownLink, dstResource: 'r-other' }).success).toBe(false);
  });
});

describe('BlobSectionRowSchema', () => {
  const topLevelSection = {
    blob: VALID_KEY,
    ordinal: 0,
    depth: 1,
    title: 'Overview',
    slug: 'overview',
    slugOccurrence: 0,
    parentOrdinal: null,
    lineStart: 1,
    lineEnd: 20,
    bytes: 400,
    tokens: 90,
  };

  it('accepts a top-level heading with no parent', () => {
    expect(BlobSectionRowSchema.safeParse(topLevelSection).success).toBe(true);
  });

  it('accepts a heading the parser gave no position, kept with all four span columns null', () => {
    const row = { ...topLevelSection, lineStart: null, lineEnd: null, bytes: null, tokens: null };
    expect(BlobSectionRowSchema.safeParse(row).success).toBe(true);
  });

  it('rejects a `characters` column, which the table deliberately does not carry', () => {
    // `bytes` is a real UTF-8 byte count and is the ONLY size column here. A
    // code-point column was added and then dropped: it cost an O(n) spread per
    // section to report a unit nothing indexes in, while `bytes` already
    // answers "how big is this" honestly. `.strict()` is what makes the removal
    // enforced rather than merely current, so this pins it.
    expect(BlobSectionRowSchema.safeParse({ ...topLevelSection, characters: 380 }).success).toBe(false);
  });

  it('accepts the second occurrence of a repeated heading, disambiguated by slugOccurrence', () => {
    const row = {
      blob: VALID_KEY,
      ordinal: 5,
      depth: 2,
      title: 'Patch Changes',
      slug: 'patch-changes',
      slugOccurrence: 3,
      parentOrdinal: 0,
      lineStart: 40,
      lineEnd: 55,
      bytes: 300,
      tokens: 60,
    };
    expect(BlobSectionRowSchema.safeParse(row).success).toBe(true);
  });

  it('rejects a depth outside 1-6', () => {
    const row = {
      blob: VALID_KEY,
      ordinal: 0,
      depth: 7,
      title: 'Too deep',
      slug: 'too-deep',
      slugOccurrence: 0,
      parentOrdinal: null,
      lineStart: 1,
      lineEnd: 2,
      bytes: 10,
      tokens: 2,
    };
    expect(BlobSectionRowSchema.safeParse(row).success).toBe(false);
  });
});

describe('BlobConditionRowSchema', () => {
  it('accepts the PARSE_ODDITY escape hatch', () => {
    const row = {
      blob: VALID_KEY,
      code: 'PARSE_ODDITY',
      ordinal: 0,
      severity: 'warning',
      message: 'unrecognized YAML anchor reuse',
      line: 4,
    };
    expect(BlobConditionRowSchema.safeParse(row).success).toBe(true);
  });

  it('accepts a condition with no line number', () => {
    const row = {
      blob: VALID_KEY,
      code: 'FRONTMATTER_PARSE_ERROR',
      ordinal: 2,
      severity: 'error',
      message: 'YAML syntax error',
      line: null,
    };
    expect(BlobConditionRowSchema.safeParse(row).success).toBe(true);
  });

  it('requires the per-code ordinal', () => {
    const row = { blob: VALID_KEY, code: 'PARSE_ODDITY', severity: 'warning', message: 'x', line: null };
    expect(BlobConditionRowSchema.safeParse(row).success).toBe(false);
  });

  it('rejects an invalid severity', () => {
    const row = {
      blob: VALID_KEY,
      code: 'PARSE_ODDITY',
      ordinal: 0,
      severity: 'critical',
      message: 'x',
      line: null,
    };
    expect(BlobConditionRowSchema.safeParse(row).success).toBe(false);
  });
});
