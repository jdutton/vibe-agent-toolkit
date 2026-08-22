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
 * | `path-scoped` | on demand, "may fire here" — a directory query is not exact | on demand, admitted iff a glob matches |
 *
 * ⛔ A path-scoped rule is ON DEMAND in BOTH columns. The vendor's on-demand
 * class is *"rules that load on demand, including path-scoped rules and rules in
 * nested `.claude/rules/` directories"* — both halves, not just the nested one.
 * A matching glob decides whether the rule is in the answer, never that it is
 * loaded at launch; `claude-context-query.ts`'s `baseLoadClass` is where that is
 * enforced and says so at length.
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
import type {
  ResourceRealizationRow,
  ResourceTagRow,
} from '../schemas/projection-resources.js';

import { RULE_SCOPE_TAG, type RuleScope } from './contributors/claude-rules-scope.js';

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

/** Why one rule is in the answer. */
export type RuleAdmission =
  | { readonly kind: 'root-rule' }
  | { readonly kind: 'nested-rule'; readonly under: string }
  | { readonly kind: 'glob-rule'; readonly pattern: string }
  | { readonly kind: 'glob-rule-may-fire' };

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
  let total = 0;
  for (const pattern of patterns) {
    let product = 1;
    for (const group of pattern.matchAll(/\{([^{}]*)\}/g)) {
      product *= (group[1] ?? '').split(',').length;
    }
    total += product;
  }
  return total;
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
    const admission = admissionFor(scope, row, input, blobByKey, overBudget);
    if (admission !== undefined) {
      rules.push({ resourceId: row.resourceId, path: row.path, admission });
    }
  }
  return { rules, overBudget };
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
 * @param input - The query, as {@link selectRules} received it
 * @param blobByKey - `contentKey` → blob, for `paths:` frontmatter
 * @param overBudget - Collector for rules whose `paths:` list blew the budget
 * @returns The admission, or undefined
 */
function admissionFor(
  scope: RuleScope,
  row: ResourceRealizationRow,
  input: { readonly queryDir: string; readonly queryFile: string | null },
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

  if (input.queryFile === null) return { kind: 'glob-rule-may-fire' };

  const patterns = pathsFrontmatterOf(row, blobByKey);
  if (patterns.length === 0) return undefined;
  if (
    expandedPatternCount(patterns) > EXPANDED_PATTERN_BUDGET
    || patterns.reduce((sum, pattern) => sum + pattern.length, 0) > PATTERN_BYTE_BUDGET
  ) {
    // The documented over-budget behaviour: the pattern is used UNEXPANDED and
    // its literal braces match no files. Reported, because a rule that silently
    // stopped matching is exactly the case a budget check is worth having for.
    overBudget.push(row.path);
    return undefined;
  }
  const matched = patterns.find((pattern) => picomatch.isMatch(input.queryFile ?? '', pattern, { dot: true }));
  return matched === undefined ? undefined : { kind: 'glob-rule', pattern: matched };
}

/**
 * A rule's `paths:` list, or empty when it has none or it is not a string array.
 *
 * A `paths:` that is not an array of strings is not a narrower predicate — it is
 * an unreadable one, and treating it as "matches everything" would charge a rule
 * the harness cannot run.
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
  const value = blobByKey.get(row.contentKey)?.frontmatter?.['paths'];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
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
 * @param queryDir - Root-relative directory of the query
 * @param under - Root-relative scoping directory
 * @returns True when the query is in scope
 */
function isAtOrBelow(queryDir: string, under: string): boolean {
  // eslint-disable-next-line local/no-path-startswith -- `resource_realizations.path`-derived directories are forward-slashed and root-relative by `relativize()` before any consumer sees it, which is the precondition this rule enforces
  return queryDir === under || queryDir.startsWith(`${under}/`);
}
