/**
 * Fixture for `test/subpath-purity.test.ts`.
 *
 * Reached only through an `export … from` edge in `entry.ts`. Its own `node:`
 * import is what proves the walker FOLLOWED that edge rather than merely
 * recording the specifier: an `export … from` the walker cannot traverse would
 * leave `node:crypto` unreported while every other assertion still passed.
 *
 * Not compiled (tsconfig includes `src/**` only) and not linted
 * (`**\/test/fixtures/**` is ignored).
 */

import { randomUUID } from 'node:crypto';

export const id = randomUUID;
