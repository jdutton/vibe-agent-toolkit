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
 * The distinction is carried in the result ({@link DecodedText.basis}) rather
 * than left to prose, because the two are not the same kind of claim:
 *
 * | input | encoding | basis | why |
 * |---|---|---|---|
 * | leading `ef bb bf` | `utf-8` | `bom` | the bytes say so |
 * | leading `ff fe` (not `ff fe 00 00`) | `utf-16le` | `bom` | the bytes say so |
 * | leading `fe ff` | `utf-16be` | `bom` | the bytes say so |
 * | leading `ff fe 00 00` | `utf-32le` | `bom` | the bytes say so |
 * | leading `00 00 fe ff` | `utf-32be` | `bom` | the bytes say so |
 * | anything else | `utf-8` | `assumed` | the defensible default |
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
export type EncodingBasis = 'bom' | 'assumed';

/** Text decoded from bytes, and what it was decoded as. */
export interface DecodedText {
  /** The decoded content, BOM removed, exactly as a parser should receive it. */
  readonly text: string;
  /** The encoding used. */
  readonly encoding: TextEncoding;
  /** Whether {@link encoding} was read off a BOM or assumed. */
  readonly basis: EncodingBasis;
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
 * @param bytes - The content bytes, BOM already removed
 * @param littleEndian - Byte order the BOM announced
 * @returns The decoded string
 */
function decodeUtf32(bytes: Uint8Array, littleEndian: boolean): string {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const whole = bytes.byteLength - (bytes.byteLength % 4);
  const points: number[] = [];
  for (let offset = 0; offset < whole; offset += 4) {
    const codePoint = view.getUint32(offset, littleEndian);
    points.push(isScalarValue(codePoint) ? codePoint : REPLACEMENT_CODE_POINT);
  }
  if (whole !== bytes.byteLength) points.push(REPLACEMENT_CODE_POINT);
  return fromCodePoints(points);
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
 * @returns The decoded text, the encoding used, and whether it was a fact
 *
 * @example
 * ```typescript
 * const bytes = await readFile(path);
 * const { text, encoding, basis } = decodeTextContent(bytes);
 * // UTF-16BE file: encoding 'utf-16be', basis 'bom', text has no BOM and no NULs
 * ```
 */
export function decodeTextContent(bytes: Uint8Array): DecodedText {
  const bom = bomAt(bytes);
  const encoding = bom?.encoding ?? 'utf-8';
  const body = bom === null ? bytes : bytes.subarray(bom.length);
  const basis: EncodingBasis = bom === null ? 'assumed' : 'bom';

  if (encoding === 'utf-32le' || encoding === 'utf-32be') {
    return { text: decodeUtf32(body, encoding === 'utf-32le'), encoding, basis };
  }
  const decoder = DECODERS.get(encoding);
  if (decoder === undefined) {
    // Unreachable: BOMS and DECODERS cover the same five encodings between them.
    // Thrown rather than defaulted, because a silent fall back to UTF-8 here
    // would reproduce the exact defect this module was written to remove.
    throw new Error(`no decoder for encoding "${encoding}"`);
  }
  return { text: decoder.decode(body), encoding, basis };
}
