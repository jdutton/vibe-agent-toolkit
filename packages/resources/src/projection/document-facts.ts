/**
 * What a document is before, or instead of, a parse: the ONE rule both lanes route
 * every read through (the registry's `admitFacts` and the blob lane's `prepareBlob`).
 *
 * Three routes, decided in this order by {@link contentRoute}:
 *
 * 1. **not text** - a NUL in the decoded head ({@link looksBinary}): no parser runs. The
 *    blob lane records `BLOB_NOT_TEXT` and stores no `blobs` row; the registry admits the
 *    file with {@link notTextFacts}. The fact reader rebuilds the same facts from the
 *    condition alone, so the two lanes agree by construction.
 * 2. **without a parser** - a kind nothing parses: {@link unparsedFacts}.
 * 3. **parse** - the narrowed content, for the caller's dispatcher.
 */

import { isParsableContent, type KeyedContent, type ParsableContent } from '../content-key.js';
import { estimateTokens } from '../link-classify.js';
import type { ParseResult } from '../link-parser.js';
import { type CodeContextRanges, findLexicalReferences } from '../reference-lexer.js';

import { measureContent } from './blob-facts.js';

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
 * The blob lane records a `BLOB_NOT_TEXT` condition, exactly as it does for
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
 * The code context a blob with no AST has: none.
 *
 * `findLexicalReferences` normally receives the ranges `codeContextRangesFrom`
 * filtered out of the parse's spans, and a `none` blob is never parsed. Empty ranges are honest
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
 * Both lanes use it: the registry's resource has no column for `lexicalReferences` or
 * `contentMeasures` and ignores them, and one function keeps the two lanes' facts one
 * contract rather than two near-copies.
 *
 * ⚠️ Deliberately NOT routed through `ParseCache`. An entry buys the cost
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
    // No parser routes these bytes, and the skills lane scans only markdown-routed text.
    skillText: null,
    content: keyed.content,
    sizeBytes: keyed.byteLength,
    estimatedTokenCount: estimateTokens(keyed.content),
  };
}

/** The reason a not-text blob carries: no parser ran, and why. */
export const NOT_TEXT_MESSAGE =
  `This blob contains a NUL within the first ${BINARY_SNIFF_CHARS} characters of its decoded`
  + ' content, so it is not text; no parser was run over it. It has no sections or references'
  + ' because it cannot have any, not because it was skipped silently';

/**
 * The resource facts of a document that is not text: no links, no headings, no tokens.
 * The ONE value both lanes give such a resource: the registry through
 * {@link notTextFacts}, the fact reader from the `BLOB_NOT_TEXT` condition alone.
 *
 * Zero tokens rather than an estimate over the bytes: a token estimate of binary is a
 * count of mojibake, and the blob lane stores none, so the one value both lanes can
 * agree on is the one that says nothing was read as text.
 */
export const NOT_TEXT_RESOURCE_FACTS: Readonly<Pick<ParseResult, 'links' | 'headings' | 'estimatedTokenCount' | 'skillText'>> = Object.freeze({
  links: [],
  headings: [],
  estimatedTokenCount: 0,
  // Nothing was read as text, so there is no skill-text record: a lane that
  // scans such a file scans it from its text, counted (`skillText.storeMiss`).
  skillText: null,
});

/**
 * The parse facts of a document that is not text: {@link NOT_TEXT_RESOURCE_FACTS} and its bytes.
 *
 * @param keyed - The confirmed read
 * @returns The not-text facts
 */
function notTextFacts(keyed: KeyedContent): ParseResult {
  return { ...NOT_TEXT_RESOURCE_FACTS, links: [], headings: [], content: keyed.content, sizeBytes: keyed.byteLength };
}

/** Where one read goes: see the module docblock. */
type ContentRoute =
  | { readonly kind: 'not-text'; readonly facts: ParseResult }
  | { readonly kind: 'without-parser'; readonly facts: ParseResult }
  | { readonly kind: 'parse'; readonly content: ParsableContent };

/**
 * Route one read: not text, no parser, or a parse. THE kind split for both lanes.
 *
 * `isParsableContent` is a type guard rather than a `parserKind !== 'none'` comparison
 * because narrowing a property does not narrow the object, and the parse path accepts
 * only the narrowed type.
 *
 * @param keyed - The confirmed read
 * @returns Its route
 */
export function contentRoute(keyed: KeyedContent): ContentRoute {
  if (looksBinary(keyed.content)) return { kind: 'not-text', facts: notTextFacts(keyed) };
  if (!isParsableContent(keyed)) return { kind: 'without-parser', facts: unparsedFacts(keyed) };
  return { kind: 'parse', content: keyed };
}
