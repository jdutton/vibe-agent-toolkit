/**
 * Convert an RFC 6901 JSON Pointer string into a path of (string | number)
 * segments suitable for use with the FrontmatterEditor mutation API.
 *
 * Canonical array indices (RFC 6901 §4: no leading zeros except for "0")
 * are converted to numbers; all other segments are decoded strings.
 *
 * @example
 *   jsonPointerToPath('/adrs-cited/0') // ['adrs-cited', 0]
 *   jsonPointerToPath('')              // []
 */

import { decodeJsonPointerSegment, isCanonicalArrayIndex } from './utils.js';

export function jsonPointerToPath(pointer: string): (string | number)[] {
  if (pointer === '') return [];
  // eslint-disable-next-line local/no-hardcoded-path-split -- RFC 6901 JSON Pointer delimiter, not a file path
  const raw = pointer.slice(1).split('/');
  const result: (string | number)[] = [];
  for (const seg of raw) {
    const decoded = decodeJsonPointerSegment(seg);
    if (isCanonicalArrayIndex(decoded)) {
      result.push(Number(decoded));
    } else {
      result.push(decoded);
    }
  }
  return result;
}
