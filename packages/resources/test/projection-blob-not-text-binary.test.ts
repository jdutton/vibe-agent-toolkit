import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { BLOB_NOT_TEXT } from '../src/projection/blob-population.js';
import { describeBlobRefusals } from '../src/projection/blob-refusals.js';
import type { BlobPopulationReport } from '../src/projection/merge.js';
import type { Projection } from '../src/projection/projection.js';

import {
  conditionsWithCode,
  populateFixtureRoot,
  writeBinaryFixture,
} from './blob-fixture-population.js';
import { setupSubdirTestSuite } from './test-helpers.js';

/**
 * Evidence for the question behind `looksBinary`'s docstring: sniffing the NUL
 * *after* decode (rather than before) is what makes UTF-16 documents work, but
 * it also means the check only ever sees what the decoder produced, within a
 * bounded window. Does a real binary file — one carrying no NUL early in its
 * decoded form — reach `remark-parse` anyway?
 *
 * Answer, adjudicated: yes, for a binary whose first {@link SNIFF_WINDOW}
 * decoded characters are NUL-free — and that is a KNOWN, ACCEPTED boundary, not
 * a defect. See the two boundary tests below for the reasoning, and
 * {@link ../src/projection/blob-population.ts}'s `looksBinary` docstring.
 */
const suite = setupSubdirTestSuite('blob-not-text-binary-');

/**
 * `BINARY_SNIFF_CHARS`, which `blob-population.ts` does not export.
 *
 * Mirrored rather than imported, and the two boundary tests below pin it from
 * BOTH sides: a NUL at index `SNIFF_WINDOW - 1` must be caught and one at index
 * `SNIFF_WINDOW` must not. Together they admit exactly one value, so widening
 * the window to 8192 or narrowing it to 4096 reddens this file instead of
 * slipping through — which a single fixture with slack on one side cannot do.
 */
const SNIFF_WINDOW = 8000;

/** `'A'`: a NUL-free filler byte that is also NUL-free once decoded. */
const ASCII_A = 0x41;

/**
 * Filler written after the NUL in the boundary fixtures.
 *
 * So the two fixtures differ ONLY in where the NUL sits — same length, same
 * bytes elsewhere. Without it the in-window fixture would also be the shorter
 * one, and "shorter" is a second difference a reader would have to rule out.
 */
const TRAILING_FILLER = 64;

/**
 * Plant bytes beneath this suite's root.
 *
 * @param relativePath - Fixture path beneath the suite root
 * @param bytes - The exact bytes to land on disk
 */
async function plant(relativePath: string, bytes: Uint8Array): Promise<void> {
  await writeBinaryFixture(suite.tempDir, relativePath, bytes);
}

/**
 * Run the shared populate driver over the suite root, with the `BLOB_NOT_TEXT`
 * rows this file is about already selected.
 *
 * @returns The report, the projection, and the refusal rows
 */
async function populateSuiteRoot(): Promise<{
  report: BlobPopulationReport;
  projection: Projection;
  notTextConditions: readonly { blob: string; code: string; message: string }[];
}> {
  const { report, projection } = await populateFixtureRoot(suite.tempDir);
  return { report, projection, notTextConditions: conditionsWithCode(projection, BLOB_NOT_TEXT) };
}

/**
 * One fixture of `nulIndex` filler characters, then a NUL, then more filler.
 *
 * @param fileName - Root-relative fixture path
 * @param nulIndex - Zero-based position of the single NUL
 */
async function writeNulAt(fileName: string, nulIndex: number): Promise<void> {
  await plant(fileName, Buffer.concat([
    Buffer.alloc(nulIndex, ASCII_A),
    Buffer.from([0x00]),
    Buffer.alloc(TRAILING_FILLER, ASCII_A),
  ]));
}

/**
 * One entry per real binary format declined by `looksBinary`.
 *
 * PNG and JPEG are declined by the identical mechanism — a NUL landing inside
 * the sniff window — so they are two rows of one table rather than two
 * near-identical test bodies. Table-driven, not two `it()` blocks, because
 * that duplication is exactly what a whole-tree `jscpd` run flagged: same
 * setup, same three assertions, differing only in the bytes and the
 * filename. `why` is not decorative — it carries the per-fixture reasoning
 * a prior review round corrected and asked to be preserved, in particular the
 * JPEG note that it is declined by the SAME mechanism as PNG, not a distinct
 * one.
 */
interface DeclinedRealFormat {
  /** Short label used in the generated test name. */
  readonly name: string;
  /** Root-relative fixture path. */
  readonly fileName: string;
  /** The exact bytes written to disk. */
  readonly bytes: Uint8Array;
  /** Why this specific byte sequence is declined, and what (if anything) it adds over the other rows. */
  readonly why: string;
}

