/**
 * Reading a population out of a command's stdout.
 *
 * Every case here is a way a report could claim a population it never observed.
 * The one that matters most is the count-without-a-list case: `filesScanned` is
 * right there in the document and taking it would produce a row that compares
 * byte-identically against any other run of the same size while knowing nothing
 * about which files those were — a green with no evidence under it.
 */

import { describe, expect, it } from 'vitest';

import { readPopulationDocument, samePopulation } from '../src/facets/population/document.js';

/** How every schema refusal opens, before it names the field. */
const NOT_A_SCAN_DOCUMENT = 'not a resource-scan document';

/** A document as `vat resources scan --verbose --format json` emits it. */
function scanDocument(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    status: 'success',
    root: '/fixture/project',
    lane: 'walk',
    filesScanned: 2,
    linksFound: 3,
    anchorsFound: 4,
    durationSecs: 0.1,
    files: [
      { path: 'b.md', links: 1, anchors: 1, checksum: 'bbb' },
      { path: 'a.md', links: 2, anchors: 3, checksum: 'aaa' },
    ],
    ...overrides,
  });
}

describe('readPopulationDocument', () => {
  it('reads the root, the lane and the files', () => {
    const result = readPopulationDocument(scanDocument());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.root).toBe('/fixture/project');
    expect(result.document.lane).toBe('walk');
    expect(result.document.files).toEqual([
      { path: 'a.md', checksum: 'aaa' },
      { path: 'b.md', checksum: 'bbb' },
    ]);
  });

  it('sorts by path, so a later set difference is about membership and not order', () => {
    const result = readPopulationDocument(scanDocument());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The document listed b before a. Registry iteration order is not a
    // property anyone wants to compare.
    expect(result.document.files.map((entry) => entry.path)).toEqual(['a.md', 'b.md']);
  });

  it('keeps an unknown lane name verbatim rather than folding it into a known one', () => {
    const result = readPopulationDocument(scanDocument({ lane: 'some-future-lane' }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.lane).toBe('some-future-lane');
  });

  it('reports a missing lane as null, which is not any real lane', () => {
    const document = JSON.parse(scanDocument()) as Record<string, unknown>;
    delete document.lane;

    const result = readPopulationDocument(JSON.stringify(document));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // `null` means the measured build does not say which enumerator ran, so a
    // row built from it cannot prove it is the arm the caller intended.
    expect(result.document.lane).toBeNull();
  });

  it('keeps the lane when the extent source is an explicit null, which is the walk', () => {
    const result = readPopulationDocument(scanDocument({ lane: 'walk', extentSource: null }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.lane).toBe('walk');
    expect(result.document.extentSource).toBeNull();
  });

  it('reports an omitted extentSource key as null, keeping the lane', () => {
    // The fixture omits the key, as a build too old to report one does.
    const result = readPopulationDocument(scanDocument({ lane: 'projection' }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.lane).toBe('projection');
    expect(result.document.extentSource).toBeNull();
  });

  // A malformed arm is a REFUSAL here, never `null`. `null` is the label an
  // old-but-honest build gets ("the output did not say"), and a subject that
  // printed a corrupt lane must not be rendered indistinguishably from one that
  // printed none. Each case names the field and what was received, so the
  // refusal reads as a schema verdict and not as a missing key.
  it('REFUSES a lane that is a number rather than reading it as unreported', () => {
    const result = readPopulationDocument(scanDocument({ lane: 42 }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toContain(NOT_A_SCAN_DOCUMENT);
    expect(result.refusal).toContain('lane: Expected string, received number');
  });

  it('REFUSES an empty-string lane, which names no enumerator', () => {
    const result = readPopulationDocument(scanDocument({ lane: '' }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toContain(NOT_A_SCAN_DOCUMENT);
    expect(result.refusal).toContain('lane: String must contain at least 1 character(s)');
  });

  it('REFUSES a null lane — vat prints null for an extent source, never for a lane', () => {
    const result = readPopulationDocument(scanDocument({ lane: null }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toContain(NOT_A_SCAN_DOCUMENT);
    expect(result.refusal).toContain('lane: Expected string, received null');
  });

  it('REFUSES a lane that is an object', () => {
    const result = readPopulationDocument(scanDocument({ lane: {} }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toContain(NOT_A_SCAN_DOCUMENT);
    expect(result.refusal).toContain('lane: Expected string, received object');
  });

  it('REFUSES an extentSource that is a number, without touching the lane verdict', () => {
    const result = readPopulationDocument(scanDocument({ lane: 'projection', extentSource: 42 }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toContain(NOT_A_SCAN_DOCUMENT);
    expect(result.refusal).toContain('extentSource: Expected string, received number');
    // The lane was fine, and the refusal must not blame it.
    expect(result.refusal).not.toContain('lane:');
  });

  it('REFUSES a document that reported a count but listed no files', () => {
    const document = JSON.parse(scanDocument()) as Record<string, unknown>;
    delete document.files;

    const result = readPopulationDocument(JSON.stringify(document));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toContain('2 files scanned but listed none');
    expect(result.refusal).toContain('--verbose');
  });

  it('reads an empty file list as an empty population, not as a refusal', () => {
    // The inverse of the case above, and the pair is the point: "listed none"
    // and "listed zero" are different facts and must not collapse.
    const result = readPopulationDocument(scanDocument({ files: [], filesScanned: 0 }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.files).toEqual([]);
  });

  it('REFUSES output that is not JSON at all', () => {
    const result = readPopulationDocument('---\nstatus: success\nfilesScanned: 2\n');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toContain('no JSON document');
  });

  it('REFUSES a JSON document that is not a scan document', () => {
    const result = readPopulationDocument(JSON.stringify({ findings: [], errors: 0 }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toContain(NOT_A_SCAN_DOCUMENT);
    expect(result.refusal).toContain('root');
  });
});

describe('samePopulation', () => {
  const base = [
    { path: 'a.md', checksum: 'aaa' },
    { path: 'b.md', checksum: 'bbb' },
  ];

  it('accepts identical populations', () => {
    expect(samePopulation(base, [...base])).toBe(true);
  });

  it('rejects a different size', () => {
    expect(samePopulation(base, [base[0] as (typeof base)[number]])).toBe(false);
  });

  it('rejects different membership at the same size', () => {
    expect(
      samePopulation(base, [
        { path: 'a.md', checksum: 'aaa' },
        { path: 'c.md', checksum: 'bbb' },
      ]),
    ).toBe(false);
  });

  it('rejects the same paths with different content', () => {
    // The case a comparison of path lists alone would call equal, and the whole
    // reason the entries carry the subject's own checksum.
    expect(
      samePopulation(base, [
        { path: 'a.md', checksum: 'aaa' },
        { path: 'b.md', checksum: 'CHANGED' },
      ]),
    ).toBe(false);
  });
});
