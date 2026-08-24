/**
 * The always-loaded context budget sweep, rendered as validation findings.
 *
 * Pure: no I/O, no config, no severity resolution, no exit code. It takes the
 * {@link BudgetSweep} `@vibe-agent-toolkit/resources` produced and answers
 * "which of these does a reader need to be told about, and in what words". The
 * command that calls it stays a thin orchestrator, and this file is where the
 * decision worth testing lives.
 *
 * ## ONE issue per REPRESENTATIVE, never one per working location
 *
 * A sweep reports every working location, and locations sharing an instruction
 * chain share one budget — that is the whole point of the collapse. Re-measured
 * on VAT's own tree 2026-08-23, after the context population began declining the
 * gitignored half: **366 of 589 directories** pay the single chain
 * `['CLAUDE.md']`, so emitting per location would print 366 byte-identical
 * findings, all blaming one file, the moment the root `CLAUDE.md` crossed the
 * budget. (It read *"553 of 819"* against the wider population; the ratio barely
 * moved, and the argument does not turn on it.) There are **9** distinct chains
 * on this tree either way, so per-representative emission caps the output at 9
 * findings at any threshold.
 *
 * That is not a formatting preference. A check that emits 366 findings for one
 * cause is a check an adopter silences with
 * `severity.ALWAYS_LOADED_CONTEXT_BUDGET: ignore` rather than fixes — and a
 * silenced check reports nothing forever, which is strictly worse than the
 * finding it was trying to deliver.
 *
 * ## What the message may and may not claim
 *
 * ⛔ Never "the total cost". A global `~/.claude/CLAUDE.md` and the enabled skill
 * index are real always-loaded cost that this TREE-ONLY projection cannot see, so
 * even a budget reporting zero exclusions is a floor — see the module doc of
 * `packages/resources/src/projection/claude-context-budget.ts`, which states the
 * bound precisely and which this wording must not contradict. The messages here
 * therefore say "estimated at", and the narrower, checkable claim carried by
 * {@link AlwaysLoadedBudget.lowerBound} — that rows VAT *did* see were left out
 * of the sum — is appended as its own sentence with the three counts behind it.
 *
 * 🔑 `excludedRuleRows` is deliberately NOT one of those counts. What it counts is
 * PATH-SCOPED rules — the ones carrying a `paths:` list — and those are excluded
 * by DESIGN: they are `selected`, not `always`, so their absence from the sum is a
 * decision rather than a gap in what we know, and only ignorance makes a sum a
 * lower bound.
 *
 * ⛔ Not "rules files" as a class. An UNSCOPED rule in the root `.claude/rules/`
 * is classed `always` and IS charged into the budget — nothing gates it on a path,
 * so it loads at launch exactly as a CLAUDE.md does. The blanket reading was true
 * while every rule was excluded and became a false statement about a check that
 * gates the moment the root-rule admission started qualifying. It matters here
 * because the largest contributor a message names may now be a rules file, which
 * is why the registry `fix` points at the named contributors rather than at a file
 * type.
 */

import type { BudgetSweep, AlwaysLoadedBudget } from '@vibe-agent-toolkit/resources';
import { createRegistryIssue, type ValidationIssue } from '@vibe-agent-toolkit/schema';
import { toForwardSlash } from '@vibe-agent-toolkit/utils';

/**
 * How many contributors a message names before it starts counting them.
 *
 * The chain can be five files deep and the message is read in a terminal, beside
 * every other finding of the run. Three names the files worth opening; the tail
 * is a count so nothing is silently dropped.
 */
const MAX_NAMED_CONTRIBUTORS = 3;

/** A sweep narrowed to the paths a caller asked about, and what did not match. */
export interface ScopedSweep {
  /**
   * The narrowed sweep.
   *
   * ⚠️ It retains EVERY location of every selected chain, not only the ones
   * inside the scope — see {@link scopeSweepToPaths} for why that is the whole
   * point rather than an oversight.
   */
  readonly sweep: BudgetSweep;
  /**
   * Requested paths that named no working location in this sweep.
   *
   * ⛔ Reported rather than dropped. A scope that matched nothing produces zero
   * findings, which is byte-identical to "everything you asked about is within
   * budget" — the one confusion this field exists to prevent.
   */
  readonly unmatchedScope: readonly string[];
}

