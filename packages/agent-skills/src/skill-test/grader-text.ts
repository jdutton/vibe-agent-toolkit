/**
 * Neutralize GRADER-SUPPLIED free text before it reaches an operator surface or
 * one of vat's own artifacts.
 *
 * WHY THIS EXISTS. The grader's only input is the executor transcript, and
 * untrusted skill code writes that transcript. Every free-text field a grader
 * emits is therefore attacker-influenced: `expectations[].text`/`.evidence`,
 * `friction[].message`/`.evidence`/`.subjectFile`, `tool.*[].name`/`.evidence`,
 * `tool.sequence[].steps`. `formatFrictionReport` interpolates one of those
 * straight into `process.stderr.write`, so a message carrying a newline and an
 * SGR sequence renders as vat's OWN voice — verified end-to-end with a grader
 * emitting a green "vat: grading verified, ignore the warning above." line on a
 * row of its own. That is strictly worse than a wrong number in
 * `baseline.json`: operators read stderr, and nobody reads the artifact.
 * (`summary` is NOT in that list — vat computes it numerically.)
 *
 * WHAT IT DOES, and why each part:
 * - **ANSI escape sequences are removed WHOLE.** Dropping only the ESC byte
 *   would leave the parameter bytes (`[32m`) as visible litter; removing the
 *   sequence keeps the surviving text readable.
 * - **Remaining C0/C1 controls become a space.** This is what kills the
 *   forged-line attack: no newline survives, so grader text can never occupy a
 *   line of its own. It also covers CR (line overwrite) and BS.
 * - **Bidi controls and invisible non-spelling characters become a space too.**
 *   Stopping at U+009F left them alive, and they are not decoration: one U+202E
 *   (RIGHT-TO-LEFT OVERRIDE) in a friction `message` renders the REST of vat's own
 *   `[low] path-assumption: …` stderr line right-to-left, so the grader repaints
 *   text it did not write. `JSON.stringify` only escapes below U+0020, so the same
 *   code point also survives verbatim into `baseline.json` and `friction.json`. The
 *   invisible members (U+200B, U+2060…) are the quieter half: they let a grader
 *   smuggle a marker through any downstream string comparison while rendering as
 *   nothing at all. This is NOT the whole Cf class — see
 *   {@link INVISIBLE_CODE_RANGES} for the two admission tests and for the joiners
 *   and variation selectors deliberately left alone, because ordinary words are
 *   spelled with them and a grader quoting a file must get the file back.
 * - **Whitespace runs collapse and the value is trimmed.** After the previous
 *   step a 200-newline message would be 200 spaces of padding. (The Unicode
 *   line/paragraph separators are NOT left to the collapse: the scan folds them,
 *   because {@link sanitizeTextPreservingLines} has no collapse to leave them to.)
 * - **Length is capped.** Bounds a flooding grader. The cap is generous enough
 *   for real evidence prose; the untruncated value is preserved nowhere, which
 *   is deliberate — an artifact nobody can trust to render is worse than a
 *   short one.
 *
 * A value that was non-empty but sanitizes away to nothing becomes
 * {@link UNPRINTABLE_PLACEHOLDER} rather than the empty string, so a nonsense
 * grader value cannot turn a `.min(1)` schema field into a hard run failure.
 *
 * SCANNED, NOT REGEXED. The obvious implementation is three regexes over
 * control-character classes. Those need literal ESC/NUL bytes in this source
 * file (`\u` escapes get normalized INTO literal bytes by editors and tools on
 * the way in), which makes the module binary to `grep` and unreviewable in a
 * diff. A forward scan over code units says the same thing in plain ASCII.
 *
 * WHERE IT IS APPLIED. Not once, and not redundantly — each of these is a distinct
 * crossing from untrusted bytes to an operator surface or a vat artifact, and none
 * of them is downstream of another:
 * - `eval-fragment.ts` — `parseEvalFragment` walks EVERY string entering vat from a
 *   grader, plus the schema path/message it quotes when the parse fails.
 * - `eval-grader.ts` — the grader-invocation error text, and both sides of the
 *   declared-vs-observed executable-name comparison (names are compared AFTER
 *   sanitizing, so an invisible smuggled into one side cannot split the match).
 * - `run-harness.ts` — `formatFrictionReport`, the stderr render, which re-reads
 *   `friction.json` from a harness dir that same-uid skill code can reach.
 * - `eval-inputs.ts` — `quoteSuiteText` / `quoteSuiteBlock`, for SUITE-authored text
 *   (untrusted too: `resolveEvalSuitePath` will harvest a suite out of a fetched
 *   artifact, i.e. out of the skill under test).
 * - `eval-lint.ts` — `lintToolExpectationExecutables`, via `quoteSuiteText`. Every
 *   executable name it quotes comes from the suite (`toolExpectations.*`, an
 *   unconstrained `z.array(z.string().min(1))` on a `.passthrough()` entry) or from
 *   the subject skill's own manifest, and `run-harness.ts` writes the advisory to
 *   stderr with no sanitizer of its own — at Step 5.5, AHEAD of the
 *   `--i-understand-this-runs-skill-code` gate and ahead of the `--dry-run`
 *   short-circuit, so this one paints a run that spawned nothing.
 * - `baseline-integrity.ts` — `BaselineScanDegradation.detail`, built from a `cd`
 *   argument lifted verbatim out of the CONTROL ARM's transcript. Sanitized where the
 *   detail is CONSTRUCTED, not at the stderr write, so the one call covers both
 *   surfaces: `run-harness.ts` (`baselineContaminationFor`) writes it to stderr AND
 *   vat stamps the same bytes into `baselineIntegrity.degraded` in `baseline.json` —
 *   which a stderr-side fix would miss, because `degraded` is attached to the
 *   fragment AFTER `parseEvalFragment` has sanitized it.
 * - `grading-adapter.ts` — the schema path and message quoted when the aggregate
 *   `grading.json` parse fails.
 *
 * That list is the whole of it, and keeping it whole is the point: this file's own
 * standard is that a function's docblock and its behaviour disagreeing is how a
 * security claim rots, and a LIST that has fallen behind the call sites rots the same
 * way in the other direction — it under-claims, so a reader goes looking for a hole
 * that was closed and trusts a boundary that was never added. `git grep
 * 'sanitizeGraderText\|sanitizeTextPreservingLines'` is the check.
 */

