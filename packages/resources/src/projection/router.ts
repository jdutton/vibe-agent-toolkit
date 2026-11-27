/**
 * The projection router: the one module that answers "which parser reads this path".
 *
 * ADR I4 (one router): path -> mime (`mimeTypeForPath`, or a collection's
 * declared `mimeType`) -> parser kind (`parserKindForMimeType`) is composed here
 * and nowhere else; no other shipping `src` file imports either table function
 * (enforced by `packages/dev-tools/test/parser-kind-router-boundary.test.ts`).
 * A directory is not routed here: callers that walk directories keep their own
 * `isDirectory` test.
 *
 * A lane outside the projection (the registry's read and sizing tally, `vat
 * validate`'s checks overlap gate) routes through {@link parseRoutingFor} and
 * {@link parserKindForResolvedPath}, so it reaches the projection lane's verdict.
 * A kind a contract fixes is {@link MARKDOWN_BY_CONTRACT}. The parser-kind
 * decisions still spelled outside this module are a counted, reviewed list,
 * recorded as a known defect ("parser-kind decisions outside the router") and
 * held by `packages/dev-tools/test/parser-kind-decisions.test.ts`.
 */

import picomatch from 'picomatch';

import { type CollectionMatcher, compileCollectionMatcher } from '../collection-matcher.js';
import { NO_PARSER_KIND, type ParserKind } from '../content-key.js';
import { type DocumentParserKind, mimeTypeForPath, parserKindForMimeType } from '../mime-type.js';
import type { CollectionConfig, ProjectConfig } from '../schemas/project-config.js';
import type { DataVariant } from '../schemas/projection-data.js';

import { canonicalJson } from './digest.js';
import { relativize } from './root-relative-path.js';

/**
 * The type of one path: the run's collection resolver's answer when it has one,
 * the built-in table's otherwise.
 *
 * @param resolver - The run's collection-aware resolver, when it has one
 * @param absolutePath - The path to type
 * @param relativePath - Root-relative spelling, for the resolver's conflict rows
 * @returns The type, or null when nothing names one
 */
export function mimeFor(
  resolver: CollectionMimeResolver | undefined,
  absolutePath: string,
  relativePath: string,
): string | null {
  return resolver === undefined ? mimeTypeForPath(absolutePath) : resolver.mimeFor(absolutePath, relativePath);
}

/**
 * The parser kind for a type, with `none` for a type no parser reads.
 *
 * Non-nullable so the sites that start from a stored or resolved type compare
 * against {@link NO_PARSER_KIND} rather than each spelling a null test. The
 * `ParserKind` return type binds the two modules' kind sets: a kind added in
 * `mime-type.ts` and not to `content-key.ts`'s `PARSER_KINDS` fails to compile.
 *
 * @param mime - The type, or null when the path has none
 * @returns The parser kind VAT hands a file of this type to, or `none`
 */
export function parserKindForMime(mime: string | null): ParserKind {
  return parserKindForMimeType(mime) ?? NO_PARSER_KIND;
}

/**
 * The parser kind of a document a CONTRACT makes markdown, whatever its path
 * says: a `SKILL.md`, a Claude Code skill, agent or command file, an OKF
 * document, or a frontmatter block cut out of one. Only the sites a contract
 * decides may use it, a counted list held both ways by
 * `packages/dev-tools/test/parser-kind-decisions.test.ts`, so a decision the
 * path makes cannot be relabelled a contract. A document whose PATH decides
 * takes {@link parserKindForPath} or {@link parserKindForResolvedPath}.
 */
export const MARKDOWN_BY_CONTRACT = 'markdown' satisfies DocumentParserKind;

