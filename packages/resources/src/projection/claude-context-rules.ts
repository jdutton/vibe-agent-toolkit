/**
 * Which `.claude/rules` files a path query loads, and under which predicate.
 *
 * ## This is the consumer half of `rule-scope`
 *
 * `ClaudeRulesScopeContributor` emits `rule-scope: root | nested | path-scoped`
 * and deliberately NO `loading` row — that decision (spec §0.3, Plan A's D2) kept
 * `agentic-convention` the projection's only `loading` producer, so
 * `resource_tags`' `(resourceId, tag, value, source)` key can never hold two
 * contradictory loading rows for one identity. The price was that somebody has to
 * turn a scope into a load class, and this is that somebody: the entry point that
 * makes "root" mean anything is in hand here and was not in hand there.
 *
 * | scope | directory query | file query |
 * |---|---|---|
 * | `root` | always | always |
 * | `nested` | on demand, at or below the rules directory's PARENT | same |
 * | `path-scoped` | on demand, ∀ (covers the directory) or ∃ (some file here matches) or absent | on demand, admitted iff a glob matches |
 *
 * ⛔ A path-scoped rule is ON DEMAND in BOTH columns. The vendor's on-demand
 * class is *"rules that load on demand, including path-scoped rules and rules in
 * nested `.claude/rules/` directories"* — both halves, not just the nested one.
 * A matching glob decides whether the rule is in the answer, never that it is
 * loaded at launch; `claude-context-query.ts`'s `baseLoadClass` is where that is
 * enforced and says so at length. **∀ does not change that**: a rule covering
 * every file in a directory still fires when the agent touches one of them, not
 * at launch. ∀ is the BURDEN signal, not a load class.
 *
 * ## ∃ and ∀, and the constant they replace
 *
 * This returned `glob-rule-may-fire` for EVERY path-scoped rule on a directory
 * query, without inspecting a single glob. Measured on a 116-rule adopter, three
 * unrelated directories — one data directory, one package, one documentation tree
 * — each reported an on-demand total of **73,958 tokens**. Identical, because the
 * answer was the whole rule corpus every time. A number that is the
 * same for every directory in a repo carries no information, and the stated
 * `directory-glob` limit kept it from being a lie without making it useful.
 *
 * The split, a product decision:
 *
 * - **∀ — `glob-rule-covers-dir`.** Some pattern covers every path under the
 *   query directory, so the rule is a second `CLAUDE.md` for it in all but name.
 *   This is the BURDEN answer, and it is **pure pattern containment**: no file is
 *   enumerated to decide it. {@link coversDirectory} asks the gitignore matcher
 *   whether it matches the query DIRECTORY, which under gitignore's own rules
 *   carries the whole subtree with it — an exact answer, where the shape-match
 *   it replaced (a glob-free prefix plus `/**`) declined `docs`, `src/` and
 *   every unanchored spelling of the same claim.
 * - **∃ — `glob-rule-may-fire`.** At least one realized file under the query
 *   directory matches, and the admission now NAMES that pattern and one path it
 *   matched. This is the DISCOVERABILITY answer. It reads `resource_realizations`
 *   and nothing else — already materialised, no new table, no new crawl.
 * - **Neither ⇒ the rule is not in the answer at all.** That is the half that
 *   kills the constant: a rule scoped to `packages/some-pkg/src/*.ts` is no longer
 *   charged against `docs/wiki/`, which it provably cannot fire under.
 *
 * ∃ is still an over-report against any ONE file in the directory, which is what
 * the rewritten `directory-glob` limit now says. It is no longer an over-report
 * against the directory.
 *
 * ## The cost of ∃, and the prune that pays for it
 *
 * ∃ is a pattern-by-file cross product, and the adopter that produced the
 * constant would run 116 rules × ~18 patterns against every file under the query
 * directory. Two prunes keep it off the critical path, and both are ordinary
 * prefix arithmetic rather than an index:
 *
 * 1. An ANCHORED pattern's literal prefix bounds the subtree it can possibly
 *    match ({@link matchBound}). When that bound and the query directory are
 *    disjoint the pattern is skipped without testing one file — which on that
 *    adopter is most of the rule corpus for most directories, and is why the
 *    constant was so much larger than any real answer.
 * 2. When the bound is BELOW the query directory, only files under it are
 *    tested, found by binary search over a path-sorted array
 *    ({@link candidateRange}). A root query against a deep pattern scans that
 *    pattern's own subtree, not the tree.
 *
 * ⛔ An UNANCHORED pattern — one with no slash, which gitignore lets match at
 * any depth — has NO bound and is swept against every candidate. That is the
 * price of the matcher being right: the prune used to read a bound off the
 * declared string and so pruned away exactly the matches the old engine was
 * already missing. On the 13-repo public corpus 39 of 378 stripped globs are
 * unanchored.
 *
 * Matchers are compiled once per pattern, when the rule is compiled, and reused
 * across every file and every lane.
 *
 * ⚠️ The `nested` trigger is the directional analogue of the vendor's
 * subdirectory-`CLAUDE.md` rule and is NOT documented. The vendor says only that
 * nested rules directories are in the on-demand class. Recorded as an assumption
 * in `claude-context-limits.ts`, and never counted into an always-loaded total.
 *
 * ## ⚠️ `paths:` is a GITIGNORE list, and this module matches it with one
 *
 * The evidence, with the decompiled lines and a re-verification recipe, is
 * [`docs/external/claude-code-rules-paths-behaviour.md`](../../../../docs/external/claude-code-rules-paths-behaviour.md)
 * — a vendor claim stated only in a docstring carries no clock, so every
 * sentence below is sourced there and the two are edited together.
 *
 * The harness normalises `paths:`, **strips a trailing `/**` from every
 * pattern**, and then hands the survivors to `node-ignore`:
 * `ignore().add(globs).ignores(relativePath)`. So the dialect is gitignore's,
 * not picomatch's, and this module compiles the same library over the same
 * stripped strings. The differences that reach a rules file, each pinned by a
 * test in `projection-claude-context-rules.test.ts`:
 *
 * | shape | gitignore (harness, and now here) | picomatch (what this used to do) |
 * |---|---|---|
 * | `src/**` vs `packages/cli/src/index.ts` | matches — stripped to `src`, which has no slash and is therefore UNANCHORED | no match |
 * | a matched directory | drags its whole subtree, so `a/*` matches `a/b/c` | no match |
 * | `README.md` vs `docs/atlas/README.md` | matches at any depth | no match |
 * | a slash in the middle (`packages/**\/ports*`) | ANCHORED to the root | anchored too, but `**` spans differently |
 * | a leading `/` | anchors and is otherwise dropped | a root-absolute path |
 * | a trailing `/` | matches a DIRECTORY only | matches nothing |
 * | a leading `!` | negates, within the rule's whole list | a literal, or picomatch's own negation |
 * | `{a,b}` | LITERAL braces — gitignore has no brace expansion, so the harness expands them ITSELF, before the strip | expanded by the matcher |
 * | `+(a|b)` | literal — no extglobs | an extglob |
 * | `./docs/**` | matches NOTHING: `./` is not gitignore syntax | matches `docs/…` |
 * | a dotfile | ordinary; there is no `dot` option to set | needs `dot: true` |
 *
 * ⛔ A pattern `node-ignore` cannot compile — `src/a[/`, an unterminated
 * character class — THROWS at match time, not at `add()` time. The harness asks
 * the question up front and drops such a pattern (`mre` →
 * `compileErrorMessage`), so {@link usableGlobs} asks it too. Without it a
 * mistyped glob in an adopter's rules file would crash the projection.
 *
 * ## The expansion budget is PER PATTERN, and it expands nothing but commas
 *
 * The harness's expander (`N`) `split(",")`s a brace group and nothing else —
 * there is **no `{1..n}` range expansion** — early-returns a brace-free pattern
 * before spending anything, and decrements the 1,000-pattern / 4 MiB budgets as
 * it goes. So exhaustion refuses THAT pattern (which is then used with its
 * braces literal) and leaves the rest of the list to try its luck; a brace-free
 * pattern after the exhaustion point is still live. {@link expandBraces} is that
 * function transcribed, and {@link harnessExpansion} runs it across one list
 * with one running budget.
 */