const DECLINED_REAL_FORMATS: readonly DeclinedRealFormat[] = [
  {
    name: 'PNG',
    fileName: 'image.md',
    // A real PNG signature: 8 magic bytes, then the IHDR chunk's length field
    // starts contributing zero bytes at offset 8.
    bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]),
    why: 'The control: its NUL sits at byte 8, well inside the 8000-character sniff window.',
  },
  {
    name: 'JPEG',
    fileName: 'photo.md',
    bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]),
    why:
      'NOT a NUL-free binary that could slip through — it has a real 0x00 at index 4 '
      + '(0xff, 0xd8, 0xff, 0xe0, 0x00, ...), and a raw 0x00 byte always decodes to a literal '
      + 'U+0000 no matter what the surrounding invalid-UTF-8 bytes (0xff, 0xd8) decode to '
      + '(replacement characters). So this JPEG header is declined by the identical "NUL inside '
      + 'the window" mechanism as PNG above, not a separate mechanism — it does not exercise '
      + 'anything the PNG row does not already cover. Kept anyway as a second, differently-shaped '
      + 'real-format fixture.',
  },
];

/** Plain ASCII markdown, with one heading and one link, for the UTF-16 fixture. */
const UTF16_SOURCE = '# Notes\n\n[b](./b.md)\n';

/**
 * {@link UTF16_SOURCE} as a real UTF-16LE file: BOM `ff fe`, then two bytes per
 * character, the high byte of every ASCII character being NUL.
 *
 * This is not a contrived shape. **PowerShell 5.1's `Out-File` and `>` write
 * UTF-16LE by default**, so it is the ordinary on-disk form of a markdown file
 * produced by a Windows script.
 */
const UTF16_DOC_BYTES = Buffer.concat([
  Buffer.from([0xff, 0xfe]),
  Buffer.from(UTF16_SOURCE, 'utf16le'),
]);

