/**
 * The blob-derivation stage: the step that turns the base stratum's
 * `contentKey` columns into the four blob-keyed tables.
 *
 * ## Why this exists as its own stage
 *
 * `blobRowFor`, `blobConditionsFor`, `blobSectionsFor` and `blobReferencesFor`
 * are pure assemblers over one `ParseResult`, and `ProjectionBuilder` has an
 * `add*` for each of their outputs — but nothing joined the two. Without this
 * stage `populate()` returns a projection whose `blobs`, `blob_references`,
 * `blob_sections` and `blob_conditions` tables are **empty**, and that is not
 * merely incomplete: `ClosureExtentContributor` defines an extent by walking
 * `blob_references` joined through realizations, so every closure extent would
 * be its declared root and nothing else, the fixpoint would converge on
 * iteration one, and `populate()` would report success. A skill extent would
 * contain its `SKILL.md` and none of the files it links to.
 *
 * ## Why between the strata, and not inside either one
 *
 * The base contributors are what enumerate realizations, and a realization is
 * what carries a `contentKey`. The closure stratum is what *reads*
 * `blob_references`. A stage between them is the only position that has the
 * inputs and precedes the consumers. It is deliberately **not** a contributor:
 * it declares no extent, so it has no `resolution_contexts` row to attach a
 * `zone_provenance` digest to, and inventing one would claim an extent that
 * does not exist.
 *
 * It runs **once**, not per closure iteration. A closure contributor only ever
 * re-realizes paths the base already realized (`{...first, extentId}`), so it
 * cannot introduce a content key this stage has not already seen.
 *
 * ## Keyed on the blob, never on the path
 *
 * Derivation is once per distinct `contentKey`. That is the whole point of a
 * content-addressed blob layer — a file bundled into three skills is one blob
 * and four realizations — and deriving per realization would re-read and
 * re-parse the same bytes once per extent that realizes them.
 *
 * ## What is NOT re-observed
 *
 * The skip rules read the realization row's own columns (`contentKey`,
 * `isDirectory`, `exists`, `symlinkResolves`) rather than issuing a fresh
 * `stat`. A second `stat` could legitimately disagree with the row the base
 * already carries, and two answers for one path is worse than either.
 *
 * ## Every keyed blob is derived — including non-markdown
 *
 * There is no extension allowlist. `parserKindForPath` is VAT's single parser
 * discriminator and the base already ran it; its answer is recorded in the
 * content key's own prefix, so this stage reads the prefix rather than
 * re-deriving the routing (running the discriminator twice is exactly how the
 * parse route and the key's parse-route component drift apart).
 *
 * That means a `.mjs`, `.py` or `.txt` blob is routed to the markdown parser,
 * which is what the raw-source reference lexer wants: `reference-lexer.ts`
 * exists to find `@`-prefixed, variable-anchored and path-shaped tokens that
 * the markdown AST is structurally blind to, and those live in scripts far more
 * than in prose. Filtering non-markdown out here would decide, silently and
 * permanently, that a skill's bundled scripts can never be closure members —
 * which is the exact `files:`-blindness failure family the projection exists to
 * make queryable. Deciding a blob is uninteresting is a lens's job; this layer
 * records shape.
 */

import { compareCodeUnits, safePath } from '@vibe-agent-toolkit/utils';

import { type KeyedContent, type ParserKind, readContentWithKey } from '../content-key.js';
import type { ParseResult } from '../link-parser.js';
import { type ParseCache, defaultParseCache, parseKeyed } from '../parse-cache.js';
import type { BlobConditionRow } from '../schemas/projection-blobs.js';
import type { ResourceRealizationRow } from '../schemas/projection-resources.js';

import { blobConditionsFor, blobRowFor } from './blob-facts.js';
import { blobReferencesFor } from './blob-references.js';
import { blobSectionsFor, flattenHeadings } from './blob-sections.js';
import type { ProjectionBase, ProjectionBuilder } from './projection.js';

/** A blob whose bytes could not be read at derivation time. */
export const BLOB_UNREADABLE = 'BLOB_UNREADABLE';