import ignore from 'ignore';

import type { BlobRow } from '../schemas/projection-blobs.js';
import type { ClaudeRulePatternStatus } from '../schemas/projection-claude-rules.js';
import type {
  ResourceRealizationRow,
  ResourceTagRow,
} from '../schemas/projection-resources.js';
import type { JsonValue } from '../schemas/projection-shared.js';

import { RULE_SCOPE_TAG, type RuleScope } from './agentic-tags.js';

/**
 * The vendor's expansion budget, in patterns, for one rule's `paths` list.
 *
 * Read off the binary as `var D=1000,z=4194304`, and spent PER PATTERN as
 * {@link expandBraces} proceeds — not as a whole-list allowance. Not a VAT
 * constant with a version to bump: a transcribed vendor quantity, sourced at
 * `docs/external/claude-code-rules-paths-behaviour.md`.
 */
const EXPANDED_PATTERN_BUDGET = 1000;

/** The other half of the same vendor budget, in bytes (`z=4194304`). */
const PATTERN_BYTE_BUDGET = 4 * 1024 * 1024;

/** The `.claude/rules` segment a nested rules directory hangs below. */
const RULES_SEGMENT = '/.claude/rules/';

/** The trailing tail `kyn` strips from every normalised pattern. */
const UNIVERSAL_TAIL = '/**';

/**
 * The stripped globs that cover the corpus ROOT, and so every path in the tree.
 *
 * ⛔ The root is the one directory {@link coversDirectory} cannot ask the
 * matcher about, because `ignore` refuses an empty path and `/` is not a
 * relative one. Every other directory is decided exactly — gitignore drags a
 * matched directory's whole subtree — so this set exists only for that one
 * query, and it is deliberately the narrow answer: `*` covers the root too and
 * is left out, because a false ∀ states a burden the adopter does not carry
 * while a false negative only falls through to the ∃ test below.
 *
 * `**` alone never reaches here — a rule whose survivors are every one `**` is
 * always-loaded ({@link declaresPaths}) — but it does reach here beside a real
 * glob, which is why it is in the set.
 */
const ROOT_COVERING_GLOBS = new Set(['**', '**/*']);

/**
 * Characters that make a path segment a pattern rather than a literal.
 *
 * `!` is here even though it only negates in leading position: a `paths:` list
 * containing a negation is a predicate this module's OR-over-patterns does not
 * model, and refusing to call such a pattern universal is the conservative
 * direction. `(` and `)` cover picomatch's extglobs.
 */
const GLOB_META = /[*?[\]{}()!]/;

/** Why one rule is in the answer. */
export type RuleAdmission =
  | { readonly kind: 'root-rule' }
  | { readonly kind: 'nested-rule'; readonly under: string }
  | { readonly kind: 'glob-rule'; readonly pattern: string }
  /** ∀ — every path under the query directory matches. The burden answer. */
  | { readonly kind: 'glob-rule-covers-dir'; readonly pattern: string }
  /**
   * ∃ — some realized file under the query directory matches.
   *
   * Carries the witness: without `examplePath` the claim is unfalsifiable by the
   * reader, who would have to re-run the matcher to find out whether "may fire"
   * meant one generated file or the whole directory.
   */
  | {
      readonly kind: 'glob-rule-may-fire';
      readonly pattern: string;
      readonly examplePath: string;
    };

/** One rule this query loads, and the predicate that admitted it. */
export interface SelectedRule {
  readonly resourceId: string;
  readonly path: string;
  readonly admission: RuleAdmission;
}

/** The selection, plus the rules whose `paths:` list blew the vendor's budget. */
export interface RuleSelectionResult {
  readonly rules: readonly SelectedRule[];
  readonly overBudget: readonly string[];
}

/**
 * What happened when one declared pattern was tested against the whole tree.
 *
 * ⛔ FOUR states, and the last two are the point: a pattern the vendor's budget
 * REFUSED, and a pattern whose territory git ignores, both have a null witness
 * while meaning something other than inertness, so folding either into `inert`
 * reports a blind spot as a defect. See `docs/architecture/zones.md` §4.
 *
 * - `matched` — some realized file matches; `witnessPath` names it.
 * - `inert` — evaluated against every candidate and matched none. The defect
 *   signal: a glob naming a moved, renamed or never-created path.
 * - `unevaluated` — the rule's `paths:` list blew the shared expansion or byte
 *   budget, so no matcher ran. One over-budget entry refuses the whole list.
 * - `gitignored` — evaluated and matched nothing VAT can see, and its
 *   territory is gitignored ({@link territoryIgnored}). VAT never realizes an
 *   ignored file while the harness reads the filesystem, so the glob may well
 *   fire and VAT declines to judge it.
 *
 * The schema's type, not a second spelling of the vocabulary.
 */
type RulePatternStatus = ClaudeRulePatternStatus;

/** One declared `paths:` entry, and what the tree-wide walk found for it. */
interface RulePatternEvaluation {
  /** Zero-based index in the rule's declared `paths:` list. */
  readonly ordinal: number;
  /** The pattern exactly as declared — never normalised. */
  readonly pattern: string;
  /**
   * The longest path every match must live at or below.
   *
   * ⛔ A wholly-literal pattern yields ITSELF, a FILE rather than a directory —
   * see {@link literalPrefix}. Read it as "at or below", inclusively.
   */
  readonly literalPrefix: string;
  /** The file that proves the pattern live, or null for every other state. */
  readonly witnessPath: string | null;
  readonly status: RulePatternStatus;
}

/**
 * The leading brace group {@link expandBraces} peels, and what surrounds it.
 *
 * The harness's own regex, transcribed: `^([^{]*)\{([^}]+)\}(.*)$`. Each part is
 * anchored and none can match a `{` or `}` the next part also matches, so it
 * peels the leftmost group in linear time and cannot backtrack into the head.
 */
const BRACE_GROUP = /^([^{]*)\{([^}]+)\}(.*)$/;

/** The two halves of the vendor budget, decremented as expansion proceeds. */
interface ExpansionBudget {
  /** Expanded patterns still affordable across the rest of the list. */
  results: number;
  /** Bytes still affordable across the rest of the list. */
  bytes: number;
}

/** What one declared `paths:` entry expands to, and whether the budget refused it. */
interface ExpandedPattern {
  /** The expansion, with each entry's trailing `/**` stripped and empties dropped. */
  readonly globs: readonly string[];
  /**
   * Did the budget run out while expanding THIS pattern?
   *
   * The harness then uses the pattern unexpanded, so its braces are literal
   * gitignore characters and it matches essentially nothing. VAT declines to
   * judge such a pattern rather than calling it dead.
   */
  readonly refused: boolean;
}

