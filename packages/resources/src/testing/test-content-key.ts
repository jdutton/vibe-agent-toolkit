import { createHash } from 'node:crypto';

import { type ContentKey, formatContentKey, type ParserKind } from '../content-key.js';

/**
 * A well-formed `sha256` content key for a test fixture: the one way a suite writes a key it did
 * not compute from bytes, so no fixture spells the key format by hand.
 *
 * @param kind - The parser kind the key names
 * @param seed - Any string; equal seeds give equal keys, distinct seeds distinct keys
 * @returns `<kind>.sha256.<SHA-256 of the seed>`
 */
export function testContentKey(kind: ParserKind, seed: string): ContentKey {
  return formatContentKey({ parserKind: kind, keyKind: 'sha256', hex: createHash('sha256').update(seed, 'utf-8').digest('hex') });
}