/** The bytes at the chosen path no longer key to the blob the base recorded. */
export const BLOB_CONTENT_CHANGED = 'BLOB_CONTENT_CHANGED';

/** The parser threw on this blob's bytes. */
export const BLOB_PARSE_FAILED = 'BLOB_PARSE_FAILED';

/** The prefix a content key carries when its bytes route to the HTML parser. */
const HTML_KEY_PREFIX = 'html.';

/**
 * What one run of {@link populateBlobs} did, and what it declined to do.
 *
 * Counters rather than a boolean, because the interesting claim about this
 * stage is quantitative. Two of them exist specifically to be asserted at zero
 * on a real corpus: `HeadingNode.line` and `ResourceLink.line` are optional
 * while `blob_sections.lineStart` and `blob_references.line` are required and
 * positive, and both are handled by **skipping, never defaulting** — a default
 * of line 1 would pile every position-less row onto the top of the document,
 * where no assertion could ever catch it. A skip that is never counted is the
 * same silence by another route, so it is counted here.
 */
export interface BlobPopulationResult {
  /** Distinct content keys that produced a `blobs` row in this run. */
  readonly blobsDerived: number;
  /**
   * Distinct content keys already present in the builder, left untouched.
   *
   * Non-zero only when the stage is run twice against one builder, which must
   * be a no-op: the closure stratum re-runs to a fixpoint and would never settle
   * if blob rows churned.
   */
  readonly blobsAlreadyPresent: number;
  /** Blobs whose bytes could not be read now — a {@link BLOB_UNREADABLE} row each. */
  readonly blobsUnreadable: number;
  /** Blobs whose bytes changed since enumeration — a {@link BLOB_CONTENT_CHANGED} row each. */
  readonly blobsContentChanged: number;
  /** Blobs the parser threw on — a {@link BLOB_PARSE_FAILED} row each. */
  readonly blobsParseFailed: number;
  /** Realization rows carrying no content key because they name a directory. */
  readonly realizationsSkippedDirectory: number;
  /** Realization rows carrying no content key because the path does not exist. */
  readonly realizationsSkippedAbsent: number;
  /** Realization rows carrying no content key because the symlink dangles. */
  readonly realizationsSkippedDanglingSymlink: number;
  /**
   * Realization rows that exist, are not directories and resolve — yet still
   * carry no content key.
   *
   * The residue: `collectRealization` reports a read failure at enumeration
   * time as a null key. Kept as its own bucket rather than folded into the
   * three explicable ones, because it is the only one that indicates something
   * went wrong rather than something is not a blob.
   */
  readonly realizationsSkippedUnkeyed: number;
  /**
   * Headings dropped by `blobSectionsFor` for want of a source line.
   *
   * Measured **0** over this repository's 4,425 blobs — remark always positions
   * a heading.
   */
  readonly headingsSkippedForMissingLine: number;
  /**
   * Reference candidates dropped by `blobReferencesFor` for want of a source line.
   *
   * Measured **77** over this repository's 4,425 blobs, not 0. Every one of them
   * is a GFM autolink literal in a *non-markdown* blob (`.ts` 61, `.json` 9,
   * `.js` 4, `.yaml` 2), and the cause is upstream of this module: remark hands
   * `toResourceLink` a `link` node whose `position` is `undefined` when the
   * autolink is wrapped in quotes and parentheses. Minimal repro, verified:
   *
   * ```text
   * parseMarkdownContent('"WebFetch(domain:www.anthropic.com)"\n', 36)
   *   .links[0].line === undefined      // whereas '(www.anthropic.com)' → 1
   * ```
   *
   * They are all external URLs and mailto targets, so none of them is a closure
   * edge — but "harmless" is a judgement a lens makes, not a reason to stop
   * counting. Defaulting them to line 1 instead would put 77 rows at the top of
   * 76 documents where nothing could falsify them.
   */
  readonly referencesSkippedForMissingLine: number;
}

/** The accumulator behind {@link BlobPopulationResult}. */
type MutableCounts = { -readonly [K in keyof BlobPopulationResult]: BlobPopulationResult[K] };

