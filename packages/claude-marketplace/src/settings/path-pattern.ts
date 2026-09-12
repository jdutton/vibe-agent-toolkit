/**
 * gitignore-style path matching for the `Read(…)`/`Edit(…)` permission lane, in
 * O(pattern × path) with no `RegExp`.
 *
 * 🚩 This lane used to hand the pattern to node-ignore, which compiles every `*`
 * to a backtracking `[^/]*`. Both inputs are attacker-reachable files this
 * auditor reads from ONE tree — a `settings.json` permission entry and a plugin
 * `SKILL.md` `allowed-tools:` entry — and `ruleConstrainsDeclaration` runs each
 * as a pattern over the other. Measured on the shipped module: a ten-star
 * declaration `Read(a*a*a*a*a*a*a*a*a*a*b)` against a path of `n` `a`s cost
 * 303 ms at n=30, 2,604 ms at n=40 and 29,158 ms at n=50 (~10× per +10
 * characters), and an end-to-end `vat audit --compat --settings` on a
 * 21-character declaration plus a 44-character rule took 11.1 s against a
 * 0.24 s control. The Bash lane had closed the identical class with a
 * two-pointer scan and its docstring claimed the class closed; this lane was
 * the other half.
 *
 * The matcher is the single-backtrack glob scan (one saved `*` position, resume
 * one character later on a mismatch), applied twice: at the character level
 * within a path segment, with `*`, `?`, `[…]` and `\` escapes, and at the
 * segment level with `**` as the segment wildcard. Each level is O(n·m), so the
 * whole is bounded by the product of the two lengths — the same bound the Bash
 * lane's `matchesWildcardPattern` carries — and no input can push it past that.
 * ⛔ An atomic-group regex (`(?=(X))\1`) is NOT an alternative: this repo has
 * measured that it satisfies the linter while remaining quadratic.
 *
 * ## What is replicated, and what is not
 *
 * The semantics are node-ignore's for a SINGLE pattern with its default
 * options, which is what the lane asked of it, and the suite pins them against
 * node-ignore itself as the oracle over the spellings the permission docs use:
 *
 * - A pattern with a `/` at its start or in its middle is anchored at the root;
 *   one with no `/` (or only a trailing one) matches at any depth.
 * - `**` as a whole segment spans zero or more directories at the start and in
 *   the middle, and ONE or more at the end (`a/**` does not match `a`). Inside
 *   a segment it is an ordinary `*`.
 * - A pattern that matches a DIRECTORY matches everything under it, and a
 *   trailing `/` restricts the pattern to directories, so it never matches the
 *   last segment of a file path. After a trailing `**` the `/` adds nothing
 *   (`a/**` with a slash after it is `a/**`) — unless the `**` is the whole
 *   pattern, when it names no directory for the `/` to restrict and must
 *   itself span one: `**` with a slash after it, anchored or not, is a
 *   directory and something beneath it, the same as `*` followed by `/**`.
 * - `#` and `!` at the start make the pattern match nothing — a comment, or a
 *   negation with nothing to negate. `\#` and `\!` are the literal characters.
 * - A pattern that names no segment matches nothing: `''`, `/`, `//`. So does
 *   one with an EMPTY segment inside it (`a//b`, `//a`), which no normalised
 *   path has. 🚩 An empty body used to compile to a bare globstar and match
 *   EVERYTHING, and it is reachable from the permission lane as `Read()`,
 *   `Read(/)`, `Read(~/)` and `Read(./)`.
 * - Matching is case-insensitive, node-ignore's default, which the lane
 *   inherited without ever choosing it; kept so the verdicts do not move.
 *
 * Divergences, each pinned in the suite beside node-ignore's own answer. They
 * were found by executing both over 3,160 (pattern, path) pairs, not by
 * reading; in every one this side is the gitignore-spec reading and
 * node-ignore's is an artefact of compiling to a regex. The permissions page
 * names the gitignore spec, so the spec wins.
 *
 * - `[!bc]` / `[^bc]` NEGATE the class here; node-ignore@6 reads them as the
 *   literal set `{!, b, c}` / `{^, b, c}`.
 * - An unterminated `[` is a literal `[` here; node-ignore's regex fails to
 *   compile and it answers `false`. `[]` and `[!]` are the literal characters
 *   here rather than regex accidents.
 * - A `]` first in a class is a member (`[]a]` holds `]` and `a`), and `[\]]`
 *   is the class holding `]`; node-ignore closes the class at the first `]`.
 * - An escape is the character it escapes, always: `\*` at the end of a
 *   pattern is a `*` (node-ignore turns it back into a wildcard), `\?` is a `?`
 *   (node-ignore compiles `\[^/]`), `\b` / `\d` / `\s` / `\w` are the letters
 *   (node-ignore passes them to its regex as a word boundary and three
 *   character classes), and a `\` with nothing after it is a `\`.
 * - A `/` inside `[…]` is the segment separator first, so `a[/]b` is the two
 *   segments `a[` and `]b` and a class never matches a separator; node-ignore
 *   lets `[/]` match one.
 * - Unicode case-folding differs at the edges (`ẞ`/`ß`, `İ`/`i̇` fold together
 *   here and not there; `Σ`/`ς` the reverse). `toLowerCase()` and a regex `i`
 *   flag are different foldings, neither is a reading of the spec, and this is
 *   documented rather than aligned.
 */

