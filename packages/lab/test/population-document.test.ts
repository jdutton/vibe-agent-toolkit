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

const HEX_A = 'a'.repeat(64);
const HEX_B = 'b'.repeat(64);
const KEY_A = `markdown.${HEX_A}`;
const KEY_B = `markdown.${HEX_B}`;

/** The two identity schemes a document can carry: `checksum` (rc.17 and earlier) and `contentKey`. */
const CHECKSUM = (value: string) => ({ scheme: 'checksum', value }) as const;
const CONTENT_KEY = (value: string) => ({ scheme: 'contentKey', value }) as const;

/** How every schema refusal opens, before it names the field. */
const NOT_A_SCAN_DOCUMENT = 'not a resource-scan document';

/** A document as `vat resources scan --verbose --format json` emits it. */
function scanDocument(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    status: 'success',
    root: '/fixture/project',
    extentSource: 'filesystem',
    filesScanned: 2,
    linksFound: 3,
    anchorsFound: 4,
    durationSecs: 0.1,
    files: [
      { path: 'b.md', links: 1, anchors: 1, checksum: HEX_B },
      { path: 'a.md', links: 2, anchors: 3, checksum: HEX_A },
    ],
    ...overrides,
  });
}

/** A minimal `Report<T>` envelope — only the fields this reader needs, so each case varies one. */
function reportScanDocument(dataOverrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    status: 'ok',
    examined: 2,
    findings: [],
    summary: { errors: 0, warnings: 0, info: 0 },
    data: {
      root: '/fixture/project',
      extentSource: 'filesystem',
      files: [
        { path: 'b.md', contentKey: KEY_B },
        { path: 'a.md', contentKey: KEY_A },
      ],
      ...dataOverrides,
    },
  });
}

/**
 * `vat resources scan --verbose --format json` as the Report envelope prints it
 * (wave 3): the count is `examined`, the population is `data.files`, the arm is
 * `data.extentSource`. Byte-for-byte the shape
 * `RESOURCES_SCAN_REPORT_SCHEMA` accepts.
 */
const REPORT_SHAPED_SCAN = JSON.stringify({
  status: 'ok',
  examined: 2,
  findings: [],
  summary: { errors: 0, warnings: 0, info: 0 },
  gate: { strict: false },
  durationMs: 41,
  data: {
    root: '/fixture/project',
    extentSource: 'git',
    collections: {},
    files: [
      { path: 'docs/b.md', links: 1, anchors: 1, contentKey: KEY_B },
      { path: 'docs/a.md', links: 2, anchors: 3, contentKey: KEY_A },
    ],
  },
});

