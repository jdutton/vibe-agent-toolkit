/**
 * Minimal `resource_realizations` / `resource_tags` / `harness_blob_facts` row builders for the
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

import { RULE_SCOPE_TAG } from '../../src/projection/agentic-tags.js';
import { harnessPaths, selectRules, type RuleAdmission } from '../../src/projection/claude-context-rules.js';
import { harnessFactsIndex, type HarnessFactsIndex } from '../../src/projection/harness/facts-index.js';
import type { HarnessBlobFactsRow } from '../../src/schemas/projection-harness.js';
import type {
  ResourceRealizationRow,
  ResourceTagRow,
} from '../../src/schemas/projection-resources.js';

/**
 * A realization carrying only the columns the context selectors read.
 *
 * ⚠️ Deliberately NOT a schema-valid content key (`key:<path>`, not
 * `<parserKind>.<sha256>`): these rows are never validated, and a recognisable
 * key makes the facts join in the rules suite readable at a glance. Every
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

/**
 * The Claude Code facts row {@link queryRealization}'s content key points at,
 * carrying a `paths:` list — `paths`, the one column the rules selector reads,
 * read the harness's way (`harnessPaths`).
 *
 * @param path - The rules file's root-relative path
 * @param paths - Its `paths:` entries, or undefined for a file with no frontmatter
 * @returns The facts row
 */
export function queryPathsBlob(path: string, paths: readonly string[] | undefined): HarnessBlobFactsRow {
  return {
    blob: `key:${path}`,
    harness: 'claude-code',
    injectedBytes: 100,
    injectedTokens: 25,
    paths: paths === undefined ? null : harnessPaths({ paths: [...paths] }),
  };
}

/**
 * The facts index `selectRules` reads, over hand-built facts rows.
 *
 * @param rows - The facts rows, one per rule
 * @returns Claude Code's index over them
 */
export function queryFacts(rows: readonly HarnessBlobFactsRow[]): HarnessFactsIndex {
  return harnessFactsIndex({ harnessBlobFacts: rows, harnessBlobImports: [] }, 'claude-code');
}

/**
 * One path-scoped rule's selection for a query, over a set of realized files.
 *
 * @param rulePath - The rules file's root-relative path
 * @param paths - Its `paths:` entries
 * @param files - The realized files beside it
 * @param queryDir - The query directory
 * @param queryFile - The query file, or null for a directory query
 * @returns The admissions the query produced
 */
export function pathScopedAdmissions(
  rulePath: string,
  paths: readonly string[],
  files: readonly string[],
  queryDir: string,
  queryFile: string | null,
): readonly RuleAdmission[] {
  return selectRules({
    realizations: [queryRealization(rulePath), ...files.map((file) => queryRealization(file))],
    tags: [queryTag(rulePath, RULE_SCOPE_TAG, 'path-scoped')],
    facts: queryFacts([queryPathsBlob(rulePath, paths)]), queryDir, queryFile,
  }).rules.map((rule) => rule.admission);
}
