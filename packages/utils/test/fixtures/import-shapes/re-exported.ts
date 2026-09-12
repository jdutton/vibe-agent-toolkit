/**
 * Fixture for `test/subpath-purity.test.ts`.
 *
 * Reached only through an `export … from` edge in `entry.ts`. Its own `node:`
 * edge is what proves the walker FOLLOWED that edge rather than merely
 * recording the specifier: an `export … from` the walker cannot traverse would
 * leave `node:crypto` unreported while every other assertion still passed.
 * That edge is itself an `export … from`, so the builtin is reached through
 * two re-export hops, not one.
 *
 * Not compiled (tsconfig includes `src/**` only) and not linted
 * (`**\/test/fixtures/**` is ignored).
 */

export { randomUUID as id } from 'node:crypto';