/** One character-level element of a segment pattern. */
type SegmentToken =
  | { readonly kind: 'literal'; readonly char: string }
  | { readonly kind: 'any' }
  | { readonly kind: 'star' }
  | {
      readonly kind: 'class';
      readonly negated: boolean;
      readonly ranges: ReadonlyArray<readonly [low: string, high: string]>;
    };

/** A pattern segment: the multi-directory wildcard, or a compiled glob. */
type PatternSegment = 'globstar' | readonly SegmentToken[];

/** A compiled path pattern. */
export interface PathPattern {
  readonly segments: readonly PatternSegment[];
  /** A comment, a lone negation, or a pattern naming no segment: nothing is ever matched. */
  readonly matchesNothing: boolean;
  /** Trailing `/`: only a directory — never a file path's last segment — matches. */
  readonly directoryOnly: boolean;
}

/** The character at `index` read as an escaped literal, and where the next token starts. */
function escapedAt(text: string, index: number): { char: string; next: number } {
  return index + 1 < text.length
    ? { char: text.charAt(index + 1), next: index + 2 }
    : { char: '\\', next: index + 1 };
}

/**
 * Parse a `[…]` class starting at `open`, or report that it is unterminated
 * (in which case the `[` is a literal).
 */
function parseClass(
  text: string,
  open: number,
): { token: SegmentToken; next: number } | undefined {
  let index = open + 1;
  const negated = text.charAt(index) === '!' || text.charAt(index) === '^';
  if (negated) index += 1;
  const ranges: (readonly [string, string])[] = [];
  let first = true;
  while (index < text.length) {
    if (text.charAt(index) === ']' && !first) {
      return { token: { kind: 'class', negated, ranges }, next: index + 1 };
    }
    first = false;
    const low = memberAt(text, index);
    index = low.next;
    // `a-z`, unless the `-` is the last thing before the closing bracket.
    if (text.charAt(index) === '-' && index + 1 < text.length && text.charAt(index + 1) !== ']') {
      const high = memberAt(text, index + 1);
      ranges.push([low.char, high.char]);
      index = high.next;
    } else {
      ranges.push([low.char, low.char]);
    }
  }
  return undefined;
}

/** One class member at `index`, honouring a `\` escape. */
function memberAt(text: string, index: number): { char: string; next: number } {
  return text.charAt(index) === '\\'
    ? escapedAt(text, index)
    : { char: text.charAt(index), next: index + 1 };
}

/** Compile one segment's text into character-level tokens. */
function compileSegment(text: string): SegmentToken[] {
  const tokens: SegmentToken[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text.charAt(index);
    if (char === '*') {
      // A run of stars permits exactly what one permits.
      if (tokens.at(-1)?.kind !== 'star') tokens.push({ kind: 'star' });
      index += 1;
    } else if (char === '?') {
      tokens.push({ kind: 'any' });
      index += 1;
    } else if (char === '\\') {
      const escaped = escapedAt(text, index);
      tokens.push({ kind: 'literal', char: escaped.char });
      index = escaped.next;
    } else if (char === '[') {
      const parsed = parseClass(text, index);
      if (parsed === undefined) {
        tokens.push({ kind: 'literal', char: '[' });
        index += 1;
      } else {
        tokens.push(parsed.token);
        index = parsed.next;
      }
    } else {
      tokens.push({ kind: 'literal', char });
      index += 1;
    }
  }
  return tokens;
}

/**
 * The gitignore segment separator, which is `/` on every platform: a pattern is
 * not a filesystem path, and a backslash in one is an ESCAPE, so normalising
 * separators would corrupt `a\*b`. The paths matched against are already
 * forward-slashed by `safePath.relative`.
 */
