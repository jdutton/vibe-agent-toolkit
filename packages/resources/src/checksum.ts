import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';

import type { SHA256 } from './schemas/checksum.js';
import { SHA256Schema } from './schemas/checksum.js';

/**
 * Calculate the SHA-256 checksum of already-decoded file content.
 *
 * The preimage is the **decoded UTF-8 string**, deliberately — not the raw
 * bytes on disk. This is user-facing identity (`vat resources scan --verbose`,
 * the cache detector, `getResourcesByChecksum`) and must stay stable.
 *
 * Do NOT confuse this with the content key in `content-key.ts`, which hashes
 * RAW BYTES precisely because decoding is lossy. Two keyspaces, two purposes;
 * on ASCII they coincide, on malformed UTF-8 they must not. See
 * `test/checksum.test.ts` for the fixture that keeps that falsifiable.
 *
 * Exists so a caller that already holds the content does not have to read the
 * file a second time just to checksum it.
 *
 * @param content Decoded file content
 * @returns SHA-256 checksum as lowercase hex string
 */
export function calculateChecksumFromContent(content: string): SHA256 {
  const hash = createHash('sha256').update(content, 'utf-8').digest('hex');
  return SHA256Schema.parse(hash);
}

/**
 * Calculate SHA-256 checksum of a file
 * @param filePath Absolute path to file
 * @returns SHA-256 checksum as lowercase hex string
 * @throws Error if file cannot be read
 */
export async function calculateChecksum(filePath: string): Promise<SHA256> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const content = await fs.readFile(filePath, 'utf-8');
  return calculateChecksumFromContent(content);
}
