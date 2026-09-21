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
 *   enumerated to decide it. {@link coversDirectory} is deliberately narrow —
 *   a glob-free literal prefix plus `/**` — because a false ∀ would overstate a
 *   cost, and everything it declines still gets the ∃ test below.
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
 * 1. A pattern's LITERAL PREFIX bounds the subtree it can possibly match. When
 *    that prefix and the query directory are disjoint the pattern is skipped
 *    without testing one file — which on that adopter is most of the rule corpus
 *    for most directories, and is why the constant was so much larger than any
 *    real answer.
 * 2. When the prefix is BELOW the query directory, only files under the prefix
 *    are tested, found by binary search over a path-sorted array
 *    ({@link candidateRange}). A root query against a deep pattern scans that
 *    pattern's own subtree, not the tree.
 *
 * Matchers are compiled once per pattern and reused across files.
 * `picomatch.isMatch` recompiles on every call, so the file-query path can use it
 * on its single path and this one must not.
 *
 * ⚠️ The `nested` trigger is the directional analogue of the vendor's
 * subdirectory-`CLAUDE.md` rule and is NOT documented. The vendor says only that
 * nested rules directories are in the on-demand class. Recorded as an assumption
 * in `claude-context-limits.ts`, and never counted into an always-loaded total.
 *
 * ## ⚠️ picomatch is not the harness's matcher
 *
 * The harness shares one budget of **1,000 expanded patterns and 4 MiB** across a
 * rule's whole `paths` list, and *"uses any pattern that would exceed the budget
 * unexpanded, and its literal braces match no files."* picomatch expands
 * unconditionally. Reimplementing the versioned budget algorithm and getting it
 * half right would be worse than declaring the divergence, so this implements the
 * BUDGET CHECK ONLY: over budget, the rule's patterns are treated as literals —
 * which is the documented behaviour — and the rule is reported in `overBudget`.
 * The malformed-`[` divergence is a stated bound, not a guard.
 *
 * `dot: true` is an ASSUMPTION. Anthropic documents nothing about dotfile
 * matching in `paths:`. It is kept because adopter paths traverse `.claude/`, and
 * it is recorded as an assumption rather than cited.
 */

import picomatch from 'picomatch';

import type { BlobRow } from '../schemas/projection-blobs.js';
import type { ClaudeRulePatternStatus } from '../schemas/projection-claude-rules.js';
import type {
  ResourceRealizationRow,
  ResourceTagRow,
} from '../schemas/projection-resources.js';
import type { JsonValue } from '../schemas/projection-shared.js';

import { RULE_SCOPE_TAG, type RuleScope } from './agentic-tags.js';

/**
 * The vendor's shared expansion budget for one rule's whole `paths` list.
 *
 * *"a rule's whole `paths` list shares one budget of 1,000 expanded patterns and
 * 4 MiB."* Not a VAT constant with a version to bump — a transcribed vendor
 * quantity, cited at its use.
 */
const EXPANDED_PATTERN_BUDGET = 1000;

/** The other half of the same vendor budget, in bytes. */
const PATTERN_BYTE_BUDGET = 4 * 1024 * 1024;

/** The `.claude/rules` segment a nested rules directory hangs below. */
const RULES_SEGMENT = '/.claude/rules/';

/**
 * The pattern tails that make a glob-free prefix universal over its subtree.
 *
 * ⚠️ The ORDER DOES NOT MATTER, and the comment that used to stand here said it
 * did: *"longest first, because `/**\/*` also ends with `/*`."* `/*` is not a
 * member of this list, and no string ends with both `/**\/*` and `/**`, so the
 * two are mutually exclusive and `find` returns the same tail either way —
 * mutation-verified by reversing the array, which left every test green. Kept in
 * this order only because it reads as most-specific-first; there is no
 * longest-first discipline being observed here, and a reader should not go
 * looking for the overlap the old comment invented.
 */
const UNIVERSAL_TAILS = ['/**/*', '/**'] as const;

/**
 * The two whole-tree patterns, which cover every directory including the root.
 *
 * Separate from {@link UNIVERSAL_TAILS} because they have no prefix to test:
 * there is no directory they do not cover.
 */