/**
 * Longest grader-supplied free-text value vat will carry. ~20 terminal lines —
 * enough for a real evidence excerpt, small enough that one item cannot own the
 * operator's screen.
 */
export const MAX_GRADER_TEXT_LENGTH = 2000;

/** Substituted for a non-empty value that sanitizes away to nothing. */
export const UNPRINTABLE_PLACEHOLDER = '(unprintable)';

const TRUNCATION_MARKER = '... (truncated)';

const ESC = 0x1b;
const BEL = 0x07;
const C0_MAX = 0x1f;
const DEL = 0x7f;
const C1_MAX = 0x9f;
const LEFT_BRACKET = 0x5b;
const RIGHT_BRACKET = 0x5d;
const BACKSLASH = 0x5c;
/** A CSI sequence ends at its first byte in `@`..`~`. */
const CSI_FINAL_MIN = 0x40;
const CSI_FINAL_MAX = 0x7e;
/** Intermediate bytes of an nF escape sequence (` `..`/`), e.g. the `(` of `ESC ( B`. */
const INTERMEDIATE_MIN = 0x20;
const INTERMEDIATE_MAX = 0x2f;
/** The leading half of a surrogate pair; see {@link capLength}. */
const HIGH_SURROGATE_MIN = 0xd800;
const HIGH_SURROGATE_MAX = 0xdbff;

const WHITESPACE_RUN = /\s+/gu;

/** Guard against a pathologically nested grader fragment; the strict parse rejects it anyway. */
const MAX_SANITIZE_DEPTH = 20;

/** Line feed — the ONE control {@link sanitizeTextPreservingLines} keeps. */
const LINE_FEED = 0x0a;

