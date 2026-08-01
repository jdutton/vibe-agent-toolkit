/**
 * Contraband-token scan — proprietary adopter names must never enter this repo.
 *
 * ## Why this gate exists
 *
 * vibe-agent-toolkit is public open source; several of its adopters are confidential.
 * Naming one — in source, a test, a fixture, a schema `.describe()` string, or
 * CHANGELOG.md — leaks the relationship. Unlike a credential, it cannot be rotated: it
 * lands in public git history, in GitHub release bodies, and inside npm tarballs, all of
 * which outlive any later fix.
 *
 * This was not caught by any gate the first time. An adopter's tool name was adopted as
 * the *canonical worked example* in documentation, and then propagated by people doing
 * the right thing — docs cite the example, tests mirror the docs, golden baselines
 * capture the tests, schema descriptions reuse it. One example choice reached four
 * packages before anyone noticed. Hence: a mechanical gate, not a review convention.
 *
 * ## Where the list lives — deliberately NOT in this repo
 *
 * A contraband list written into a public repo *is itself the leak*: it would ship the
 * very names it defends, to the same git history and npm tarballs. So this module ships
 * no list at all. The tokens are injected from outside at scan time, from the first of:
 *
 *   1. `$VAT_CONTRABAND_TOKENS` — path to a token file (CI supplies this from a secret)
 *   2. `.contraband-tokens` in the repo root — gitignored, so it cannot be committed
 *   3. `~/.vat-contraband-tokens` — per-machine, so every worktree and clone is covered
 *      by one file with no per-checkout setup
 *
 * Format: one token per line, `#` starts a comment, blank lines ignored.
 *
 * With no list configured the scan cannot run. It reports that loudly as a warning rather
 * than passing silently — a confidentiality gate that quietly finds nothing is worse than
 * no gate, because it reads as a clean bill of health. It is a warning and not an error so
 * that a fresh clone still builds; CI is where the list is mandatory.
 *
 * ## Why a keyword scan is legitimate here
 *
 * VAT's own engineering rule is that a keyword regex must not define a gate's population
 * or verdict — a keyword scan cannot reliably *classify* a body of code. That rule is
 * about classification. This gate does the opposite: it asserts **absence** over a
 * population defined independently of any keyword (every git-tracked text file). A miss
 * is a false negative, never a false verdict about a file's nature. Do not "fix" this by
 * replacing the scan with structural analysis — there is no structure to analyze; a
 * proprietary name is a string and nothing else.
 *
 * ## Matching, and why there are three token forms
 *
 * A token is normalized to bare lowercase alphanumerics, and matched against candidates
 * extracted from each line in one of three ways, chosen by how the token is written:
 *
 *   - `word`   — a token with no separator (`SomeName`) matches whole words only, so
 *                `somenamery` does not trip it.
 *   - `slug`   — a token joined by punctuation (`some-name`) matches any punctuation
 *                join (`some_name`, `some.name`) but deliberately NOT across a space.
 *                Several real entries are two ordinary English words joined by a hyphen,
 *                and matching those across a space would fire on ordinary prose.
 *   - `phrase` — a token containing a space (`Some Name`) matches space-separated
 *                n-grams. Widest blast radius; reserve it for phrases that cannot occur
 *                innocently.
 *
 * One known collision worth stating: a three-letter entry on the current list also names
 * an OOXML length unit used by docx-generating code as a `WidthType` member. Nothing in
 * this repo's tracked text uses it today (the OOXML occurrences live inside a compressed
 * test fixture, which this scan does not open). If VAT ever gains docx-generating code,
 * exempt that file rather than dropping the entry.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

/** Shortest token worth matching — below this, collisions dominate. */
const MIN_TOKEN_LENGTH = 3;

/** Longest space-joined n-gram considered for `phrase` tokens. */
const MAX_PHRASE_WORDS = 4;

/** An alphanumeric run. */
const WORD_RUN = /[a-z0-9]+/g;

/**
 * A run of alphanumerics and slug punctuation. Written as one flat character class rather
 * than the more obvious `[a-z0-9]+(?:[-_./][a-z0-9]+)+` because that form nests two
 * quantifiers over overlapping classes and backtracks super-linearly on adversarial input.
 * Candidates are filtered afterwards by {@link isSlugCandidate} instead.
 */
const SLUG_RUN = /[a-z0-9][a-z0-9\-_./]*[a-z0-9]/g;

/** Slug separators — a run only counts as a slug if it actually joins two parts. */
const SLUG_SEPARATOR = /[-_./]/;

/** Env var naming a token file; takes precedence over the repo-root default. */
export const TOKENS_ENV = 'VAT_CONTRABAND_TOKENS';

/** Gitignored default location, so the list can sit in the repo root but never be committed. */
export const TOKENS_DEFAULT_FILE = '.contraband-tokens';

/** Per-machine default, relative to the home directory — covers every worktree at once. */
export const TOKENS_HOME_FILE = '.vat-contraband-tokens';

export type TokenForm = 'word' | 'slug' | 'phrase';

