/**
 * Normalization of captured whole-command output.
 *
 * ## Why this exists
 *
 * A snapshot comparison is only worth reading if two runs over an *unchanged*
 * tree diff to zero lines. Anything that varies between such runs is noise that
 * appears in every comparison forever, and a reader who has learned to ignore
 * lines is a reader who will ignore the real one.
 *
 * ## Why it does so little
 *
 * The rewrites below are the complete list of instabilities **measured** across
 * 3 runs x 6 commands over two corpora: a duration, and the absolute paths in a
 * `root:` header plus the config-less fallback warning on stderr. Every
 * per-file path inside the reports is already corpus-relative, so nothing else
 * needed touching.
 *
 * ⛔ **Do not add a rewrite without a measurement behind it.** Every extra
 * substitution is a real difference that has been made invisible: the diff goes
 * quiet and nobody can audit what it swallowed. A normalizer that erases too
 * much fails in exactly the direction that cannot be noticed.
 *
 * The duration rewrites replace the *value* (`0`, `0ms`) rather than a
 * placeholder token, so normalized text stays valid YAML/JSON and can still be
 * piped through `jq`/`yq`.
 *
 * ## Performance is a correctness concern here
 *
 * This runs over `vat audit` output, which reaches ~1.8 MB. Every pattern below
 * is written so that no two adjacent quantifiers can match the same character —
 * that is what keeps matching linear instead of backtracking super-linearly on
 * a long near-miss line. `sonarjs/slow-regex` guards the property; do not
 * silence it.
 */

import { toForwardSlash } from '@vibe-agent-toolkit/utils';

/** The roots a captured stream may name absolutely. */
export interface NormalizeContext {
  /** Absolute path of the directory the commands were pointed at. */
  corpusRoot: string;
  /** Absolute path of the VAT repository or install the commands came from. */
  vatRoot: string;
  /**
   * The user's home directory. Passed in rather than read from the environment
   * so that {@link normalizeCommandOutput} stays a pure function.
   */
  homeDir: string;
}

/** One literal string rewrite. `from` is matched literally, never as a pattern. */
export interface PathSubstitution {
  /** The exact text to find. May contain regex metacharacters; it is not a regex. */
  from: string;
  /** The placeholder written in its place. */
  to: string;
}

/** A duration rewrite: a whole-line pattern, and what its value becomes. */
interface DurationRule {
  /** Anchored to a whole line (`m` flag) so a value inside a longer line is left alone. */
  pattern: RegExp;
  /** Uses named groups only — `$1` followed by a digit is ambiguous. */
  replacement: string;
}

/**
 * Duration is the only field three runs of every verb were observed to
 * disagree on.
 *
 * Every pattern is a **regex literal**, not a `new RegExp` composed from a
 * shared number sub-pattern. Composing read better, but it meant handing the
 * engine a constructed string — which `security/detect-non-literal-regexp`
 * flags, and which (the part that actually matters) hides the pattern from the
 * static backtracking analysis that is the only thing standing between this
 * module and a hang on a 1.8 MB capture. The value shape is therefore spelled
 * out twice, on purpose.
 *
 * Each pattern is anchored with `^`/`$` under the `m` flag and uses `[ \t]`
 * rather than `\s` for surrounding space, because `\s` matches a newline and
 * would swallow the following line. No `[ \t]*` ever sits beside another
 * space-matching quantifier, so there is no ambiguity to backtrack through —
 * which is why the JSON rule captures a bare `,?` and lets the single trailing
 * `[ \t]*$` absorb the rest.
 *
 * The value is matched as `-?\d[\d.eE+-]*` — one digit then one character
 * class — rather than as a precise number grammar. A precise grammar needs
 * optional groups (`(?:\.\d+)?(?:[eE][-+]?\d+)?`), and a quantified group
 * inside another quantifier is star height 2, which `security/detect-unsafe-regex`
 * rejects outright. The looseness costs nothing: `^[ \t]*durationSecs:` has
 * already established that this is the duration line, so there is no second
 * candidate for what the value could be, and a normalizer's job is to zero it
 * rather than to validate it.
 */