describe('readPopulationDocument', () => {
  it('reads a Report-shaped scan: examined and data.files', () => {
    const result = readPopulationDocument(REPORT_SHAPED_SCAN);

    expect(result.ok, result.ok ? '' : result.refusal).toBe(true);
    if (!result.ok) return;
    expect(result.document).toEqual({
      root: '/fixture/project',
      extentSource: 'git',
      files: [
        { path: 'docs/a.md', identity: CONTENT_KEY(KEY_A) },
        { path: 'docs/b.md', identity: CONTENT_KEY(KEY_B) },
      ],
    });
  });

  it('reads a report-shaped document, taking the file count from the envelope\'s examined', () => {
    // `data` carries no `filesScanned` of its own — the envelope's `examined`
    // IS the denominator, and this facet must not require a per-command
    // restatement of it.
    const result = readPopulationDocument(reportScanDocument());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.root).toBe('/fixture/project');
    expect(result.document.files.map((entry) => entry.path)).toEqual(['a.md', 'b.md']);
  });

  it('REFUSES a report whose data reported files but no verbose list, using examined in the message', () => {
    const result = readPopulationDocument(JSON.stringify({
      status: 'ok',
      examined: 5,
      findings: [],
      summary: { errors: 0, warnings: 0, info: 0 },
      data: { root: '/fixture/project', extentSource: 'filesystem' },
    }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toContain('5 files scanned but listed none');
  });

  it('reads the root, the arm and the files', () => {
    const result = readPopulationDocument(scanDocument());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.root).toBe('/fixture/project');
    expect(result.document.extentSource).toBe('filesystem');
    expect(result.document.files).toEqual([
      { path: 'a.md', identity: CHECKSUM(HEX_A) },
      { path: 'b.md', identity: CHECKSUM(HEX_B) },
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

  it('keeps an unknown enumerator name verbatim rather than folding it into a known one', () => {
    const result = readPopulationDocument(scanDocument({ extentSource: 'some-future-source' }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.extentSource).toBe('some-future-source');
  });

  it('reports a missing extentSource as null, which is not any real arm', () => {
    const document = JSON.parse(scanDocument()) as Record<string, unknown>;
    delete document['extentSource'];

    const result = readPopulationDocument(JSON.stringify(document));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // `null` means the measured build does not say which enumerator ran, so a
    // row built from it cannot prove it is the arm the caller intended.
    expect(result.document.extentSource).toBeNull();
  });

  it('reports an explicit null extentSource as null', () => {
    const result = readPopulationDocument(scanDocument({ extentSource: null }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.extentSource).toBeNull();
  });

  // A malformed arm is a REFUSAL here, never `null`. `null` is the label an
  // old-but-honest build gets ("the output did not say"), and a subject that
  // printed a corrupt arm must not be rendered indistinguishably from one that
  // printed none. Each case names the field and what was received, so the
  // refusal reads as a schema verdict and not as a missing key.
  it('REFUSES an extentSource that is a number rather than reading it as unreported', () => {
    const result = readPopulationDocument(scanDocument({ extentSource: 42 }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toContain(NOT_A_SCAN_DOCUMENT);
    expect(result.refusal).toContain('extentSource: Expected string, received number');
  });

  it('REFUSES an empty-string extentSource, which names no enumerator', () => {
    const result = readPopulationDocument(scanDocument({ extentSource: '' }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toContain(NOT_A_SCAN_DOCUMENT);
    expect(result.refusal).toContain('extentSource: String must contain at least 1 character(s)');
  });

  it('REFUSES an extentSource that is an object', () => {
    const result = readPopulationDocument(scanDocument({ extentSource: {} }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toContain(NOT_A_SCAN_DOCUMENT);
    expect(result.refusal).toContain('extentSource: Expected string, received object');
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

  it('reads the default YAML scan (opened with ---), now that YAML is parsed', () => {
    // `vat resources scan` prints this by default; `--format json` is no
    // longer required for this facet to read it.
    const yaml = '---\nroot: /fixture/project\nstatus: success\nfilesScanned: 1\nfiles:\n  - path: a.md\n    checksum: ' + HEX_A + '\n';
    const result = readPopulationDocument(yaml);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.root).toBe('/fixture/project');
    expect(result.document.files).toEqual([{ path: 'a.md', identity: CHECKSUM(HEX_A) }]);
  });

  it('REFUSES output that is neither JSON nor YAML, carrying the reason', () => {
    const notADocument = 'a: [1, 2\n';
    const result = readPopulationDocument(notADocument);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toContain('no document this facet can read');
  });

  it('REFUSES a JSON document that is not a scan document', () => {
    const result = readPopulationDocument(JSON.stringify({ findings: [], errors: 0 }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toContain(NOT_A_SCAN_DOCUMENT);
    expect(result.refusal).toContain('root');
  });
});

describe('readPopulationDocument identity schemes', () => {
  const entries = (files: unknown[]): string => reportScanDocument({ files });

  it('reads a file carrying contentKey as the contentKey scheme', () => {
    const result = readPopulationDocument(entries([{ path: 'a.md', contentKey: KEY_A }]));
    expect(result.ok, result.ok ? '' : result.refusal).toBe(true);
    if (!result.ok) return;
    expect(result.document.files).toEqual([{ path: 'a.md', identity: CONTENT_KEY(KEY_A) }]);
  });

  it('reads a file carrying checksum (rc.17 and earlier) as the checksum scheme, never as a content key', () => {
    const result = readPopulationDocument(entries([{ path: 'a.md', checksum: HEX_A }]));
    expect(result.ok, result.ok ? '' : result.refusal).toBe(true);
    if (!result.ok) return;
    expect(result.document.files).toEqual([{ path: 'a.md', identity: CHECKSUM(HEX_A) }]);
  });

  it('REFUSES a file carrying both, since one entry has one identity', () => {
    const result = readPopulationDocument(entries([{ path: 'a.md', checksum: HEX_A, contentKey: KEY_A }]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toContain(NOT_A_SCAN_DOCUMENT);
    expect(result.refusal).toContain('exactly one');
  });

  it('REFUSES an identity that is not shaped like its scheme (a contentKey with no parser kind, an empty checksum)', () => {
    for (const file of [{ contentKey: HEX_A }, { contentKey: '' }, { checksum: '' }, { checksum: KEY_A }]) {
      const result = readPopulationDocument(entries([{ path: 'a.md', ...file }]));
      expect(result.ok, JSON.stringify(file)).toBe(false);
    }
  });

  it('REFUSES a file carrying neither', () => {
    const result = readPopulationDocument(entries([{ path: 'a.md' }]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toContain('exactly one');
  });
});

describe('samePopulation', () => {
  const base = [
    { path: 'a.md', identity: CONTENT_KEY('aaa') },
    { path: 'b.md', identity: CONTENT_KEY('bbb') },
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
        { path: 'a.md', identity: CONTENT_KEY('aaa') },
        { path: 'c.md', identity: CONTENT_KEY('bbb') },
      ]),
    ).toBe(false);
  });

  it('rejects the same paths with different content', () => {
    // The case a comparison of path lists alone would call equal, and the whole
    // reason the entries carry the subject's own identity.
    expect(
      samePopulation(base, [
        { path: 'a.md', identity: CONTENT_KEY('aaa') },
        { path: 'b.md', identity: CONTENT_KEY('CHANGED') },
      ]),
    ).toBe(false);
  });
});