/**
 * One pattern's brace expansion, charged against a RUNNING budget.
 *
 * `N()` transcribed. Three properties of it were invented before this was read
 * out of the binary, and each produced a wrong answer:
 *
 * 1. **There is no range expansion.** `l.split(",")` is the whole grammar, so
 *    `logs/{1..2000}.txt` is ONE glob there. VAT modelled `{1..n}` as `n`
 *    expansions and reported the rule `unevaluated`.
 * 2. **A brace-free pattern costs nothing** — `if(!e.includes("{"))return[e]`
 *    precedes every decrement, so a list of 1,001 brace-free patterns is
 *    entirely live. VAT summed them to 1,001 and refused the list.
 * 3. **Refusal is per pattern.** `N` returns `[e]` for the pattern that trips
 *    the budget and the caller carries on with the next one, so a list is not
 *    all-or-nothing. VAT refused the whole list from one oversized entry.
 *
 * @param pattern - One `paths:` entry, as declared
 * @param budget - The running budget, mutated in place as the list is walked
 * @returns The expansion, or the pattern alone when the budget refused it
 */
function expandBraces(pattern: string, budget: ExpansionBudget): ExpandedPattern {
  if (!pattern.includes('{')) return { globs: [pattern], refused: false };
  const done: string[] = [];
  const pending: string[] = [pattern];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const group = BRACE_GROUP.exec(next);
    if (group === null) {
      done.push(next);
      continue;
    }
    const [, head = '', body = '', tail = ''] = group;
    const alternatives = body.split(',').map((alternative) => alternative.trim());
    budget.bytes -= next.length;
    const width = done.length + pending.length + alternatives.length;
    if (budget.bytes < 0 || width > budget.results || width * pattern.length > budget.bytes) {
      return { globs: [pattern], refused: true };
    }
    for (let index = alternatives.length - 1; index >= 0; index -= 1) {
      pending.push(head + (alternatives[index] ?? '') + tail);
    }
  }
  budget.results -= done.length;
  // ⚠️ `e.length` — the ORIGINAL pattern's length, once per result — and not
  // each result's own length. Transcribed, not tidied: a "fix" here would make
  // the byte budget disagree with the harness for every multi-group pattern.
  budget.bytes -= done.length * pattern.length;
  return { globs: done, refused: false };
}

/**
 * One rule's whole `paths:` list, expanded and stripped the way the harness does.
 *
 * ⛔ ONE budget object walks the list in declaration order, which is what makes
 * refusal positional: everything before the exhaustion point expanded, the
 * pattern at it is refused, and what follows is charged against whatever is
 * left. Exported so a test can assert that positional answer directly rather
 * than through four layers of status.
 *
 * @param patterns - The rule's `paths:` entries, in declaration order
 * @returns One expansion per entry, in the same order
 */
export function harnessExpansion(patterns: readonly string[]): readonly ExpandedPattern[] {
  const budget: ExpansionBudget = {
    results: EXPANDED_PATTERN_BUDGET,
    bytes: PATTERN_BYTE_BUDGET,
  };
  return patterns.map((pattern) => {
    const { globs, refused } = expandBraces(pattern, budget);
    return {
      // `kyn`'s strip, AFTER the expansion and not before it: `{**,**}` expands
      // to two `**`s and leaves the rule always-loaded, where stripping first
      // would have left one unrecognisable `{**,**}` and called it scoped.
      globs: globs
        .map((glob) => (glob.endsWith(UNIVERSAL_TAIL) ? glob.slice(0, -UNIVERSAL_TAIL.length) : glob))
        .filter((glob) => glob !== ''),
      refused,
    };
  });
}

/**
 * A stand-in path `usableGlobs` compiles a candidate against.
 *
 * `ignore().add()` builds no regex — the rule object compiles lazily on its
 * first match — so the only way to learn that a pattern is uncompilable is to
 * match something with it. The harness asks the same question the same way.
 */
const COMPILE_PROBE = 'vat-compile-probe';

/**
 * The globs `node-ignore` can actually compile, which is what the harness adds.
 *
 * ⛔ Not defensive tidying: `src/a[/` is an unterminated character class, and
 * `new RegExp` throws on it at MATCH time, from inside a getter, three frames
 * below any call site a reader would look at. The harness drops such a pattern
 * up front (`mre` → `compileErrorMessage`, one `tengu_uncompilable_ignore_pattern`
 * event) and treats it as matching nothing; so does this. Without it one
 * mistyped glob in one adopter's rules file takes the whole projection down.
 *
 * @param globs - One pattern's expanded, stripped globs
 * @returns The subset that compiles
 */
function usableGlobs(globs: readonly string[]): string[] {
  return globs.filter((glob) => {
    try {
      ignore().add([glob]).ignores(COMPILE_PROBE);
      return true;
    } catch (error) {
      // Only the uncompilable-pattern case is absorbed, and it is absorbed
      // because the harness absorbs it. Anything that is not a `RegExp`
      // SyntaxError is a bug in this module or in the library and stays loud.
      if (error instanceof SyntaxError) return false;
      throw error;
    }
  });
}

/**
 * A gitignore matcher over one glob set, refusing a path the library would throw on.
 *
 * `ignore().ignores()` throws — it does not return false — for an empty,
 * absolute, `./`- or `../`-prefixed path, and this module's callers hand it
 * query directories and corpus paths that arrive from configuration. `false` is
 * the right answer for a path no root-relative glob can name, and `isPathValid`
 * is the library's own question rather than a second spelling of it.
 *
 * @param globs - The compiled glob set; an empty one matches nothing
 * @returns A predicate over root-relative paths; a trailing `/` asks about a DIRECTORY
 */
function gitignoreMatcher(globs: readonly string[]): (path: string) => boolean {
  const usable = usableGlobs(globs);
  if (usable.length === 0) return () => false;
  const compiled = ignore().add(usable);
  return (path) => ignore.isPathValid(path) && compiled.ignores(path);
}

/** One root-relative form of one declared pattern, compiled. */
interface CompiledForm {
  /** The form as spelled — what {@link territoryIgnored} asks its prefix about. */
  readonly form: string;
  /**
   * The subtree every match lives at or below, or `''` when there is no bound.
   *
   * ⛔ `''` is the ORDINARY answer now, not the corner case: under gitignore a
   * pattern with no slash matches at any depth, so `pom.xml` and `src` bound
   * nothing and must be swept against the whole file list. A bound taken from
   * the declared string — which is what {@link literalPrefix} returns — would
   * prune away every match of exactly the patterns FIX 1 exists to find.
   */
  readonly bound: string;
  /** Does this form reach `path`? A trailing `/` asks about a directory. */
  readonly reaches: (path: string) => boolean;
}

/** One declared `paths:` entry, compiled the way the harness compiles it. */
interface CompiledPattern {
  readonly ordinal: number;
  /** The author's spelling, reported verbatim and never normalised. */
  readonly pattern: string;
  readonly refused: boolean;
  /** The root form, plus the re-based one when the rule is nested. */
  readonly forms: readonly CompiledForm[];
  /** Does some form of this pattern cover the corpus ROOT, and so every path? */
  readonly coversRoot: boolean;
}

/**
 * One rule's `paths:` list, compiled once for every lane that matches against it.
 *
 * Two matchers, and they answer different questions:
 *
 * - **{@link CompiledRule.loads}** is the harness's own shape — every glob of
 *   every pattern in ONE `ignore()` instance — and it is the only one that can
 *   answer *does this rule load for this file*, because a `!` pattern only
 *   means anything beside the patterns it subtracts from.
 * - **{@link CompiledPattern.forms}** is per pattern, and answers *what does
 *   THIS glob reach*, which is the `claude_rule_patterns` question and the one
 *   a finding names.
 */
interface CompiledRule {
  readonly patterns: readonly CompiledPattern[];
  /** Does the whole list admit `path`? Negations included, in declaration order. */
  readonly loads: (path: string) => boolean;
}