/** Options for {@link populateBlobs}. */
export interface BlobPopulationOptions {
  /**
   * The content-addressed parse cache to consult.
   *
   * This stage deliberately adds **no** caching layer of its own: `ParseCache`
   * is already keyed on exactly the pair a parse is a function of (the bytes and
   * the parser), which is the same key this stage derives per blob, and it
   * outlives the process — the property that matters, since `vat validate`,
   * `vat verify` and `vat build` each spawn the binary once per phase. A second
   * in-process memo stacked on top would also hide the lower layer's hit rate,
   * making the cache's own correctness unobservable.
   *
   * Defaults to the process-wide instance.
   */
  parseCache?: ParseCache | undefined;
}

/** One blob to derive, and the path its bytes are read from. */
interface BlobTarget {
  /** The blob's content key, exactly as the realization row carries it. */
  contentKey: string;
  /** Root-relative path of the realization chosen to supply the bytes. */
  path: string;
}

/**
 * Derive every blob-keyed table from the realizations the base contributed.
 *
 * ## Deterministic, and idempotent
 *
 * Blobs are derived in **content-key order** and each blob's bytes are read
 * from the lexicographically first path that realizes it — never in enumeration
 * order. `crawlDirectory`'s directory route returns filesystem order, which
 * differs between ext4, APFS and NTFS, so letting it reach the row order would
 * make two machines produce two different (but equally "correct") projections.
 * Within a blob the assemblers' own ordinal contracts decide.
 *
 * Running it twice against one builder changes nothing: a blob whose row is
 * already present is skipped outright, and every `add*` de-duplicates anyway.
 *
 * ## A failure is a row, never an abort
 *
 * A file readable at enumeration time can be unreadable now, and a blob routed
 * to the markdown parser can be anything at all. Either one produces a
 * `blob_conditions` row and the run continues — one permissions quirk on one
 * host must not destroy a whole population. But it is a *row*, not a silence:
 * a blob with no rows and no condition would be indistinguishable from a blob
 * that genuinely has nothing to say.
 *
 * @param builder - The builder to read realizations from and add blob rows to
 * @param options - The parse cache to consult; defaults to the shared instance
 * @returns What was derived and what was skipped, with a reason per bucket
 */
export async function populateBlobs(
  builder: ProjectionBuilder,
  options: BlobPopulationOptions = {},
): Promise<BlobPopulationResult> {
  const base = builder.base();
  const cache = options.parseCache ?? defaultParseCache();
  const counts = emptyCounts();

  for (const row of base.resourceRealizations) {
    if (row.contentKey === null) countUnkeyedRealization(row, counts);
  }

  const alreadyPresent = new Set(base.blobs.map((row) => row.contentKey));

  for (const target of blobTargets(base)) {
    if (alreadyPresent.has(target.contentKey)) {
      counts.blobsAlreadyPresent += 1;
      continue;
    }
    // Sequential rather than fanned out with `Promise.all`: each iteration reads
    // and parses a whole file, and one file handle per corpus blob in flight is
    // how a large corpus meets EMFILE. `FilesystemExtentContributor` keys the
    // same bytes under the same constraint for the same reason.
    await deriveBlob(builder, target, base.root, cache, counts);
  }

  return counts;
}

/** A zeroed accumulator — one place that knows every bucket. */
function emptyCounts(): MutableCounts {
  return {
    blobsDerived: 0,
    blobsAlreadyPresent: 0,
    blobsUnreadable: 0,
    blobsContentChanged: 0,
    blobsParseFailed: 0,
    realizationsSkippedDirectory: 0,
    realizationsSkippedAbsent: 0,
    realizationsSkippedDanglingSymlink: 0,
    realizationsSkippedUnkeyed: 0,
    headingsSkippedForMissingLine: 0,
    referencesSkippedForMissingLine: 0,
  };
}

/**
 * Attribute one content-key-less realization to the reason it has no blob.
 *
 * An `if`/`else if` chain rather than a `switch`: the buckets are derived from
 * four independent boolean columns, not from a union with members to enumerate.
 *
 * @param row - A realization whose `contentKey` is null
 * @param counts - The accumulator to attribute it to
 */