const SEGMENT_SEPARATOR = '/';

/** The non-empty `/`-separated segments of a PATH. */
function splitSegments(text: string): string[] {
  return text.split(SEGMENT_SEPARATOR).filter((segment) => segment.length > 0);
}

/**
 * The compiled segments of a pattern body that has had its leading and
 * trailing slashes stripped.
 */
function compileSegments(raw: readonly string[], anchored: boolean): PatternSegment[] {
  const segments: PatternSegment[] = [];
  if (!anchored && raw[0] !== '**') segments.push('globstar');
  for (const segment of raw) {
    if (segment !== '**') {
      segments.push(compileSegment(segment));
    } else if (segments.at(-1) !== 'globstar') {
      // A run of `**` segments spans what one spans.
      segments.push('globstar');
    }
  }
  // A trailing `/**` spans ONE or more segments: `a/**` does not match `a`.
  if (segments.length > 1 && segments.at(-1) === 'globstar') {
    segments.splice(-1, 0, [{ kind: 'star' }]);
  }
  return segments;
}

const MATCHES_NOTHING: PathPattern = { segments: [], matchesNothing: true, directoryOnly: false };

/**
 * Compile a gitignore-style pattern. The pattern is expected trimmed; matching
 * is case-insensitive, so it is lower-cased here once.
 */
export function compilePathPattern(pattern: string): PathPattern {
  const lowered = pattern.toLowerCase();
  if (lowered.startsWith('#') || lowered.startsWith('!')) return MATCHES_NOTHING;

  // ONE trailing `/` is the directory restriction and ONE leading `/` is the
  // anchor; a second of either is an empty segment, and an empty segment —
  // like an empty body — names no file, so the pattern matches nothing.
  // 🚩 Every slash used to be stripped, so `''`, `/` and `//` compiled to a
  // bare globstar and matched EVERYTHING.
  let body = lowered;
  const trailingSlash = body.endsWith(SEGMENT_SEPARATOR);
  if (trailingSlash) body = body.slice(0, -1);
  // A `/` at the start or in the middle anchors the pattern at the root.
  const anchored = body.includes(SEGMENT_SEPARATOR);
  if (body.startsWith(SEGMENT_SEPARATOR)) body = body.slice(1);
  if (body.length === 0) return MATCHES_NOTHING;
  const raw = body.split(SEGMENT_SEPARATOR);
  if (raw.some((segment) => segment.length === 0)) return MATCHES_NOTHING;

  // `a/**/` is everything inside `a`, exactly as `a/**` is: the directory
  // restriction adds nothing to a trailing `**`, and node-ignore reads it so.
  // 🚩 Unless the `**` is the WHOLE pattern — `**/`, `/**/`, `**/**/` — which
  // names no directory for the `/` to restrict: the `**` must then span one
  // itself, and the pattern is `*/**`, a directory with something beneath it.
  // The restriction was being dropped there too, and `**/` matched a
  // top-level file.
  const onlyGlobstars = raw.every((segment) => segment === '**');
  const effective = trailingSlash && onlyGlobstars ? ['*', '**'] : raw;
  const directoryOnly = trailingSlash && raw.at(-1) !== '**';

  return { segments: compileSegments(effective, anchored), matchesNothing: false, directoryOnly };
}

/**
 * A character no `[…]` class in practice excludes, tried in order when the
 * class is negated; a class's own first bound is tried before any of these.
 */
const WITNESS_CANDIDATES = ['x', 'a', '0', '-', '_', '.'] as const;

/** One character a class accepts. */
function classMember(token: Extract<SegmentToken, { kind: 'class' }>): string {
  const candidates = [...token.ranges.map(([low]) => low), ...WITNESS_CANDIDATES];
  return candidates.find((char) => inClass(token, char)) ?? WITNESS_CANDIDATES[0];
}

/** One string a segment's tokens accept. */
function segmentMember(tokens: readonly SegmentToken[]): string {
  let text = '';
  for (const token of tokens) {
    switch (token.kind) {
      case 'literal':
        text += token.char;
        break;
      case 'any':
        text += WITNESS_CANDIDATES[0];
        break;
      case 'class':
        text += classMember(token);
        break;
      case 'star':
        break;
    }
  }
  // A segment that is only `*` still has to be a segment.
  return text.length === 0 ? WITNESS_CANDIDATES[0] : text;
}

