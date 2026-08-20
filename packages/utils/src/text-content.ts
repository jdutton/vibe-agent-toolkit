/**
 * **The one way VAT turns file bytes into text.**
 *
 * `local/no-raw-text-decode` enforces that — but only where it is registered,
 * which today is `packages/utils/src` and `packages/resources/src`. Those two
 * own the seam and every corpus-document read; the rest of the repo is a
 * migration ledger, not a covered claim, and `eslint.config.js` carries it in
 * cost order. Do not read this docstring as "nothing else in the repo decodes".
 *
 * ## Where this lives, and why it is a `utils` primitive
 *
 * Bytes-to-text is a pure function of its argument. It knows nothing about
 * content keys, parse caches or the projection — `readContentWithKey` in
 * `@vibe-agent-toolkit/resources` *composes* this with a raw-bytes content key,
 * and the key is the projection concept, not the decode.
 *
 * It has to live here for a harder reason than tidiness. `resources` depends on
 * `utils` and `utils` must never depend on `resources`, so a seam in `resources`
 * with a lint rule shipped from `utils` would flag `utils`' own reads
 * (`gitignore-checker.ts` reads an adopter's `.gitignore`; `project-utils.ts`
 * reads an adopter's `package.json`) while giving them no legal way to comply.
 * The rule would then be widened with exemptions until it meant nothing. Placing
 * the primitive at the bottom of the arrow is what makes the guardrail
 * enforceable.
 *
 * `./text` is also deliberately **pure** — no `node:*` import at all — so bytes
 * from a git blob, an HTTP body or a zip entry decode through the same function
 * as bytes from disk. The file-reading half is in `./fs` (`readTextContent`),
 * where everything that touches `node:fs` lives.
 *
 * ## The defect this exists for
 *
 * `readContentWithKey` (in `@vibe-agent-toolkit/resources`) used to call
 * `bytes.toString('utf-8')` unconditionally. Measured end to end, on a real
 * `working-tree-encoding=UTF-16` checkout (see `resources`'
 * `test/system/git-hostile-config.system.test.ts`):
 *
 * ```text
 * bytes on disk   40 B, BOM fe ff, UTF-16BE
 * decoded         "��# \0D\0o\0c\0…"   NUL-interleaved mojibake
 * looksBinary     true  — the decoded string carries NULs
 * projection      BLOB_NOT_TEXT, no blob row, 0 sections, 0 references
 * the same doc    1 heading, 1 link, from its UTF-8 bytes
 * ```
 *
 * So VAT could not read a UTF-16 document *at all*, and the reason it matters is
 * not exotic: **PowerShell 5.1's `Out-File` and `>` write UTF-16LE by default**,
 * so a Windows-authored document lands squarely in that hole.
 *
 * ## What is a fact here, and what is an assumption
 *
 * The distinction is carried in the result ({@link TextProvenance.encodingSource})
 * rather than left to prose, because the two are not the same kind of claim:
 *
 * | input | encoding | encodingSource | why |
 * |---|---|---|---|
 * | leading `ef bb bf` | `utf-8` | `bom` | the bytes say so |
 * | leading `ff fe` (not `ff fe 00 00`) | `utf-16le` | `bom` | the bytes say so |
 * | leading `fe ff` | `utf-16be` | `bom` | the bytes say so |
 * | leading `ff fe 00 00` | `utf-32le` | `bom` | the bytes say so |
 * | leading `00 00 fe ff` | `utf-32be` | `bom` | the bytes say so |
 * | anything else | `utf-8` | `assumed` | the defensible default |
 *
 * ## And what proves the assumption WRONG
 *
 * `encoding` says what was guessed; {@link TextProvenance.replacementCharacters}
 * is what the guess cost. A malformed sequence decodes to U+FFFD instead of
 * throwing, so a mis-decoded document arrives as a well-formed JS string full of
 * garbage — and a byte-level BPE tokenizer has no out-of-vocabulary concept, so
 * it embeds and indexes that garbage without erroring anywhere. Counting the
 * substitutions is what turns "we assumed UTF-8" into "we assumed UTF-8 and were
 * demonstrably wrong 3,200 times in this file".
 *
 * It is counted **without paying for it on the clean path**. Every decode runs
 * first through a `fatal: true` decoder, which throws on the first malformed
 * sequence rather than substituting; a file that decodes cleanly — nearly every
 * file — costs exactly one decode and no scan at all. Only a file that actually
 * threw is decoded a second time in substituting mode and scanned for U+FFFD, so
 * the O(n) scan is charged entirely to broken input.
 *
 * That ordering also buys a correctness property a scan alone cannot have: a
 * document that *legitimately contains* U+FFFD is valid input, so the fatal
 * decoder does not throw and it is reported as **0** replacements rather than
 * accused of a bad decode. A bare scan would count its own content against it.
 *
 * 🪤 **The UTF-32LE BOM starts with the UTF-16LE BOM.** `ff fe 00 00` matches
 * `ff fe`, so a table tested shortest-first decodes every UTF-32LE document as
 * NUL-interleaved UTF-16 — the same bug this module exists to fix, one encoding
 * further down. {@link BOMS} is therefore ordered longest-first and the test
 * suite pins that ordering directly.
 *
 * ## The two limitations, recorded rather than guessed around
 *
 * - **BOM-less UTF-16 is not detected.** It is undecidable from bytes alone: the
 *   same byte string is a legal, different UTF-8 document. A NUL-density
 *   heuristic would decide it *usually* correctly and silently wrongly the rest
 *   of the time, and "silently wrongly" is the failure class this whole module
 *   is a reaction to. BOM-less input is UTF-8.
 * - **Latin charsets are not detected either, and there is no windows-1252
 *   fallback.** "These bytes are not valid UTF-8" is a fact; "therefore they are
 *   latin-1" is a guess, and it is equally consistent with a UTF-8 document
 *   carrying one corrupt byte. Malformed input gets U+FFFD. In practice the
 *   Latin family costs little: every ASCII byte string is valid UTF-8 and
 *   decodes correctly, so only high bytes are affected.
 *
 * Both are pinned as tests that state what is given up, so adding a heuristic
 * later has to edit an assertion rather than quietly widen a claim.
 *
 * ## Why `TextDecoder` for three encodings and hand-rolled code for two
 *
 * `TextDecoder` implements the WHATWG Encoding Standard, which **deliberately
 * omits UTF-32** — no engine offers it. Node's `Buffer` is narrower still:
 * `utf8`, `utf16le`/`ucs2`, `latin1`, `ascii` and the binary-to-text codecs, with
 * **no UTF-16BE at all** (the encoding a round trip through git's
 * `working-tree-encoding=UTF-16` actually produces). So `TextDecoder` carries
 * utf-8/utf-16le/utf-16be, and UTF-32 is converted here.
 *
 * Refusing UTF-32 loudly was the alternative, and it was rejected for one
 * reason: the BOM has to be *recognised* regardless (see the trap above), so the
 * choice was never "detect it or not" — only "having detected it, decode it or
 * throw". Decoding is ~20 lines and leaves no hole.
 *
 * ## The BOM is stripped, and that is load-bearing in both directions
 *
 * A surviving leading U+FEFF stops `# Heading` from parsing as a heading. And
 * every offset downstream is a **character** offset over this decoded string —
 * `lineStartOffsets` in `resources`' `projection/blob-sections.ts` derives them
 * from `content.split('\n')`, and `parseMarkdownContent` takes remark's own
 * character positions — so stripping shifts all of them consistently. What must
 * NOT shift is the content key, which is computed over the raw bytes; see
 * `resources`' `content-key.ts`.
 */