function countUnkeyedRealization(row: ResourceRealizationRow, counts: MutableCounts): void {
  if (row.isDirectory) {
    counts.realizationsSkippedDirectory += 1;
  } else if (!row.exists) {
    counts.realizationsSkippedAbsent += 1;
  } else if (row.symlinkResolves === false) {
    counts.realizationsSkippedDanglingSymlink += 1;
  } else {
    counts.realizationsSkippedUnkeyed += 1;
  }
}

/**
 * The distinct blobs the base realizes, in a machine-independent order.
 *
 * The chosen path is the lexicographically first realization of the blob, by
 * UTF-16 code unit. Which realization supplies the bytes is unobservable in the
 * output — the rows are keyed on content, and the content key is what selected
 * the path — but *choosing* it by enumeration order would make a read failure
 * on one of two identical copies depend on crawl order.
 *
 * @param base - The projection built so far
 * @returns One target per distinct content key, ordered by content key
 */
function blobTargets(base: ProjectionBase): BlobTarget[] {
  const pathByKey = new Map<string, string>();

  for (const row of base.resourceRealizations) {
    if (row.contentKey === null) continue;
    const chosen = pathByKey.get(row.contentKey);
    if (chosen === undefined || compareCodeUnits(row.path, chosen) < 0) {
      pathByKey.set(row.contentKey, row.path);
    }
  }

  return [...pathByKey]
    .map(([contentKey, path]): BlobTarget => ({ contentKey, path }))
    .sort((left, right) => compareCodeUnits(left.contentKey, right.contentKey));
}

/**
 * Read, parse and record one blob.
 *
 * @param builder - The builder to add rows to
 * @param target - The blob and the path its bytes come from
 * @param root - Absolute corpus root the target's path is relative to
 * @param cache - The parse cache to consult
 * @param counts - The accumulator
 */
async function deriveBlob(
  builder: ProjectionBuilder,
  target: BlobTarget,
  root: string,
  cache: ParseCache,
  counts: MutableCounts,
): Promise<void> {
  const keyed = await readTarget(builder, target, root, counts);
  if (keyed === null) return;

  const parsed = await parseTarget(builder, target, keyed, cache, counts);
  if (parsed === null) return;

  emitBlobRows(builder, target, keyed, parsed, counts);
  counts.blobsDerived += 1;
}

/**
 * Read a target's bytes and confirm they still key to the blob the base named.
 *
 * The confirmation is not defensive padding: filing a fresh parse under a key
 * it is not a function of is the one failure the parse cache's fail-soft
 * handling explicitly does not cover, and joining rows derived from *these*
 * bytes onto a realization that names *those* bytes is the same mistake one
 * layer up.
 *
 * @param builder - The builder to record a condition on
 * @param target - The blob and its path
 * @param root - Absolute corpus root
 * @param counts - The accumulator
 * @returns The read, or null when a condition was recorded instead
 */
async function readTarget(
  builder: ProjectionBuilder,
  target: BlobTarget,
  root: string,
  counts: MutableCounts,
): Promise<KeyedContent | null> {
  let keyed: KeyedContent;
  try {
    keyed = await readContentWithKey(safePath.join(root, target.path), parserKindOf(target.contentKey));
  } catch (error) {
    counts.blobsUnreadable += 1;
    builder.addBlobCondition(condition(
      target.contentKey,
      BLOB_UNREADABLE,
      `The bytes for "${target.path}" could not be read during blob derivation (${errorLabel(error)});`
      + ' this blob has no rows because it could not be observed, not because it has nothing to say',
    ));
    return null;
  }

  if (keyed.key !== target.contentKey) {
    counts.blobsContentChanged += 1;
    builder.addBlobCondition(condition(
      target.contentKey,
      BLOB_CONTENT_CHANGED,
      `"${target.path}" now keys to ${keyed.key}, so its current bytes are not this blob's;`
      + ' deriving from them would file one blob\'s facts under another blob\'s key',
    ));
    return null;
  }

  return keyed;
}

