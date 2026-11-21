/**
 * Normalization of captured whole-command output: the ONE normalizer, shared by
 * the lab's `verdict` facet and the CLI's system tests (two packages compare
 * whole-command output, so a second copy would be a second contract). A pure
 * function over text: no I/O, no environment reads, no `vitest` import.
 *
 * A document comparison is only worth reading if two runs over an *unchanged*
 * tree diff to zero lines; a reader who learns to ignore noisy lines will
 * ignore the real one. The rewrites are the instabilities **measured** across
 * 3 runs x 6 commands over two corpora: a duration, the absolute paths in a
 * `root:` header, and the config-less fallback warning on stderr. Further
 * wall-clock fields are each wall time BY CONSTRUCTION: `durationMs`
 * (`Report.durationMs`, e.g. okf/validate.ts:256) and `populationSecs`
 * (resources query.ts:105 / check.ts:471; check's `null` is left alone).
 * `lensSecs` (query.ts:109, check.ts:477) joined on a crucible control run of
 * rc.11 that differed only in it, incl. scientific notation (7.08e-7 vs
 * 5.41e-7), which `[\d.eE+-]` covers.
 *
 * ⛔ **Do not add a rewrite without a measurement behind it.** Every extra
 * substitution makes a real difference invisible.
 *
 * Duration rewrites replace the *value* (`0`, `0ms`), not a placeholder token,
 * so normalized text stays valid YAML/JSON for `jq`/`yq`.
 *
 * Performance is a correctness concern: this runs over `vat audit` output of
 * ~1.8 MB, so no two adjacent quantifiers in a pattern may match the same
 * character (linear, not super-linear backtracking). `sonarjs/slow-regex`
 * guards it; do not silence it.
 */

import { toForwardSlashAnyPlatform } from '../path-core.js';

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
 * Wall time is the only kind of field three runs of every verb were observed
 * to disagree on (see this module's docstring).
 *
 * Every pattern is a **regex literal**, never a `new RegExp` composed from a
 * shared sub-pattern: a constructed string is flagged by
 * `security/detect-non-literal-regexp` and hides the pattern from the static
 * backtracking analysis that guards a 1.8 MB capture. The value shape is
 * therefore spelled out twice, on purpose.
 *
 * Each pattern is anchored with `^`/`$` under the `m` flag and uses `[ \t]`,
 * not `\s`, which would match a newline and swallow the next line. No `[ \t]*`
 * sits beside another space-matching quantifier, which is why the JSON rule
 * captures a bare `,?` and lets the single trailing `[ \t]*$` absorb the rest.
 *
 * The value is `-?\d[\d.eE+-]*`, not a precise number grammar: that needs a
 * quantified group inside a quantifier (star height 2, rejected by
 * `security/detect-unsafe-regex`). The looseness costs nothing, because
 * `^[ \t]*durationSecs:` has already identified the duration line.
 */
const DURATION_RULES: readonly DurationRule[] = Object.freeze([
  // YAML: `durationSecs: 12.481`, `durationMs: 1873`, `populationSecs: 0.412`,
  // `lensSecs: 7.08e-7`. The alternation is of fixed literals, so it adds no
  // ambiguity: at most one of them can match at any position.
  {
    pattern: /^(?<prefix>[ \t]*(?:durationSecs|durationMs|populationSecs|lensSecs):[ \t]*)-?\d[\d.eE+-]*[ \t]*$/gm,
    replacement: '$<prefix>0',
  },
  // YAML: `duration: 412ms`
  {
    pattern: /^(?<prefix>[ \t]*duration:[ \t]*)\d+ms[ \t]*$/gm,
    replacement: '$<prefix>0ms',
  },
  // JSON: `"durationSecs": 3.902,`, `"durationMs": 1873,`, `"populationSecs": 0.412,`,
  // `"lensSecs": 5e-7,`.
  {
    pattern: /^(?<prefix>[ \t]*"(?:durationSecs|durationMs|populationSecs|lensSecs)":[ \t]*)-?\d[\d.eE+-]*(?<comma>,?)[ \t]*$/gm,
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
  const normalizedCandidate = toForwardSlashAnyPlatform(candidate);
  const normalizedContainer = toForwardSlashAnyPlatform(container);
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
 * `toForwardSlashAnyPlatform` does not — so both spellings are substituted regardless of
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
  const forward = toForwardSlashAnyPlatform(trimmed);
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
 * dropped rather than winning on length. The corpus is the *subject* of the
 * snapshot, so every path inside it must render corpus-relative; `homeDir` is
 * an outer container with no claim on what it encloses. Otherwise snapshotting
 * VAT's own repository would split one corpus across `<CORPUS>` and
 * `<VATROOT>/…`, differently for a dev checkout than for an installed `vat`.
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