/**
 * Which parser handles a document, judged by its path alone.
 *
 * Path-only: it IGNORES a collection's declared `mimeType`. Its two
 * cross-package callers, `agent-skills/src/walk-link-graph.ts` and
 * `cli/src/pipeline-oracles/parse-fact-snapshot.ts`, therefore answer `none` for
 * a `.ts` file a collection types `text/markdown` while the projection and
 * registry lanes answer `markdown`. That divergence is recorded, not fixed here;
 * whether they should take the run's resolver is a follow-up. A lane that has
 * the resolver uses {@link mimeFor} and {@link parserKindForMime} instead.
 *
 * @param filePath - Path the document was read from (need not exist)
 * @returns The parser kind VAT will hand this document to, or `none`
 */
export function parserKindForPath(filePath: string): ParserKind {
  return parserKindForMime(mimeTypeForPath(filePath));
}

/**
 * One file that two collections declare incompatible types for. A pair, not a
 * list: naming two is enough for the author's first edit.
 */
export interface CollectionMimeConflict {
  /** Root-relative path of the file the collections disagree about. */
  path: string;
  /** The two collections, in the order the config declares them. */
  collections: readonly [string, string];
  /** What each of them declared, positionally paired with {@link collections}. */
  mimeTypes: readonly [string, string];
}

/**
 * The run's answer to "what is this file", and the config errors it found asking.
 * Stateful: one path is walked once per extent, so the conflict accumulator
 * outlives a single `collectRealization` call and reports each file once.
 */
export interface CollectionMimeResolver {
  /**
   * Type one path, recording a conflict rather than throwing on one.
   *
   * @param absolutePath - The path to type, matched against collection patterns
   * @param relativePath - The path as `resource_realizations.path` spells it,
   *   which is what a conflict names (an absolute path would leak `$HOME`)
   * @returns The declared type, or `mime-type.ts`'s answer when nothing declared
   *   one or the declarations conflict
   */
  mimeFor(absolutePath: string, relativePath: string): string | null;
  /** Every conflict seen so far, one per path, in first-encounter order. Read it after the population. */
  readonly conflicts: readonly CollectionMimeConflict[];
  /**
   * A digest of the routing rules, folded into the store key by `storeKeyFor`
   * (merge.ts, which says why). Declaration ORDER is part of it and must not be
   * sorted away: the first match is the one a conflict row names.
   */
  readonly fingerprint: string;
}

/** The fingerprint of a routing no collection contributes to: a legible literal, as nearly every run carries it. */
export const NO_DECLARED_MIME_TYPES = 'mime:none-declared';

/** A collection that actually declares a type, the only kind that participates. */
interface DeclaringCollection {
  /** The collection's name, as the config keys it. */
  name: string;
  /** The type it declares. */
  mimeType: string;
  /** Its patterns, as declared: the fingerprint's input. */
  config: CollectionConfig;
  /** Its patterns compiled once, when the resolver is built. */
  matches: CollectionMatcher;
}

/**
 * Build the run's MIME resolver from the project's collections.
 *
 * Only a collection that declares a `mimeType` participates. However many
 * declare the SAME type, that is the answer; two distinct values are recorded as
 * a {@link CollectionMimeConflict} and the file takes `mime-type.ts`'s answer, so
 * the run completes with every offending file named. (One file parsed by two
 * parsers is not representable: a blob has one content key.)
 *
 * @param collections - The project's `resources.collections`, or undefined
 * @returns A resolver whose conflicts accumulate across every path it is asked about
 */
