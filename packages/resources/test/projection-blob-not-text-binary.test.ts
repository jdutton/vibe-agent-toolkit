import { writeFile } from 'node:fs/promises';

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { BLOB_NOT_TEXT } from '../src/projection/blob-population.js';
import { ContributorRegistry } from '../src/projection/contributor.js';
import { FilesystemExtentContributor } from '../src/projection/contributors/filesystem-extent.js';
import { populate, type BlobPopulationReport } from '../src/projection/merge.js';

import { setupSubdirTestSuite } from './test-helpers.js';

/**
 * Evidence for the question behind `looksBinary`'s docstring: sniffing the NUL
 * *after* decode (rather than before) is what makes UTF-16 documents work, but
 * it also means the check only ever sees what the decoder produced, within a
 * bounded window. Does a real binary file — one carrying no NUL early in its
 * decoded form — reach `remark-parse` anyway?
 *
 * Answer, adjudicated: yes, for a binary whose first `BINARY_SNIFF_CHARS`
 * (8000) decoded characters are NUL-free — and that is a KNOWN, ACCEPTED
 * boundary, not a defect. See the boundary-pinning test below (the one
 * asserting the OPPOSITE outcome, on `LATE_NUL`) for the reasoning, and
 * {@link ../src/projection/blob-population.ts}'s `looksBinary` docstring.
 */
const suite = setupSubdirTestSuite('blob-not-text-binary-');

/**
 * Write raw bytes to a fixture beneath the suite root, bypassing UTF-8 string
 * encoding entirely.
 *
 * The corpus helper the rest of this suite family uses (`writeCorpusFiles` in
 * `test-helpers.ts`) takes a `string` and writes it via `Buffer.from(text,
 * 'utf-8')` — it cannot place an arbitrary byte like `0x89` on disk, because
 * that byte does not exist in any string's UTF-8 encoding on its own. The
 * fixtures below are Buffers of exact byte values, so they must be written
 * with `fs.writeFile` directly.
 */
async function writeBinaryFixture(relativePath: string, bytes: Uint8Array): Promise<void> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixture path beneath a mkdtemp root
  await writeFile(safePath.join(suite.tempDir, relativePath), bytes);
}

/** Only reachable if the assertion below stopped asserting. */
function unreachableReport(): BlobPopulationReport {
  throw new Error('populate() did not report blob-population counts');
}

/**
 * Run the filesystem-only projection driver over whatever the suite root
 * holds, and return the blob-population report plus the `BLOB_NOT_TEXT`
 * conditions it recorded.
 */
async function populateFixtureRoot(): Promise<{
  report: BlobPopulationReport;
  notTextConditions: readonly { blob: string; code: string; message: string }[];
}> {
  let report: BlobPopulationReport | undefined;
  const registry = new ContributorRegistry();
  registry.register(new FilesystemExtentContributor());

  const projection = await populate({
    root: suite.tempDir,
    registry,
    onBlobPopulation: (result) => {
      report = result;
    },
  });

  expect(report).toBeDefined();
  return {
    report: report ?? unreachableReport(),
    notTextConditions: projection.blobConditions.filter((row) => row.code === BLOB_NOT_TEXT),
  };
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
      'NOT a NUL-free binary that could slip through — it has a real 0x00 at index 4 ' +
      '(0xff, 0xd8, 0xff, 0xe0, 0x00, ...), and a raw 0x00 byte always decodes to a literal ' +
      'U+0000 no matter what the surrounding invalid-UTF-8 bytes (0xff, 0xd8) decode to ' +
      '(replacement characters). So this JPEG header is declined by the identical "NUL inside ' +
      'the window" mechanism as PNG above, not a separate mechanism — it does not exercise ' +
      'anything the PNG row does not already cover. Kept anyway as a second, differently-shaped ' +
      'real-format fixture.',
  },
];

describe('looksBinary, against real binary shapes (not synthesized NUL strings)', () => {
  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(suite.beforeEach);

  // `why` is read only by whoever is reading this source, not by the assertions below —
  // see the `DeclinedRealFormat` doc comment for what it preserves and why that is enough.
  it.each(DECLINED_REAL_FORMATS)('declines a $name header', async ({ fileName, bytes }) => {
    await writeBinaryFixture(fileName, bytes);

    const { report, notTextConditions } = await populateFixtureRoot();

    expect(report.blobsNotText).toBe(1);
    expect(report.blobsDerived).toBe(0);
    expect(notTextConditions).toHaveLength(1);
    expect(notTextConditions[0]?.message).toContain(fileName);
  });

  it('pins a KNOWN, ACCEPTED boundary: a NUL past the 8000-char window is not caught, and reaches the parser', async () => {
    // The adversarial shape: 9000 NUL-free bytes (0x41, the ASCII letter
    // 'A'), then one NUL — placed deliberately outside BINARY_SNIFF_CHARS
    // (8000). Measured (not assumed): this file is NOT declined. `looksBinary`
    // bounds its scan to 8000 DECODED characters, so a NUL past that point is
    // invisible to it.
    //
    // This is not a defect to fix here. Two facts make the bound correct as
    // designed, not merely convenient:
    //
    // 1. The bound matches git's own heuristic (also 8000, though git counts
    //    RAW BYTES because it never decodes). Unbounded scanning is unbounded
    //    cost on a hot path whose cost profile this stage was built to avoid
    //    — see BINARY_SNIFF_CHARS's docstring in blob-population.ts.
    // 2. VAT sniffs DECODED content where git sniffs RAW BYTES, and that
    //    divergence is deliberate and load-bearing: in UTF-16LE, every ASCII
    //    character is stored as its own byte followed by a NUL byte (e.g.
    //    `'A'` → `0x41 0x00`), so the raw bytes of any ASCII-in-UTF-16LE
    //    document are saturated with NULs. A RAW-BYTE pre-check — the
    //    "obvious" fix for this exact gap — would therefore decline every
    //    UTF-16 document outright. That is precisely the class of bug the
    //    decode-then-sniff ordering exists to prevent (see `looksBinary`'s
    //    docstring, "the sniff runs AFTER the decode"). A correct raw-byte
    //    check would have to run after BOM detection — a real design change,
    //    not a cleanup, and out of scope here.
    //
    // The exposure this leaves is narrow and non-corrupting: a binary file
    // whose first 8000 decoded characters happen to be NUL-free is derived as
    // one junk blob row, not silently declined. It is also, honestly, still
    // "text" for its first 9000 characters here.
    //
    // This test PINS that boundary rather than asserting an aspiration. If a
    // later change widens BINARY_SNIFF_CHARS or adds a post-BOM raw-byte
    // pre-check, this test SHOULD start failing — that failure means the
    // boundary moved on purpose, and this test (or its replacement) needs to
    // move with it.
    const LATE_NUL = Buffer.concat([Buffer.alloc(9000, 0x41), Buffer.from([0x00])]);
    await writeBinaryFixture('late.md', LATE_NUL);

    const { report, notTextConditions } = await populateFixtureRoot();

    // Reaches the parser: derived as a real blob, not declined.
    expect(report.blobsDerived).toBe(1);
    expect(report.blobsNotText).toBe(0);
    expect(notTextConditions).toHaveLength(0);
  });
});