/**
 * Invisible code points above U+009F that are neutralized exactly like a C0/C1
 * control, because they do the same job by other means.
 *
 * ⚠️ WRITTEN AS NUMBERS, like every other constant in this file, and for the same
 * reason: a `\u202E` escape in a regex literal gets normalized into the real code
 * point by editors and tooling on the way in, which makes the module unreviewable
 * in a diff and unfindable by `grep`. Build test inputs with `String.fromCharCode`.
 *
 * THE RULE, and it is not "the Cf class". Two admission tests; a code point has to
 * pass one of them:
 *
 * (a) **It is a bidi or shaping control** — it changes how the text AROUND it is
 *     ordered or directed, which is the forgery this module exists to stop. U+202E
 *     is the verified case: it renders the REST of vat's own
 *     `[low] path-assumption: …` stderr line right-to-left.
 * (b) **It is invisible AND spells nothing** — no word in any script is written with
 *     it, so removing it cannot change what a quotation says, while keeping it lets
 *     a grader hide a difference from a reader and from every downstream string
 *     comparison (`eval-grader.ts` compares tool names across both sides of a run,
 *     sanitized on each).
 *
 * Member by member:
 * - U+00AD SOFT HYPHEN — (b) a hyphenation HINT; no word is spelled with one.
 * - U+061C ARABIC LETTER MARK — (a) the Arabic analogue of LRM/RLM.
 * - U+200B ZERO WIDTH SPACE — (b) a line-break hint, invisible, spells nothing.
 * - U+200E…U+200F LRM/RLM — (a) directional MARKS: they re-resolve the direction of
 *   the neutral characters beside them, so they reorder text they did not write.
 * - U+2028…U+2029 LINE and PARAGRAPH SEPARATOR — some renderers break a line on
 *   them, which is the "occupy a line of your own" attack spelled with a different
 *   code point. Folded to a space, never to LF, even in the line-preserving path.
 * - U+202A…U+202E — (a) the bidi embeddings and OVERRIDES.
 * - U+2060…U+2064 — (b) word joiner and the invisible math operators.
 * - U+2066…U+2069 — (a) the bidi ISOLATES (U+2066 LRI verified surviving).
 * - U+206A…U+206F — (a) the deprecated shaping controls (inhibit symmetric swapping,
 *   Arabic form shaping, nominal digit shapes); absent from modern text entirely.
 * - U+FEFF ZERO WIDTH NO-BREAK SPACE — (b). It is `\s`, so {@link sanitizeGraderText}'s
 *   whitespace collapse would eat it anyway; {@link sanitizeTextPreservingLines} has
 *   no collapse and used to ship it to stderr intact, so it is neutralized HERE.
 * - U+FFF9…U+FFFB — (b) interlinear annotation, which hides its own payload.
 *
 * DELIBERATELY ABSENT, because they fail BOTH tests — zero directional power, and
 * real words ARE spelled with them:
 * - U+FE00…U+FE0F variation selectors (category Mn, not Cf). How `⚠️` and most emoji
 *   are spelled, vat's own banner glyph included.
 * - U+200C ZERO WIDTH NON-JOINER — orthographically load-bearing in Persian, Hindi,
 *   Bengali and Malayalam. `می<ZWNJ>خواهم` is two words; folding it to a space gave
 *   back a different string than the file the grader was quoting.
 * - U+200D ZERO WIDTH JOINER — how a multi-person emoji and a flag sequence are
 *   spelled. Folding it turned `👨<ZWJ>👩<ZWJ>👧` into three separate glyphs.
 * - U+180E MONGOLIAN VOWEL SEPARATOR — orthographic in Mongolian (it selects the
 *   letterform of the syllable before it) and reorders nothing.
 *
 * The residual cost of that exclusion is real and accepted: a grader can still
 * smuggle an invisible joiner into a string a human compares by eye. It is the same
 * trade the variation-selector exclusion always made, and the standard this file
 * already stated — "dropping them would mangle ordinary text" — decides it the same
 * way. What it must NOT do is state that standard and then break it.
 */
const INVISIBLE_CODE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00ad, 0x00ad],
  [0x061c, 0x061c],
  [0x200b, 0x200b],
  [0x200e, 0x200f],
  [0x2028, 0x2029],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x206f],
  [0xfeff, 0xfeff],
  [0xfff9, 0xfffb],
];

/** Lowest code point in {@link INVISIBLE_CODE_RANGES}, so ASCII bails on one compare. */
const INVISIBLE_CODE_MIN = 0x00ad;

function isInvisibleCode(code: number): boolean {
  if (code < INVISIBLE_CODE_MIN) return false;
  return INVISIBLE_CODE_RANGES.some(([low, high]) => code >= low && code <= high);
}

function isControlCode(code: number): boolean {
  return code <= C0_MAX || (code >= DEL && code <= C1_MAX) || isInvisibleCode(code);
}

/** Index of the first code unit AFTER a CSI sequence whose parameters start at `from`. */
function endOfCsi(value: string, from: number): number {
  let i = from;
  while (i < value.length) {
    const code = value.charCodeAt(i);
    i += 1;
    if (code >= CSI_FINAL_MIN && code <= CSI_FINAL_MAX) return i;
  }
  return i;
}