export function createCollectionMimeResolver(
  collections: Readonly<Record<string, CollectionConfig>> | undefined,
): CollectionMimeResolver {
  const declaring: DeclaringCollection[] = Object.entries(collections ?? {})
    .flatMap(([name, config]) => (
      config.mimeType === undefined
        ? []
        : [{ name, mimeType: config.mimeType, config, matches: compileCollectionMatcher(config) }]
    ));
  const conflicts: CollectionMimeConflict[] = [];
  // Keyed on the path: one file is one authoring mistake however many extents realize it.
  const reported = new Set<string>();
  // Off the same `declaring` array the matcher uses, in declaration order.
  const fingerprint = declaring.length === 0
    ? NO_DECLARED_MIME_TYPES
    : canonicalJson(declaring.map((candidate) => ({
      name: candidate.name,
      mimeType: candidate.mimeType,
      include: candidate.config.include,
      exclude: candidate.config.exclude ?? null,
    })));

  return {
    conflicts,
    fingerprint,
    mimeFor(absolutePath: string, relativePath: string): string | null {
      const matched = declaring.filter((candidate) => candidate.matches(absolutePath));
      const winner = matched[0];
      if (winner === undefined) {
        return mimeTypeForPath(absolutePath);
      }
      const rival = matched.find((candidate) => candidate.mimeType !== winner.mimeType);
      if (rival === undefined) {
        return winner.mimeType;
      }
      if (!reported.has(relativePath)) {
        reported.add(relativePath);
        conflicts.push({
          path: relativePath,
          collections: [winner.name, rival.name],
          mimeTypes: [winner.mimeType, rival.mimeType],
        });
      }
      return mimeTypeForPath(absolutePath);
    },
  };
}

/**
 * The parser kind a resolved path goes to through a run's collection MIME resolver,
 * so a declared `mimeType` overrides the extension table.
 *
 * @param absolutePath - The resolved path to route
 * @param resolver - The run's collection MIME resolver; it falls back to the
 *   built-in table for every path no declaration matches
 * @param baseDir - The directory declarations are relative to, or undefined to
 *   match them against the absolute path
 * @returns The parser kind, or `none` when nothing parses this type
 */
export function parserKindForResolvedPath(
  absolutePath: string,
  resolver: CollectionMimeResolver,
  baseDir: string | undefined,
): ParserKind {
  return parserKindForMime(mimeFor(resolver, absolutePath, baseDir === undefined ? absolutePath : relativize(absolutePath, baseDir)));
}

/**
 * A parse routing: its collection MIME resolver and the directory declarations are relative to
 * (`undefined` for a registry not yet given one, which matches declarations against the absolute path).
 */
export interface ParseRouting<Base extends string | undefined> {
  readonly resolver: CollectionMimeResolver;
  readonly baseDir: Base;
}

/**
 * The one constructor of a parse routing from a project config: the registry's read and sizing,
 * `vat validate`'s checks overlap gate, and a caller judging what the gate decides all build theirs
 * here, never a resolver of their own.
 *
 * @param config - The project config, if there is one
 * @param baseDir - The directory collection declarations are relative to
 * @returns The routing
 */
export function parseRoutingFor<Base extends string | undefined>(config: ProjectConfig | undefined, baseDir: Base): ParseRouting<Base> {
  return { resolver: createCollectionMimeResolver(config?.resources?.collections), baseDir };
}

/** One compiled glob list: whether a root-relative path matches any of its patterns. */
type PathMatcher = (relativePath: string) => boolean;

/** Every data glob is matched this way: dot directories and dot files are ordinary path segments. */
const DATA_GLOB_OPTIONS = { dot: true } as const;

/** Compile a glob list once; an absent or empty list matches nothing. */
function compileGlobs(patterns: readonly string[] | undefined): PathMatcher {
  return patterns === undefined || patterns.length === 0 ? () => false : picomatch([...patterns], DATA_GLOB_OPTIONS);
}

/** Never routed, whatever the config says: a dependency's files are not the project's data. */
const NEVER_DATA: PathMatcher = compileGlobs(['**/node_modules/**']);

/**
 * The one route of variant `ini`, asked before every rule but `exclude`: an `.npmrc` is read as
 * `ini` or not at all. No `jsonc` glob can make it JSONC, and no other path is ever `ini` (no
 * extension in {@link VARIANT_BY_EXTENSION} names it), so no routing reaches the `.npmrc`
 * allowlist (`data-ini.ts`) with another file, or reaches an `.npmrc` without it.
 */