/**
 * One relative path the pattern matches, materialised from its compiled
 * tokens: each literal is itself, `?` and a bare `*` are a fixed character, a
 * `*` between other tokens is nothing, a class is one of its members, `**`
 * spans zero directories, and a directory-only pattern gets a file beneath it.
 * Empty for a pattern that matches nothing.
 *
 * 🚩 The permission lane used to read a rule's RAW text as a literal file path
 * and call it a witness of the rule. That works for `*`, `**` and `?` only
 * because `*` and `?` match themselves as characters; a rule holding `[…]` or
 * a `\` escape was not a member of its own extension, so an identical
 * `Read(a[!b]c)` pair reported no conflict.
 */
export function witnessOf(pattern: PathPattern): string {
  if (pattern.matchesNothing) return '';
  const segments = pattern.segments
    .filter((segment): segment is readonly SegmentToken[] => segment !== 'globstar')
    .map(segmentMember);
  // A bare `**` names no segment and matches any file; a directory-only
  // pattern needs a file beneath the directory it names.
  if (segments.length === 0 || pattern.directoryOnly) segments.push(WITNESS_CANDIDATES[0]);
  return segments.join(SEGMENT_SEPARATOR);
}

/** Whether `char` is in the class. */
function inClass(token: Extract<SegmentToken, { kind: 'class' }>, char: string): boolean {
  const hit = token.ranges.some(([low, high]) => low <= char && char <= high);
  return hit !== token.negated;
}

/** Whether one non-star token accepts `char`. */
function acceptsChar(token: SegmentToken, char: string): boolean {
  switch (token.kind) {
    case 'literal':
      return token.char === char;
    case 'any':
      return true;
    case 'class':
      return inClass(token, char);
    case 'star':
      return false;
  }
}

/**
 * The single-backtrack glob scan over one segment: `*` remembers where it was
 * and, on a later mismatch, gives back one more character. Each retry moves the
 * saved text position forward, so the scan is O(text × tokens).
 */
function matchesSegment(tokens: readonly SegmentToken[], text: string): boolean {
  let tokenIndex = 0;
  let textIndex = 0;
  let starToken = -1;
  let starText = -1;

  while (textIndex < text.length) {
    const token = tokens[tokenIndex];
    if (token?.kind === 'star') {
      starToken = tokenIndex;
      starText = textIndex;
      tokenIndex += 1;
    } else if (token !== undefined && acceptsChar(token, text.charAt(textIndex))) {
      tokenIndex += 1;
      textIndex += 1;
    } else if (starToken === -1) {
      return false;
    } else {
      tokenIndex = starToken + 1;
      starText += 1;
      textIndex = starText;
    }
  }
  while (tokens[tokenIndex]?.kind === 'star') tokenIndex += 1;
  return tokenIndex === tokens.length;
}

/**
 * The same scan one level up, over path segments, with `**` as the wildcard.
 */
function matchesSegments(pattern: readonly PatternSegment[], path: readonly string[]): boolean {
  let patternIndex = 0;
  let pathIndex = 0;
  let starPattern = -1;
  let starPath = -1;

  while (pathIndex < path.length) {
    const segment = pattern[patternIndex];
    if (segment === 'globstar') {
      starPattern = patternIndex;
      starPath = pathIndex;
      patternIndex += 1;
    } else if (segment !== undefined && matchesSegment(segment, path[pathIndex] as string)) {
      patternIndex += 1;
      pathIndex += 1;
    } else if (starPattern === -1) {
      return false;
    } else {
      patternIndex = starPattern + 1;
      starPath += 1;
      pathIndex = starPath;
    }
  }
  while (pattern[patternIndex] === 'globstar') patternIndex += 1;
  return patternIndex === pattern.length;
}

/**
 * Whether `relativePath` — a `/`-separated path with no leading `/` or `./`,
 * read as a FILE — is matched by `pattern`, including through a directory above
 * it that the pattern matches.
 */
export function matchesPathPattern(pattern: PathPattern, relativePath: string): boolean {
  if (pattern.matchesNothing) return false;
  const path = splitSegments(relativePath.toLowerCase());
  if (path.length === 0) return false;
  // "The pattern, or a directory it matches with anything beneath": a trailing
  // `**` reads the ancestor rule into the scan, and a directory-only pattern
  // needs at least one segment beneath the directory it matched.
  const tail: PatternSegment[] = pattern.directoryOnly ? [[{ kind: 'star' }], 'globstar'] : ['globstar'];
  return matchesSegments([...pattern.segments, ...tail], path);
}