/**
 * Compile one rule's declared patterns.
 *
 * @param rulePath - The rules file's root-relative path, for the nested re-base
 * @param declared - Its `paths:` entries, in declaration order
 * @returns The per-pattern matchers and the whole-list one
 */
function compileRule(
  rulePath: string,
  declared: readonly DeclaredPattern[],
): CompiledRule {
  const expanded = harnessExpansion(declared.map((entry) => entry.pattern));
  const patterns = declared.map((entry, index) => compilePattern(
    rulePath,
    entry,
    expanded[index] ?? { globs: [], refused: false },
  ));
  // ⚠️ A refused pattern contributes its UNEXPANDED self, which is what the
  // harness adds: braces are literal gitignore characters there, so it matches
  // essentially nothing without being silently absent from the rule's list.
  const all = patterns.flatMap((pattern) => pattern.forms.map((form) => form.form));
  const loads = gitignoreMatcher([...new Set(all)]);
  return { patterns, loads };
}

/**
 * Compile one declared pattern, under every base its rules file may resolve against.
 *
 * @param rulePath - The rules file's root-relative path
 * @param declared - The entry, carrying the author's spelling and its ordinal
 * @param expansion - What {@link harnessExpansion} made of it
 * @returns The compiled pattern
 */
function compilePattern(
  rulePath: string,
  declared: DeclaredPattern,
  expansion: ExpandedPattern,
): CompiledPattern {
  const base = nestedRuleParent(rulePath);
  const bases = base === null ? [null] : [null, base];
  const forms = bases.map((under) => {
    const globs = expansion.globs.map((glob) => rebase(glob, under));
    return {
      form: rebase(declared.pattern, under),
      bound: matchBound(globs),
      reaches: gitignoreMatcher(globs),
    };
  });
  return {
    ordinal: declared.ordinal,
    pattern: declared.pattern,
    refused: expansion.refused,
    forms,
    coversRoot: expansion.globs.some((glob) => ROOT_COVERING_GLOBS.has(glob)),
  };
}

/**
 * One glob under one base — itself at the root, or below a nested rule's project.
 *
 * @param glob - The glob, or the declared pattern it came from
 * @param under - The nested rule's project directory, or null for the root
 * @returns The re-based glob
 */
function rebase(glob: string, under: string | null): string {
  return under === null ? glob : `${under}/${withoutLeadingDotSegments(glob)}`;
}

/**
 * The subtree bound shared by a pattern's expanded globs, for the sorted-range prune.
 *
 * Gitignore anchors a pattern that has a `/` anywhere but its end, and lets
 * every other pattern match at any depth. So the bound is the weakest of the
 * per-glob bounds, and ONE unanchored glob makes the whole pattern unbounded.
 *
 * ⚠️ Computed from the EXPANDED globs, because a brace group can introduce a
 * slash (`{a,b/c}`) and so change whether an alternative is anchored at all.
 *
 * @param globs - One pattern's expanded, stripped globs
 * @returns The bound, or `''` when the pattern can match at any depth
 */
