import { describe, expect, it } from 'vitest';

import type { ParseResult } from '../src/link-parser.js';
import { blobReferencesFor } from '../src/projection/blob-references.js';
import type { LexicalReference } from '../src/reference-lexer.js';
import { BlobReferenceRowSchema } from '../src/schemas/projection-blobs.js';
import type { LinkNodeType, ResourceLink } from '../src/schemas/resource-metadata.js';

const CONTENT_KEY = `markdown.${'c'.repeat(64)}`;
const AT_TOKEN = '@docs/setup.md';
const HREF = './b.md';

function parseResult(overrides: Partial<ParseResult>): ParseResult {
  return { content: '', sizeBytes: 0, links: [], headings: [], estimatedTokenCount: 0, ...overrides };
}

/** An AST link as the parser really shapes it. `nodeType` decides syntacticForm. */
function link(line: number, nodeType?: LinkNodeType): ResourceLink {
  return { text: 'b', href: HREF, type: 'local_file', line, ...(nodeType !== undefined && { nodeType }) };
}

/** A lexer token. Every column is explicit so a defaulted one cannot hide. */
function token(line: number, column: number, overrides: Partial<LexicalReference> = {}): LexicalReference {
  return {
    raw: AT_TOKEN,
    line,
    column,
    syntacticForm: 'at-prefixed',
    hasExtension: true,
    leadingAt: true,
    slashCount: 1,
    variableExpansion: null,
    inCodeSpan: false,
    inFence: false,
    ...overrides,
  };
}

describe('blobReferencesFor', () => {
  it('interleaves AST links and lexer tokens into ONE ordinal space, ordered by position', () => {
    const rows = blobReferencesFor(CONTENT_KEY, parseResult({
      links: [link(5)],
      lexicalReferences: [token(2, 1)],
    }));

    expect(rows.map((row) => row.ordinal)).toEqual([0, 1]);
    expect(rows[0]?.rawRef).toBe(AT_TOKEN);
    expect(rows[0]?.line).toBe(2);
    expect(rows[1]?.rawRef).toBe(HREF);
  });

  it('nulls text for a lexer-derived form and keeps its column', () => {
    const rows = blobReferencesFor(CONTENT_KEY, parseResult({
      lexicalReferences: [token(1, 3, { inCodeSpan: true })],
    }));

    expect(rows[0]?.text).toBeNull();
    expect(rows[0]?.column).toBe(3);
    expect(rows[0]?.inCodeSpan).toBe(true);
  });

  it('derives syntacticForm from nodeType, defaulting an absent one to markdown-link', () => {
    const rows = blobReferencesFor(CONTENT_KEY, parseResult({
      links: [link(1, 'link'), link(2, 'linkReference'), link(3, 'definition'), link(4)],
    }));

    expect(rows.map((row) => row.syntacticForm)).toEqual([
      'markdown-link', 'markdown-link-reference', 'markdown-definition', 'markdown-link',
    ]);
  });

  it('gives an AST link a null column, which the schema permits', () => {
    const rows = blobReferencesFor(CONTENT_KEY, parseResult({ links: [link(1, 'link')] }));

    expect(rows[0]?.column).toBeNull();
  });

  it('sorts a null column before a real one on the same line', () => {
    const rows = blobReferencesFor(CONTENT_KEY, parseResult({
      links: [link(4, 'link')],
      lexicalReferences: [token(4, 20)],
    }));

    expect(rows.map((row) => row.rawRef)).toEqual([HREF, AT_TOKEN]);
  });

  it('carries every lexer column through unchanged', () => {
    const rows = blobReferencesFor(CONTENT_KEY, parseResult({
      lexicalReferences: [token(1, 1, {
        raw: '${VAR}/x.md',
        syntacticForm: 'env-anchored',
        leadingAt: false,
        variableExpansion: 'brace',
        inFence: true,
      })],
    }));

    expect(rows[0]).toMatchObject({
      hasExtension: true, leadingAt: false, slashCount: 1,
      variableExpansion: 'brace', inCodeSpan: false, inFence: true,
    });
  });

  it('derives the lexical columns of an AST link from its href', () => {
    // The four lexical columns are required on every row, whichever producer
    // emitted it. Read from the href with the lexer's own rules, so a query
    // filtering on `hasExtension` reads one predicate across the table rather
    // than two. `@`-shaped and variable-bearing hrefs are both writable in
    // markdown, so neither column is constant.
    const rows = blobReferencesFor(CONTENT_KEY, parseResult({
      links: [
        { text: 'plain', href: HREF, type: 'local_file', line: 1, nodeType: 'link' },
        { text: 'scoped', href: '@scope/pkg/docs/x.md', type: 'local_file', line: 2, nodeType: 'link' },
        { text: 'var', href: '${CLAUDE_PLUGIN_ROOT}/scripts/run', type: 'local_file', line: 3, nodeType: 'link' },
      ],
    }));

    expect(rows.map((row) => ({
      hasExtension: row.hasExtension,
      leadingAt: row.leadingAt,
      slashCount: row.slashCount,
      variableExpansion: row.variableExpansion,
    }))).toEqual([
      { hasExtension: true, leadingAt: false, slashCount: 1, variableExpansion: null },
      { hasExtension: true, leadingAt: true, slashCount: 3, variableExpansion: null },
      { hasExtension: false, leadingAt: false, slashCount: 2, variableExpansion: 'brace' },
    ]);
  });

  it('never carries resolvedId, which production code mutates after the parse', () => {
    // `skill-packager` assigns `resolvedId` in place while bundling. A
    // content-addressed row carrying it would depend on which skill was
    // packaged first, so it must not appear on the row under any key.
    const rows = blobReferencesFor(CONTENT_KEY, parseResult({
      links: [{ text: 'b', href: HREF, type: 'local_file', line: 1, nodeType: 'link', resolvedId: 'leaked' }],
    }));

    expect(Object.values(rows[0] ?? {})).not.toContain('leaked');
    expect(Object.keys(rows[0] ?? {})).not.toContain('resolvedId');
  });

  it('marks an AST-derived row as being in neither a fence nor a code span', () => {
    // A link inside either context is a `code`/`inlineCode` node and never
    // becomes a link row at all, so these two are structurally false here —
    // not merely unset.
    const rows = blobReferencesFor(CONTENT_KEY, parseResult({ links: [link(1, 'link')] }));

    expect(rows[0]?.inCodeSpan).toBe(false);
    expect(rows[0]?.inFence).toBe(false);
  });

  it('skips a link with no line rather than defaulting it to line 1', () => {
    // ResourceLink.line is optional; BlobReferenceRow.line is required and
    // positive(). Defaulting would pile every position-less reference onto the
    // first line, where no assertion could ever catch it.
    const rows = blobReferencesFor(CONTENT_KEY, parseResult({
      links: [{ text: 'b', href: HREF, type: 'local_file' }],
    }));

    expect(rows).toEqual([]);
  });

  it('produces rows the shipped schema accepts', () => {
    const rows = blobReferencesFor(CONTENT_KEY, parseResult({
      links: [link(1, 'link')], lexicalReferences: [token(2, 1)],
    }));

    expect(() => rows.map((row) => BlobReferenceRowSchema.parse(row))).not.toThrow();
    expect(rows).toHaveLength(2);
  });
});
