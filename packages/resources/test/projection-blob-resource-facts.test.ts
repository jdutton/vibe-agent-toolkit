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

import { parseMarkdownContent } from '../src/link-parser.js';
import { blobConditionsFor, blobRowFor } from '../src/projection/blob-facts.js';
import { blobReferencesFor } from '../src/projection/blob-references.js';
import { blobFactsReader } from '../src/projection/blob-resource-facts.js';
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
  const parsed = parseMarkdownContent(DOC, DOC.length);
  return {
    blobs: [blobRowFor(CONTENT_KEY, DOC.length, { encoding: 'utf-8', encodingSource: 'assumed', replacementCharacters: 0 }, parsed)],
    blobReferences: blobReferencesFor(CONTENT_KEY, parsed),
    blobSections: blobSectionsFor(CONTENT_KEY, DOC, parsed.headings),
    blobConditions: blobConditionsFor(CONTENT_KEY, parsed),
    harnessBlobFacts: [],
    harnessBlobImports: [],
  };
}

describe('blobFactsReader', () => {
  it('rebuilds the untampered rows', () => {
    const outcome = blobFactsReader(rowsOfDoc())(CONTENT_KEY);
    expect(outcome.kind).toBe('facts');
  });

  it('is uncovered when a reference row is missing against linkCount', () => {
    const rows = rowsOfDoc();
    const outcome = blobFactsReader({ ...rows, blobReferences: rows.blobReferences.slice(1) })(CONTENT_KEY);
    expect(outcome).toMatchObject({ kind: 'uncovered', reason: expect.stringContaining('linkCount') });
  });

  it('is uncovered when a section row is missing against headingCount', () => {
    const rows = rowsOfDoc();
    const outcome = blobFactsReader({ ...rows, blobSections: rows.blobSections.slice(1) })(CONTENT_KEY);
    expect(outcome).toMatchObject({ kind: 'uncovered', reason: expect.stringContaining('headingCount') });
  });

  it('is uncovered when an unresolved reference has no line', () => {
    const rows = rowsOfDoc();
    const blobConditions = rows.blobConditions.map((row) => (row.code === 'UNRESOLVED_REFERENCE' ? { ...row, line: null } : row));
    expect(blobConditions.some((row) => row.code === 'UNRESOLVED_REFERENCE')).toBe(true);
    const outcome = blobFactsReader({ ...rows, blobConditions })(CONTENT_KEY);
    expect(outcome).toMatchObject({ kind: 'uncovered', reason: expect.stringContaining('UNRESOLVED_REFERENCE') });
  });

  it('is uncovered when an AST reference row has no text', () => {
    const rows = rowsOfDoc();
    const blobReferences = rows.blobReferences.map((row) => (row.astIndex === 0 ? { ...row, text: null } : row));
    const outcome = blobFactsReader({ ...rows, blobReferences })(CONTENT_KEY);
    expect(outcome).toMatchObject({ kind: 'uncovered', reason: expect.stringContaining('no text') });
  });

  it('is uncovered for a key the bundle does not hold', () => {
    expect(blobFactsReader(rowsOfDoc())(`markdown.${'d'.repeat(64)}`).kind).toBe('uncovered');
  });
});
