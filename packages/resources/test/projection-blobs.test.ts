import { describe, expect, it } from 'vitest';

import {
  BlobConditionRowSchema,
  BlobLinkRowSchema,
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
    proseBytes: 10,
    codeBlockBytes: 0,
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
      proseBytes: 900,
      codeBlockBytes: 124,
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

describe('BlobLinkRowSchema', () => {
  it('accepts a link inside a fence, tagged rather than dropped', () => {
    const row = {
      blob: VALID_KEY,
      ordinal: 0,
      rawHref: './other.md',
      text: 'other',
      line: 12,
      column: 3,
      nodeType: 'link',
      inCodeSpan: false,
      inFence: true,
    };
    expect(BlobLinkRowSchema.safeParse(row).success).toBe(true);
  });

  it('accepts a bare autolink with null text', () => {
    const row = {
      blob: VALID_KEY,
      ordinal: 1,
      rawHref: 'https://example.com',
      text: null,
      line: 1,
      column: null,
      nodeType: 'link',
      inCodeSpan: false,
      inFence: false,
    };
    expect(BlobLinkRowSchema.safeParse(row).success).toBe(true);
  });

  it('rejects an invalid nodeType', () => {
    const row = {
      blob: VALID_KEY,
      ordinal: 0,
      rawHref: './x.md',
      text: 'x',
      line: 1,
      column: null,
      nodeType: 'bogus',
      inCodeSpan: false,
      inFence: false,
    };
    expect(BlobLinkRowSchema.safeParse(row).success).toBe(false);
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
