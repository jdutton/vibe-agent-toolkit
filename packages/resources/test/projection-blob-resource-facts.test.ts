/**
 * The fact reader's refusals: rows that do not add up to what the `blobs` row says
 * the parse produced are `uncovered`, never a partial resource.
 *
 * Driven from a real parse's rows, tampered one way per case, so each case changes
 * exactly one thing a store could have lost. The agreement with the cold registry
 * is the round-trip enforcer's job (projection-sqlite's
 * `blob-facts-round-trip.integration.test.ts`); this suite pins what the reader
 * does with rows that cannot be trusted.
 */

import { describe, expect, it } from 'vitest';

import { parseHtmlContent } from '../src/html-link-parser.js';
import { parseMarkdownContent, type ParseResult } from '../src/link-parser.js';
import { blobConditionsFor, blobRowFor } from '../src/projection/blob-facts.js';
import { BLOB_NOT_TEXT, BLOB_PARSE_FAILED } from '../src/projection/blob-population.js';
import { blobReferencesFor } from '../src/projection/blob-references.js';
import { blobFactsReader, type BlobFactsOutcome } from '../src/projection/blob-resource-facts.js';
import { blobSectionsFor } from '../src/projection/blob-sections.js';
import type { BlobScopedRows } from '../src/projection/store.js';

const CONTENT_KEY = `markdown.${'c'.repeat(64)}`;
const DOC = '# Title\n\nSee [a](./a.md) and [x][missing].\n\n## Next\n';

/**
 * The rows the blob lane writes for {@link DOC}.
 *
 * @returns Every blob-scoped table, harness tables empty
 */
function rowsOfDoc(): BlobScopedRows {
  return rowsOf(CONTENT_KEY, DOC, parseMarkdownContent(DOC, DOC.length));
}

/**
 * The rows the blob lane writes for one parse.
 *
 * @param contentKey - The blob's key
 * @param source - The decoded text
 * @param parsed - Its parse
 * @returns Every blob-scoped table, harness tables empty
 */
function rowsOf(contentKey: string, source: string, parsed: ParseResult): BlobScopedRows {
  return {
    blobs: [blobRowFor(contentKey, source.length, { encoding: 'utf-8', encodingSource: 'assumed', replacementCharacters: 0 }, parsed)],
    blobReferences: blobReferencesFor(contentKey, parsed),
    blobSections: blobSectionsFor(contentKey, source, parsed.headings),
    blobConditions: blobConditionsFor(contentKey, parsed),
    harnessBlobFacts: [],
    harnessBlobImports: [],
  };
}

/**
 * The reader's outcome for a key, with its route-only answer held to the same kind in every case:
 * `answer` runs the checks `outcome` runs, without building the facts.
 *
 * @param rows - The bundle
 * @returns The outcome for a key
 */
function agreedReader(rows: BlobScopedRows): (contentKey: string) => BlobFactsOutcome {
  const reader = blobFactsReader(rows);
  return (contentKey) => {
    const outcome = reader.outcome(contentKey);
    expect(reader.answer(contentKey).kind, 'the route-only answer agrees with the rebuild').toBe(outcome.kind);
    return outcome;
  };
}