/**
 * Narrow a sweep to the instruction chains the requested paths inherit.
 *
 * ## The retention rule, which is the whole design
 *
 * A scope selects CHAINS, never payers. Every location paying a selected chain
 * is retained even when it sits outside the scope, because the finding's message
 * says how many working locations pay it — and that number is a fact about the
 * TREE. Retaining only the in-scope payers would make `vat claude budget
 * docs/guides` report *"1 working location pays it"* for a chain 366 directories
 * pay: a confidently wrong number, which costs more than no number.
 *
 * ## Matching is on SEGMENT boundaries
 *
 * `'packages/cli-x'.startsWith('packages/cli')` is true, so a bare prefix test
 * hands a sibling directory its neighbour's scope. The same trap
 * `representativeFor` in `claude-context-budget-sweep.ts` exists to avoid, one
 * layer down.
 *
 * @param sweep - Every working location's budget, from `sweepAlwaysLoadedBudgets`
 * @param scope - Root-relative directories to report for. `''` is the corpus
 *   root and selects the whole tree; an empty list selects nothing
 * @returns The narrowed sweep and the requested paths that matched no location
 */
export function scopeSweepToPaths(sweep: BudgetSweep, scope: readonly string[]): ScopedSweep {
  const selected = new Set<string>();
  const unmatched: string[] = [];
  for (const target of scope) {
    const matched = sweep.locations.filter((location) => coversDirectory(target, location.directory));
    if (matched.length === 0) {
      unmatched.push(target);
      continue;
    }
    for (const location of matched) selected.add(location.representative);
  }
  return {
    // Counters are carried through untouched: they describe the SWEEP, and a
    // scope narrows what is reported without changing what was measured.
    sweep: {
      ...sweep,
      locations: sweep.locations.filter((location) => selected.has(location.representative)),
    },
    unmatchedScope: unmatched,
  };
}

/**
 * Does a requested directory cover another one — itself included?
 *
 * @param target - The requested root-relative directory; `''` is the corpus root
 * @param directory - A working location
 * @returns True when `target` is `directory` or one of its ancestors
 */
function coversDirectory(target: string, directory: string): boolean {
  if (target === '') return true;
  // Both sides are already forward-slashed — the projection's `dir` column and
  // `safePath.relative`'s output both are — but normalizing anyway is what keeps
  // a Windows-separator string from silently matching nothing here.
  const normalizedScope = toForwardSlash(target);
  const normalizedLocation = toForwardSlash(directory);
  return normalizedLocation === normalizedScope
    || normalizedLocation.startsWith(`${normalizedScope}/`);
}

/** One representative's budget, and how many working locations borrow it. */
interface RepresentativeGroup {
  readonly representative: string;
  readonly budget: AlwaysLoadedBudget;
  /** Working locations in this sweep whose chain this representative sets. */
  locations: number;
}

/**
 * One finding per over-budget instruction chain, ordered for a clean diff.
 *
 * @param sweep - Every working location's budget, from `sweepAlwaysLoadedBudgets`
 * @returns The issues, ascending by representative directory (code point)
 */
export function contextBudgetIssues(sweep: BudgetSweep): ValidationIssue[] {
  return [...groupByRepresentative(sweep).values()]
    .filter((group) => group.budget.overBudget)
    .sort((left, right) => comparePaths(left.representative, right.representative))
    .map(issueFor);
}

/**
 * Collapse the sweep's locations onto the representatives that produced them.
 *
 * Every location in a group carries the SAME `budget` object — the sweep memoizes
 * one answer per representative — so the first one seen is the group's budget and
 * the rest only add to the count.
 *
 * @param sweep - The sweep
 * @returns Representative directory → its budget and its location count
 */
function groupByRepresentative(sweep: BudgetSweep): Map<string, RepresentativeGroup> {
  const groups = new Map<string, RepresentativeGroup>();
  for (const location of sweep.locations) {
    const existing = groups.get(location.representative);
    if (existing === undefined) {
      groups.set(location.representative, {
        representative: location.representative,
        budget: location.budget,
        locations: 1,
      });
      continue;
    }
    existing.locations += 1;
  }
  return groups;
}

