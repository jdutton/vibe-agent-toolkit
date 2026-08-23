/**
 * Encoding provenance, end to end: real bytes on disk → `blobs` columns → the
 * line a CLI prints.
 *
 * Every fixture here is an exact byte sequence, never a string this test encoded
 * for itself. That is not fastidiousness — it is the only way the suite can
 * exhibit its subject at all. Three tidy ASCII `.md` files decode identically
 * under every encoding VAT knows, so a corpus of them cannot distinguish a
 * decoder that reads BOMs from one that ignores them, nor a replacement count
 * that works from one hardcoded to zero.
 *
 * The three cases are chosen to be mutually distinguishing:
 *
 * | fixture | encoding | encodingSource | replacementCharacters |
 * |---|---|---|---|
 * | UTF-16LE with a BOM | `utf-16le` | `bom` | 0 |
 * | ordinary UTF-8 | `utf-8` | `assumed` | 0 |
 * | windows-1252 high bytes | `utf-8` | `assumed` | **> 0** |
 *
 * No single wrong implementation satisfies all three rows: a decoder that always
 * says `bom` fails row 2, one that always says `assumed` fails row 1, and one
 * that never counts fails row 3.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { describeBlobRefusals } from '../src/projection/blob-refusals.js';
import type { Projection } from '../src/projection/projection.js';
import type { BlobRow } from '../src/schemas/projection-blobs.js';

import { populateFixtureRoot, writeBinaryFixture } from './blob-fixture-population.js';
import { setupSubdirTestSuite } from './test-helpers.js';

const suite = setupSubdirTestSuite('blob-encoding-');

/** One heading and one link — enough that a wrong decode cannot parse as markdown. */
const DOC = '# Notes\n\n[b](./b.md)\n';

/**
 * {@link DOC} as a real UTF-16LE file: BOM `ff fe`, then two bytes per character.
 *
 * **PowerShell 5.1's `Out-File` and `>` write UTF-16LE by default**, so this is
 * the ordinary on-disk form of a markdown file produced by a Windows script, not
 * a contrived shape.
 */
const UTF16LE_WITH_BOM = Buffer.concat([
  Buffer.from([0xff, 0xfe]),
  Buffer.from(DOC, 'utf16le'),
]);

/**
 * `# café ± 3° — naïve` as a legacy Windows editor writes it: windows-1252.
 *
 * Spelled as bytes because it has to be. `0x97` (em dash) is a windows-1252
 * assignment latin-1 does not share, so no JS string encoder produces this byte
 * string; and the point of the fixture is that each of the five high bytes is
 * invalid UTF-8 standing alone, so a UTF-8 decode substitutes five U+FFFD.
 *
 * The heading marker and the ASCII words are ordinary bytes, so the document
 * still parses as markdown and still gets a `blobs` row — which is exactly the
 * danger: it is indexed, not refused.
 */
const WINDOWS_1252_BYTES = Uint8Array.from([
  0x23, 0x20, // "# "
  0x63, 0x61, 0x66, 0xe9, 0x20, // caf<e9>
  0xb1, 0x20, 0x33, 0xb0, 0x20, // <b1> 3<b0>
  0x97, 0x20, // <97>
  0x6e, 0x61, 0xef, 0x76, 0x65, 0x0a, // na<ef>ve\n
]);

/** How many high bytes {@link WINDOWS_1252_BYTES} carries, and so how many U+FFFD it earns. */
const WINDOWS_1252_HIGH_BYTES = 5;

/**
 * The single `blobs` row of a one-file projection.
 *
 * @param projection - A populated projection
 * @returns Its only blob row
 */
function onlyBlob(projection: Projection): BlobRow {
  expect(projection.blobs).toHaveLength(1);
  return projection.blobs[0] as BlobRow;
}

