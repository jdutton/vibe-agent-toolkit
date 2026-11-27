/**
 * Data files built against a data-extractor job's own output caps, for suites in more than one
 * package that seed a file past them.
 */

import { DATA_OUTPUT_CAPS } from '../parse-limits.js';

/** The key every element's pointer carries: long enough that a few thousand elements pass a cap. */
const LONG_KEY_LENGTH = 10_000;

/**
 * Rows whose JSON passes `outputBytes` from a few tens of kilobytes: one wide array under a long
 * key, each element's pointer carrying the key, so the rows pass the byte cap far under the row
 * cap and far under `inputBytes`.
 *
 * @param outputBytes - The byte cap to pass; the data job's own when none is given
 * @returns The JSON text
 */
export function pastDataBytes(outputBytes: number = DATA_OUTPUT_CAPS.outputBytes): string {
  const elements = Math.ceil(outputBytes / LONG_KEY_LENGTH);
  return `{"${'k'.repeat(LONG_KEY_LENGTH)}": [${Array.from({ length: elements }, () => '0').join(',')}]}\n`;
}