/** A normalized token plus the candidate form it is matched against. */
export interface ContrabandToken {
  normalized: string;
  form: TokenForm;
}

export interface ContrabandHit {
  /** 1-indexed line number within the scanned text. */
  line: number;
  /**
   * Which form matched. Deliberately does NOT carry the matched text — a report that
   * echoed the token back would reintroduce the name into CI logs and PR comments.
   */
  form: TokenForm;
}

/** How a raw token is written determines which candidate form it matches. */
function formOf(raw: string): TokenForm {
  if (/\s/.test(raw.trim())) return 'phrase';
  if (/[a-z0-9][-_./][a-z0-9]/i.test(raw)) return 'slug';
  return 'word';
}

/** Strip to bare lowercase alphanumerics — the common shape of tokens and candidates. */
function normalize(raw: string): string {
  return raw.toLowerCase().replaceAll(/[^a-z0-9]/g, '');
}

/** Parse a token file: one token per line, `#` comments, blanks ignored. */
export function parseTokenList(contents: string): ContrabandToken[] {
  const tokens: ContrabandToken[] = [];
  for (const line of contents.split('\n')) {
    const raw = (line.split('#')[0] ?? '').trim();
    const normalized = normalize(raw);
    if (normalized.length < MIN_TOKEN_LENGTH) continue;
    tokens.push({ normalized, form: formOf(raw) });
  }
  return tokens;
}

export interface TokenSource {
  tokens: ContrabandToken[];
  /** Where they came from, for the operator-facing message; undefined when none found. */
  path?: string;
}

/**
 * Load the token list from outside the repo. Returns an empty list (with no `path`) when
 * nothing is configured — callers must surface that rather than treating it as "clean".
 * A configured-but-unreadable file throws, so a typo'd path can never look like a pass.
 */
export function loadTokens(repoRoot: string, env: NodeJS.ProcessEnv = process.env): TokenSource {
  const configured = env[TOKENS_ENV]?.trim();
  // Home is read from the passed env (falling back to the OS) so tests can redirect it.
  const home = env['HOME'] ?? env['USERPROFILE'] ?? homedir();
  const candidates = configured
    ? [configured]
    : [`${repoRoot}/${TOKENS_DEFAULT_FILE}`, `${home}/${TOKENS_HOME_FILE}`];

  for (const path of candidates) {
    let contents: string;
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- operator-supplied path, by design
      contents = readFileSync(path, 'utf8');
    } catch (cause) {
      // An explicitly configured path that cannot be read is an error, not a fallback.
      if (configured) {
        throw new Error(
          `${TOKENS_ENV} points at "${path}", which could not be read. Fix the path or unset it — ` +
            `silently skipping would turn a confidentiality gate into a no-op that reports success.`,
          { cause },
        );
      }
      continue;
    }
    return { tokens: parseTokenList(contents), path };
  }
  return { tokens: [] };
}

/** Words of a line, lowercased, with every other character treated as a separator. */
function wordsOf(lowerLine: string): string[] {
  return lowerLine.match(WORD_RUN) ?? [];
}

/** A matched run is a slug only when punctuation actually joins two alphanumeric parts. */
function isSlugCandidate(run: string): boolean {
  return SLUG_SEPARATOR.test(run);
}

/** Every punctuation-joined slug in a line, normalized to bare alphanumerics. */
function slugsOf(lowerLine: string): string[] {
  return (lowerLine.match(SLUG_RUN) ?? []).filter(isSlugCandidate).map(normalize);
}

/** Every space-joined n-gram (2..MAX_PHRASE_WORDS) in a line, normalized. */
function phrasesOf(words: string[]): string[] {
  const candidates: string[] = [];
  for (let size = 2; size <= MAX_PHRASE_WORDS; size++) {
    for (let start = 0; start + size <= words.length; start++) {
      candidates.push(words.slice(start, start + size).join(''));
    }
  }
  return candidates;
}

/**
 * Scan text for contraband adopter names. Pure and I/O-free so it is unit-testable with
 * synthetic tokens; `validateNoContrabandTokens` supplies the file population and
 * `loadTokens` supplies the list.
 */
export function scanTextForContraband(text: string, tokens: readonly ContrabandToken[]): ContrabandHit[] {
  if (tokens.length === 0) return [];
  const byForm: Record<TokenForm, Set<string>> = { word: new Set(), slug: new Set(), phrase: new Set() };
  for (const { normalized, form } of tokens) byForm[form].add(normalized);

  const hits: ContrabandHit[] = [];
  for (const [index, rawLine] of text.split('\n').entries()) {
    const lowerLine = rawLine.toLowerCase();
    const words = wordsOf(lowerLine);
    const matched = (form: TokenForm, candidates: string[]): boolean =>
      byForm[form].size > 0 && candidates.some((c) => byForm[form].has(c));

    if (matched('word', words)) hits.push({ line: index + 1, form: 'word' });
    else if (matched('slug', slugsOf(lowerLine))) hits.push({ line: index + 1, form: 'slug' });
    else if (matched('phrase', phrasesOf(words))) hits.push({ line: index + 1, form: 'phrase' });
  }
  return hits;
}