/** An encoding this module can decode. */
export type TextEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'utf-32le' | 'utf-32be';

/**
 * How the encoding was arrived at.
 *
 * `'bom'` is a fact about the bytes. `'assumed'` is a default, and the honest
 * name for it: BOM-less UTF-16 and BOM-less latin-1 both land here and both
 * decode as UTF-8.
 */
export type EncodingSource = 'bom' | 'assumed';

/**
 * Everything the decode knew, guessed, and lost — the text itself excluded.
 *
 * Split out from {@link DecodedText} so a consumer that must carry the decode's
 * provenance alongside *other* facts about the same bytes — `KeyedContent` in
 * `@vibe-agent-toolkit/resources` carries it beside a content key and a byte
 * length — can hold exactly these three fields without also re-holding the
 * content, and without restating them one by one at every layer they cross.
 */
export interface TextProvenance {
  /** The encoding used. */
  readonly encoding: TextEncoding;
  /** Whether {@link encoding} was read off a BOM or assumed. */
  readonly encodingSource: EncodingSource;
  /**
   * How many U+FFFD REPLACEMENT CHARACTERs the decode produced.
   *
   * Zero for a document that decodes cleanly, **including one whose own content
   * legitimately contains U+FFFD** — see the module docstring for why the
   * fatal-first ordering is what makes those two cases distinguishable. A
   * non-zero value is proof, not suspicion: these bytes are not valid in the
   * encoding they were read as.
   */
  readonly replacementCharacters: number;
}

/** Text decoded from bytes, and what it was decoded as. */
export interface DecodedText extends TextProvenance {
  /** The decoded content, BOM removed, exactly as a parser should receive it. */
  readonly text: string;
}

/**
 * Byte-order marks, **longest first**.
 *
 * The ordering is the correctness property, not a formatting choice — see the
 * module docstring's trap. Frozen so a caller cannot reorder it in place.
 */
