/**
 * Shapes for the intermediate correctness oracles.
 *
 * See `./README.md` for what these are for and why a whole-command golden is
 * not sufficient on its own.
 */

/**
 * The corpus-enumerating routines VAT actually has. There is no single one —
 * there are five, and they disagree about what the corpus is. Each is named
 * here by the lane that owns it, so a snapshot can say *whose* population
 * changed rather than only *that* output changed.
 */
export type LaneId =
  /** `vat resources scan` / `vat resources validate` — the only config-aware lane. */
  | 'resources'
  /** `vat audit` and post-build validation — memoized per root, deliberately config-less. */
  | 'audit'
  /** `vat skills build` — via `createProjectRegistry`; config-aware but markdown-only. */
  | 'skills-build'
  /** `vat inventory` — the only lane that asks git for untracked files. */
  | 'inventory'
  /** `vat skills validate` — a batch-scoped shared registry, markdown-only, config-less. */
  | 'skills-validate';

/** Which of `crawlDirectory`'s two mutually exclusive routes answered the crawl. */
export type EnumerationRoute =
  /** `git ls-files` answered. Output is git-sorted, hence portable across hosts. */
  | 'git-ls-files'
  /**
   * A recursive `readdirSync` walk answered, because there was no git root (or
   * git failed). Output is in **filesystem order**, which differs between ext4,
   * APFS and NTFS — so an ordered golden captured on one host does not hold on
   * another. Snapshots taken on this route are order-stable within a host and
   * only set-comparable across hosts.
   */
  | 'walk';

/**
 * One enumerated path and the cheap attributes later stages must not go compute
 * for themselves.
 *
 * `gitignored` is worth stating plainly: on the `git-ls-files` route it is
 * constant-`false`, because `git ls-files` cannot return an ignored path. It is
 * a real question only for paths that arrive from somewhere other than the
 * enumeration — parse-discovered link targets, chiefly — which is exactly what
 * `LINK_TO_GITIGNORED` is about. The column is carried here so the two
 * populations can be compared, not because it varies within one.
 */
export interface EnumerationRow {
  /** Corpus-relative, forward-slashed, so a snapshot is host-independent. */
  path: string;
  /**
   * The key this document's parse would be filed under, over the bytes on disk
   * right now. `null` when the path could not be read (broken symlink,
   * directory, permissions).
   */
  contentKey: string | null;
  exists: boolean;
  isDirectory: boolean;
  gitignored: boolean;
  isSymlink: boolean;
  /** `null` when the path is not a symlink. */
  symlinkResolves: boolean | null;
  /**
   * Is this path's real location inside the corpus root?
   *
   * `null` when the real path could not be read (a dangling link, chiefly).
   * False means the row widens the corpus to somewhere nobody pointed the
   * command at — the hazard the `followSymlinks` boolean bundles together with
   * looping and with membership, and the one a visited-set does NOT bound: that
   * guard limits re-entry, not reach.
   */
  targetInsideRoot: boolean | null;
  /**
   * Does another enumerated path in this same lane resolve to the same file?
   *
   * A set-level fact, so it is filled in by a pass over the whole population
   * rather than by {@link collectPathFacts}. Recorded rather than deduplicated
   * on purpose: collapsing aliases here would be judgement in phase 1, and the
   * measured reality is that every symlink divergence in Anthropic's own
   * shipped plugin trees is an alias — one blob, two names, two generated ids.
   * Phase 4 decides what that means; this only states that it is true.
   */
  aliasesEnumeratedPath: boolean;
}

/** A duplicate-id drop, recorded in arrival order by `addResources`. */
export interface CollisionRow {
  id: string;
  /** The file that arrived first and therefore won. Corpus-relative. */
  existingPath: string;
  /** The file that arrived later and was skipped. Corpus-relative. */
  conflictingPath: string;
}

/**
 * What one lane enumerated over one corpus.
 *
 * ⛔ `enumerated` and `admitted` are **order-preserving and must never be
 * sorted**. `ResourceRegistry.addResources` is first-added-wins on
 * `DuplicateResourceIdError`, so arrival order decides which of two colliding
 * files is the one that gets validated and bundled. A sorted snapshot hides
 * precisely the defect this oracle exists to catch.
 */
