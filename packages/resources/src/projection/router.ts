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

import { matchesCollection } from '../collection-matcher.js';
import { NO_PARSER_KIND, type ParserKind } from '../content-key.js';
import { type DocumentParserKind, mimeTypeForPath, parserKindForMimeType } from '../mime-type.js';
import type { CollectionConfig, ProjectConfig } from '../schemas/project-config.js';

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
  /** Its patterns, for {@link matchesCollection}. */
  config: CollectionConfig;
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
      config.mimeType === undefined ? [] : [{ name, mimeType: config.mimeType, config }]
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
      const matched = declaring.filter((candidate) => matchesCollection(absolutePath, candidate.config));
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

/**
 * Every parser kind, keyed by itself.
 *
 * The redundant-looking `markdown: 'markdown'` earns its place twice over. The
 * KEY set is what `satisfies Record<ParserKind, ParserKind>` checks for
 * exhaustiveness, so a fourth kind added in `content-key.ts` stops this file
 * compiling instead of falling into an else-branch. The VALUES are already typed
 * as the union, so {@link parserKindOf} can hand one back without casting a
 * substring of a key into a type nobody checked.
 *
 * The shape exists because the else-branch shape has now shipped the same defect
 * twice, one level apart. `parserKindForPath` was
 * `endsWith('.html') ? html : markdown` and handed every `.ts` file in a
 * repository to remark; {@link parserKindOf} was
 * `startsWith('html.') ? 'html' : 'markdown'` and, the instant `none` existed,
 * silently relabelled every `none.` key as markdown — with no type error
 * anywhere, because both arms of that ternary are valid {@link ParserKind}s.
 */
const PARSER_KIND_BY_NAME = {
  markdown: 'markdown',
  html: 'html',
  none: 'none',
} as const satisfies Record<ParserKind, ParserKind>;

/**
 * `<kind>.` → the kind it names, derived from {@link PARSER_KIND_BY_NAME} rather
 * than written out again, so a prefix table and a kind set cannot drift apart.
 *
 * The `.` is part of the lookup key on purpose: matching bare kind names would
 * make a future `markdown-lite` collide with `markdown`, which is the same class
 * of near-miss `startsWith` invited.
 */
const PARSER_KIND_BY_PREFIX = new Map<string, ParserKind>(
  Object.values(PARSER_KIND_BY_NAME).map((kind) => [`${kind}.`, kind]),
);

/**
 * The parser a blob's bytes were routed to, read back off its own key.
 *
 * `computeContentKey` mixes the parser kind into the hash preimage *and* spells
 * it as the key's prefix, so the key is the authoritative record of the routing
 * decision the base already made. Calling `parserKindForPath` again here would
 * be a second run of the discriminator against a path — and at least one shipped
 * caller deliberately parses `.html` as markdown, so the two answers can
 * legitimately differ.
 *
 * Exported for one reason: the mislabel this function shipped is invisible to
 * `tsc` — every branch returns a valid {@link ParserKind} — so the only thing
 * that can catch it is a test that asks all three prefixes directly.
 *
 * @param contentKey - A `<parserKind>.<sha256>` key
 * @returns The parser kind the key names
 * @throws {Error} If the key names no kind. Unreachable through
 *   `ContentKeySchema`, which is exactly why guessing would be worse: a default
 *   would derive a whole blob's worth of real-looking facts under a parser
 *   nothing routed those bytes to, and nothing downstream could tell.
 */
export function parserKindOf(contentKey: string): ParserKind {
  const kind = PARSER_KIND_BY_PREFIX.get(contentKey.slice(0, contentKey.indexOf('.') + 1));
  if (kind === undefined) {
    throw new Error(
      `Content key "${contentKey}" names no parser kind. Keys are minted only by `
      + '`computeContentKey` and validated by `ContentKeySchema`, so this is a producer bug '
      + 'rather than anything the corpus did.',
    );
  }
  return kind;
}