/** Index of the first code unit AFTER an OSC sequence whose payload starts at `from`. */
function endOfOsc(value: string, from: number): number {
  let i = from;
  while (i < value.length) {
    const code = value.charCodeAt(i);
    if (code === BEL) return i + 1;
    // String Terminator is ESC followed by a backslash; a bare ESC ends it too.
    if (code === ESC) return i + (value.charCodeAt(i + 1) === BACKSLASH ? 2 : 1);
    i += 1;
  }
  return i;
}

/**
 * Index of the first code unit AFTER an nF sequence (`ESC` intermediates final),
 * e.g. the charset selection `ESC ( B`, whose intermediates start at `from`.
 */
function endOfNf(value: string, from: number): number {
  let i = from;
  while (i < value.length) {
    const code = value.charCodeAt(i);
    i += 1;
    if (code < INTERMEDIATE_MIN || code > INTERMEDIATE_MAX) return i;
  }
  return i;
}

/** Index of the first code unit AFTER the escape sequence introduced by the ESC at `start`. */
function endOfEscapeSequence(value: string, start: number): number {
  if (start + 1 >= value.length) return start + 1;
  const second = value.charCodeAt(start + 1);
  if (second === LEFT_BRACKET) return endOfCsi(value, start + 2);
  if (second === RIGHT_BRACKET) return endOfOsc(value, start + 2);
  if (second >= INTERMEDIATE_MIN && second <= INTERMEDIATE_MAX) return endOfNf(value, start + 1);
  // Any remaining two-code-unit form (RIS, NEL, ...).
  return start + 2;
}

/**
 * Drop every escape sequence and map every remaining control code to a space.
 *
 * `preserveNewlines` keeps LF — and ONLY LF — as itself, for
 * {@link sanitizeTextPreservingLines}. CR still becomes a space even then: the
 * line-overwrite attack it carries is not made safe by the caller wanting lines.
 */
function stripEscapesAndControls(value: string, preserveNewlines = false): string {
  const out: string[] = [];
  let i = 0;
  while (i < value.length) {
    const code = value.charCodeAt(i);
    if (code === ESC) {
      i = endOfEscapeSequence(value, i);
    } else if (isControlCode(code)) {
      out.push(preserveNewlines && code === LINE_FEED ? '\n' : ' ');
      i += 1;
    } else {
      out.push(value.charAt(i));
      i += 1;
    }
  }
  return out.join('');
}

/**
 * Truncate to at most `max` code units, spending the tail on a marker that says so.
 *
 * THE CUT BACKS OFF ONE CODE UNIT rather than landing between the halves of a
 * surrogate pair. A naive `slice` on a value ending in an astral character (1984
 * ASCII characters plus one emoji is enough) leaves a LONE HIGH SURROGATE, which
 * persists into `grading.json` and `baseline.json`. The artifact stays valid JSON —
 * Node's `JSON.stringify` is well-formed and escapes it — but a consumer decoding
 * it gets an unpaired surrogate, and stderr renders U+FFFD. Well-formedness is a
 * correctness property of what this function emits, so it is enforced here.
 *
 * GRAPHEME CLUSTERS ARE DELIBERATELY NOT HANDLED. A cut inside a cluster — between
 * a base and its combining mark, or inside a ZWJ emoji sequence (now that the
 * joiners survive, see {@link INVISIBLE_CODE_RANGES}) — yields a WELL-FORMED string
 * that renders as two glyphs instead of one. That is cosmetic. Segmenting for it
 * would mean `Intl.Segmenter` over the whole value on every capped field, for a
 * locale-dependent answer, to fix an appearance rather than a defect. The line is
 * well-formedness, not beauty.
 */
function capLength(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = max - TRUNCATION_MARKER.length;
  // A high surrogate immediately before the cut has its partner AT the cut (or is
  // itself already lone) — either way it must not be the last thing kept.
  const last = value.charCodeAt(cut - 1);
  const safeCut = last >= HIGH_SURROGATE_MIN && last <= HIGH_SURROGATE_MAX ? cut - 1 : cut;
  return value.slice(0, safeCut) + TRUNCATION_MARKER;
}