const UNIVERSAL_PATTERNS = new Set(['**', '**/*']);

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
 * How many patterns the harness would expand this `paths` list to.
 *
 * Brace groups multiply, so the count is the product of each pattern's group
 * cardinalities, summed across the list. Deliberately arithmetic rather than an
 * actual expansion: the number is all the budget check needs, and materialising
 * 14,641 strings to count them is the cost the check exists to avoid.
 *
 * @param patterns - The rule's `paths:` entries
 * @returns The expanded pattern count the shared budget is measured against
 */
export function expandedPatternCount(patterns: readonly string[]): number {
  return patterns.reduce((total, pattern) => total + expansionsOf(pattern), 0);
}

/**
 * How many strings one pattern's braces expand to.
 *
 * ⛔ A real grammar, not a comma count, and both halves of that were live
 * under-counts: a RANGE (`{1..5000}`) has no comma and scored 1, and an
 * innermost-group scan scored `{x,y}{a,{b,c}}` as 4 when it expands to 6. An
 * under-count is the dangerous direction — the list reads as inside the budget,
 * the matcher runs, and a row the harness would never have evaluated is reported
 * `matched` or `inert` instead of `unevaluated`.
 *
 * The first top-level group is split on its top-level commas; each alternative is
 * counted recursively and the sum multiplies the count of everything after the
 * group. A group with no top-level comma is a range when it parses as one, and
 * otherwise literal text.
 *
 * @param pattern - One `paths:` entry
 * @returns Its expansion count, never less than 1
 */
function expansionsOf(pattern: string): number {
  const open = pattern.indexOf('{');
  if (open === -1) return 1;
  const close = matchingBrace(pattern, open);
  if (close === -1) return 1;
  const rest = expansionsOf(pattern.slice(close + 1));
  const alternatives = topLevelAlternatives(pattern.slice(open + 1, close));
  if (alternatives.length === 1) return rangeSize(alternatives[0] ?? '') * rest;
  return alternatives.reduce((sum, alternative) => sum + expansionsOf(alternative), 0) * rest;
}

/**
 * The index of the `}` closing the `{` at `open`, or -1 when it is unclosed.
 *
 * @param text - The pattern
 * @param open - Index of a `{`
 * @returns The matching close index, or -1
 */