const BOMS: readonly { readonly bytes: readonly number[]; readonly encoding: TextEncoding }[] =
  Object.freeze([
    { bytes: [0xff, 0xfe, 0x00, 0x00], encoding: 'utf-32le' },
    { bytes: [0x00, 0x00, 0xfe, 0xff], encoding: 'utf-32be' },
    { bytes: [0xef, 0xbb, 0xbf], encoding: 'utf-8' },
    { bytes: [0xff, 0xfe], encoding: 'utf-16le' },
    { bytes: [0xfe, 0xff], encoding: 'utf-16be' },
  ]);

/**
 * One `TextDecoder` per encoding, built once.
 *
 * Constructing a decoder per call is measurable on a corpus of thousands of
 * files, and these are stateless when `stream: false` (the default for
 * `decode()`), so one instance is safe to share.
 *
 * `ignoreBOM: true` on purpose: this module has already removed the BOM by the
 * time a decoder sees the bytes, and leaving the option at its default would put
 * a second, silent BOM-stripping step behind the deliberate one — so a document
 * whose *content* legitimately begins with U+FEFF would lose a character that
 * nothing here decided to remove.
 */
const DECODERS: ReadonlyMap<TextEncoding, InstanceType<typeof TextDecoder>> = new Map([
  // No `eslint-disable` needed: this file is the `exemptFiles` entry for
  // `local/no-raw-text-decode` in the repo's `eslint.config.js`. If the rule
  // starts firing here, that entry has drifted from this path.
  ['utf-8', new TextDecoder('utf-8', { ignoreBOM: true })],
  ['utf-16le', new TextDecoder('utf-16le', { ignoreBOM: true })],
  ['utf-16be', new TextDecoder('utf-16be', { ignoreBOM: true })],
]);

/**
 * The same three encodings in **fatal** mode — throw rather than substitute.
 *
 * This is the whole cost model for {@link TextProvenance.replacementCharacters}.
 * A substituting decoder cannot tell a caller whether it substituted, so the only
 * other way to know is to scan every decoded string for U+FFFD — an O(n) pass
 * over every file in a corpus to learn that almost none of them needed it. A
 * fatal decoder answers the same question by *not throwing*, at no extra cost on
 * the clean path, and the expensive route is taken only where there is genuinely
 * something to count.
 *
 * Same `ignoreBOM: true` as their substituting twins, for the same reason: the
 * BOM is already gone by the time either sees the bytes.
 */
const FATAL_DECODERS: ReadonlyMap<TextEncoding, InstanceType<typeof TextDecoder>> = new Map([
  ['utf-8', new TextDecoder('utf-8', { ignoreBOM: true, fatal: true })],
  ['utf-16le', new TextDecoder('utf-16le', { ignoreBOM: true, fatal: true })],
  ['utf-16be', new TextDecoder('utf-16be', { ignoreBOM: true, fatal: true })],
]);

/** How many code points to spread into one `String.fromCodePoint` call. */
const CODE_POINT_CHUNK = 4096;

/** The last Unicode code point. */
const MAX_CODE_POINT = 0x10_ff_ff;

/** First and last UTF-16 surrogate — never a scalar value on their own. */
const SURROGATE_FIRST = 0xd8_00;
const SURROGATE_LAST = 0xdf_ff;

/** U+FFFD REPLACEMENT CHARACTER, what a malformed unit becomes. */
const REPLACEMENT_CODE_POINT = 0xff_fd;

/** Does `bytes` begin with `prefix`? */
function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  return prefix.every((byte, index) => bytes[index] === byte);
}

/**
 * The encoding a BOM announces, and how many bytes it occupies.
 *
 * @param bytes - Raw bytes, from the start of the file
 * @returns The BOM's encoding and length, or `null` when there is no BOM
 */
function bomAt(bytes: Uint8Array): { encoding: TextEncoding; length: number } | null {
  for (const bom of BOMS) {
    if (startsWith(bytes, bom.bytes)) {
      return { encoding: bom.encoding, length: bom.bytes.length };
    }
  }
  return null;
}

/**
 * Is `codePoint` something `String.fromCodePoint` will accept?
 *
 * A lone surrogate and anything past U+10FFFF both throw, and a corrupt document
 * must not surface as an exception out of a decoder.
 */
function isScalarValue(codePoint: number): boolean {
  if (codePoint > MAX_CODE_POINT) return false;
  return codePoint < SURROGATE_FIRST || codePoint > SURROGATE_LAST;
}

/**
 * Build a string from code points, in chunks.
 *
 * `String.fromCodePoint(...points)` blows the engine's argument limit somewhere
 * in the tens of thousands, which a real document reaches — so the spread is
 * bounded rather than whole-array.
 */