const NPMRC: PathMatcher = compileGlobs(['**/.npmrc']);

/** The default routes, in the order they are asked; the first match names the variant. */
const DEFAULT_DATA_ROUTES: ReadonlyArray<{ readonly matches: PathMatcher; readonly variant: DataVariant }> = [
  { matches: compileGlobs(['**/package.json']), variant: 'json' },
  { matches: compileGlobs(['**/tsconfig*.json', '**/jsconfig*.json']), variant: 'jsonc' },
  { matches: compileGlobs(['**/pnpm-workspace.yaml']), variant: 'yaml' },
];

/** The variant an `include`d path takes from its extension, matched case-insensitively. */
const VARIANT_BY_EXTENSION: ReadonlyMap<string, DataVariant> = new Map([
  ['.json', 'json'],
  ['.jsonc', 'jsonc'],
  ['.yaml', 'yaml'],
  ['.yml', 'yaml'],
]);

/** `a`, `a or b`, `a, b or c`: a list as a sentence spells it. */
function spokenList(items: readonly string[]): string {
  return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} or ${items.at(-1) ?? ''}`;
}

/** The extensions `include` routes, for a message: spelled from {@link VARIANT_BY_EXTENSION}, never by hand. */
const INCLUDED_EXTENSIONS = spokenList([...VARIANT_BY_EXTENSION.keys()]);

/**
 * The `data` instance's static routing for one project config, its globs compiled once. Build it
 * with {@link dataRoutingFor}; ask it with {@link dataRouteFor}.
 */
export interface DataRouting {
  /** Whether the config declares `resources.extractors.data` (an empty block counts). */
  readonly declared: boolean;
  /** Whether a declared instance that examined nothing is legitimate (`allowEmpty: true`). */
  readonly allowEmpty: boolean;
  /** The `exclude` globs: a match is never routed. */
  readonly exclude: PathMatcher;
  /** The `jsonc` globs: a match is `jsonc` whatever its extension. */
  readonly jsonc: PathMatcher;
  /** The `include` globs: a match is routed by its extension. */
  readonly include: PathMatcher;
  /** Each `include` glob with its own matcher, so one that routes nothing can be named. */
  readonly includeGlobs: ReadonlyArray<{ readonly glob: string; readonly matches: PathMatcher }>;
}

/**
 * The one constructor of a data routing from a project config. Pure: no file system, no process state.
 *
 * @param config - The project config, if there is one
 * @returns The routing; with no `resources.extractors.data` block, the defaults only, undeclared
 */
export function dataRoutingFor(config: ProjectConfig | undefined): DataRouting {
  const data = config?.resources?.extractors?.data;
  return {
    declared: data !== undefined,
    allowEmpty: data?.allowEmpty === true,
    exclude: compileGlobs(data?.exclude),
    jsonc: compileGlobs(data?.jsonc),
    include: compileGlobs(data?.include),
    includeGlobs: (data?.include ?? []).map((glob) => ({ glob, matches: compileGlobs([glob]) })),
  };
}

/** The variant an `include`d path takes from its extension, or undefined for any other extension. */
function variantByExtension(relativePath: string): DataVariant | undefined {
  const dot = relativePath.lastIndexOf('.');
  return dot > relativePath.lastIndexOf('/') ? VARIANT_BY_EXTENSION.get(relativePath.slice(dot).toLowerCase()) : undefined;
}

/**
 * The variant the `data` instance reads one path as, or undefined when it does not read it. One
 * variant per path: `exclude` removes it; else an `.npmrc` is `ini` ({@link NPMRC}); else a `jsonc`
 * glob makes it `jsonc`; else a default names
 * its variant ({@link DEFAULT_DATA_ROUTES}, in order); else an `include` glob routes it by extension
 * ({@link VARIANT_BY_EXTENSION}, case-insensitive; any other extension is not routed).
 * `**\/node_modules/**` is never routed. Pure: a function of the path and the routing alone.
 *
 * @param relativePath - The path relative to the project root, forward slashes, no leading `./`
 * @param routing - The project's routing, from {@link dataRoutingFor}
 * @returns The variant, or undefined when the path is not routed
 */
