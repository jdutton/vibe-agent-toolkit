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
 * It runs **once per closure iteration — never**. A closure contributor only
 * ever re-realizes paths the base already realized (`{...first, extentId}`), so
 * it cannot introduce a content key this stage has not already seen.
 *
 * The merge driver does run it a **second** time, strictly after the fixpoint
 * has converged, and only when something promoted a `deferred` realization
 * during the closure stratum. That is the one way a content key can appear
 * after the first run, and running the stage again is safe for the same reason
 * running it twice always was: a blob already present is skipped outright. See
 * `merge.ts` for why the two runs are reported separately rather than summed.
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
 * The skip rules read the realization row's own columns (`contentState`, then
 * `isDirectory`, `exists`, `symlinkResolves`) rather than issuing a fresh
 * `stat`. A second `stat` could legitimately disagree with the row the base
 * already carries, and two answers for one path is worse than either.
 *
 * `contentState` is read **first**, and is the reason the column exists: a
 * null `contentKey` used to be re-explained here by reconstructing the cause
 * from three other columns, which meant "the read threw" and "nobody asked for
 * these bytes" were the same residue bucket. The base already decided; this
 * stage reports its decision instead of re-deriving it.
 *
 * ## Every keyed blob is derived — including the ones no parser reads
 *
 * There is no extension allowlist. `parserKindForPath` is VAT's single parser
 * discriminator and the base already ran it; its answer is recorded in the
 * content key's own prefix, so this stage reads the prefix rather than
 * re-deriving the routing (running the discriminator twice is exactly how the
 * parse route and the key's parse-route component drift apart).
 *
 * Since `mime-type.ts` began typing paths, that prefix has THREE values, and the
 * third — `none` — names the ABSENCE of a document parser. It is a third shape
 * here, not a fourth refusal:
 *
 * ```text
 *                      blobs row   estimateTokens   lexer   unified()
 *  markdown / html        yes           yes         yes*      yes
 *  none                   YES           YES         YES       no
 *  refused (NOT_TEXT…)    no            no          no        no
 *                                                   * markdown only; see blob-references.ts
 * ```
 *
 * ### Why a `none` blob still earns a row
 *
 * Because a refusal's shape is "no `blobs` row at all" — {@link prepareBlob}
 * answers with a {@link RefusedBlob} on every refusal path, and
 * {@link emitPreparedBlob} then records only its condition — and copying that
 * shape here would break accounting on the majority of files in a repository.
 * With no row there is no `tokenEstimate`; `whatLoadsAt` then reports
 * `tokens: null` and `chargeOf` answers `unknown-size`. That is a live state,
 * reached the moment a CLAUDE.md imports a `.ts` file.
 *
 * ### Why it still runs the LEXER — the constraint that decides correctness
 *
 * **Route away from the PARSER, never from the lexer.** Measured on this
 * repository: of 51,783 `blob_references`, 2,432 are AST rows and ~46,600 are
 * `at-prefixed` (24,918), `bare-token` (21,687) and `env-anchored` (2,746) —
 * every one of them produced by `findLexicalReferences` over RAW SOURCE, with no
 * AST anywhere in the derivation. `reference-lexer.ts` exists precisely to find
 * the tokens a markdown AST is structurally blind to, and those live in scripts
 * far more than in prose.
 *
 * So dropping the lexer for `none` would decide, silently and permanently, that
 * a skill's bundled scripts can never be closure members — the exact
 * `files:`-blindness failure family the projection exists to make queryable.
 * What the `none` route drops instead is `remark-parse`, which over a `.ts` file
 * was never telling the truth anyway: 5,329 TypeScript and 713 JSON files parsed
 * as CommonMark produced 64.7% of one adopter tree's reference rows and **100%**
 * of its dangling-reference warnings. Deciding a blob is uninteresting is a
 * lens's job; this layer records shape.
 */

import { compareCodeUnits, safePath } from '@vibe-agent-toolkit/utils';
import type { TextProvenance } from '@vibe-agent-toolkit/utils/text';

import { isParsableContent, type KeyedContent, type ParsableContent, type ParserKind } from '../content-key.js';
import { estimateTokens } from '../link-classify.js';
import type { ParseResult } from '../link-parser.js';
import { type ParseCache, defaultParseCache, isParserUnavailable } from '../parse-cache.js';
import { ParseDispatcher, type ParsePoolPolicy, driveInOrder, tallyParsable } from '../parse-dispatcher.js';
import { type CodeContextRanges, findLexicalReferences } from '../reference-lexer.js';
import type { BlobConditionRow } from '../schemas/projection-blobs.js';
import type { ResourceRealizationRow } from '../schemas/projection-resources.js';

import { blobConditionsFor, blobRowFor, measureContent } from './blob-facts.js';
import { blobReferencesFor } from './blob-references.js';
import { blobSectionsFor, flattenHeadings } from './blob-sections.js';
import { readKeyedContent } from './content-cache.js';
import { errorLabel } from './error-label.js';
import type { ProjectionBase, ProjectionBuilder } from './projection.js';

/** A blob whose bytes could not be read at derivation time. */
export const BLOB_UNREADABLE = 'BLOB_UNREADABLE';

/** The bytes at the chosen path no longer key to the blob the base recorded. */
export const BLOB_CONTENT_CHANGED = 'BLOB_CONTENT_CHANGED';

/** The parser threw on this blob's bytes. */
export const BLOB_PARSE_FAILED = 'BLOB_PARSE_FAILED';

/** The bytes are not text, so no text parser was run over them. */
export const BLOB_NOT_TEXT = 'BLOB_NOT_TEXT';

/**
 * How far into a blob's DECODED content to look for the NUL that says "not
 * text".
 *
 * Git's own heuristic, and the same 8000-unit window it uses: a NUL inside the
 * first block is the one signal that separates binary from text without knowing
 * anything about the format. Bounded rather than whole-file because the check
 * must be cheap enough to run on every blob — the point is to avoid touching
 * megabytes, so a test that reads megabytes defeats itself.
 *
 * **Characters, not bytes**, and the name says so because the difference is
 * real: {@link looksBinary} runs over the decoded string, so for a UTF-16
 * document this window covers ~16 000 bytes and for UTF-32 ~32 000. Git counts
 * bytes because git never decodes. Nothing downstream depends on the exact
 * width, so the window is left at git's number rather than scaled per encoding —
 * a scaled window would be a second encoding-dependent behaviour to keep in step
 * with the decoder for no gain.
 */
const BINARY_SNIFF_CHARS = 8000;

/**
 * Whether these bytes are binary, and therefore have nothing a text parser can
 * find.
 *
 * ## Why this exists, with the measurement
 *
 * `parserKindForPath` used to route `.html`/`.htm` to the HTML parser and
 * **everything else to markdown** — so the filesystem extent, which enumerates
 * the whole tree rather than a glob, handed `remark-parse` every zip, PDF and
 * `.docx` under the root. What was never measured is what "arbitrary bytes"
 * costs when they are not text at all.
 *
 * Measured: a project of one 13-byte markdown file plus one 8 MB zip takes
 * **4.83 s on the projection lane against 0.035 s on the walker — 138×** — and
 * produces the identical answer, because the zip was never a member of the
 * result in the first place. On a real 86 MB adopter corpus carrying 77 MB of
 * PDFs and zips the command did not finish in five minutes, at 100% CPU.
 * `remark-parse` does not *fail* on binary input; it succeeds, slowly, building
 * an AST of garbage that every downstream stage then walks.
 *
 * ## Routing by MIME type did NOT retire this test
 *
 * A `.zip` now routes to `none`, so remark no longer sees it — and that removes
 * none of the reason for sniffing. This test runs **ahead of the kind split** and
 * refuses all three kinds, for two independent reasons. A `none`-routed binary
 * would otherwise earn a `blobs` row carrying a token estimate computed over
 * megabytes of mojibake, plus a full lexer scan of the same. And typing is by
 * NAME (`mime-type.ts` is a pure path lookup), so a `.docx` renamed `.md` still
 * routes to markdown and still hangs — which is exactly the case an extension
 * table can never see, and the case below is about.
 *
 * ## Why a content sniff and not an extension list
 *
 * An extension list would be a claim about a FILENAME, and a filename cannot
 * observe a cause: a `.zip` renamed `.md` would still hang, while a `.sh` a
 * skill bundles — which the closure genuinely wants read — has no extension in
 * common with `.md`. A NUL byte is the property itself. It also keeps the
 * deliberate capability intact: scripts, configs, `.txt`, files with no
 * extension at all are text, and are still parsed.
 *
 * ## This is a refusal, not a silence
 *
 * The caller records a {@link BLOB_NOT_TEXT} condition, exactly as it does for
 * an unreadable or changed blob. A blob with no rows and no condition would be
 * indistinguishable from a blob that genuinely had nothing to say — and the
 * whole `blob_conditions` table exists to keep those two apart. The blob is
 * still KEYED and still a member: identity, `gitignored`, and the realization
 * row are untouched. Only the parse is declined.
 *
 * ## The sniff runs AFTER the decode, and that ordering is the whole reason
 * UTF-16 works
 *
 * This takes the **decoded string**, never the raw bytes, and the argument type
 * is the enforcement. UTF-16 and UTF-32 text legitimately contains NUL *bytes* —
 * every ASCII character in a UTF-16 document carries one — so a sniff over bytes
 * classifies every such document as binary. That is precisely what used to
 * happen: `readContentWithKey` decoded as UTF-8 unconditionally, the NUL bytes
 * survived into the string as U+0000, and a perfectly ordinary markdown document
 * was refused here before any parser saw it. The decoder fix
 * (`decodeTextContent`, in `@vibe-agent-toolkit/utils/text`) removes the NULs by
 * decoding correctly, and this function needs no encoding table of its own to
 * benefit — it needs only to keep running second. **Moving this test onto raw bytes reinstates the defect in full.**
 *
 * What remains, stated rather than hidden: a genuinely binary file whose first
 * bytes happen to match a recognised BOM is decoded as text, and whether its
 * NULs survive that decode is luck. UTF-16 pairs `00 00` to U+0000 and UTF-32
 * maps most 4-byte runs to U+FFFD, so binary content usually still trips this
 * test — usually, not always. The consequence of a miss is a slow parse of
 * garbage, which is the cost this function exists to avoid, not a wrong answer.
 *
 * @param content - The decoded content, as the parser would receive it
 * @returns `true` when the content is binary
 */
function looksBinary(content: string): boolean {
  const limit = Math.min(content.length, BINARY_SNIFF_CHARS);
  for (let index = 0; index < limit; index += 1) {
    if (content.codePointAt(index) === 0) return true;
  }
  return false;
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
  /**
   * Blobs declined as binary before any parse — a {@link BLOB_NOT_TEXT} row each.
   *
   * Expected to be NON-zero on any real corpus that ships an image, an archive
   * or a PDF, and that is the point: this counter is what makes the refusal
   * auditable rather than a quiet speed-up. A corpus of pure text reports zero.
   */
  readonly blobsNotText: number;
  /**
   * Blobs derived with no document parser behind them — a `none.` key each.
   *
   * A **subset of {@link blobsDerived}**, never a peer of the four refusal
   * buckets above: these blobs have a row, a real `tokenEstimate`, real content
   * measures and their full complement of lexical `blob_references`. The only
   * thing they lack is the one thing a `text/x-typescript` file was never going
   * to yield honestly — an mdast.
   *
   * ## Why this is a COUNTER and not a `blob_conditions` row
   *
   * Because every column such a row could carry is a function of the key it
   * would be filed under. `blob` *is* the `none.<digest>` key, whose prefix
   * already says no parser ran; `code` and `severity` would be constants; `line`
   * is null; and `message` could only restate the code. "Which blobs did not get
   * a document parse" is answered exactly, per blob, by `contentKey LIKE
   * 'none.%'` — and answered better than a row could, because the prefix is the
   * same value that selected the route and is mixed into the digest
   * (content-key.ts), so it cannot drift from the routing the way a
   * separately-emitted row can.
   *
   * The "and WHY" half is the stronger argument. The interesting reason is the
   * MIME type — `mime-type.ts` exists so that 6,000 `.ts` files and 40
   * `.fraud-ingest-job` files do not read as "6,040 unparsed" — and a blob does
   * not have one. A blob has no path; the same bytes are legitimately realized
   * at `x.ts` and at `x.fraud-ingest-job`. A per-blob row asserting a type would
   * be a claim this layer is in no position to make, which is the argument
   * `mime-type.ts` itself opens with about `application/octet-stream`. Typing
   * belongs to the realization, which has a path.
   *
   * Volume then makes the `warning`-versus-`info` question moot rather than
   * close. Measured on this repository, 6,967 of 8,713 documents route to `none`
   * — a ratio that moves with every file added and has never been near a
   * minority. A `warning` on four documents in five is wallpaper within a day,
   * and it trains readers to ignore the table the four genuine refusal codes
   * depend on being read; an `info` row is the same five columns of restated key,
   * merely quieter. `describeBlobRefusals` deliberately does not print this
   * counter either, for the reason that module already gives about
   * `realizationsContentDeferred`: a line that fires on every run over every
   * repository is not a signal.
   */
  readonly blobsWithoutParser: number;
  /**
   * `contentState: 'none'` rows that name a directory.
   *
   * The three `none` sub-buckets below are still derived from the row's own
   * `isDirectory` / `exists` / `symlinkResolves` columns — `none` says *there
   * are no bytes here*, and which of the three shapes produced it is a real
   * distinction those columns already carry.
   */
  readonly realizationsSkippedDirectory: number;
  /** `contentState: 'none'` rows whose path does not exist. */
  readonly realizationsSkippedAbsent: number;
  /** `contentState: 'none'` rows whose symlink dangles. */
  readonly realizationsSkippedDanglingSymlink: number;
  /**
   * `contentState: 'unreadable'` rows — the read was attempted and it threw.
   *
   * The only bucket here that indicates something went **wrong** rather than
   * something is not a blob or was not asked for. Read off the state column
   * rather than reconstructed from the absence of the other three explanations,
   * which is what it used to be.
   */
  readonly realizationsSkippedUnkeyed: number;
  /**
   * `contentState: 'deferred'` rows — bytes that exist and were deliberately
   * **not** read.
   *
   * Not a skip and not a warning: a nonzero value here is the demand-driven
   * keying design doing its job. `FilesystemExtentContributor` passes
   * `contentDemand: 'deferGitignored'` precisely so a gitignored path gets a
   * realization row without anyone paying to SHA-256 it — measured at 1.19 GB
   * of ignored tree against 40.8 MB of tracked source on a large adopter, which
   * is the whole cost this counter reports as avoided.
   *
   * It is named apart from the `realizationsSkipped*` family on purpose: those
   * describe bytes that could not be keyed, this describes bytes nobody has
   * asked for **yet**. A consumer that wants them calls
   * {@link ProjectionBuilder.ensureContentKey}, which promotes the row to
   * `keyed`; a second {@link populateBlobs} then derives its blob. Folding this
   * into a skip bucket would restore exactly the ambiguity `contentState` was
   * added to remove.
   */
  readonly realizationsContentDeferred: number;
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
   * ⚠️ Non-zero on this repository, and reliably so. The cause is upstream of
   * this module: a GFM autolink literal the tokenizer does not see is
   * reconstructed by `mdast-util-gfm-autolink-literal`'s `findAndReplace`
   * post-pass, which builds the `link` node with **no `position`**, so
   * `toResourceLink` emits it with neither a line nor offsets. Minimal repro,
   * verified:
   *
   * ```text
   * parseMarkdownContent('"WebFetch(domain:www.anthropic.com)"\n', 36)
   *   .links[0].line === undefined      // whereas '(www.anthropic.com)' → 1
   * ```
   *
   * ⛔ **The count is deliberately not written here.** It used to read
   * "measured 77 over this repository's 4,425 blobs, with a per-extension
   * breakdown". Re-measured over the tracked tree it came back **94** — the
   * figure moves whenever anyone adds a file quoting a URL, so pinning it in
   * prose only guarantees a docstring that is wrong most of the time. Run the
   * stage and read this counter if you want today's number.
   *
   * 🔑 What IS stable, and what the counter is really for, is the SHAPE: every
   * dropped candidate observed so far is an http/www/email target sitting in a
   * *non-markdown* blob (`.ts`, `.json`, `.yaml` — quoted URLs in source and
   * fixtures), so none of them is a closure edge. That is a measured property
   * of GFM autolink literals, not a guarantee — a position-less node naming a
   * local file would be a lost edge, and this counter is the only thing that
   * would show it. "Harmless" is a judgement a lens makes, not a reason to stop
   * counting. Defaulting them to line 1 instead would plant rows at the top of
   * documents where nothing could falsify them.
   */
  readonly referencesSkippedForMissingLine: number;
  /**
   * Blobs whose decode produced at least one U+FFFD.
   *
   * The one counter here that describes a blob the stage **derived** rather than
   * one it declined, and it is here for that reason: a refusal is at least
   * visible as a missing row, while a mis-decode produces a complete, plausible,
   * queryable row whose text is garbage. Nothing else in this result set would
   * ever go non-zero for it.
   *
   * Counted at row-emission time, deliberately **after** the {@link looksBinary}
   * refusal. Counting it at read time would count every PNG, zip and PDF in the
   * corpus — their bytes are invalid UTF-8 by the megabyte — and a warning that
   * fires on every repository containing an image is wallpaper. What survives to
   * here is the population that actually reached the index.
   */
  readonly blobsDecodedWithReplacements: number;
  /**
   * Of those, how many had **no BOM**, so the encoding was a guess.
   *
   * The distinction that decides what a reader should do. With a BOM the
   * encoding is a fact and the replacements mean the file is genuinely corrupt;
   * without one they mean VAT probably read a windows-1252 or BOM-less UTF-16
   * document as UTF-8, and the remedy is to re-encode the source rather than to
   * repair it.
   */
  readonly blobsAssumedEncodingWithReplacements: number;
  /**
   * Total U+FFFD across those blobs — characters, not malformed byte runs.
   *
   * The magnitude, which the blob count alone cannot give: one replacement in a
   * 40 KB document is a stray byte, and 3,200 in the same document is a file
   * that was never UTF-8 at all.
   */
  readonly replacementCharacters: number;
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
  /**
   * How, and whether, to move parsing off this thread.
   *
   * Defaults are what a command gets; see {@link ParsePoolPolicy}.
   */
  parsePool?: ParsePoolPolicy | undefined;
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
 * **Concurrency does not weaken any of that.** Reading and parsing happen with a
 * bounded fan-out ({@link driveInOrder}) and may finish in any order; every
 * `builder.*` call happens afterwards, in target order, from
 * {@link emitPreparedBlob}. The row order is a function of the corpus and of
 * nothing else — not of the fan-out width, not of which worker answered first,
 * not of whether a pool ran at all.
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

  const pending = pendingTargets(base, counts);
  const dispatcher = new ParseDispatcher(cache, options.parsePool ?? {});
  try {
    await driveInOrder(
      pending,
      dispatcher,
      async (target) => prepareBlob(target, base, dispatcher),
      (prepared) => emitPreparedBlob(builder, prepared, counts),
      // The key's own prefix is the routing record — see `parserKindOf`, which
      // is the single authority so this cannot drift from what `prepareBlob`
      // decides, and which answers without touching the file.
      (from) => tallyParsable(pending, from, (target) => parserKindOf(target.contentKey)),
    );
  } finally {
    // ⚠️ In a `finally`, and it must stay there. `pool.shutdown()` is what closes
    // each worker's port gracefully so its `exit` listeners run and its
    // parse-timing dump reaches disk; a run that threw past this would leave live
    // threads, and a process that exits with live threads runs none of their exit
    // listeners. See `parse-pool.ts` — `terminate()` is not shutdown.
    await dispatcher.shutdown();
  }

  return counts;
}

/**
 * The targets this run must actually derive, charging the ones it need not.
 *
 * Split out of the loop so the loop below receives a plain list: the drive claims
 * targets by INDEX and emits by index, and a `continue` in the middle of the
 * enumeration would make "the target at position n" a different blob on the two
 * sides.
 *
 * @param base - The projection built so far
 * @param counts - The accumulator; charges {@link BlobPopulationResult.blobsAlreadyPresent}
 * @returns The targets with no `blobs` row yet, in content-key order
 */
function pendingTargets(base: ProjectionBase, counts: MutableCounts): BlobTarget[] {
  const alreadyPresent = new Set(base.blobs.map((row) => row.contentKey));
  const pending: BlobTarget[] = [];

  for (const target of blobTargets(base)) {
    if (alreadyPresent.has(target.contentKey)) {
      counts.blobsAlreadyPresent += 1;
      continue;
    }
    pending.push(target);
  }

  return pending;
}


/** A zeroed accumulator — one place that knows every bucket. */
function emptyCounts(): MutableCounts {
  return {
    blobsDerived: 0,
    blobsAlreadyPresent: 0,
    blobsUnreadable: 0,
    blobsContentChanged: 0,
    blobsParseFailed: 0,
    blobsNotText: 0,
    blobsWithoutParser: 0,
    realizationsSkippedDirectory: 0,
    realizationsSkippedAbsent: 0,
    realizationsSkippedDanglingSymlink: 0,
    realizationsSkippedUnkeyed: 0,
    realizationsContentDeferred: 0,
    headingsSkippedForMissingLine: 0,
    referencesSkippedForMissingLine: 0,
    blobsDecodedWithReplacements: 0,
    blobsAssumedEncodingWithReplacements: 0,
    replacementCharacters: 0,
  };
}

/**
 * Attribute one derived blob's decode to the encoding buckets.
 *
 * A no-op for a clean decode, which is nearly every blob — the point of these
 * counters is that they stay at zero until something is actually wrong, so a
 * clean corpus produces exactly the silence it did before.
 *
 * @param decoding - What the decode of this blob's bytes knew, guessed and lost
 * @param counts - The accumulator to attribute it to
 */
function countDecoding(decoding: TextProvenance, counts: MutableCounts): void {
  if (decoding.replacementCharacters === 0) return;
  counts.blobsDecodedWithReplacements += 1;
  counts.replacementCharacters += decoding.replacementCharacters;
  if (decoding.encodingSource === 'assumed') {
    counts.blobsAssumedEncodingWithReplacements += 1;
  }
}

/**
 * Attribute one content-key-less realization to the reason it has no blob.
 *
 * A `switch` on `contentState`, not a reconstruction: the base already decided
 * why this row carries no key, and that decision is a column. The previous
 * implementation re-derived it from `isDirectory`/`exists`/`symlinkResolves`
 * and put everything it could not explain into one residue bucket — which meant
 * a file the run failed to read and a file the run deliberately did not read
 * were counted as the same thing.
 *
 * @param row - A realization whose `contentKey` is null
 * @param counts - The accumulator to attribute it to
 */
function countUnkeyedRealization(row: ResourceRealizationRow, counts: MutableCounts): void {
  switch (row.contentState) {
    case 'none': {
      countBytelessRealization(row, counts);
      break;
    }
    case 'unreadable': {
      counts.realizationsSkippedUnkeyed += 1;
      break;
    }
    case 'deferred': {
      counts.realizationsContentDeferred += 1;
      break;
    }
    case 'keyed': {
      // Filtered out by the caller: the schema pins keyed ⟺ a non-null key in
      // both directions, so a keyed row cannot reach a null-key counter.
      break;
    }
  }
}

/**
 * Split a `contentState: 'none'` row into the three shapes that produce it.
 *
 * `keyOrState` emits `none` exactly when `lstat` said there are no bytes —
 * absent, a directory, or a dangling symlink — so these three exhaust it. They
 * stay separate because "the corpus has 2,000 directories" and "the corpus
 * names 2,000 paths that are not there" are different facts about a run.
 *
 * @param row - A realization whose `contentState` is `none`
 * @param counts - The accumulator to attribute it to
 */
function countBytelessRealization(row: ResourceRealizationRow, counts: MutableCounts): void {
  if (row.isDirectory) {
    counts.realizationsSkippedDirectory += 1;
  } else if (row.exists) {
    // Present, not a directory, and still byteless: the remaining shape
    // `keyOrState` calls `none` is a symlink whose target does not resolve.
    counts.realizationsSkippedDanglingSymlink += 1;
  } else {
    counts.realizationsSkippedAbsent += 1;
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
 * The filter is on `contentState === 'keyed'`, not on `contentKey !== null`.
 * The schema's `superRefine` makes the two equivalent **today**, which is
 * exactly why the choice has to be deliberate: a fourth null state added later
 * would slip through a null check silently and become a blob target that has no
 * bytes, whereas it cannot slip through a state check. (The `contentKey === null`
 * arm below is the type system's requirement, not a second rule — the row type
 * cannot express the invariant.)
 *
 * @param base - The projection built so far
 * @returns One target per distinct content key, ordered by content key
 */
function blobTargets(base: ProjectionBase): BlobTarget[] {
  const pathByKey = new Map<string, string>();

  for (const row of base.resourceRealizations) {
    if (row.contentState !== 'keyed' || row.contentKey === null) continue;
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
 * Which refusal counter a {@link RefusedBlob} charges.
 *
 * A key of {@link MutableCounts} rather than a private enum, so the bucket and
 * the counter cannot drift: a renamed counter stops this compiling, whereas a
 * `switch` mapping one to the other would happily keep charging the old one.
 */
type RefusalBucket = 'blobsUnreadable' | 'blobsContentChanged' | 'blobsNotText' | 'blobsParseFailed';

/** A blob the stage declined, with the row and the bucket that say why. */
interface RefusedBlob {
  outcome: 'refused';
  bucket: RefusalBucket;
  row: BlobConditionRow;
}

/** A blob whose facts are ready to be written into the builder. */
interface DerivedBlob {
  outcome: 'derived';
  target: BlobTarget;
  keyed: KeyedContent;
  parsed: ParseResult;
  /** A `none.` key — charges {@link BlobPopulationResult.blobsWithoutParser}. */
  withoutParser: boolean;
}

/**
 * Everything {@link prepareBlob} can conclude, as a VALUE.
 *
 * The whole point of the type: preparation runs concurrently, so anything it
 * decided has to be carried back to the sequential half rather than written
 * where it was decided. A prepare that recorded its own condition row would put
 * `blob_conditions` in completion order while `blobs` stayed in target order —
 * two tables from one run disagreeing about what "first" means.
 */
type PreparedBlob = RefusedBlob | DerivedBlob;

/**
 * Read and parse one blob, deciding everything and recording nothing.
 *
 * ⛔ It must stay free of side effects on the builder and the counters. This is
 * the half that runs concurrently — see {@link driveInOrder} — so a
 * `builder.*` call here would order rows by which read finished first.
 *
 * @param target - The blob and the path its bytes come from
 * @param base - Supplies the corpus root and the run's content cache
 * @param dispatcher - Decides whether the parse runs here or on a worker
 * @returns What this blob turned out to be, for the caller to emit in order
 * @throws {ParserUnavailableError} If the parser module cannot be loaded — a
 *   broken install fails the run rather than accusing the corpus
 */
async function prepareBlob(
  target: BlobTarget,
  base: ProjectionBase,
  dispatcher: ParseDispatcher,
): Promise<PreparedBlob> {
  // Read back HERE rather than inside `readTarget`, which would put it inside
  // that function's `try`: a key naming no kind is a producer bug, and reporting
  // one as `BLOB_UNREADABLE` would blame the corpus for it.
  const parserKind = parserKindOf(target.contentKey);
  const keyed = await readTarget(target, parserKind, base);
  if ('outcome' in keyed) return keyed;

  // Before the parse, never after: the whole cost this refuses IS the parse.
  // And after the DECODE, never before — see {@link looksBinary} for why a sniff
  // over raw bytes refuses every UTF-16 document, and for why the test is on the
  // content rather than on the extension. Ahead of the kind split below, because
  // a `none`-routed binary is just as much a waste as a markdown-routed one.
  if (looksBinary(keyed.content)) {
    return refused('blobsNotText', condition(
      target.contentKey,
      BLOB_NOT_TEXT,
      `"${target.path}" contains a NUL within the first ${BINARY_SNIFF_CHARS} characters of its`
      + ' decoded content, so it is not text; no parser was run over it. This blob has no sections'
      + ' or references because it cannot have any, not because it was skipped silently',
    ));
  }

  // THE kind split. `isParsableContent` is a type guard rather than a
  // `parserKind !== 'none'` comparison because narrowing a property does not
  // narrow the object, and the parse path accepts only the narrowed type — so
  // forgetting this branch is a compile error at the call site rather than a
  // parser handed bytes nothing routed to it.
  if (!isParsableContent(keyed)) {
    return { outcome: 'derived', target, keyed, parsed: unparsedFacts(keyed), withoutParser: true };
  }

  const parsed = await parseTarget(target, keyed, dispatcher);
  if ('outcome' in parsed) return parsed;
  return { outcome: 'derived', target, keyed, parsed, withoutParser: false };
}

/**
 * A refusal, paired with the counter it charges.
 *
 * @param bucket - Which counter emission should charge
 * @param row - The condition row emission should add
 * @returns The refusal, for {@link emitPreparedBlob} to record in order
 */
function refused(bucket: RefusalBucket, row: BlobConditionRow): RefusedBlob {
  return { outcome: 'refused', bucket, row };
}

/**
 * Write one prepared blob into the builder, and charge what it cost.
 *
 * THE sequential half. Every mutation this stage performs happens here, and it
 * is called in target order, which is what makes the row order a function of the
 * corpus rather than of the machine.
 *
 * The counters are charged here too, though every one of them is a pure sum:
 * charging them in preparation would work today and would silently stop working
 * the first time a counter cares about order.
 *
 * @param builder - The builder to add rows to
 * @param prepared - What preparation concluded about one blob
 * @param counts - The accumulator
 */
function emitPreparedBlob(
  builder: ProjectionBuilder,
  prepared: PreparedBlob,
  counts: MutableCounts,
): void {
  if (prepared.outcome === 'refused') {
    counts[prepared.bucket] += 1;
    builder.addBlobCondition(prepared.row);
    return;
  }

  if (prepared.withoutParser) counts.blobsWithoutParser += 1;
  emitBlobRows(builder, prepared.target, prepared.keyed, prepared.parsed, counts);
  counts.blobsDerived += 1;
}

/**
 * The code context a blob with no AST has: none.
 *
 * `findLexicalReferences` normally receives the ranges `collectCodeContextRanges`
 * walked out of the tree, and a `none` blob has no tree. Empty ranges are honest
 * rather than lossy here, and the measurement is what says so: the
 * fence/code-span annotation covered 0.0–2.7% of source files, and on those it
 * **inverted** — a backtick in a JSDoc comment read `inCodeSpan: true` while the
 * executable code beneath it read `false`, because remark was reading TypeScript
 * as CommonMark. An annotation that is wrong exactly where it applies is worth
 * less than an absent one, and every consumer already handles `false`.
 *
 * `excluded` is empty for a second, independent reason: it suppresses tokens
 * inside `link` / `image` / `yaml` / `html` NODES, so that a markdown link's
 * destination is not counted twice. Nothing is being double-counted here,
 * because no AST recorded it the first time.
 *
 * Shared rather than rebuilt per blob — the lexer only reads it — since being
 * cheap is the point of this route.
 */
const NO_CODE_CONTEXT: CodeContextRanges = { fences: [], codeSpans: [], excluded: [] };

/**
 * The facts a blob with no document parser has: everything derivable from its
 * bytes, and nothing derivable from a tree.
 *
 * Assembled here rather than fetched from a parser because there is no parser to
 * fetch it from — that is what `none` *means*. The empty fields are empty
 * because the document genuinely has no such facts, not because they were
 * skipped: `links` and `headings` are AST products, and `anchors`,
 * `parseErrors`, `unresolvedReferences` and the frontmatter trio are omitted
 * exactly as `parseHtmlContent` omits the ones it cannot produce.
 *
 * ⚠️ Deliberately NOT routed through {@link ParseCache}. An entry buys the cost
 * of the computation it replaces, and this one is `estimateTokens`, one lexer
 * scan and one offset walk — over a cold population of 8,713 documents the whole
 * `estimateTokens` pass measured 0.0006 s against `remark-parse`'s 66.0 s. Filing
 * that behind a disk read, a JSON parse and a Zod validate would cost more than
 * it saves, and would put a second, staler answer where the bytes already are.
 *
 * @param keyed - The confirmed read, of the kind no parser routes to
 * @returns Parse facts describing exactly what the bytes say and nothing more
 */
function unparsedFacts(keyed: KeyedContent): ParseResult {
  const lexicalReferences = findLexicalReferences(keyed.content, NO_CODE_CONTEXT);
  return {
    links: [],
    headings: [],
    // Omitted when empty, matching `parseMarkdownContent`: no own property of a
    // `ParseResult` is ever valued `undefined`, and the cache's JSON round trip
    // is exact under `toStrictEqual` only while that holds.
    ...(lexicalReferences.length > 0 && { lexicalReferences }),
    // No fence ranges, because no AST said where any are — so every code unit
    // counts as prose. That is the only thing that can honestly be said, and it
    // keeps `proseCodeUnits + codeBlockCodeUnits === content.length` true.
    contentMeasures: measureContent(keyed.content, []),
    content: keyed.content,
    sizeBytes: keyed.byteLength,
    estimatedTokenCount: estimateTokens(keyed.content),
  };
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
 * ## The read goes through the run's cache, so it is the base's read
 *
 * `content-cache.ts` holds what the base already read for this path, keyed on
 * `(path, parserKind)` — and the caller got `parserKind` from
 * {@link parserKindOf}, which reads the routing back off the content key, the
 * same answer `collectRealization` recorded it from. So inside `populate()` this
 * is a memo hit, not a third traversal of the file.
 *
 * That makes both failure branches below **unreachable for a path this run
 * already read**: the cached bytes are by construction the bytes the key names,
 * and a file deleted mid-run is still held. Deliberate — see
 * `RunContentCache.read`, which owns that decision and the argument for it. The
 * branches stay because `populateBlobs` is also reachable from a builder with no
 * cache, where the read is genuinely fresh and can genuinely disagree.
 *
 * **Demand promotion does not change that argument.** A row promoted by
 * `ProjectionBuilder.ensureContentKey` had its key minted through this same run
 * cache, so when this stage then reads the promoted path it is served the very
 * bytes that key names — the identical position a row keyed at enumeration time
 * is in, reached one stage later.
 *
 * @param target - The blob and its path
 * @param parserKind - The routing read back off the key by {@link parserKindOf}.
 *   It must be the kind the key names, or the read computes a different key and
 *   every blob looks like it changed under the run.
 * @param base - Supplies the absolute corpus root and the run's content cache
 * @returns The read, or the refusal to emit in its place
 */
async function readTarget(
  target: BlobTarget,
  parserKind: ParserKind,
  base: ProjectionBase,
): Promise<KeyedContent | RefusedBlob> {
  let keyed: KeyedContent;
  try {
    keyed = await readKeyedContent(safePath.join(base.root, target.path), parserKind, base.contentCache);
  } catch (error) {
    return refused('blobsUnreadable', condition(
      target.contentKey,
      BLOB_UNREADABLE,
      `The bytes for "${target.path}" could not be read during blob derivation (${errorLabel(error)});`
      + ' this blob has no rows because it could not be observed, not because it has nothing to say',
    ));
  }

  if (keyed.key !== target.contentKey) {
    return refused('blobsContentChanged', condition(
      target.contentKey,
      BLOB_CONTENT_CHANGED,
      `"${target.path}" now keys to ${keyed.key}, so its current bytes are not this blob's;`
      + ' deriving from them would file one blob\'s facts under another blob\'s key',
    ));
  }

  return keyed;
}

/**
 * Parse a blob, recording a condition instead of propagating a throw.
 *
 * Reachable rather than defensive, and MIME routing did not make it less so. A
 * `.md` file may hold anything at all; `text/plain` — a `.txt`, an extensionless
 * `README` — routes to the markdown parser deliberately (see
 * `parserKindForMimeType`); and typing is by NAME, so a renamed archive that
 * survives the binary sniff still reaches a parser. One document failing must
 * not abort a whole population.
 *
 * ⚠️ A broken INSTALL must not be reported as a broken DOCUMENT. The parser
 * arrives by `import()` from inside `parseKeyed`, so a module that cannot be
 * loaded — a half-extracted tarball, a quarantined or `chmod 000` file — lands in
 * this very catch, and unguarded was reported as
 * `The markdown parser threw on the bytes at "<path>" (EACCES)`, once per
 * document, blaming every innocent file in the corpus while the exit code stayed
 * 0.
 *
 * The guard is the error TYPE, not the load's position. Hoisting the load above
 * this `try` also closes it, and was tried — it costs every fully warm
 * population the ~730 ms remark load for parses that never happen, which is the
 * whole point of loading past the cache's hit-path return. `isParserUnavailable`
 * matches one type VAT constructs at one place, so it is complete by
 * construction; it is emphatically not the errno blocklist that was deleted (see
 * its docstring). The errno classes remain indistinguishable by inspection —
 * that is why nothing here inspects.
 *
 * The guard covers the pooled route too: a worker's `ParserUnavailableError`
 * arrives as a plain `Error` — structured clone cannot carry a class — but it
 * still wears the original `code`, which is the half `isParserUnavailable`
 * matches on. That is why the code exists rather than only the class.
 *
 * @param target - The blob and its path
 * @param keyed - The confirmed read, narrowed to a kind that HAS a parser. The
 *   narrowing is the caller's, and it is why no branch in here has to invent an
 *   answer for a blob nothing parses.
 * @param dispatcher - Decides whether the parse runs here or on a worker
 * @returns The parse, or the refusal to emit in its place
 * @throws {ParserUnavailableError} If the parser module cannot be loaded — a
 *   broken install fails the run rather than accusing the corpus
 */
async function parseTarget(
  target: BlobTarget,
  keyed: ParsableContent,
  dispatcher: ParseDispatcher,
): Promise<ParseResult | RefusedBlob> {
  try {
    return await dispatcher.parse(keyed);
  } catch (error) {
    // The install, not the document. See the ⚠️ block above for why this is a
    // type check and not a hoist, and `isParserUnavailable` for why matching one
    // constructed type is not the guessed blocklist that preceded it.
    if (isParserUnavailable(error)) throw error;

    return refused('blobsParseFailed', condition(
      target.contentKey,
      BLOB_PARSE_FAILED,
      `The ${keyed.parserKind} parser threw on the bytes at "${target.path}" (${errorLabel(error)})`,
    ));
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
  builder.addBlob(blobRowFor(contentKey, keyed.byteLength, keyed.decoding, parsed));
  countDecoding(keyed.decoding, counts);

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

// `compareCodeUnits` comes from `@vibe-agent-toolkit/utils`. Never `localeCompare`: collation is
// locale-dependent, so two machines populating one corpus would order these rows differently, which
// defeats the entire point of sorting them.
