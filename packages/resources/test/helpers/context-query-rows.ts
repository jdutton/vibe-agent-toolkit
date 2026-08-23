/**
 * Minimal `resource_realizations` / `resource_tags` row builders for the two
 * Claude-context SELECTOR suites — `projection-claude-context-ancestry.test.ts`
 * and `projection-claude-context-rules.test.ts`.
 *
 * ## Why these are not `claude-context-fixture.ts`
 *
 * That helper assembles a whole `Projection` by running the SHIPPED
 * contributors, which is exactly what an end-to-end `whatLoadsAt` test needs and
 * is the reason its rows carry real content keys, real parsed frontmatter and
 * real derived columns. `claudeAncestry` and `selectRules` are the pure
 * selection functions UNDER that query: each takes loose row arrays and reads a
 * handful of columns. Handing them a contributor-built projection would make
 * every one of their assertions depend on what the contributors happen to emit,
 * which is the coupling those suites exist to avoid — so they hand-build the
 * minimum row instead, and it is built here once rather than once per suite.
 */

import type {
  ResourceRealizationRow,
  ResourceTagRow,
} from '../../src/schemas/projection-resources.js';

/**
 * A realization carrying only the columns the context selectors read.
 *
 * ⚠️ Deliberately NOT a schema-valid content key (`key:<path>`, not
 * `<parserKind>.<sha256>`): these rows are never validated, and a recognisable
 * key makes the `blobs` join in the rules suite readable at a glance. Every
 * other column is either derived from `path` or the quiet default, so a suite
 * that cares about one of them overrides it at the call site and the override is
 * visible in the test rather than buried here.
 *
 * @param path - Root-relative, forward-slashed fixture path
 * @returns The realization row for that path
 */
export function queryRealization(path: string): ResourceRealizationRow {
  // eslint-disable-next-line local/no-hardcoded-path-split -- fixture paths are authored forward-slashed, matching resource_realizations.path's own convention
  const segments = path.split('/');
  return {
    resourceId: `id:${path}`,
    extentId: 'extent:fs',
    path,
    pathLower: path.toLowerCase(),
    basenameLower: (segments.at(-1) ?? '').toLowerCase(),
    dir: segments.slice(0, -1).join('/'),
    depth: segments.length - 1,
    ext: '.md',
    contentKey: `key:${path}`,
    contentState: 'keyed',
    mtime: null,
    exists: true,
    isDirectory: false,
    gitignored: false,
    isSymlink: false,
    symlinkResolves: null,
  };
}

/**
 * One tag against {@link queryRealization}'s identity for the same path.
 *
 * The identity is spelled the same way in both builders on purpose: the
 * selectors join realizations to tags on `resourceId`, so a fixture whose two
 * halves minted ids differently would silently produce an untagged path — which
 * both suites have a real test for, and which must therefore never happen by
 * accident.
 *
 * @param path - The path whose identity the tag is filed against
 * @param tag - The tag name, from the shipped producer's own constant
 * @param value - The tag's value, or null for a boolean-presence tag
 * @returns The tag row
 */
export function queryTag(path: string, tag: string, value: string | null): ResourceTagRow {
  return { resourceId: `id:${path}`, tag, value, source: 'builtin' };
}