describe('looksBinary, against real binary shapes (not synthesized NUL strings)', () => {
  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(suite.beforeEach);

  // `why` is read only by whoever is reading this source, not by the assertions below —
  // see the `DeclinedRealFormat` doc comment for what it preserves and why that is enough.
  it.each(DECLINED_REAL_FORMATS)('declines a $name header', async ({ fileName, bytes }) => {
    await plant(fileName, bytes);

    const { report, notTextConditions } = await populateSuiteRoot();

    expect(report.blobsNotText).toBe(1);
    expect(report.blobsDerived).toBe(0);
    expect(notTextConditions).toHaveLength(1);
    expect(notTextConditions[0]?.message).toContain(fileName);
  });

  it('accepts a UTF-16LE document whose RAW bytes are saturated with NULs', async () => {
    // THE ordering pin. `looksBinary`'s docstring calls the decode-then-sniff
    // order "deliberate and load-bearing", on the grounds that a RAW-BYTE
    // pre-check — the obvious fix for the window gap the two boundary tests
    // below pin — would decline every UTF-16 document outright. Nothing in this
    // file used to hold that claim: the boundary fixture's NUL sits at byte 9000
    // AND character 9000, so it lands the same side of the window under either
    // ordering and cannot tell the two apart. This fixture can, and only this
    // fixture: reorder the sniff before the decode and it goes red.
    //
    // The premise, asserted rather than asserted-about: these raw bytes really
    // would trip a byte-wise check, and well inside the window.
    expect(UTF16_DOC_BYTES.subarray(0, SNIFF_WINDOW).includes(0x00)).toBe(true);
    await plant('powershell-notes.md', UTF16_DOC_BYTES);

    const { report, projection, notTextConditions } = await populateSuiteRoot();

    // Accepted as text...
    expect(report.blobsNotText).toBe(0);
    expect(notTextConditions).toHaveLength(0);
    // ...and the positive control, so the two assertions above cannot be
    // satisfied by a run that simply never enumerated the file.
    expect(report.blobsDerived).toBe(1);
    // Decoded, not merely admitted: a byte-wise reading of these bytes is
    // NUL-interleaved garbage in which neither the heading nor the link exists.
    expect(projection.blobs[0]?.headingCount).toBe(1);
    expect(projection.blobSections.map((row) => row.title)).toEqual(['Notes']);
    expect(projection.blobReferences.map((row) => row.rawRef)).toEqual(['./b.md']);
  });

  it('declines a NUL at the last character inside the window', async () => {
    // The tight lower edge of the KNOWN, ACCEPTED boundary the next test pins
    // from above. Without this half, narrowing BINARY_SNIFF_CHARS — to 4096, or
    // to the 512 a "cheaper sniff" refactor would reach for — would pass every
    // other fixture in this file silently, because the PNG and JPEG rows put
    // their NUL at byte 8.
    await writeNulAt('inside.md', SNIFF_WINDOW - 1);

    const { report, notTextConditions } = await populateSuiteRoot();

    expect(report.blobsNotText).toBe(1);
    expect(report.blobsDerived).toBe(0);
    // The window the refusal reports is the window it applied, so a constant
    // changed without changing this file is caught in the message too.
    expect(notTextConditions[0]?.message).toContain(String(SNIFF_WINDOW));
  });

  it('pins a KNOWN, ACCEPTED boundary: a NUL one character past the window is not caught, and reaches the parser', async () => {
    // The adversarial shape, one character wide: NUL-free filler up to index
    // 7999, then a NUL at index 8000 — the FIRST position `looksBinary` does not
    // scan (`limit = min(length, BINARY_SNIFF_CHARS)`, so 7999 is the last index
    // read). Measured, not assumed: this file is NOT declined.
    //
    // This is not a defect to fix here. Two facts make the bound correct as
    // designed, not merely convenient:
    //
    // 1. The bound matches git's own heuristic (also 8000, though git counts
    //    RAW BYTES because it never decodes). Unbounded scanning is unbounded
    //    cost on a hot path whose cost profile this stage was built to avoid
    //    — see BINARY_SNIFF_CHARS's docstring in blob-population.ts.
    // 2. VAT sniffs DECODED content where git sniffs RAW BYTES, and that
    //    divergence is deliberate and load-bearing — see the UTF-16LE test
    //    above, which is what actually holds that property: a RAW-BYTE
    //    pre-check, the "obvious" fix for this exact gap, would decline every
    //    UTF-16 document outright. A correct raw-byte check would have to run
    //    after BOM detection — a real design change, not a cleanup, and out of
    //    scope here.
    //
    // The exposure this leaves is narrow and non-corrupting: a binary file
    // whose first 8000 decoded characters happen to be NUL-free is derived as
    // one junk blob row, not silently declined.
    //
    // This test PINS that boundary rather than asserting an aspiration, and it
    // is deliberately one character off it: paired with the test above there is
    // exactly one window width that satisfies both, so a change to
    // BINARY_SNIFF_CHARS in EITHER direction reddens this file. That failure
    // means the boundary moved on purpose, and these tests need to move with it.
    await writeNulAt('outside.md', SNIFF_WINDOW);

    const { report, notTextConditions } = await populateSuiteRoot();

    // Reaches the parser: derived as a real blob, not declined.
    expect(report.blobsDerived).toBe(1);
    expect(report.blobsNotText).toBe(0);
    expect(notTextConditions).toHaveLength(0);
  });
});

describe('the refusal reaches a reader, over a corpus that is REALLY declined', () => {
  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(suite.beforeEach);

  it('turns a declined binary into a line a caller can print', async () => {
    // The end-to-end half of the fix. `looksBinary` calls itself "a refusal, not
    // a silence" and `blobsNotText` "what makes the refusal auditable rather than
    // a quiet speed-up" — and both were false in every shipped run, because
    // `onBlobPopulation` was optional and no production caller passed one. Every
    // count was computed and dropped at the end of `populate()`.
    //
    // Real PNG bytes, not a synthesized NUL string: three tidy .md files cannot
    // exhibit a binary refusal at all.
    await plant('image.md', DECLINED_REAL_FORMATS[0]?.bytes ?? new Uint8Array());

    const { report } = await populateSuiteRoot();

    // The premise, so the line below is about a refusal rather than about an
    // empty corpus: something really was declined, and nothing was derived.
    expect(report.blobsNotText).toBe(1);

    const line = describeBlobRefusals(report);
    expect(line).toBeDefined();
    expect(line).toContain('1 not text');
    expect(line).toContain('declined 1 of 1 blob(s)');
  });

  it('says nothing over a corpus of ordinary markdown — and really did read it', async () => {
    // The negative control, with its own positive control attached. Without
    // `blobsDerived` asserted, "no refusal reported" would be satisfied by a run
    // that enumerated nothing at all, which is the exact shape of the bug.
    await plant('clean.md', Buffer.from('# Clean\n\nJust prose.\n', 'utf-8'));

    const { report } = await populateSuiteRoot();

    expect(report.blobsDerived).toBe(1);
    expect(describeBlobRefusals(report)).toBeUndefined();
  });
});
