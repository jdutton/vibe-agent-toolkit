import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';

import type { SHA256 } from './schemas/checksum.js';
import { SHA256Schema } from './schemas/checksum.js';

/**
 * Calculate SHA-256 checksum of a file
 * @param filePath Absolute path to file
 * @returns SHA-256 checksum as lowercase hex string
 * @throws Error if file cannot be read
 */
export async function calculateChecksum(filePath: string): Promise<SHA256> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const content = await fs.readFile(filePath, 'utf-8');
  const hash = createHash('sha256').update(content, 'utf-8').digest('hex');
  return SHA256Schema.parse(hash);
}