const DURATION_RULES: readonly DurationRule[] = Object.freeze([
  // YAML: `durationSecs: 12.481`
  {
    pattern: /^(?<prefix>[ \t]*durationSecs:[ \t]*)-?\d[\d.eE+-]*[ \t]*$/gm,
    replacement: '$<prefix>0',
  },
  // YAML: `duration: 412ms`
  {
    pattern: /^(?<prefix>[ \t]*duration:[ \t]*)\d+ms[ \t]*$/gm,
    replacement: '$<prefix>0ms',
  },
  // JSON: `"durationSecs": 3.902,`
  {
    pattern: /^(?<prefix>[ \t]*"durationSecs":[ \t]*)-?\d[\d.eE+-]*(?<comma>,?)[ \t]*$/gm,
    replacement: '$<prefix>0$<comma>',
  },
]);

/**
 * Drop any trailing path separators, so a root given as `/a/b/` and one given
 * as `/a/b` produce the same substitution.
 *
 * A loop rather than a `/[/\\]+$/` replace: an unbounded quantifier anchored to
 * `$` is precisely the shape that backtracks super-linearly, and this helper is
 * on the path of every capture.
 *
 * @param root - Path to trim.
 * @returns The path without trailing `/` or `\` characters.
 */
function withoutTrailingSeparators(root: string): string {
  let trimmed = root;
  while (trimmed.endsWith('/') || trimmed.endsWith('\\')) {
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed;
}

/**
 * Is `candidate` the same directory as `container`, or nested inside it?
 *
 * Compares separator-normalized text with an explicit boundary: `/repo-other`
 * is **not** inside `/repo`, which a bare `startsWith` would get wrong. Both
 * sides are expected to have had their trailing separators removed already.
 *
 * @param candidate - The path that might be inside.
 * @param container - The path that might contain it.
 * @returns `true` when equal or nested.
 */
function isWithin(candidate: string, container: string): boolean {
  const normalizedCandidate = toForwardSlash(candidate);
  const normalizedContainer = toForwardSlash(container);
  if (normalizedCandidate === normalizedContainer) {
    return true;
  }
  return normalizedCandidate.startsWith(`${normalizedContainer}/`);
}

/**
 * Every spelling of one root that could appear in captured output.
 *
 * Windows output mixes separators within a single run — a path built by
 * `path.join` arrives backslashed while one that passed through
 * `toForwardSlash` does not — so both spellings are substituted regardless of
 * which platform is doing the normalizing.
 *
 * @param root - Absolute path of the root, as given.
 * @param placeholder - Token to write in its place.
 * @returns One substitution per distinct spelling; none for an unusable root.
 */
function spellingsOf(root: string, placeholder: string): PathSubstitution[] {
  const trimmed = withoutTrailingSeparators(root);
  if (trimmed.length === 0) {
    return [];
  }
  const forward = toForwardSlash(trimmed);
  const backward = forward.replaceAll('/', '\\');
  const spellings = new Set([trimmed, forward, backward]);
  return [...spellings].map((from) => ({ from, to: placeholder }));
}

/**
 * The literal rewrites that erase absolute paths, in the order they must run.
 *
 * Ordered longest `from` first so a nested root wins over its ancestor: with a
 * VAT install inside the home directory the output must say `<VATROOT>`, not
 * `<HOME>/…`, which it only does if the longer string is consumed first. The
 * sort is stable, so equal-length roots keep corpus → vat → home order.
 *
 * **The corpus is the one exception, and the asymmetry is deliberate.** When
 * `vatRoot` is the corpus or sits inside it, the vatRoot substitution is
 * dropped entirely rather than winning on length. The corpus is the *subject*
 * of the snapshot, so every path inside it must render corpus-relative;
 * `homeDir`, by contrast, is an outer container with no claim on anything it
 * happens to enclose. Without this, snapshotting VAT's own repository would
 * split one corpus across two placeholders — `/repo` as `<CORPUS>` but
 * `/repo/packages/cli/…` as `<VATROOT>/…` — and, worse, the split would land
 * differently for a dev checkout than for an installed `vat`, so two captures
 * of the *same* corpus would diff on the very lines the placeholders exist to
 * mask.
 *
 * ⚠️ Substitution is plain text replacement (see {@link applySubstitutions}),
 * so a root that is a strict text prefix of an unrelated path — `/repo` inside
 * `/repository/…` — would be rewritten there too. Longest-first ordering
 * settles it among these three roots; it is not a general guarantee.
 *
 * Exported so a test can assert the ordering rather than infer it from output.
 *
 * @param context - The roots to erase.
 * @returns Substitutions to apply in array order.
 */
export function buildPathSubstitutions(context: NormalizeContext): PathSubstitution[] {
  const corpusRoot = withoutTrailingSeparators(context.corpusRoot);
  const vatRoot = withoutTrailingSeparators(context.vatRoot);
  const vatRootBelongsToCorpus = corpusRoot.length > 0 && isWithin(vatRoot, corpusRoot);

  const candidates = [
    ...spellingsOf(context.corpusRoot, '<CORPUS>'),
    ...(vatRootBelongsToCorpus ? [] : spellingsOf(context.vatRoot, '<VATROOT>')),
    ...spellingsOf(context.homeDir, '<HOME>'),
  ];

  // First writer wins: a spelling claimed by two roots keeps the earlier, more
  // specific placeholder.
  const byText = new Map<string, PathSubstitution>();
  for (const candidate of candidates) {
    if (!byText.has(candidate.from)) {
      byText.set(candidate.from, candidate);
    }
  }

  return [...byText.values()].sort((a, b) => b.from.length - a.from.length);
}

/**
 * Apply the literal rewrites.
 *
 * Uses `String.prototype.replaceAll` with a **string** needle, never a regex
 * built from the path: a directory may legitimately be named `a+b(c)`, and a
 * path compiled as a pattern would either fail to match or match the wrong
 * thing. Placeholders contain no `$`, so no replacement-pattern escaping is
 * needed on the other side.
 *
 * @param text - Text to rewrite.
 * @param substitutions - Rewrites, already ordered.
 * @returns The rewritten text.
 */
function applySubstitutions(text: string, substitutions: readonly PathSubstitution[]): string {
  let result = text;
  for (const { from, to } of substitutions) {
    result = result.replaceAll(from, to);
  }
  return result;
}

/**
 * Zero out the duration values.
 *
 * @param text - Text to rewrite.
 * @returns The text with every whole-line duration value replaced by zero.
 */
function normalizeDurations(text: string): string {
  let result = text;
  for (const { pattern, replacement } of DURATION_RULES) {
    result = result.replaceAll(pattern, replacement);
  }
  return result;
}

/**
 * Convert CRLF and lone CR to LF.
 *
 * @param text - Text to rewrite.
 * @returns The text with LF line endings only.
 */
function toLf(text: string): string {
  return text.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
}

/**
 * Give the text a trailing newline iff it has content.
 *
 * @param text - Text to rewrite.
 * @returns The text, newline-terminated unless it is empty.
 */
function ensureTrailingNewline(text: string): string {
  if (text.length === 0 || text.endsWith('\n')) {
    return text;
  }
  return `${text}\n`;
}

/**
 * Normalize one captured stdout/stderr stream.
 *
 * Pure: reads no filesystem, no environment, no clock. Idempotent —
 * `normalizeCommandOutput(normalizeCommandOutput(x, c), c)` equals
 * `normalizeCommandOutput(x, c)` — which is what lets a normalized artifact be
 * re-normalized by a later reader without drifting.
 *
 * @param text - The raw captured stream.
 * @param context - The roots to erase.
 * @returns Text stable across two runs over an unchanged tree.
 */
export function normalizeCommandOutput(text: string, context: NormalizeContext): string {
  const lf = toLf(text);
  const withoutAbsolutePaths = applySubstitutions(lf, buildPathSubstitutions(context));
  return ensureTrailingNewline(normalizeDurations(withoutAbsolutePaths));
}
