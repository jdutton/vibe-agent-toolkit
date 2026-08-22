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

function isControlCode(code: number): boolean {
  return code <= C0_MAX || (code >= DEL && code <= C1_MAX);
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

/** Drop every escape sequence and map every remaining control code to a space. */
function stripEscapesAndControls(value: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < value.length) {
    const code = value.charCodeAt(i);
    if (code === ESC) {
      i = endOfEscapeSequence(value, i);
    } else if (isControlCode(code)) {
      out.push(' ');
      i += 1;
    } else {
      out.push(value.charAt(i));
      i += 1;
    }
  }
  return out.join('');
}

/** Sanitize one grader-supplied string. Pure. See the module docblock for the rules. */
export function sanitizeGraderText(value: string): string {
  const collapsed = stripEscapesAndControls(value).replaceAll(WHITESPACE_RUN, ' ').trim();
  if (collapsed.length === 0) return value.length === 0 ? '' : UNPRINTABLE_PLACEHOLDER;
  if (collapsed.length <= MAX_GRADER_TEXT_LENGTH) return collapsed;
  return collapsed.slice(0, MAX_GRADER_TEXT_LENGTH - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
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