export interface EnumerationSnapshot {
  laneId: LaneId;
  /** Human label for the corpus, so a golden filename means something. */
  corpus: string;
  route: EnumerationRoute;
  /** Whether a usable git tracker was available to answer `gitignored`. */
  gitAvailable: boolean;
  /** Ordered, pre-deduplication: what the crawl handed to `addResources`. */
  enumerated: EnumerationRow[];
  /** Ordered, post-deduplication: the registry's arrival order. Corpus-relative. */
  admitted: string[];
  /** Drops the first-added-wins rule made, in arrival order. */
  collisions: CollisionRow[];
  /**
   * Set when the lane's production builder **threw** instead of returning a
   * registry, with `admitted` and `collisions` left empty.
   *
   * A lane that cannot enumerate a corpus is a fact about VAT, not a fault in
   * the harness, and recording it is the only way a golden can show it. It is
   * reachable today: a committed dangling `*.md` symlink terminates every
   * resource lane with an unhandled `ENOENT`, because `git ls-files` returns
   * mode-120000 entries and `addResources` catches only duplicate-id errors.
   */
  buildError?: string;
  /**
   * Non-empty when `enumerated` does not reconcile with `admitted` plus
   * `collisions` — i.e. this module's restatement of the lane's crawl options
   * has drifted from what the lane's real builder does. That drift is itself
   * the finding; it is surfaced in the snapshot rather than thrown, so a golden
   * diff shows it.
   */
  restatementDrift: string[];
}

/** One link occurrence, with the ordinal that makes it addressable. */
export interface LinkFact {
  ordinal: number;
  href: string;
  text: string;
  type: string;
  line: number | null;
  nodeType: string | null;
  /**
   * `ResourceLink.resolvedId`, which is `undefined` on a freshly-parsed link.
   *
   * Recorded because it is the one field of a parsed link that production code
   * **mutates in place after the parse**: `skill-packager` assigns it while
   * bundling, guarded by `if (link.resolvedId !== undefined) continue`. A cache
   * that hands the same `ParseResult` to two skills therefore does not merely
   * leak one skill's id into the other — it makes the second skill *skip
   * computing its own*, and `walk-link-graph` then reads that id to decide what
   * gets bundled and rewritten.
   *
   * A non-null value in a snapshot taken straight off a parse means something
   * has already written to a result this oracle assumed was pristine.
   */
  resolvedId: string | null;
}

/** One heading, with the slug anchors resolve against. */
export interface HeadingFact {
  ordinal: number;
  level: number;
  text: string;
  slug: string;
  line: number | null;
}

/**
 * One top-level frontmatter key and the runtime shape of its value.
 *
 * The shape, not the value, is the fact worth holding still here. A YAML→JSON
 * round-trip preserves most values and changes their *type*: `.inf` becomes
 * `null` (`number` → `null`), `!!binary` becomes a plain envelope object
 * (`Buffer` → `Object`), a date becomes a string. Recording `typeName` catches
 * every one of those while staying cycle-safe, because it never descends past
 * the top level — and a cyclic YAML anchor is exactly what makes a value-
 * recording snapshot throw instead of record.
 */
export interface FrontmatterFieldFact {
  key: string;
  /** `null`, a `typeof` result, or the constructor name for objects. */
  typeName: string;
  /**
   * A short digest of the value, so the snapshot can tell two documents apart
   * when their frontmatter has the same *shape*.
   *
   * Shape alone is not enough, and this is the gap it left: every SKILL.md in a
   * corpus has `{name: string, description: string}`, so a cache serving one
   * skill's parse for another moved nothing in this row. The other frontmatter
   * column, `frontmatterSource`, cannot help — it is re-derived from the freshly
   * read bytes, so it is constant for a given content key by construction.
   *
   * A digest rather than the value because frontmatter values can be arbitrarily
   * large; cycle-safe and non-JSON because `.inf`/`.nan`/`!!binary` and cyclic
   * anchors are all reachable in YAML and `JSON.stringify` either mangles or
   * throws on them.
   */
  valueDigest: string;
}

/**
 * Facts a parse produces from one blob. Keyed by content key, never by path —
 * that is the property that makes this doubles as the parse cache's oracle.
 */
