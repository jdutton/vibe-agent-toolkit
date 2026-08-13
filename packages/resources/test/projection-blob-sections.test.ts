import { describe, expect, it } from 'vitest';

import { parseMarkdownContent } from '../src/link-parser.js';
import { blobSectionsFor, flattenHeadings } from '../src/projection/blob-sections.js';
import { BlobSectionRowSchema } from '../src/schemas/projection-blobs.js';
import type { HeadingNode } from '../src/schemas/resource-metadata.js';

const CONTENT_KEY = 'markdown.' + 'b'.repeat(64);
const USAGE = 'Usage';
const USAGE_SLUG = 'usage';

const DOC = ['# Top', 'intro', '## Usage', 'a', '### Deep', 'b', '## Usage', 'c', ''].join('\n');

/**
 * Parse for real rather than hand-building headings.
 *
 * The tree shape, the slugger's `-N` suffixing and the line numbers are all
 * things a hand-built fixture would restate — and a fixture that restates the
 * producer cannot detect the producer changing.
 */
function headingsOf(markdown: string): readonly HeadingNode[] {
  return parseMarkdownContent(markdown, markdown.length).headings;
}

describe('flattenHeadings', () => {
  it('returns the tree in document order', () => {
    expect(flattenHeadings(headingsOf(DOC)).map((node) => node.text))
      .toEqual(['Top', USAGE, 'Deep', USAGE]);
  });
});

describe('blobSectionsFor', () => {
  it('numbers sections in document order, not tree order', () => {
    const rows = blobSectionsFor(CONTENT_KEY, DOC, headingsOf(DOC));
    expect(rows.map((row) => row.ordinal)).toEqual([0, 1, 2, 3]);
    expect(rows.map((row) => row.title)).toEqual(['Top', USAGE, 'Deep', USAGE]);
  });

  it('splits the slugger occurrence suffix off the slug', () => {
    // github-slugger is stateful and emits "usage" then "usage-1"; the schema
    // wants the bare slug plus the occurrence as its own column.
    const rows = blobSectionsFor(CONTENT_KEY, DOC, headingsOf(DOC));
    expect(rows[1]?.slug).toBe(USAGE_SLUG);
    expect(rows[1]?.slugOccurrence).toBe(0);
    expect(rows[3]?.slug).toBe(USAGE_SLUG);
    expect(rows[3]?.slugOccurrence).toBe(1);
  });

  it('does not mistake a trailing numeral in the title for an occurrence suffix', () => {
    // "Step 1" slugs to "step-1" on its FIRST occurrence. Stripping "-N" by
    // regex would report it as occurrence 1 of a section named "step".
    const doc = '# Step 1\n\ntext\n';
    const rows = blobSectionsFor(CONTENT_KEY, doc, headingsOf(doc));
    expect(rows[0]?.slug).toBe('step-1');
    expect(rows[0]?.slugOccurrence).toBe(0);
  });

  it('points each section at its nearest shallower ancestor', () => {
    const rows = blobSectionsFor(CONTENT_KEY, DOC, headingsOf(DOC));
    expect(rows[0]?.parentOrdinal).toBeNull();
    expect(rows[1]?.parentOrdinal).toBe(0);
    expect(rows[2]?.parentOrdinal).toBe(1);
    expect(rows[3]?.parentOrdinal).toBe(0);
  });

  it('ends a section at the next heading of equal or lower level, so bytes include nested subsections', () => {
    const rows = blobSectionsFor(CONTENT_KEY, DOC, headingsOf(DOC));
    // "## Usage" at line 3 owns lines 3-6: itself, "a", "### Deep", "b".
    expect(rows[1]?.lineStart).toBe(3);
    expect(rows[1]?.lineEnd).toBe(6);
    // "### Deep" is nested inside it and is also its own row.
    expect(rows[2]?.lineStart).toBe(5);
    expect(rows[2]?.lineEnd).toBe(6);
    // No `!` — @typescript-eslint/no-non-null-assertion is an error in tests too.
    // `?? 0` on the left and `?? Infinity` on the right keep this able to go red:
    // a missing row makes the assertion fail rather than pass vacuously.
    expect(rows[1]?.bytes ?? 0).toBeGreaterThan(rows[2]?.bytes ?? Number.POSITIVE_INFINITY);
  });

  it('runs the last section to the end of the document', () => {
    const rows = blobSectionsFor(CONTENT_KEY, DOC, headingsOf(DOC));
    expect(rows.at(-1)?.lineEnd).toBe(DOC.split('\n').length);
  });

  it('returns nothing for a document with no headings', () => {
    expect(blobSectionsFor(CONTENT_KEY, 'just prose\n', [])).toEqual([]);
  });

  it('skips a heading with no line rather than defaulting it to the top of the document', () => {
    const orphan: HeadingNode = { level: 1, text: 'No position', slug: 'no-position' };
    expect(blobSectionsFor(CONTENT_KEY, DOC, [orphan])).toEqual([]);
  });

  it('produces rows the shipped schema accepts', () => {
    const rows = blobSectionsFor(CONTENT_KEY, DOC, headingsOf(DOC));
    expect(() => rows.map((row) => BlobSectionRowSchema.parse(row))).not.toThrow();
  });
});