/**
 * Parse a blob, recording a condition instead of propagating a throw.
 *
 * Reachable rather than defensive: every keyed blob is derived, including the
 * non-markdown ones, so the markdown parser is handed arbitrary bytes by design.
 * One of them failing must not abort a whole population.
 *
 * @param builder - The builder to record a condition on
 * @param target - The blob and its path
 * @param keyed - The confirmed read
 * @param cache - The parse cache to consult
 * @param counts - The accumulator
 * @returns The parse, or null when a condition was recorded instead
 */
async function parseTarget(
  builder: ProjectionBuilder,
  target: BlobTarget,
  keyed: KeyedContent,
  cache: ParseCache,
  counts: MutableCounts,
): Promise<ParseResult | null> {
  try {
    return await parseKeyed(keyed, cache);
  } catch (error) {
    counts.blobsParseFailed += 1;
    builder.addBlobCondition(condition(
      target.contentKey,
      BLOB_PARSE_FAILED,
      `The ${keyed.parserKind} parser threw on the bytes at "${target.path}" (${errorLabel(error)})`,
    ));
    return null;
  }
}

/**
 * Add every row one parse yields, and count what the assemblers dropped.
 *
 * The skip counts are measured by **comparison**, not reported by the
 * assemblers: `flattenHeadings(...).length` against the section rows, and
 * `links + lexicalReferences` against the reference rows. A count the producer
 * hands back could stop being true without anything noticing; a difference
 * between the input population and the output population cannot.
 *
 * `ParseResult.headings` is a **tree** — `headings.length` counts root headings
 * only, so it would silently under-report the population these rows come from.
 *
 * @param builder - The builder to add rows to
 * @param target - The blob and its path
 * @param keyed - The confirmed read
 * @param parsed - The parse
 * @param counts - The accumulator
 */
function emitBlobRows(
  builder: ProjectionBuilder,
  target: BlobTarget,
  keyed: KeyedContent,
  parsed: ParseResult,
  counts: MutableCounts,
): void {
  const { contentKey } = target;

  // `byteLength`, never `content.length`: decoding is many-to-one on malformed
  // UTF-8, so the decoded string's length is not the on-disk byte count.
  builder.addBlob(blobRowFor(contentKey, keyed.byteLength, parsed));

  for (const row of blobConditionsFor(contentKey, parsed)) {
    builder.addBlobCondition(row);
  }

  const sections = blobSectionsFor(contentKey, keyed.content, parsed.headings);
  for (const row of sections) {
    builder.addBlobSection(row);
  }
  counts.headingsSkippedForMissingLine += flattenHeadings(parsed.headings).length - sections.length;

  const references = blobReferencesFor(contentKey, parsed);
  for (const row of references) {
    builder.addBlobReference(row);
  }
  const candidates = parsed.links.length + (parsed.lexicalReferences?.length ?? 0);
  counts.referencesSkippedForMissingLine += candidates - references.length;
}

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
 * @param contentKey - A `<parserKind>.<sha256>` key
 * @returns The parser kind the key names
 */
function parserKindOf(contentKey: string): ParserKind {
  return contentKey.startsWith(HTML_KEY_PREFIX) ? 'html' : 'markdown';
}

/**
 * A `blob_conditions` row with no line, since none of this module's conditions
 * are about a position in the document.
 *
 * @param blob - The content key the condition is about
 * @param code - The condition code
 * @param message - What happened, in terms of the root-relative path
 * @returns The condition row
 */
function condition(blob: string, code: string, message: string): BlobConditionRow {
  return { blob, code, severity: 'warning', message, line: null };
}

/**
 * A short, path-free label for a thrown value.
 *
 * Deliberately not `String(error)`: an `fs` error's message embeds the absolute
 * path it failed on, which would put `$HOME` into a projection row that every
 * other column keeps root-relative. The `code` carries the diagnosis anyway.
 *
 * @param error - Whatever was thrown
 * @returns The error's `code`, its message, or a stable placeholder
 */
function errorLabel(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return String((error as { code: unknown }).code);
  }
  return error instanceof Error ? error.message : 'unknown error';
}

// `compareCodeUnits` comes from `@vibe-agent-toolkit/utils`. Never `localeCompare`: collation is
// locale-dependent, so two machines populating one corpus would order these rows differently, which
// defeats the entire point of sorting them.