export interface ParseFactRow {
  contentKey: string;
  parserKind: string;
  sizeBytes: number;
  estimatedTokenCount: number;
  links: LinkFact[];
  headings: HeadingFact[];
  /**
   * The frontmatter block **as written**, delimiters excluded, or `null` when
   * the document has none.
   *
   * Deliberately the source and not the parsed object: a YAML→JSON round-trip
   * is lossy in ways a validator notices (`.inf`/`.nan` become `null`,
   * `!!binary` becomes a Buffer envelope, cyclic anchors make `JSON.stringify`
   * throw). A cold run would hand Ajv `Infinity` and a warm run `null` — same
   * corpus, same config, different reported issues.
   */
  frontmatterSource: string | null;
  /**
   * Top-level frontmatter keys and value shapes as the **parser** returned them,
   * or `null` when `frontmatter` is absent from the parse result entirely.
   *
   * {@link frontmatterSource} alone cannot do this job. It is re-derived from
   * the document text, so it is constant by construction across a cached and an
   * uncached parse — it detects a change in the *parser*, and is structurally
   * blind to a cache that hands back a lossily round-tripped object. This field
   * is the one that discriminates, which is why both are here.
   */
  frontmatterFields: FrontmatterFieldFact[] | null;
  /**
   * Fragment targets the parse declared, or `null` when the field is absent.
   *
   * Absent and `[]` are different states in the contract — `ParseResult.anchors`
   * is optional under `exactOptionalPropertyTypes` and both parsers omit the key
   * rather than emitting an empty array — so they are different values here.
   * A cache that normalises one into the other must show up as a diff.
   *
   * This feeds `ResourceRegistry.buildFragmentIndex`, so it is the input to
   * every `file.md#fragment` check. A parse layer that dropped it would change
   * anchor validation across the whole corpus while every other fact held.
   */
  anchors: string[] | null;
  /**
   * Length of `ParseResult.content` in UTF-16 code units, as the parser
   * returned it.
   *
   * The full text is deliberately not stored — it would make the golden a copy
   * of the corpus. This is what it carries instead, and it is chosen to pair
   * with {@link sizeBytes}: that one is `stat().size` (**raw bytes**) while this
   * one is derived from the **decoded string**. The two move independently
   * exactly where content-addressing is hardest — malformed UTF-8, where
   * decoding is many-to-one — so recording both makes that divergence visible
   * instead of implicit.
   *
   * This replaced a `contentMatchesKey` boolean that re-keyed `parsed.content`.
   * That check was 23/23 `true`, reduced algebraically to
   * `parsed.content === keyed.content` (a TOCTOU check on two reads of one
   * path), and would have become a literal tautology under any cache that
   * re-attaches freshly-read bytes to a stored result.
   */
  decodedLength: number;
  /** Parse-time oddities: YAML errors, HTML well-formedness, dangling refs. */
  conditions: ConditionFact[];
  /**
   * Presence state of the optional array fields that {@link conditions} folds
   * together, recorded separately because the fold destroys it.
   *
   * `collectConditions` reads both through `?? []`, so absent and empty produce
   * an identical `conditions` list — and for these two the distinction is real
   * and documented: `unresolvedReferences` is *"HTML leaves this undefined;
   * markdown always populates it (possibly empty)"*, and `parseErrors` is the
   * mirror image. A parse layer that normalised `undefined` into `[]` would
   * change which parser a row claims to have come from, with no diff.
   *
   * Note this is where the "absent is not empty" rule actually bites. It does
   * NOT bite on `anchors`: both parsers spread that key conditionally
   * (`...(list.length > 0 && { anchors: list })`), so a present-but-empty
   * `anchors` is unreachable and its `(none)` rendering is defensive only.
   */
  optionalArrays: OptionalArrayFact[];
}

/** Whether an optional array field was missing, present-and-empty, or populated. */
export type OptionalArrayState = 'absent' | 'empty' | 'present';

/** One optional array field of `ParseResult` and how it was supplied. */
export interface OptionalArrayFact {
  field: string;
  state: OptionalArrayState;
}

/** A parse-time oddity. `code` is an open vocabulary; add rows, never columns. */
export interface ConditionFact {
  code: string;
  message: string;
  line: number | null;
}

/** Parse facts for a corpus, keyed by content key. */
export interface ParseFactSnapshot {
  corpus: string;
  /**
   * Ordered by content key so this snapshot is comparable across hosts even
   * when the enumeration that produced it was in filesystem order. Sorting is
   * safe HERE and unsafe in {@link EnumerationSnapshot} because a parse fact is
   * a function of the blob alone — nothing about it depends on arrival order.
   */
  rows: ParseFactRow[];
  /**
   * Corpus-relative paths that mapped to each key, sorted. Two paths under one
   * key is the cache's whole reason to exist; zero paths is impossible.
   */
  pathsByKey: Record<string, string[]>;
}