/** Sanitize one grader-supplied string. Pure. See the module docblock for the rules. */
export function sanitizeGraderText(value: string): string {
  const collapsed = stripEscapesAndControls(value).replaceAll(WHITESPACE_RUN, ' ').trim();
  if (collapsed.length === 0) return value.length === 0 ? '' : UNPRINTABLE_PLACEHOLDER;
  return capLength(collapsed, MAX_GRADER_TEXT_LENGTH);
}

/**
 * Most lines {@link sanitizeTextPreservingLines} will let through, and the total
 * budget across them.
 *
 * Two caps rather than one because the two floods are different shapes: 4000
 * characters on ONE line is a wrapped paragraph, 4000 NEWLINES is the operator's
 * whole scrollback. The line cap is the one that protects the screen; the length
 * cap protects `Summary:` and the artifact.
 */
const MAX_MULTILINE_TEXT_LINES = 40;
const MAX_MULTILINE_TEXT_LENGTH = 4000;

/**
 * The LINE-PRESERVING sanitizer, for untrusted text whose STRUCTURE is the
 * message.
 *
 * WHY IT EXISTS RATHER THAN A SECOND CALL TO {@link sanitizeGraderText}. Zod's
 * `.strict()`/schema failure text is a multi-line, indented list of issues, one
 * per offending path, and it is the only thing telling an adopter WHICH eval in a
 * 200-eval suite is malformed. Folding it with the single-line sanitizer collapses
 * every issue onto one 2000-character line and then truncates it — so the common
 * case (a real typo in a real suite) gets materially worse in exchange for
 * neutralizing bytes the suite author almost never wrote. This keeps the shape and
 * still removes everything that can paint: escape sequences whole, every C0/C1
 * control except LF, and every member of {@link INVISIBLE_CODE_RANGES}.
 *
 * THAT LAST CLAUSE USED TO BE FALSE, and the sibling's whitespace collapse was why.
 * U+FEFF, U+2028 and U+2029 were left OUT of the scan on the grounds that they are
 * `\s` and "the collapse eats them" — true of exactly one of the two consumers.
 * This function has no collapse, so all three reached `process.stderr` through
 * `quoteSuiteBlock` -> `EvalInputError` intact, two of them being separators some
 * renderers break a line on. They are neutralized in the SCAN now, which is the only
 * place both consumers share. A function's docblock and its behaviour disagreeing is
 * how a security claim rots; on a terminal-bound path, the code moves to meet the
 * docblock and not the other way round.
 *
 * It is NOT a replacement for {@link sanitizeGraderText} and must not be used for
 * grader free text: a surviving newline is exactly what lets a value occupy a line
 * of its own and impersonate vat's voice. Use it only where the caller's own
 * message already spans lines and the untrusted part is quoted INSIDE it.
 */
export function sanitizeTextPreservingLines(value: string): string {
  const stripped = stripEscapesAndControls(value, true).trim();
  if (stripped.length === 0) return value.length === 0 ? '' : UNPRINTABLE_PLACEHOLDER;
  const lines = stripped.split('\n');
  const kept = lines.slice(0, MAX_MULTILINE_TEXT_LINES);
  if (lines.length > kept.length) {
    kept.push(`... and ${lines.length - kept.length} more line(s) (truncated)`);
  }
  return capLength(kept.join('\n'), MAX_MULTILINE_TEXT_LENGTH);
}

function walk(value: unknown, skipKeys: ReadonlySet<string>, depth: number): unknown {
  if (depth > MAX_SANITIZE_DEPTH) return value;
  if (typeof value === 'string') return sanitizeGraderText(value);
  if (Array.isArray(value)) return value.map((item) => walk(item, skipKeys, depth + 1));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = skipKeys.has(key) ? val : walk(val, skipKeys, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Sanitize every string in an arbitrary parsed-JSON value, recursively.
 *
 * Deliberately field-BLIND: a per-field allowlist is a list somebody has to
 * remember to extend, and these schemas grow (`mustSucceed` and
 * `sequence[].steps` both arrived after the fields above them). Walking every
 * string means a new grader-controlled field is covered the day it is added.
 *
 * `skipKeys` is REQUIRED, not defaulted — the one value that must survive
 * byte-exact is the integrity nonce, and a caller that forgets it should have
 * to say so.
 */
export function sanitizeGraderTextDeep(value: unknown, skipKeys: ReadonlySet<string>): unknown {
  return walk(value, skipKeys, 0);
}