function matchBound(globs: readonly string[]): string {
  let bound: string | null = null;
  for (const glob of globs) {
    const body = glob.endsWith('/') ? glob.slice(0, -1) : glob;
    // A leading `!` negates; its territory is the same as the positive form's,
    // and a leading `/` anchors without being part of any path.
    const positive = (body.startsWith('!') ? body.slice(1) : body).replace(/^\//, '');
    if (!positive.includes('/')) return '';
    const prefix = literalPrefix(positive);
    if (prefix === '') return '';
    bound = bound === null ? prefix : commonPrefixDirectory(bound, prefix);
    if (bound === '') return '';
  }
  return bound ?? '';
}

/**
 * The deepest directory both paths are at or below.
 *
 * @param left - A root-relative path
 * @param right - Another
 * @returns Their common directory, possibly `''`
 */
function commonPrefixDirectory(left: string, right: string): string {
  // eslint-disable-next-line local/no-hardcoded-path-split -- `paths:` globs are forward-slashed by the vendor's own dialect, never platform-separated
  const leftSegments = left.split('/');
  // eslint-disable-next-line local/no-hardcoded-path-split -- same: a glob's separator is the dialect's, not the platform's
  const rightSegments = right.split('/');
  const shared: string[] = [];
  for (let index = 0; index < Math.min(leftSegments.length, rightSegments.length); index += 1) {
    if (leftSegments[index] !== rightSegments[index]) break;
    shared.push(leftSegments[index] ?? '');
  }
  return shared.join('/');
}

/**
 * The rules a query at `queryDir` (optionally at `queryFile`) loads.
 *
 * @param input - The projection's rows plus the query's directory and file
 * @param input.realizations - Every realization the projection holds
 * @param input.tags - Every `resource_tags` row; rules are the {@link RULE_SCOPE_TAG} rows
 * @param input.blobs - Every blob row, for `paths:` frontmatter
 * @param input.queryDir - Root-relative directory of the query
 * @param input.queryFile - Root-relative file, or null for a directory query.
 *   Null is what makes a glob rule inexact — the exactness only holds when
 *   there is a file to test
 * @returns The selected rules and the over-budget reports
 */
export function selectRules(input: {
  readonly realizations: readonly ResourceRealizationRow[];
  readonly tags: readonly ResourceTagRow[];
  readonly blobs: readonly BlobRow[];
  readonly queryDir: string;
  readonly queryFile: string | null;
}): RuleSelectionResult {
  const scopeOf = new Map<string, RuleScope>();
  for (const row of input.tags) {
    if (row.tag === RULE_SCOPE_TAG && row.value !== null) {
      scopeOf.set(row.resourceId, row.value as RuleScope);
    }
  }
  const blobByKey = new Map(input.blobs.map((row) => [row.contentKey, row]));
  // Computed ONCE for the whole selection, not per rule: it is a function of the
  // query alone, and 116 rules rebuilding one adopter's file list is the shape of
  // cost that made the naive ∃ pass look unaffordable in the first place. Empty
  // for a file query, which never reaches ∃.
  const dirFiles = input.queryFile === null
    ? filesUnder(input.realizations, input.queryDir)
    : [];

  const rules: SelectedRule[] = [];
  const overBudget: string[] = [];
  // ⚠️ One pass per IDENTITY, not per realization row, and the cause is
  // STRUCTURAL rather than defensive. `resource_realizations` is keyed
  // `(extentId, path)`, and a rules file is itself an `@`-import root
  // (`claude-import-extent.ts`), so it is re-realized under its own closure
  // extent and under every closure that reaches it — three rows for one file is
  // ordinary. Both outputs below are functions of `scope` and `row.path` alone,
  // and those are identical across an identity's rows, so the second and third
  // visits could only ever repeat the first: three identical `nested-rule`
  // admissions (a false report — it says three predicates admitted the file when
  // one did) and three `overBudget` entries for one rule. Deduped HERE rather
  // than at the query seam, because both outputs leave through this one loop.
  const seen = new Set<string>();
  for (const row of input.realizations) {
    const scope = scopeOf.get(row.resourceId);
    if (scope === undefined || row.isDirectory || seen.has(row.resourceId)) continue;
    seen.add(row.resourceId);
    const admission = admissionFor(scope, row, { ...input, dirFiles }, blobByKey, overBudget);
    if (admission !== undefined) {
      rules.push({ resourceId: row.resourceId, path: row.path, admission });
    }
  }
  return { rules, overBudget };
}

/**
 * Every realized file in the corpus, deduplicated and path-sorted.
 *
 * The input {@link evaluateRulePatterns} needs, hoisted to its own export so a
 * caller evaluating many rules builds it ONCE. Rebuilding it per rule is the
 * shape of cost this module already refuses inside {@link selectRules}: on the
 * adopter that motivated the per-pattern lane it would be 246 walks of the same
 * realization table.
 *
 * @param realizations - Every realization the projection holds
 * @returns The sorted, deduplicated file list for the whole tree
 */
export function corpusFiles(
  realizations: readonly ResourceRealizationRow[],
): readonly string[] {
  return filesUnder(realizations, '');
}

/**
 * Every declared pattern of one rule, and whether the tree realizes it.
 *
 * **Not what {@link selectRules} answers.** {@link directoryAdmission} returns on
 * the FIRST pattern that produces a witness — correct for *is this rule in the
 * answer, and why*, and deliberately cheap — so the rule's other patterns are
 * never tested and are absent from its result. This walks all of them, and that
 * short-circuit is untouched.
 *
 * ⛔ The witness is TREE-WIDE, not query-scoped: that is the difference between
 * "matches nothing" and "matches nothing HERE", and a rule scoped to another
 * package is correctly absent from a `packages/cli/src` query without its
 * patterns being dead. {@link isAtOrBelow} makes the empty `under` the corpus
 * root, so passing `''` disables the disjoint-subtree prune and keeps the
 * sorted-range one — exactly the tree-wide walk.
 *
 * ⛔ **The vendor's budget is spent PER PATTERN**, so `unevaluated` names the
 * entries the budget actually refused — never the live siblings beside them.
 * Reporting a refused entry as `inert` would name a defect the rule does not
 * have; reporting its siblings as refused hides the ones it does.
 *
 * ⛔ **`files` holds no gitignored path, and the harness reads the filesystem**,
 * so a glob scoped to build output (`dist/**`) matches nothing here and may
 * fire there. A would-be `inert` pattern whose territory `isIgnored` says is
 * ignored is `gitignored` instead — {@link territoryIgnored} says which path is
 * asked. Only would-be `inert` patterns ask, so a healthy tree pays nothing.
 *
 * @param input - The rule's declared patterns, the tree's files, and the tree's
 *   ignore oracle
 * @param input.patterns - The rule's `paths:` entries, in declaration order
 * @param input.files - {@link corpusFiles}' output; the order is load-bearing,
 *   because {@link candidateRange} binary-searches it
 * @param input.isIgnored - Would git ignore a file at this root-relative,
 *   forward-slashed path? Required, not defaulted: a caller outside a
 *   repository passes `() => false` and says so, because an omitted oracle is
 *   exactly the false `inert` this state exists to prevent
 * @returns One evaluation per declared pattern, in declaration order
 */
export function evaluateRulePatterns(input: {
  /** The rules file's root-relative path — decides whether a second base applies. */
  readonly rulePath: string;
  readonly patterns: readonly DeclaredPattern[];
  readonly files: readonly string[];
  readonly isIgnored: (path: string) => boolean;
}): readonly RulePatternEvaluation[] {
  return compileRule(input.rulePath, input.patterns).patterns.map((compiled) => {
    const { ordinal, pattern } = compiled;
    const prefix = literalPrefix(pattern);
    // ⚠️ No file is swept on this branch. That is the claim `unevaluated`
    // makes, and a witness search here would quietly turn it into a lie the
    // reader cannot see.
    if (compiled.refused) {
      return { ordinal, pattern, literalPrefix: prefix, witnessPath: null, status: 'unevaluated' };
    }
    const witness = compiled.forms
      .map((form) => firstMatchUnder(form, '', input.files))
      .find((match) => match !== undefined);
    if (witness !== undefined) {
      return { ordinal, pattern, literalPrefix: prefix, witnessPath: witness, status: 'matched' };
    }
    const ignored = compiled.forms.some((form) => territoryIgnored(form.form, input.isIgnored));
    return {
      ordinal,
      pattern,
      literalPrefix: prefix,
      witnessPath: null,
      status: ignored ? 'gitignored' : 'inert',
    };
  });
}

/**
 * A stand-in file name beneath a glob's literal prefix — see {@link territoryIgnored}.
 *
 * Extension-less on purpose: an ignore line that names only some files
 * (`*.map`) does not make the territory ignored, and must not match the probe.
 */
const TERRITORY_PROBE = 'vat-territory-probe';

/**
 * Is the territory one matching form can reach gitignored?
 *
 * The question asked is about a path, and WHICH path is the whole decision:
 *
 * - **A wholly-literal form** names one file, so that file is asked about.
 * - **Otherwise every match lives strictly BELOW the literal prefix**, so a
 *   stand-in file beneath it is asked about — never the bare prefix. ⛔ The
 *   bare prefix is the wrong question: `.gitignore`'s `dist/` matches only a
 *   DIRECTORY, and a `dist` that has not been built is not known to be one, so
 *   git answers "not ignored" for `dist` while answering "ignored" for
 *   anything beneath it. The same holds for `gen/**`, which ignores `gen`'s
 *   contents but not `gen`.
 * - **An empty prefix** (`**\/*.gen.ts`) reaches the whole tree, and "is the
 *   root ignored" is not a question worth asking — never judged, so such a
 *   glob stays `inert` (a documented blind spot).
 *
 * A prefix that climbs out of the tree is passed through as spelled; the
 * oracle owns the root, so it is the one that answers "outside" (not ignored).
 *
 * @param form - One matching form of a `paths:` entry
 * @param isIgnored - The tree's ignore oracle
 * @returns True when a file the form could match would be gitignored
 */
function territoryIgnored(form: string, isIgnored: (path: string) => boolean): boolean {
  const prefix = literalPrefix(form);
  if (prefix === '') return false;
  const wholeForm = withoutLeadingDotSegments(form);
  return isIgnored(prefix === wholeForm ? prefix : `${prefix}/${TERRITORY_PROBE}`);
}

/**
 * The admission one rule earns, or undefined when this query does not load it.
 *
 * Split from {@link selectRules} to stay under the cognitive-complexity ceiling:
 * three scopes plus the budget guard plus the file/directory split exceed it in
 * one body.
 *
 * @param scope - The rule's `rule-scope` value
 * @param row - The rule's realization
 * @param input - The query, as {@link selectRules} received it, plus the
 *   path-sorted files under the query directory
 * @param blobByKey - `contentKey` → blob, for `paths:` frontmatter
 * @param overBudget - Collector for rules whose `paths:` list blew the budget
 * @returns The admission, or undefined
 */
function admissionFor(
  scope: RuleScope,
  row: ResourceRealizationRow,
  input: {
    readonly queryDir: string;
    readonly queryFile: string | null;
    readonly dirFiles: readonly string[];
  },
  blobByKey: ReadonlyMap<string, BlobRow>,
  overBudget: string[],
): RuleAdmission | undefined {
  if (scope === 'root') return { kind: 'root-rule' };
  if (scope === 'nested') {
    const under = nestedRuleParent(row.path);
    if (under === null) return undefined;
    return isAtOrBelow(input.queryDir, under) ? { kind: 'nested-rule', under } : undefined;
  }
  // ⛔ Explicit, not a fall-through. `scope` is cast from `resource_tags.value`,
  // and tags are an OPEN channel — a corpus can declare its own via a config
  // `resources.tags` glob (`agentic-tags.ts`'s header says so). Without this,
  // any unrecognised `rule-scope` value would be treated as path-scoped and
  // charged as a rule, and a fourth member added to `RuleScope` later would
  // silently inherit glob semantics nobody chose for it.
  if (scope !== 'path-scoped') return undefined;

  const declared = pathsFrontmatterOf(row, blobByKey);
  if (declared.length === 0) return undefined;
  const rule = compileRule(row.path, declared);
  // ⚠️ Reported, never used to DROP the rule, and that changed with the budget
  // itself: refusal is per pattern, so a list with one oversized entry still
  // has live siblings and still loads. Dropping the rule here charged the
  // adopter nothing for a rule the harness loads.
  if (rule.patterns.some((pattern) => pattern.refused)) overBudget.push(row.path);

  if (input.queryFile === null) return directoryAdmission(rule, input.queryDir, input.dirFiles);
  if (!rule.loads(input.queryFile)) return undefined;
  return { kind: 'glob-rule', pattern: namingPattern(rule, input.queryFile) };
}

/**
 * Which of a rule's patterns to NAME once the whole list has admitted a file.
 *
 * ⛔ The yes/no is the whole list's — a `!` pattern only means anything beside
 * the patterns it subtracts from — but a finding has to point at something the
 * author can grep for. The first pattern that reaches the file on its own is
 * that something; the first declared pattern is the fallback, which is reached
 * only when the admission came from an interaction no single pattern carries.
 *
 * @param rule - The compiled rule, already known to admit `path`
 * @param path - The admitted file
 * @returns The pattern to name, verbatim
 */
function namingPattern(rule: CompiledRule, path: string): string {
  const named = rule.patterns.find((pattern) => pattern.forms.some((form) => form.reaches(path)));
  return (named ?? rule.patterns[0])?.pattern ?? '';
}

/**
 * A directory query's answer for one path-scoped rule: ∀, ∃, or absent.
 *
 * ∀ is tested first and across every pattern before any ∃ work, because it is
 * the stronger claim and free — a rule that covers the directory is reported as
 * covering it even when a second pattern would also have produced a witness.
 *
 * @param rule - The rule's compiled patterns
 * @param queryDir - Root-relative directory of the query
 * @param dirFiles - Path-sorted realized files at or below `queryDir`
 * @returns The ∀ or ∃ admission, or undefined when the rule cannot fire here
 */
function directoryAdmission(
  rule: CompiledRule,
  queryDir: string,
  dirFiles: readonly string[],
): RuleAdmission | undefined {
  const covering = rule.patterns.find((pattern) => coversDirectory(pattern, queryDir));
  if (covering !== undefined) return { kind: 'glob-rule-covers-dir', pattern: covering.pattern };

  for (const pattern of rule.patterns) {
    for (const form of pattern.forms) {
      const examplePath = firstMatchUnder(form, queryDir, dirFiles);
      if (examplePath !== undefined) {
        return { kind: 'glob-rule-may-fire', pattern: pattern.pattern, examplePath };
      }
    }
  }
  return undefined;
}

/**
 * Does this one pattern match EVERY path under `queryDir`?
 *
 * ⭐ EXACT now, where it used to be a deliberately narrow guess. Gitignore
 * carries a matched DIRECTORY's whole subtree — `node-ignore`'s own `_t` returns
 * an ignored ancestor's verdict before consulting the path itself, so not even a
 * `!` can re-include underneath one — which makes *"does the matcher match the
 * query directory"* the ∀ question rather than an approximation of it. The old
 * shape-matching (`a glob-free prefix plus /**`) declined `docs` and `src/`
 * and every unanchored spelling of the same claim.
 *
 * The corpus ROOT is the one directory that cannot be asked, and
 * {@link ROOT_COVERING_GLOBS} says what is accepted there and why.
 *
 * @param pattern - One compiled `paths:` entry
 * @param queryDir - Root-relative directory of the query
 * @returns True when every path under `queryDir` matches
 */
function coversDirectory(pattern: CompiledPattern, queryDir: string): boolean {
  if (queryDir === '') return pattern.coversRoot;
  return pattern.forms.some((form) => form.reaches(`${queryDir}/`));
}

/**
 * The first realized file under `queryDir` this form matches, if any.
 *
 * The matcher is compiled ONCE, when the rule is compiled, and applied across
 * the candidate range — on a root query the difference between one compile and
 * thousands.
 *
 * @param form - One compiled form of one `paths:` entry
 * @param queryDir - Root-relative directory of the query
 * @param dirFiles - Path-sorted realized files at or below `queryDir`
 * @returns The witness path, or undefined when the form matches nothing here
 */
function firstMatchUnder(
  form: CompiledForm,
  queryDir: string,
  dirFiles: readonly string[],
): string | undefined {
  // Disjoint subtrees: the form cannot match anything under the query
  // directory, and no file is tested. This is the prune that turns the whole
  // rule corpus into the handful that can actually fire here — and an
  // unanchored form has an empty bound, so it correctly prunes nothing.
  if (!isAtOrBelow(queryDir, form.bound) && !isAtOrBelow(form.bound, queryDir)) return undefined;

  const [start, end] = candidateRange(dirFiles, form.bound, queryDir);
  for (let index = start; index < end; index += 1) {
    const file = dirFiles[index];
    if (file !== undefined && form.reaches(file)) return file;
  }
  return undefined;
}

/**
 * The literal directory prefix a pattern NAMES, read left to right.
 *
 * Segments are taken while they contain no glob metacharacter, so
 * `packages/some-pkg/src/thing*.ts` yields `packages/some-pkg/src`, and a
 * wholly literal pattern yields ITSELF — a FILE path, not a directory — because
 * `.` is not in {@link GLOB_META}.
 *
 * ⛔ This is NOT a matching bound, and calling it one is the bug FIX 1 closed.
 * Under gitignore a pattern with no slash matches at ANY depth, so
 * `literalPrefix('README.md')` is `README.md` while the pattern's real reach is
 * the whole tree. {@link matchBound} is the bound; this is the `literalPrefix`
 * COLUMN of `claude_rule_patterns` (where a reader wants the path the author
 * wrote) and the path {@link territoryIgnored} asks git about (where the
 * question is which directory on disk the glob was aimed at).
 *
 * @param pattern - One `paths:` entry
 * @returns The literal prefix, possibly empty
 */
function literalPrefix(pattern: string): string {
  // eslint-disable-next-line local/no-hardcoded-path-split -- `paths:` globs are forward-slashed by the vendor's own dialect, never platform-separated
  const segments = withoutLeadingDotSegments(pattern).split('/');
  const literal: string[] = [];
  for (const segment of segments) {
    if (GLOB_META.test(segment)) break;
    literal.push(segment);
  }
  return literal.join('/');
}

/**
 * A pattern with its leading `./` segments removed.
 *
 * ⛔ Only for LOCATING the glob's territory on disk — the `literalPrefix`
 * column and {@link territoryIgnored}'s question — never for matching. The
 * harness's matcher does NOT accept `./docs` against `docs/guide.md` (`./` is
 * not gitignore syntax; measured against the binary's own `node-ignore`), so a
 * `./`-prefixed glob is genuinely dead there and this module now reports it so.
 * Stripping it for the match would hide a real defect; stripping it here keeps
 * the territory question pointed at the directory the author meant. The
 * reported `pattern` stays the author's spelling either way.
 *
 * @param pattern - One `paths:` entry
 * @returns The same pattern without leading `./`
 */
function withoutLeadingDotSegments(pattern: string): string {
  let stripped = pattern;
  while (stripped.startsWith('./')) stripped = stripped.slice(2);
  return stripped;
}

/**
 * The slice of `dirFiles` a pattern could match, as `[start, end)`.
 *
 * `dirFiles` is already restricted to `queryDir`, so a prefix at or above it
 * bounds nothing new and the whole array is the range. A prefix BELOW it names a
 * contiguous run, because the array is sorted by code point and every string
 * beginning with `P` sorts together.
 *
 * ⛔ The bound is `P`, NOT `P/`, and the difference is a silent under-report
 * rather than a slower scan. {@link matchBound} returns the WHOLE pattern when
 * it is wholly literal — `.` is not a glob metacharacter — so `P` is then a FILE,
 * `P/` has no children by construction, `start >= end`, and the rule disappeared
 * from every directory query while the file query for that same path admitted it.
 * Bounding on `P` admits the exact-`P` entry.
 *
 * ⚠️ An UNANCHORED pattern hands an empty `prefix`, which is the whole array —
 * correct, because gitignore lets it match at any depth. Most of the prune's
 * value survives: a pattern with a slash in it is still anchored and still
 * bounds its own subtree.
 *
 * ⚠️ And the run is scanned on `P`, not `P/`, for the DIRECTORY case: `.` (0x2E)
 * sorts before `/` (0x2F), so a sibling `docs/foo.bak` lands between the bound
 * `docs/foo` and the run `docs/foo/…`. Stopping at the first entry not under
 * `docs/foo/` would stop on the sibling and lose the whole directory. Widening
 * past the sibling costs one `isMatch` call, which is the correct trade: this
 * range is only a PRUNE, and {@link firstMatchUnder}'s compiled matcher is the
 * real filter — too wide is slower, too narrow is wrong.
 *
 * @param dirFiles - Path-sorted realized files at or below the query directory
 * @param prefix - The pattern's literal prefix
 * @param queryDir - Root-relative directory of the query
 * @returns Inclusive start and exclusive end indices
 */
function candidateRange(
  dirFiles: readonly string[],
  prefix: string,
  queryDir: string,
): [number, number] {
  if (prefix === '' || isAtOrBelow(queryDir, prefix)) return [0, dirFiles.length];
  const start = lowerBound(dirFiles, prefix);
  let end = start;
  while (end < dirFiles.length && (dirFiles[end] ?? '').startsWith(prefix)) end += 1;
  return [start, end];
}

/**
 * The first index in a sorted array whose value is not less than `target`.
 *
 * @param sorted - A code-point-sorted array
 * @param target - The value to bound
 * @returns The insertion index
 */
function lowerBound(sorted: readonly string[], target: string): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((sorted[middle] ?? '') < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * Every realized file at or below `queryDir`, deduplicated and path-sorted.
 *
 * ⚠️ Deduplicated because `resource_realizations` is keyed `(extentId, path)`:
 * a file reachable from three import closures carries three rows, and testing it
 * three times would be three chances to return the same witness at triple the
 * cost. Directories are dropped — a rule's `paths:` glob names files.
 *
 * Sorted by code point rather than `localeCompare`, matching every other
 * ordering in this lane: {@link candidateRange}'s binary search depends on the
 * order, so an ICU- and locale-dependent one would make the ∃ answer differ
 * between two machines.
 *
 * @param realizations - Every realization the projection holds
 * @param queryDir - Root-relative directory of the query
 * @returns The sorted, deduplicated file list
 */
function filesUnder(
  realizations: readonly ResourceRealizationRow[],
  queryDir: string,
): string[] {
  const paths = new Set<string>();
  for (const row of realizations) {
    // A realization that does not exist is a dangling link target, and as a
    // witness it would call a dead glob matched on a file nobody can open.
    if (row.isDirectory || !row.exists || !isAtOrBelow(row.dir, queryDir)) continue;
    paths.add(row.path);
  }
  return [...paths].sort((left, right) => (left < right ? -1 : Number(left > right)));
}

/**
 * The `paths:` globs one rules file declares, read off its parsed frontmatter.
 *
 * ## ⭐ A SCALAR string is a `paths:` list, and reading only arrays lost it
 *
 * The vendor's documentation shows a YAML sequence and nothing else, so this
 * read arrays only — and a rules file carrying `paths: src/**` (the form the
 * doc's own unquoted examples decode to, and the one its issue tracker says
 * works) produced NO pattern rows, was classified as carrying no `paths:` at
 * all, and was charged to every query as always-loaded.
 *
 * The shipped harness normalises a `paths:` value through ONE function (`C`,
 * transcribed in
 * [`docs/external/claude-code-rules-paths-behaviour.md`](../../../../docs/external/claude-code-rules-paths-behaviour.md),
 * which is the clock on this claim), and it is not array-only: an ARRAY is
 * flat-mapped through the function ITSELF — so nesting recurses and
 * `paths: [["src/**"]]` is scoped — a STRING is split on commas **at brace
 * depth zero** with each part trimmed and empties dropped, and any other value
 * contributes nothing. All three halves matter: `{ts,tsx}` is one pattern, an
 * entry of a list is comma-split exactly as a bare string is, and a nested list
 * is not a non-string.
 *
 * ⛔ Exported so the PRODUCER of `claude_rule_patterns`
 * (`ClaudeRulesScopeContributor`) and this module's query lane read one
 * declaration through one function. A second reader would be free to disagree
 * about what `paths:` means, and the disagreement would surface as a stored row
 * describing a predicate the query never applies.
 *
 * ⚠️ A rule the harness reads as ALWAYS-LOADED declares no predicate, so this
 * returns nothing for one — see {@link declaresPaths} for the three shapes that
 * normalise away. Reporting a pattern there would name a glob that decides
 * nothing, and `claude context` would list the rule as on-demand while the
 * harness loads it every turn.
 *
 * @param frontmatter - The rules file's parsed frontmatter, or null
 * @returns The declared patterns in declaration order, or an empty list
 */
export function declaredPatterns(
  frontmatter: Readonly<Record<string, JsonValue>> | null | undefined,
): DeclaredPattern[] {
  if (!declaresPaths(frontmatter)) return [];
  return normalisedEntries(frontmatter?.['paths'])
    .map((pattern, ordinal) => ({ ordinal, pattern }));
}

/**
 * `C()`: one `paths:` value flattened to the harness's pattern list.
 *
 * Recursive on arrays, because the harness's own function is
 * (`e.flatMap((a)=>C(a,n))` — `C`, not a string reader), so a nested list is
 * flattened rather than discarded as a non-string.
 *
 * @param value - A `paths:` value, or any element of one
 * @returns The patterns it declares, in order
 */
function normalisedEntries(value: JsonValue | undefined): string[] {
  if (Array.isArray(value)) return value.flatMap((entry) => normalisedEntries(entry));
  return typeof value === 'string' ? commaSeparatedPatterns(value) : [];
}

/**
 * One `paths:` string, split the way the harness splits it.
 *
 * Commas at brace depth zero separate patterns; a comma inside `{…}` belongs to
 * the brace group and must not split it. Parts are trimmed, and an empty part
 * is dropped rather than becoming a pattern that matches nothing.
 *
 * ⛔ The depth counter is UNCLAMPED, and the clamp that used to stand here was
 * a divergence: the harness writes `else if(l==="}")o--`, so a stray `}` drives
 * the depth NEGATIVE and every later comma stops separating. `"a}/b,c"` is one
 * pattern there and was two here. Clamping at zero reads as defensive and is
 * the thing being modelled getting it wrong differently.
 *
 * @param entry - One `paths:` string — a whole scalar value, or one list entry
 * @returns The patterns it declares, in order
 */
function commaSeparatedPatterns(entry: string): string[] {
  const patterns: string[] = [];
  let depth = 0;
  let current = '';
  for (const character of entry) {
    if (character === ',' && depth === 0) {
      patterns.push(current);
      current = '';
      continue;
    }
    if (character === '{') depth += 1;
    else if (character === '}') depth -= 1;
    current += character;
  }
  patterns.push(current);
  return patterns.map((pattern) => pattern.trim()).filter((pattern) => pattern.length > 0);
}

/**
 * Is this rules file PATH-SCOPED — the load-class question?
 *
 * ## ⭐ The harness decides it on the NORMALISED patterns, not on the key
 *
 * The rules-file reader (`kyn`, transcribed in
 * [`docs/external/claude-code-rules-paths-behaviour.md`](../../../../docs/external/claude-code-rules-paths-behaviour.md)
 * with its re-verification clock) normalises `paths:` through the one function
 * {@link declaredPatterns} documents, **expands its brace groups**, then
 * **drops a trailing `/**` from every result**, drops what is left empty, and —
 * this is the load-class decision — returns the file with NO `paths` at all
 * when the survivors are empty or are **every one `**`**. A rule the harness
 * gives no `paths` is loaded on every turn.
 *
 * So four shapes that look path-scoped are always-loaded there:
 *
 * | `paths:` | survivors | load class |
 * |---|---|---|
 * | `["src/**"]`, `[["src/**"]]` | `src` | path-scoped |
 * | `["**"]`, `["**", "**"]` | `**` | **always-loaded** |
 * | `["/**"]`, `[""]`, `[42]`, `[[]]` | none | **always-loaded** |
 * | `["{**,**}"]`, `["{/**,/**}"]` | `**` / none | **always-loaded** |
 *
 * ⛔ The last row is why the expansion runs BEFORE the strip and not after:
 * `{**,**}` ends in `}`, survives a strip-first reader intact, and reads as a
 * pattern nobody wrote.
 *
 * ⛔ The under-report this closes is the expensive direction: charged as
 * path-scoped, a rule that actually loads every turn is missing from every
 * budget answer. VAT used to call all three path-scoped — the middle row
 * because `**` is a pattern like any other, the last because refusing to read a
 * malformed entry was held not to promote a rule. The harness disagrees, and it
 * is the thing being modelled.
 *
 * ⚠️ The strip is for THIS question only. A pattern is still reported and
 * matched verbatim, so a finding quotes what the author can grep for.
 *
 * ⛔ One reader for the predicate both lanes rest on: `ruleScopeFor` tags the
 * load class with it, and this module's query lane reads the patterns with
 * {@link declaredPatterns}. Two readers would disagree about the string form
 * exactly as they did before it was read at all.
 *
 * @param frontmatter - The rules file's parsed frontmatter, or null
 * @returns True when the harness would scope this rule by its patterns
 */
export function declaresPaths(
  frontmatter: Readonly<Record<string, JsonValue>> | null | undefined,
): boolean {
  const survivors = harnessSurvivors(frontmatter);
  return survivors.length > 0 && !survivors.every((pattern) => pattern === '**');
}

/**
 * What the harness is left holding after it normalises one `paths:` value.
 *
 * ⛔ The SAME globs the matcher is built from — {@link harnessExpansion} — not
 * a second normalisation beside it. A load class decided on one string form
 * while the matching is done on another is the two-contracts-for-one-thing
 * shape, and it is what let `{**,**}` read as scoped here and always-loaded
 * there.
 *
 * @param frontmatter - The rules file's parsed frontmatter, or null
 * @returns The surviving patterns, in declaration order
 */
function harnessSurvivors(
  frontmatter: Readonly<Record<string, JsonValue>> | null | undefined,
): string[] {
  return harnessExpansion(normalisedEntries(frontmatter?.['paths']))
    .flatMap((expanded) => expanded.globs);
}

/**
 * One readable `paths:` entry and its index among the rule's PATTERNS.
 *
 * ## ⛔ `ordinal` is the pattern index, and deliberately NOT `paths[N]`
 *
 * It used to promise both, and the two stopped agreeing the moment a `paths:`
 * string became a pattern LIST: `['a/**, b/**', 'c/**']` declares three
 * patterns at author slots 0, 0 and 1, and a scalar `paths: "a/**, b/**"` has
 * no YAML list at all, so `paths[1]` names nothing anybody can grep for. A
 * finding built on the author-slot reading pointed at the wrong glob for the
 * first shape and at a non-existent one for the second.
 *
 * One contract, and it is the dense pattern index: it keys
 * `claude_rule_patterns` (`(resourceId, ordinal)`), it is stable under the
 * comma split, and it is what orders a rule's rows. A finding that needs to
 * name something the author can find quotes the PATTERN, which is carried
 * verbatim beside it for exactly that reason.
 */
export interface DeclaredPattern {
  /** The zero-based index among the rule's declared patterns, after the comma split. */
  readonly ordinal: number;
  /** The pattern exactly as declared — never normalised. */
  readonly pattern: string;
}

/**
 * A rule's `paths:` list, or empty when it has none or it normalises away.
 *
 * @param row - The rule's realization
 * @param blobByKey - `contentKey` → blob
 * @returns The declared patterns, or an empty list
 */
function pathsFrontmatterOf(
  row: ResourceRealizationRow,
  blobByKey: ReadonlyMap<string, BlobRow>,
): DeclaredPattern[] {
  if (row.contentKey === null) return [];
  return declaredPatterns(blobByKey.get(row.contentKey)?.frontmatter);
}

/**
 * ⛔ The base a NESTED rules file's globs resolve against — a recorded ASSUMPTION.
 *
 * The vendor resolves a rules glob against the directory that owns the
 * `.claude/` it was read from, and the lane VAT models reads only the project
 * root's rules directory. VAT classifies a second `.claude/rules/` further down
 * the tree as a rule anyway, and swept only against the repository root a
 * fixture project's `src/**` was called dead beside its own `src/index.ts`: a
 * false CLAUDE_RULE_GLOB_INERT whose remedy deletes a working glob. So a nested
 * rule's globs are compiled under BOTH bases ({@link compilePattern}) and
 * "dead" means dead under both. A rule in the project's own rules directory has
 * one base and is never re-based. Recorded as the `nested-rule-glob-base`
 * assumption.
 *
 * Under gitignore semantics the re-base matters less than it did — an
 * unanchored glob already matches at any depth — but an anchored multi-segment
 * one (`src/lib/**`) still needs it.
 */

/**
 * The directory a nested rules file is scoped to — its `.claude/rules` parent.
 *
 * @param path - Root-relative path of the rule
 * @returns The scoping directory, or null when the path is not nested
 */
export function nestedRuleParent(path: string): string | null {
  const index = path.indexOf(RULES_SEGMENT);
  return index <= 0 ? null : path.slice(0, index);
}

/**
 * Is `queryDir` the directory `under`, or somewhere below it?
 *
 * ⚠️ An EMPTY `under` is the corpus ROOT, and everything is at or below it. The
 * nested-rule caller can never produce one — `nestedRuleParent` returns null
 * rather than `''` — so this branch exists for the ∃/∀ callers, where the root is
 * an ordinary query directory (`vat claude context .` at the top of a repo) and a
 * literal-free pattern has an empty prefix. Without it a root query enumerated
 * zero candidate files and every path-scoped rule silently vanished from the
 * answer: a confident empty, which is the one answer shape this lane refuses.
 *
 * @param queryDir - Root-relative directory of the query
 * @param under - Root-relative scoping directory, or `''` for the corpus root
 * @returns True when the query is in scope
 */
function isAtOrBelow(queryDir: string, under: string): boolean {
  if (under === '') return true;
  // eslint-disable-next-line local/no-path-startswith -- `resource_realizations.path`-derived directories are forward-slashed and root-relative by `relativize()` before any consumer sees it, which is the precondition this rule enforces
  return queryDir === under || queryDir.startsWith(`${under}/`);
}