describe('blobFactsReader', () => {
  it('builds a key\'s facts afresh on every ask, keeping none of them', () => {
    const reader = blobFactsReader(rowsOfDoc());
    const first = reader.outcome(CONTENT_KEY);
    expect(first.kind).toBe('facts');
    expect(reader.outcome(CONTENT_KEY)).not.toBe(first);
    expect(reader.outcome(CONTENT_KEY)).toEqual(first);
  });

  it('answers a key by its rows: every row filed under it is read, none for a key it does not hold', () => {
    const rows = rowsOfDoc();
    const reader = blobFactsReader(rows);
    const held = 1 + rows.blobReferences.length + rows.blobSections.length + rows.blobConditions.length;
    expect(reader.answer(CONTENT_KEY)).toEqual({ kind: 'facts', rowsRead: held });
    expect(reader.answer(`markdown.${'d'.repeat(64)}`)).toEqual({ kind: 'uncovered', rowsRead: 0 });
  });

  it('agrees on a key whose every realization is refused (not-admitted)', () => {
    const refusedKey = `markdown.${'9'.repeat(64)}`;
    const outcome = agreedReader({
      blobs: [],
      blobReferences: [],
      blobSections: [],
      blobConditions: [{ blob: refusedKey, code: BLOB_PARSE_FAILED, ordinal: 0, severity: 'warning', message: 'the parse failed', line: null }],
      harnessBlobFacts: [],
      harnessBlobImports: [],
    })(refusedKey);
    expect(outcome.kind).toBe('not-admitted');
  });

  it('rebuilds the untampered rows', () => {
    const outcome = agreedReader(rowsOfDoc())(CONTENT_KEY);
    expect(outcome.kind).toBe('facts');
  });

  it('carries the key it rebuilt as the resource content key', () => {
    const outcome = agreedReader(rowsOfDoc())(CONTENT_KEY);
    expect(outcome.kind === 'facts' && outcome.facts.contentKey).toBe(CONTENT_KEY);
  });

  it('carries the key of a not-text blob, which has no blobs row', () => {
    const notTextKey = `markdown.${'f'.repeat(64)}`;
    const outcome = agreedReader({
      blobs: [],
      blobReferences: [],
      blobSections: [],
      blobConditions: [{ blob: notTextKey, code: BLOB_NOT_TEXT, ordinal: 0, severity: 'warning', message: 'not text', line: null }],
      harnessBlobFacts: [],
      harnessBlobImports: [],
    })(notTextKey);
    expect(outcome.kind === 'facts' && outcome.facts.contentKey).toBe(notTextKey);
  });

  it('is uncovered when a reference row is missing against linkCount', () => {
    const rows = rowsOfDoc();
    const outcome = agreedReader({ ...rows, blobReferences: rows.blobReferences.slice(1) })(CONTENT_KEY);
    expect(outcome).toMatchObject({ kind: 'uncovered', reason: expect.stringContaining('linkCount') });
  });

  it('is uncovered when a section row is missing against headingCount', () => {
    const rows = rowsOfDoc();
    const outcome = agreedReader({ ...rows, blobSections: rows.blobSections.slice(1) })(CONTENT_KEY);
    expect(outcome).toMatchObject({ kind: 'uncovered', reason: expect.stringContaining('headingCount') });
  });

  it('is uncovered when an unresolved reference has no line', () => {
    const rows = rowsOfDoc();
    const blobConditions = rows.blobConditions.map((row) => (row.code === 'UNRESOLVED_REFERENCE' ? { ...row, line: null } : row));
    expect(blobConditions.some((row) => row.code === 'UNRESOLVED_REFERENCE')).toBe(true);
    const outcome = agreedReader({ ...rows, blobConditions })(CONTENT_KEY);
    expect(outcome).toMatchObject({ kind: 'uncovered', reason: expect.stringContaining('UNRESOLVED_REFERENCE') });
  });

  it('is uncovered when an AST reference row has no text', () => {
    const rows = rowsOfDoc();
    const blobReferences = rows.blobReferences.map((row) => (row.astIndex === 0 ? { ...row, text: null } : row));
    const outcome = agreedReader({ ...rows, blobReferences })(CONTENT_KEY);
    expect(outcome).toMatchObject({ kind: 'uncovered', reason: expect.stringContaining('no text') });
  });

  it('is uncovered for a key the bundle does not hold', () => {
    expect(agreedReader(rowsOfDoc())(`markdown.${'d'.repeat(64)}`).kind).toBe('uncovered');
  });

  // parse5 no longer emits a link with a line and no offsets (the clone that
  // carried one is dropped upstream), so no file reaches this shape and the
  // store-fidelity round trip cannot hold it: it is held here, from a real HTML
  // parse with the offsets taken off one link.
  it('rebuilds an HTML link that has a line and no offsets exactly as the parser left it', () => {
    const source = '<p><a href="./a.md">A</a></p>\n';
    const parsed = parseHtmlContent(source, source.length);
    const [located] = parsed.links;
    expect(located?.line).toBe(1);
    if (located === undefined) throw new Error('the page yielded no link');
    const halfPositioned = { ...located };
    delete halfPositioned.startOffset;
    delete halfPositioned.endOffset;
    const htmlKey = `html.${'e'.repeat(64)}`;
    const outcome = agreedReader(rowsOf(htmlKey, source, { ...parsed, links: [halfPositioned] }))(htmlKey);
    expect(outcome.kind).toBe('facts');
    if (outcome.kind !== 'facts') return;
    expect(outcome.facts.links).toStrictEqual([halfPositioned]);
    expect(outcome.facts.links.map((link) => Object.keys(link))).toEqual([Object.keys(halfPositioned)]);
  });

  it('is uncovered, not a throw, when the stored frontmatter encoding is malformed', () => {
    const rows = rowsOfDoc();
    const blobs = rows.blobs.map((row) => ({ ...row, frontmatterValue: 'not the codec encoding' }));
    const outcome = agreedReader({ ...rows, blobs })(CONTENT_KEY);
    expect(outcome).toMatchObject({ kind: 'uncovered', reason: expect.stringContaining('frontmatterValue') });
  });

  it('is uncovered when the astIndex values have a gap', () => {
    const rows = rowsOfDoc();
    const blobReferences = rows.blobReferences.map((row) => (row.astIndex === 0 ? { ...row, astIndex: 1 } : row));
    expect(blobReferences.filter((row) => row.astIndex === 1)).toHaveLength(1);
    const outcome = agreedReader({ ...rows, blobReferences })(CONTENT_KEY);
    expect(outcome).toMatchObject({ kind: 'uncovered', reason: expect.stringContaining('astIndex') });
  });

  it('is uncovered when the section ordinals have a gap', () => {
    const rows = rowsOfDoc();
    const blobSections = rows.blobSections.map((row) => (row.ordinal === 1 ? { ...row, ordinal: 5 } : row));
    const outcome = agreedReader({ ...rows, blobSections })(CONTENT_KEY);
    expect(outcome).toMatchObject({ kind: 'uncovered', reason: expect.stringContaining('section') });
  });

  it('is uncovered when a finding condition row is missing against findingCount', () => {
    const rows = rowsOfDoc();
    expect(rows.blobs[0]?.findingCount).toBeGreaterThan(0);
    const outcome = agreedReader({ ...rows, blobConditions: [] })(CONTENT_KEY);
    expect(outcome).toMatchObject({ kind: 'uncovered', reason: expect.stringContaining('findingCount') });
  });
});