export function dataRouteFor(relativePath: string, routing: DataRouting): DataVariant | undefined {
  const decision = dataRouteDecision(relativePath, routing);
  return 'variant' in decision ? decision.variant : undefined;
}

/**
 * How the `data` instance's routing decides one path: the variant it reads the path as, or why it
 * reads it not at all.
 */
type DataRouteDecision =
  | { readonly variant: DataVariant }
  /** `excluded`: an `exclude` glob matches it. `unrouted`: no rule routes it (`**\/node_modules/**` included). */
  | { readonly unrouted: 'excluded' | 'unrouted' };

/**
 * The one routing decision behind {@link dataRouteFor}, with why a path is not routed. Pure.
 *
 * @param relativePath - The path relative to the project root, forward slashes, no leading `./`
 * @param routing - The project's routing, from {@link dataRoutingFor}
 * @returns The variant, or why the path is not routed
 */
export function dataRouteDecision(relativePath: string, routing: DataRouting): DataRouteDecision {
  if (NEVER_DATA(relativePath)) return { unrouted: 'unrouted' };
  if (routing.exclude(relativePath)) return { unrouted: 'excluded' };
  if (NPMRC(relativePath)) return { variant: 'ini' };
  if (routing.jsonc(relativePath)) return { variant: 'jsonc' };
  const byDefault = DEFAULT_DATA_ROUTES.find((route) => route.matches(relativePath));
  if (byDefault !== undefined) return { variant: byDefault.variant };
  const byExtension = routing.include(relativePath) ? variantByExtension(relativePath) : undefined;
  return byExtension === undefined ? { unrouted: 'unrouted' } : { variant: byExtension };
}

/**
 * Why a routing is a config error over one run's extent, or undefined when it is not: a declared
 * instance that routed no path, or an `include` glob that matches no path outside `**\/node_modules/**`
 * with an extension {@link VARIANT_BY_EXTENSION} routes (a typo, or a glob for another extension,
 * which `include` never routes); the message names those extensions from the map itself. Such
 * a glob is named even when the defaults route other files, since it would otherwise be ignored
 * without a word. `allowEmpty: true` excuses both. A glob whose paths an earlier rule also decides
 * (`exclude`, `jsonc`, a default) still matches, so it is not named. Pure.
 *
 * @param routedCount - How many paths the routing routed in the extent
 * @param paths - Every path the extent holds that the routing was asked about
 * @param routing - The project's routing, from {@link dataRoutingFor}
 * @returns The `CONFIG_INVALID` message, or undefined
 */
export function dataRoutingEmptiness(routedCount: number, paths: readonly string[], routing: DataRouting): string | undefined {
  if (!routing.declared || routing.allowEmpty) return undefined;
  if (routedCount === 0) {
    return 'resources.extractors.data is declared, but it routed no file in this run\'s extent. Fix its globs,'
      + ' or set allowEmpty: true when an empty instance is expected.';
  }
  const candidates = paths.filter((path) => !NEVER_DATA(path) && variantByExtension(path) !== undefined);
  const inert = routing.includeGlobs.filter(({ matches }) => !candidates.some((path) => matches(path)));
  if (inert.length === 0) return undefined;
  const named = inert.map(({ glob }) => `resources.extractors.data.include glob "${glob}"`).join(', ');
  return `${named} matches no ${INCLUDED_EXTENSIONS} file in this run's extent, so it routes nothing.`
    + ' Fix the glob (an include routes by extension; list another extension under jsonc instead),'
    + ' or set allowEmpty: true when it is expected to match nothing.';
}