function fromCodePoints(points: readonly number[]): string {
  if (points.length <= CODE_POINT_CHUNK) return String.fromCodePoint(...points);
  const parts: string[] = [];
  for (let start = 0; start < points.length; start += CODE_POINT_CHUNK) {
    parts.push(String.fromCodePoint(...points.slice(start, start + CODE_POINT_CHUNK)));
  }
  return parts.join('');
}

/**
 * Decode UTF-32, by hand, because no engine does.
 *
 * Every 4-byte unit that is not a Unicode scalar value becomes U+FFFD, as does a
 * trailing run of 1–3 bytes that cannot form a unit. That mirrors what
 * `TextDecoder` does with malformed input, so the two paths fail the same way.
 *
 * There is no fatal-first pass here and none is needed: this loop *decides* each
 * substitution, so it can count them as it makes them — free, and exact. The
 * fatal-decoder trick exists only because `TextDecoder` refuses to say.
 *
 * @param bytes - The content bytes, BOM already removed
 * @param littleEndian - Byte order the BOM announced
 * @returns The decoded string and how many units were replaced
 */
function decodeUtf32(
  bytes: Uint8Array,
  littleEndian: boolean,
): { text: string; replacementCharacters: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const whole = bytes.byteLength - (bytes.byteLength % 4);
  const points: number[] = [];
  let replacementCharacters = 0;
  for (let offset = 0; offset < whole; offset += 4) {
    const codePoint = view.getUint32(offset, littleEndian);
    if (isScalarValue(codePoint)) {
      points.push(codePoint);
    } else {
      points.push(REPLACEMENT_CODE_POINT);
      replacementCharacters += 1;
    }
  }
  if (whole !== bytes.byteLength) {
    points.push(REPLACEMENT_CODE_POINT);
    replacementCharacters += 1;
  }
  return { text: fromCodePoints(points), replacementCharacters };
}

/**
 * Count the U+FFFD in a string that a fatal decode already refused.
 *
 * Only ever called on input known to be malformed, which is what keeps the O(n)
 * scan off the common path. `charCodeAt` rather than a regex or a split: U+FFFD
 * is a BMP character, so a code-unit comparison is exact here and allocates
 * nothing on a string that may be megabytes long.
 *
 * @param text - The substituting decoder's output
 * @returns How many replacement characters it contains
 */
function countReplacementCharacters(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === REPLACEMENT_CODE_POINT) count += 1;
  }
  return count;
}

/**
 * **The canonical content-decoding seam.** Turn file bytes into the text a
 * parser should see.
 *
 * Takes bytes rather than a path so that a caller which must also key, hash or
 * measure the raw bytes reads the file exactly once — `readContentWithKey` in
 * `@vibe-agent-toolkit/resources` is that caller, and its key must stay over the
 * raw byte preimage whatever this function decides the characters are. For the
 * ordinary "read a file, give me its text" case use `readTextContent` from
 * `@vibe-agent-toolkit/utils/fs`.
 *
 * @param bytes - The exact bytes read from disk
 * @returns The decoded text, the encoding used, whether that was a fact, and how
 *   many characters the decode had to replace
 *
 * @example
 * ```typescript
 * const bytes = await readFile(path);
 * const { text, encoding, encodingSource, replacementCharacters } = decodeTextContent(bytes);
 * // UTF-16BE file: encoding 'utf-16be', encodingSource 'bom', 0 replacements,
 * // text with no BOM and no NULs
 * ```
 */
export function decodeTextContent(bytes: Uint8Array): DecodedText {
  const bom = bomAt(bytes);
  const encoding = bom?.encoding ?? 'utf-8';
  const body = bom === null ? bytes : bytes.subarray(bom.length);
  const encodingSource: EncodingSource = bom === null ? 'assumed' : 'bom';

  if (encoding === 'utf-32le' || encoding === 'utf-32be') {
    return { ...decodeUtf32(body, encoding === 'utf-32le'), encoding, encodingSource };
  }
  const decoder = DECODERS.get(encoding);
  const fatalDecoder = FATAL_DECODERS.get(encoding);
  if (decoder === undefined || fatalDecoder === undefined) {
    // Unreachable: BOMS, DECODERS and FATAL_DECODERS cover the same five
    // encodings between them. Thrown rather than defaulted, because a silent fall
    // back to UTF-8 here would reproduce the exact defect this module was written
    // to remove.
    throw new Error(`no decoder for encoding "${encoding}"`);
  }

  try {
    // The clean path, and the only one nearly every file takes: one decode, no
    // scan. A throw here is the ONLY evidence that a substitution happened —
    // see FATAL_DECODERS.
    return { text: fatalDecoder.decode(body), encoding, encodingSource, replacementCharacters: 0 };
  } catch {
    const text = decoder.decode(body);
    return { text, encoding, encodingSource, replacementCharacters: countReplacementCharacters(text) };
  }
}
