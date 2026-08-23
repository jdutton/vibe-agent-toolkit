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
 * - **Bidi and zero-width FORMAT characters become a space too.** Stopping at
 *   U+009F left the whole Unicode Cf class alive, and it is not decoration: one
 *   U+202E (RIGHT-TO-LEFT OVERRIDE) in a friction `message` renders the REST of
 *   vat's own `[low] path-assumption: …` stderr line right-to-left, so the
 *   grader repaints text it did not write. `JSON.stringify` only escapes below
 *   U+0020, so the same code point also survives verbatim into `baseline.json`
 *   and `friction.json`. The zero-width members (U+200B/C/D, U+2060…) are the
 *   quieter half: they let a grader smuggle a marker through any downstream
 *   string comparison while rendering as nothing at all.
 * - **Whitespace runs collapse and the value is trimmed.** After the previous
 *   step a 200-newline message would be 200 spaces of padding, and the collapse
 *   also folds the Unicode line/paragraph separators that some renderers break
 *   lines on.
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
 * Applied at TWO boundaries on purpose, not once redundantly: `parseEvalFragment`
 * (everything entering vat from a grader) and `formatFrictionReport` (the stderr
 * render, which re-reads `friction.json` from a harness dir that same-uid skill
 * code can reach).
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

const WHITESPACE_RUN = /\s+/gu;

/** Guard against a pathologically nested grader fragment; the strict parse rejects it anyway. */
const MAX_SANITIZE_DEPTH = 20;

/** Line feed — the ONE control {@link sanitizeTextPreservingLines} keeps. */
const LINE_FEED = 0x0a;

/**
 * Format (Unicode general category **Cf**) code points that reorder, join or hide
 * the text AROUND them. Neutralized exactly like a C0/C1 control, because they do
 * the same job by other means.
 *
 * ⚠️ WRITTEN AS NUMBERS, like every other constant in this file, and for the same
 * reason: a `\u202E` escape in a regex literal gets normalized into the real code
 * point by editors and tooling on the way in, which makes the module unreviewable
 * in a diff and unfindable by `grep`. Build test inputs with `String.fromCharCode`.
 *
 * The set is bounded to the members that change RENDERING, not the whole Cf class:
 * - U+00AD SOFT HYPHEN — invisible, splits a word wherever a renderer likes.
 * - U+061C ARABIC LETTER MARK — a bidi control.
 * - U+180E MONGOLIAN VOWEL SEPARATOR — invisible, historically whitespace.
 * - U+200B…U+200F — zero-width space/non-joiner/joiner, plus LRM and RLM.
 * - U+202A…U+202E — the bidi embeddings and OVERRIDES. U+202E is the one verified
 *   to repaint vat's own stderr line.
 * - U+2060…U+2064 — word joiner and the invisible math operators.
 * - U+2066…U+206F — the bidi ISOLATES (U+2066 LRI verified surviving) and the
 *   deprecated format controls above them.
 * - U+FFF9…U+FFFB — interlinear annotation, which hides its own payload.
 *
 * DELIBERATELY ABSENT: U+FE00…U+FE0F (variation selectors, category Mn, not Cf).
 * They are how `⚠️` and most emoji are spelled — dropping them would mangle
 * ordinary text, including vat's own banner characters if this were ever pointed
 * at one. U+FEFF is absent too: it is `\s`, so the whitespace collapse below
 * already eats it (verified by the existing whitespace rule).
 */
const FORMAT_CODE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00ad, 0x00ad],
  [0x061c, 0x061c],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x206f],
  [0xfff9, 0xfffb],
];

/** Lowest code point in {@link FORMAT_CODE_RANGES}, so ASCII bails on one compare. */
const FORMAT_CODE_MIN = 0x00ad;

function isFormatCode(code: number): boolean {
  if (code < FORMAT_CODE_MIN) return false;
  return FORMAT_CODE_RANGES.some(([low, high]) => code >= low && code <= high);
}

function isControlCode(code: number): boolean {
  return code <= C0_MAX || (code >= DEL && code <= C1_MAX) || isFormatCode(code);
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

/** Truncate to `max` code units, spending the tail on a marker that says so. */
function capLength(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
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
 * control except LF, and the bidi/zero-width format characters.
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
