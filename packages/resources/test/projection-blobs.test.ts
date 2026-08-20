import { describe, expect, it } from 'vitest';

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
    tokenEstimate: 2,
    frontmatter: null,
    frontmatterError: null,
    wordCount: 1,
    proseCharacters: 10,
    codeBlockCharacters: 0,
    linkCount: 0,
    headingCount: 0,
    sectionCount: 0,
  };

  it('accepts a fully-populated row', () => {
    const row = {
      contentKey: VALID_KEY,
      bytes: 1024,
      tokenEstimate: 256,
      frontmatter: { status: 'accepted', sources: ['a.md', 'b.md'] },
      frontmatterError: null,
      wordCount: 150,
      proseCharacters: 900,
      codeBlockCharacters: 124,
      linkCount: 3,
      headingCount: 2,
      sectionCount: 2,
    };
    expect(BlobRowSchema.safeParse(row).success).toBe(true);
  });

  it('accepts a blob with no frontmatter block', () => {
    expect(BlobRowSchema.safeParse(minimalBlob).success).toBe(true);
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

  it('requires the span, so no row can be admitted that a rewriter cannot locate', () => {
    // `column` is null for every AST-derived link, so the span is the ONLY
    // column that can place a reference precisely — a nullable one would leave
    // exactly the population a rewriter cares about unlocatable, which is the
    // state this column pair was added to end. A candidate with no span is
    // skipped by `blobReferencesFor` and counted, never admitted with a hole.
    for (const missing of ['startOffset', 'endOffset']) {
      const row: Record<string, unknown> = { ...markdownLink };
      delete row[missing];
      expect(BlobReferenceRowSchema.safeParse(row).success).toBe(false);
    }
  });

  it('accepts an @-prefixed token with a column (lexer-derived)', () => {
    const row = {
      ...markdownLink,
      ordinal: 1,
      rawRef: '@README.md',
      text: null,
      column: 1,
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
  it('accepts a top-level heading with no parent', () => {
    const row = {
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
      characters: 380,
      tokens: 90,
    };
    expect(BlobSectionRowSchema.safeParse(row).success).toBe(true);
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
      characters: 290,
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
      characters: 10,
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
      severity: 'error',
      message: 'YAML syntax error',
      line: null,
    };
    expect(BlobConditionRowSchema.safeParse(row).success).toBe(true);
  });

  it('rejects an invalid severity', () => {
    const row = {
      blob: VALID_KEY,
      code: 'PARSE_ODDITY',
      severity: 'critical',
      message: 'x',
      line: null,
    };
    expect(BlobConditionRowSchema.safeParse(row).success).toBe(false);
  });
});
