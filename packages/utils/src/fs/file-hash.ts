import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * Compute the SHA-256 hash of a file's raw bytes.
 *
 * Reads the file synchronously and returns the full lowercase hex digest (64
 * characters). The hash is computed over the raw byte content, so it is stable
 * across platforms for identical file content and changes whenever the content
 * changes.
 *
 * @param path - Absolute (or relative) path to the file to hash.
 * @returns Lowercase hex SHA-256 digest string (64 characters).
 *
 * @example
 * const hash = fileContentHash('/path/to/file.txt');
 * // '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
 */
export function fileContentHash(path: string): string {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is caller-supplied; callers are responsible for path safety
  const bytes = readFileSync(path);
  return createHash('sha256').update(bytes).digest('hex');
}