describe('the blobs table records how its text was decoded', () => {
  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(suite.beforeEach);

  it('records a BOM-announced UTF-16LE document as a FACT, with nothing lost', async () => {
    await writeBinaryFixture(suite.tempDir, 'powershell-notes.md', UTF16LE_WITH_BOM);

    const { report, projection } = await populateFixtureRoot(suite.tempDir);
    const blob = onlyBlob(projection);

    expect(blob.encoding).toBe('utf-16le');
    expect(blob.encodingSource).toBe('bom');
    expect(blob.replacementCharacters).toBe(0);
    // Positive control on that zero: the document really was decoded, not merely
    // admitted. A byte-wise reading of these bytes is NUL-interleaved garbage in
    // which neither the heading nor the link exists.
    expect(report.blobsDerived).toBe(1);
    expect(blob.headingCount).toBe(1);
    expect(projection.blobReferences.map((row) => row.rawRef)).toEqual(['./b.md']);
  });

  it('records an ordinary UTF-8 document as an ASSUMPTION, because that is what it is', async () => {
    await writeBinaryFixture(suite.tempDir, 'plain.md', Buffer.from(DOC, 'utf-8'));

    const { projection } = await populateFixtureRoot(suite.tempDir);
    const blob = onlyBlob(projection);

    // Nothing in these bytes says "UTF-8" — there is no BOM — so `bom` here would
    // be a claim the file never made. The honest value is the one that carries
    // the risk, and it is the common case.
    expect(blob.encoding).toBe('utf-8');
    expect(blob.encodingSource).toBe('assumed');
    expect(blob.replacementCharacters).toBe(0);
    expect(blob.headingCount).toBe(1);
  });

  it('counts what a windows-1252 document loses when it is read as UTF-8', async () => {
    await writeBinaryFixture(suite.tempDir, 'legacy.md', WINDOWS_1252_BYTES);

    const { report, projection } = await populateFixtureRoot(suite.tempDir);
    const blob = onlyBlob(projection);

    // The whole point: this file was NOT refused. It has a blob row, a heading,
    // a token estimate — everything a clean document has — and its text is
    // mojibake. `replacementCharacters` is the only column that says so.
    expect(report.blobsDerived).toBe(1);
    expect(report.blobsNotText).toBe(0);
    expect(blob.encoding).toBe('utf-8');
    expect(blob.encodingSource).toBe('assumed');
    expect(blob.replacementCharacters).toBe(WINDOWS_1252_HIGH_BYTES);
  });

  it('keeps the raw byte count and the replacement count independent', async () => {
    // `bytes` is `stat().size` and says nothing about fidelity: this file is 20
    // bytes whether or not any of them decoded. A reader must not be able to
    // infer one column from the other.
    await writeBinaryFixture(suite.tempDir, 'legacy.md', WINDOWS_1252_BYTES);

    const blob = onlyBlob((await populateFixtureRoot(suite.tempDir)).projection);

    expect(blob.bytes).toBe(WINDOWS_1252_BYTES.byteLength);
    expect(blob.replacementCharacters).toBe(WINDOWS_1252_HIGH_BYTES);
  });
});

describe('a mis-decoded corpus says so, and a clean one stays silent', () => {
  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(suite.beforeEach);

  it('turns a mis-decode into a line a caller can print', async () => {
    await writeBinaryFixture(suite.tempDir, 'legacy.md', WINDOWS_1252_BYTES);
    await writeBinaryFixture(suite.tempDir, 'plain.md', Buffer.from(DOC, 'utf-8'));

    const { report } = await populateFixtureRoot(suite.tempDir);

    // The premise, so the line below is about a mis-decode rather than about an
    // empty corpus: two blobs were derived and exactly one of them lost
    // characters. Nothing was declined, so no refusal bucket is involved.
    expect(report.blobsDerived).toBe(2);
    expect(report.blobsDecodedWithReplacements).toBe(1);

    const line = describeBlobRefusals(report);
    expect(line).toBeDefined();
    expect(line).toContain('mis-decoded 1 of 2 blob(s) into 5 replacement character(s)');
    expect(line).toContain('all with no BOM, so the encoding was assumed');
    expect(line).toContain('replacementCharacters > 0');
  });

  it('says nothing over a corpus that decoded cleanly — and really did read it', async () => {
    // The negative control with its own positive control attached. Both fixtures
    // are non-ASCII on purpose: a corpus of pure ASCII would decode cleanly under
    // a broken decoder too, so it could not tell silence-because-correct from
    // silence-because-nothing-happened.
    await writeBinaryFixture(suite.tempDir, 'powershell-notes.md', UTF16LE_WITH_BOM);
    await writeBinaryFixture(
      suite.tempDir,
      'accented.md',
      Buffer.from('# café ± 3° — naïve\n', 'utf-8'),
    );

    const { report, projection } = await populateFixtureRoot(suite.tempDir);

    expect(report.blobsDerived).toBe(2);
    expect(projection.blobs.every((row) => row.replacementCharacters === 0)).toBe(true);
    expect(report.blobsDecodedWithReplacements).toBe(0);
    expect(describeBlobRefusals(report)).toBeUndefined();
  });
});
