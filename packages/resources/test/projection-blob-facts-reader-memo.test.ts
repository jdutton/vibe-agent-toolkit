import { describe, expect, it } from 'vitest';

import { parseMarkdownContent } from '../src/link-parser.js';
import { blobConditionsFor, blobRowFor } from '../src/projection/blob-facts.js';
import { blobReferencesFor } from '../src/projection/blob-references.js';
import { blobFactsReader } from '../src/projection/blob-resource-facts.js';
import { blobSectionsFor } from '../src/projection/blob-sections.js';

const KEY = `markdown.${'d'.repeat(64)}`;
const ABSENT = `markdown.${'e'.repeat(64)}`;
const DOC = '# Title\n\nSee [a](./a.md).\n';

describe('blobFactsReader memo', () => {
  const parsed = parseMarkdownContent(DOC, DOC.length);
  const reader = blobFactsReader({
    blobs: [blobRowFor(KEY, DOC.length, { encoding: 'utf-8', encodingSource: 'assumed', replacementCharacters: 0 }, parsed)],
    blobReferences: blobReferencesFor(KEY, parsed),
    blobSections: blobSectionsFor(KEY, DOC, parsed.headings),
    blobConditions: blobConditionsFor(KEY, parsed),
    harnessBlobFacts: [],
    harnessBlobImports: [],
  });

  it('decodes a key once across two reader calls', () => {
    const first = reader(KEY);
    expect(first.kind).toBe('facts');
    expect(reader(KEY)).toBe(first);
  });

  it('memoizes an uncovered key too', () => {
    const first = reader(ABSENT);
    expect(first.kind).toBe('uncovered');
    expect(reader(ABSENT)).toBe(first);
  });
});