function matchingBrace(text: string, open: number): number {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === '{') depth += 1;
    else if (text[index] === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/**
 * A group body split on the commas that are not inside a nested group.
 *
 * @param body - The text between a group's braces
 * @returns Its alternatives, in order
 */
function topLevelAlternatives(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === '{') depth += 1;
    else if (char === '}') depth -= 1;
    else if (char === ',' && depth === 0) {
      parts.push(body.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
}

/**
 * The size of a comma-free group: a numeric or single-character range, or 1.
 *
 * @param body - The group body
 * @returns How many strings the group expands to
 */
function rangeSize(body: string): number {
  // `from..to` or `from..to..step`, where the ends are integers or one
  // character. Split rather than matched whole: the one-pattern form backtracks.
  const [from = '', to = '', step, ...rest] = body.split('..');
  const isEnd = (end: string): boolean => NUMBER.test(end) || (end.length === 1 && !NOT_A_CHAR_END.test(end));
  if (rest.length > 0 || !isEnd(from) || !isEnd(to) || (step !== undefined && !NUMBER.test(step))) return 1;
  const numeric = NUMBER.test(from) && NUMBER.test(to);
  const first = numeric ? Number(from) : from.codePointAt(0) ?? 0;
  const last = numeric ? Number(to) : to.codePointAt(0) ?? 0;
  const stride = Math.abs(Number(step ?? 1)) || 1;
  return Math.floor(Math.abs(last - first) / stride) + 1;
}

/** An optionally signed integer. */
const NUMBER = /^-?\d+$/;

/** A single character that cannot be a character-range end: a digit or a dot. */
const NOT_A_CHAR_END = /[\d.]/;

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
 * ⛔ **The vendor's 1,000-pattern / 4 MiB budget is spent by the whole `paths:`
 * list at once**, so one oversized entry makes EVERY pattern in the list
 * `unevaluated`. Reporting those as `inert` would name a defect the rule does
 * not have and hide the one it does.
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
  const refused = isOverBudget(input.patterns.map((entry) => entry.pattern));
  return input.patterns.map(({ ordinal, pattern }) => {
    const prefix = literalPrefix(pattern);
    // ⚠️ No matcher is compiled and no file is read on this branch. That is the
    // claim `unevaluated` makes, and a `firstMatchUnder` call here would quietly
    // turn it into a lie the reader cannot see.
    if (refused) {
      return { ordinal, pattern, literalPrefix: prefix, witnessPath: null, status: 'unevaluated' };
    }
    const forms = matchingForms(input.rulePath, pattern);
    const witness = forms
      .map((form) => firstMatchUnder(form, '', input.files))
      .find((match) => match !== undefined);
    if (witness !== undefined) {
      return { ordinal, pattern, literalPrefix: prefix, witnessPath: witness, status: 'matched' };
    }
    const ignored = forms.some((form) => territoryIgnored(form, input.isIgnored));
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

  const patterns = pathsFrontmatterOf(row, blobByKey);
  if (patterns.length === 0) return undefined;
  // ⚠️ NOW BEFORE the file/directory split, where it used to sit after it. A
  // directory query never reached this check while it answered "may fire" for
  // everything, which is what the retired `directory-budget-unchecked` limit
  // recorded: a rule the harness would refuse to expand was indistinguishable
  // from one that matched cleanly, and its over-budget list was always empty.
  // Both query shapes read the same `paths:` list, so both owe the same check.
  if (isOverBudget(patterns)) {
    // The documented over-budget behaviour: the pattern is used UNEXPANDED and
    // its literal braces match no files. Reported, because a rule that silently
    // stopped matching is exactly the case a budget check is worth having for.
    overBudget.push(row.path);
    return undefined;
  }

  const forms = patterns.flatMap((pattern) => matchingForms(row.path, pattern));
  if (input.queryFile === null) return directoryAdmission(forms, input.queryDir, input.dirFiles);

  const matched = forms.find((pattern) => picomatch.isMatch(input.queryFile ?? '', pattern, { dot: true }));
  return matched === undefined ? undefined : { kind: 'glob-rule', pattern: matched };
}

/**
 * Has this `paths:` list blown either half of the vendor's shared budget?
 *
 * @param patterns - The rule's `paths:` entries
 * @returns True when the harness would use the patterns unexpanded
 */
function isOverBudget(patterns: readonly string[]): boolean {
  return expandedPatternCount(patterns) > EXPANDED_PATTERN_BUDGET
    || patterns.reduce((sum, pattern) => sum + pattern.length, 0) > PATTERN_BYTE_BUDGET;
}

/**
 * A directory query's answer for one path-scoped rule: ∀, ∃, or absent.
 *
 * ∀ is tested first and across every pattern before any ∃ work, because it is
 * the stronger claim and free — a rule that covers the directory is reported as
 * covering it even when a second pattern would also have produced a witness.
 *
 * @param patterns - The rule's `paths:` entries, already inside the budget
 * @param queryDir - Root-relative directory of the query
 * @param dirFiles - Path-sorted realized files at or below `queryDir`
 * @returns The ∀ or ∃ admission, or undefined when the rule cannot fire here
 */
function directoryAdmission(
  patterns: readonly string[],
  queryDir: string,
  dirFiles: readonly string[],
): RuleAdmission | undefined {
  const covering = patterns.find((pattern) => coversDirectory(pattern, queryDir));
  if (covering !== undefined) return { kind: 'glob-rule-covers-dir', pattern: covering };

  for (const pattern of patterns) {
    const examplePath = firstMatchUnder(pattern, queryDir, dirFiles);
    if (examplePath !== undefined) return { kind: 'glob-rule-may-fire', pattern, examplePath };
  }
  return undefined;
}

/**
 * Does this one pattern match EVERY path under `queryDir`?
 *
 * ⛔ Deliberately narrow, and the narrowness is the safety property. Only a
 * glob-free literal prefix followed by `/**` (or `/**\/*`) qualifies, plus the
 * two whole-tree patterns. `docs/**\/*.md` is declined though it covers every
 * markdown file, because it does not cover every FILE; `packages/*\/README.md` is
 * declined because its prefix is not literal. Everything declined here still
 * reaches the ∃ test, so a false negative costs precision and a false positive
 * would state a burden the adopter does not carry — the asymmetry decides it.
 *
 * @param pattern - One `paths:` entry
 * @param queryDir - Root-relative directory of the query
 * @returns True when every path under `queryDir` matches
 */
function coversDirectory(declared: string, queryDir: string): boolean {
  const pattern = withoutLeadingDotSegments(declared);
  if (UNIVERSAL_PATTERNS.has(pattern)) return true;
  const tail = UNIVERSAL_TAILS.find((candidate) => pattern.endsWith(candidate));
  if (tail === undefined) return false;
  const prefix = pattern.slice(0, -tail.length);
  // An empty prefix here means a leading-slash pattern (`/**`), which is not the
  // root-relative shape every other path in this projection uses. Declined rather
  // than normalised: guessing what an author meant by it would be a dialect.
  if (prefix === '' || GLOB_META.test(prefix)) return false;
  return isAtOrBelow(queryDir, prefix);
}

/**
 * The first realized file under `queryDir` this pattern matches, if any.
 *
 * The matcher is compiled ONCE and applied across the candidate range;
 * `picomatch.isMatch` would recompile per file, which on a root query is the
 * difference between one compile and thousands.
 *
 * @param pattern - One `paths:` entry
 * @param queryDir - Root-relative directory of the query
 * @param dirFiles - Path-sorted realized files at or below `queryDir`
 * @returns The witness path, or undefined when the pattern matches nothing here
 */
function firstMatchUnder(
  pattern: string,
  queryDir: string,
  dirFiles: readonly string[],
): string | undefined {
  const prefix = literalPrefix(pattern);
  // Disjoint subtrees: the pattern cannot match anything under the query
  // directory, and no file is tested. This is the prune that turns the whole
  // rule corpus into the handful that can actually fire here.
  if (!isAtOrBelow(queryDir, prefix) && !isAtOrBelow(prefix, queryDir)) return undefined;

  const [start, end] = candidateRange(dirFiles, prefix, queryDir);
  if (start >= end) return undefined;
  const isMatch = picomatch(pattern, { dot: true });
  for (let index = start; index < end; index += 1) {
    const file = dirFiles[index];
    if (file !== undefined && isMatch(file)) return file;
  }
  return undefined;
}

/**
 * The literal directory prefix a pattern's matches must all live under.
 *
 * Segments are taken while they contain no glob metacharacter, so
 * `packages/some-pkg/src/thing*.ts` yields `packages/some-pkg/src`.
 *
 * ⛔ A wholly literal pattern yields ITSELF — a FILE path, not a directory —
 * because `.` is not in {@link GLOB_META}, and that is NOT harmless. This comment
 * used to claim it was, on the grounds that the prefix "is used only for
 * at-or-below tests"; it is not. {@link candidateRange} also uses it as a STRING
 * BOUND over the sorted file list, and a bound of `prefix + '/'` asked for the
 * children of a file — none exist, so every wholly-literal `paths:` entry was
 * silently dropped from every directory query. Callers must treat the return
 * value as "the longest path all matches live at or below", which a file
 * satisfies only inclusively.
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
 * ⛔ Only for the PRUNE. The compiled matcher accepts `./docs/**` against
 * `docs/guide.md`, but `.` is not a glob metacharacter, so the literal prefix
 * came back as `./docs` — a string no root-relative path starts with. The
 * candidate range was then empty on every tree, and a live glob was reported
 * `inert` by the default-on check while the file query for the same path
 * admitted the rule. Stripped here and nowhere else: the reported `pattern`
 * stays the author's spelling.
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
 * rather than a slower scan. {@link literalPrefix} returns the WHOLE pattern when
 * it is wholly literal — `.` is not a glob metacharacter — so `P` is then a FILE,
 * `P/` has no children by construction, `start >= end`, and the rule disappeared
 * from every directory query while the file query for that same path admitted it.
 * Bounding on `P` admits the exact-`P` entry.
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
 * A `paths:` that is not an array of strings is not a narrower predicate — it is
 * an unreadable one, and treating it as "matches everything" would charge a rule
 * the harness cannot run. Non-string entries are dropped for the same reason,
 * one entry at a time.
 *
 * ⛔ Exported so the PRODUCER of `claude_rule_patterns`
 * (`ClaudeRulesScopeContributor`) and this module's query lane read one
 * declaration through one function. A second reader would be free to disagree
 * about what `paths:` means, and the disagreement would surface as a stored row
 * describing a predicate the query never applies.
 *
 * ⚠️ NOT the same question as {@link ruleScopeFor}'s, which asks only whether a
 * `paths:` key holds a non-empty array. A rule declaring `paths: [42]` is
 * therefore `path-scoped` with zero patterns: classified as on-demand, and with
 * nothing to evaluate. Deliberate — the scope is the load class, and refusing to
 * read a malformed entry must not promote a rule to always-loaded.
 *
 * @param frontmatter - The rules file's parsed frontmatter, or null
 * @returns The declared patterns in declaration order, or an empty list
 */
export function declaredPatterns(
  frontmatter: Readonly<Record<string, JsonValue>> | null | undefined,
): DeclaredPattern[] {
  const value = frontmatter?.['paths'];
  if (!Array.isArray(value)) return [];
  const declared: DeclaredPattern[] = [];
  for (const [ordinal, pattern] of value.entries()) {
    if (typeof pattern === 'string') declared.push({ ordinal, pattern });
  }
  return declared;
}

/**
 * One readable `paths:` entry and its index in the AUTHOR'S list.
 *
 * ⛔ The index is taken before anything is dropped. Numbered afterwards, a blank
 * YAML item ahead of a dead glob shifted every later ordinal, and the finding's
 * `paths[N]` named the healthy glob beside the one to delete.
 */
export interface DeclaredPattern {
  readonly ordinal: number;
  readonly pattern: string;
}

/**
 * A rule's `paths:` list, or empty when it has none or it is not a string array.
 *
 * @param row - The rule's realization
 * @param blobByKey - `contentKey` → blob
 * @returns The declared patterns, or an empty list
 */
function pathsFrontmatterOf(
  row: ResourceRealizationRow,
  blobByKey: ReadonlyMap<string, BlobRow>,
): string[] {
  if (row.contentKey === null) return [];
  return declaredPatterns(blobByKey.get(row.contentKey)?.frontmatter).map((entry) => entry.pattern);
}

/**
 * Every root-relative form a rule's `paths:` glob may take.
 *
 * ⛔ The vendor does not say which base a NESTED rules file's globs resolve
 * against — the repository root the session runs in, or the project directory
 * the second `.claude/` belongs to. Swept only against the root, a fixture
 * project's `src/**` was called dead beside its own `src/index.ts`: a false
 * CLAUDE_RULE_GLOB_INERT whose remedy deletes a working glob. So a nested rule's
 * glob is tried under BOTH bases, and "dead" means dead under both. A rule in the
 * project's own rules directory has one base and is never re-based. Recorded as
 * the `nested-rule-glob-base` assumption.
 *
 * Both lanes call this — the per-pattern sweep and the query — so the check can
 * never call a glob live while `claude context` leaves its rule out.
 *
 * @param rulePath - Root-relative path of the rules file
 * @param pattern - One declared `paths:` entry
 * @returns The root-relative form, then the re-based one when the rule is nested
 */
function matchingForms(rulePath: string, pattern: string): string[] {
  const base = nestedRuleParent(rulePath);
  return base === null ? [pattern] : [pattern, `${base}/${withoutLeadingDotSegments(pattern)}`];
}

/**
 * The directory a nested rules file is scoped to — its `.claude/rules` parent.
 *
 * @param path - Root-relative path of the rule
 * @returns The scoping directory, or null when the path is not nested
 */
function nestedRuleParent(path: string): string | null {
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
