/* eslint-disable security/detect-non-literal-fs-filename -- test writes to temp dirs from computed paths */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { afterAll, describe, expect, it } from 'vitest';

import { calculateChecksum, calculateChecksumFromContent } from '../src/checksum.js';
import { SHA256Schema } from '../src/schemas/checksum.js';

import { scratchFixtureWriter } from './test-helpers.js';

const fixtures = scratchFixtureWriter('vat-checksum-');

afterAll(fixtures.cleanup);

describe('SHA256Schema', () => {
  it('should accept valid SHA-256 hash', () => {
    const validHash = 'a'.repeat(64);
    const result = SHA256Schema.safeParse(validHash);
    expect(result.success).toBe(true);
  });

  it('should reject hash with wrong length', () => {
    const shortHash = 'a'.repeat(63);
    const result = SHA256Schema.safeParse(shortHash);
    expect(result.success).toBe(false);
  });

  it('should reject hash with invalid characters', () => {
    const invalidHash = 'g'.repeat(64);
    const result = SHA256Schema.safeParse(invalidHash);
    expect(result.success).toBe(false);
  });

  it('should reject uppercase characters', () => {
    const uppercaseHash = 'A'.repeat(64);
    const result = SHA256Schema.safeParse(uppercaseHash);
    expect(result.success).toBe(false);
  });
});

describe('calculateChecksumFromContent', () => {
  it('agrees with the file-reading half on plain ASCII', async () => {
    const content = '# Hello\n\nplain ascii body\n';
    const file = await fixtures.write('ascii.md', Buffer.from(content, 'utf-8'));

    expect(await calculateChecksum(file)).toBe(calculateChecksumFromContent(content));
  });

  /**
   * The distinguishing fixture.
   *
   * VAT has TWO deliberately different keyspaces over the same file:
   * `calculateChecksum` hashes the DECODED UTF-8 STRING, while
   * `content-key.ts` hashes the RAW BYTES (because decoding is lossy — see that
   * module's docstring). On ASCII input the two digests are IDENTICAL, so an
   * ASCII-only suite cannot tell them apart and would stay green if someone
   * "unified" the checksum onto raw bytes.
   *
   * A lone 0xFF is invalid UTF-8 and decodes to U+FFFD, which re-encodes to
   * THREE bytes. That is the only condition under which the decoded-string
   * digest and the raw-byte digest disagree.
   */
  it('hashes the decoded string, NOT the raw bytes on disk', async () => {
    const bytes = Uint8Array.from([...Buffer.from('# Bad\n'), 0xff, ...Buffer.from('\n')]);
    const file = await fixtures.write('malformed.md', bytes);

    const decoded = await readFile(file, 'utf-8');
    const decodedDigest = createHash('sha256').update(decoded, 'utf-8').digest('hex');
    const rawByteDigest = createHash('sha256').update(bytes).digest('hex');

    // GUARD THE FIXTURE. If these ever stop differing the fixture is inert and
    // every assertion below becomes vacuous — which is exactly how this
    // invariant went unguarded before.
    expect(decoded).toContain('�');
    expect(bytes.byteLength).toBe(8);
    expect(Buffer.byteLength(decoded)).toBe(10);
    expect(decodedDigest).not.toBe(rawByteDigest);

    // The invariant: both halves land on the DECODED-string digest.
    expect(calculateChecksumFromContent(decoded)).toBe(decodedDigest);
    expect(await calculateChecksum(file)).toBe(decodedDigest);
    expect(await calculateChecksum(file)).not.toBe(rawByteDigest);
  });
});