/**
 * One group's finding, with severity, `fix` and `reference` taken from the
 * registry rather than restated here.
 *
 * ⛔ `location` is OMITTED entirely for the corpus root. `ValidationIssue.
 * location` is a project-relative POSIX path, and `''` is not one — the schema's
 * own refinements would be handed a value that means "nowhere", while the message
 * carries the same fact in words a reader can act on.
 *
 * @param group - The over-budget representative
 * @returns The issue
 */
function issueFor(group: RepresentativeGroup): ValidationIssue {
  return createRegistryIssue(
    'ALWAYS_LOADED_CONTEXT_BUDGET',
    messageFor(group),
    group.representative === '' ? {} : { location: group.representative },
  );
}

/**
 * The finding's prose: where, how much, against what, who pays it, and what is
 * biggest — in that order, because that is the order a reader needs them to
 * decide whether to open anything.
 *
 * @param group - The over-budget representative
 * @returns The message
 */
function messageFor(group: RepresentativeGroup): string {
  const { budget, locations } = group;
  const paying = locations === 1
    ? '1 working location pays it'
    : `${count(locations)} working locations pay it`;
  return `Always-loaded context at ${subjectOf(group.representative)} is estimated at`
    + ` ${count(budget.tokens)} tokens, over the ${count(budget.threshold)}-token budget;`
    + ` ${paying}. ${contributorsOf(budget)}${lowerBoundOf(budget)}`;
}

/**
 * How the representative is named in prose.
 *
 * The corpus root is `''`, which renders as nothing at all and reads like a bug —
 * and it is also the one case that carries no `location` field, so the prose is
 * the ONLY place a reader learns which directory the finding is about.
 *
 * @param representative - The representative directory
 * @returns Its display form
 */
function subjectOf(representative: string): string {
  return representative === '' ? 'the repository root' : representative;
}

/**
 * The largest contributors, capped, with the tail counted rather than dropped.
 *
 * The sweep already sorted contributors descending by tokens (ties broken on path
 * by code point), so "largest" is a prefix and this function does no ordering of
 * its own.
 *
 * @param budget - The over-budget answer
 * @returns The sentence, ending in a period
 */
function contributorsOf(budget: AlwaysLoadedBudget): string {
  const { contributors } = budget;
  if (contributors.length === 0) return 'No contributor was charged.';
  const named = contributors
    .slice(0, MAX_NAMED_CONTRIBUTORS)
    .map((contributor) => `${contributor.path} (${count(contributor.tokens)} tokens)`);
  const remaining = contributors.length - named.length;
  const tail = remaining > 0 ? `, +${count(remaining)} more` : '';
  return `Largest contributors: ${named.join(', ')}${tail}.`;
}

/**
 * The bound sentence, when — and only when — rows VAT saw were left unsummed.
 *
 * All three counts are named even at zero, so a reader learns which kind of
 * ignorance is behind the bound rather than having to infer it from silence.
 *
 * @param budget - The over-budget answer
 * @returns The sentence with a leading space, or the empty string
 */
function lowerBoundOf(budget: AlwaysLoadedBudget): string {
  if (!budget.lowerBound) return '';
  return ' That figure is a lower bound: '
    + `${count(budget.unknownTokenRows)} rows of unknown size, `
    + `${count(budget.excludedDeepImportRows)} import rows past one hop and `
    + `${count(budget.unattributedImportRows)} unattributed import rows`
    + ' were seen but left out of the sum.';
}

/**
 * A count as a reader reads it.
 *
 * Pinned to `en-US` rather than left to the host locale: the same finding must
 * render byte-identically on two developers' machines, for the same reason the
 * ordering below is code-point and not `localeCompare`.
 *
 * @param value - The number
 * @returns Its thousands-separated form
 */
function count(value: number): string {
  return value.toLocaleString('en-US');
}

/**
 * Order two root-relative directories by UTF-16 code point.
 *
 * ⛔ Not `localeCompare`: ICU collation is locale-dependent, so two developers
 * diffing the same run's findings would see churn neither of them caused. Matches
 * every other ordering in the projection lane.
 *
 * @param left - One representative
 * @param right - The other
 * @returns Negative, zero or positive, per the `Array#sort` contract
 */
function comparePaths(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
