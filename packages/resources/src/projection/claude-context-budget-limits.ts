/**
 * What the always-loaded BUDGET deliberately does not settle — published with the
 * verdict, for the same reason its sibling publishes them with the query.
 *
 * `vat claude context` attaches {@link CLAUDE_CONTEXT_LIMITS} to every answer it
 * gives, on the rule spelled in that module: *a limit a reader has to go and find
 * is a limit that does not reach the person acting on the number.* `vat claude
 * budget` applies a THRESHOLD to the very same measurement and — until this list
 * existed — published none of them. The half that GATES was the half with no
 * stated bounds, which is the wrong way round: a number that can fail a build is
 * the number whose caveats a reader most needs beside it.
 *
 * ## It is COMPOSED, never copied
 *
 * The shared entries are selected out of {@link CLAUDE_CONTEXT_LIMITS} by id
 * through {@link limitsById}, which THROWS on an id it cannot find. That throw is
 * the whole point of the indirection: a limit renamed in the source list would
 * otherwise vanish from this one silently, and a bound that quietly stops being
 * published is indistinguishable from a bound that stopped applying. Copying the
 * sentences instead would give the two lists room to disagree about the same
 * mechanism, and this repo's duplication gate would be the only thing objecting.
 *
 * ## Which of the query's limits apply here, and why the rest do not
 *
 * The budget measures the ALWAYS-LOADED chain of ONE working location: CLAUDE.md
 * files on the path down to it, their first hop of `@` imports, and unscoped root
 * rules. It publishes a sum, a verdict against a threshold, and the largest
 * contributors. Nothing else. So an entry is in scope exactly when it can move
 * that sum, or bound what the verdict means.
 *
 * **Left out, each because the budget never charges the thing it is about:**
 *
 * - `glob-dialect`, `dot-matching` — the `paths:` matcher's fidelity. Only a
 *   path-scoped rule is matched by it, and no path-scoped rule enters this sum.
 * - `directory-glob`, `existential-needs-a-file` — the ∀/∃ classification of a
 *   path-scoped rule against a directory. Same reason: on-demand cost, not this.
 * - `nested-rule-trigger` — nested paths-less rules, whose own statement already
 *   records that they *"are never counted into the always-loaded total"*.
 * - `discovery-one-hop` — the `--discoverable` lens, which this command does not
 *   have and whose tokens are a ceiling on a voluntary cost, never a charge.
 * - `root-claude-md-order` — the ASSUMED order of `./CLAUDE.md` against
 *   `./.claude/CLAUDE.md`. A sum is order-independent and the contributor list is
 *   sorted by size, so no output here can be wrong in the way that entry bounds.
 *   ⚠️ This is the one departure from the obvious reading of "always-loaded
 *   chain": both files are still CHARGED, and if the vendor's "alternative
 *   locations" wording ever turns out to mean only one of them loads, that is a
 *   new over-report bound and not this entry.
 *
 * **Kept, including two that need a word.** `unresolved-conditions-collapse` is
 * kept though this command prints no condition rows: what it bounds is that a
 * file's broken `@` imports are under-reported, and every unresolved import is
 * content the sum does not carry. `version-gated` is kept for its second half —
 * a CLAUDE.md, a rules file or an import reachable only through a symlinked name
 * is uncounted — not for its path-scoped-rule half.
 *
 * ## The four bounds that exist only because a threshold is applied
 *
 * Appended after the shared block, and ordered the way the query's list is:
 * under-report, then scope, then assumption. They are the ones a reader of a
 * VERDICT needs and a reader of a query does not — the calibration boundary the
 * sum honours, the rows it declines to attribute, the class of file it declines
 * to charge, and where the threshold itself came from.
 */

import { CLAUDE_CONTEXT_LIMITS, type StatedLimit } from './claude-context-limits.js';

/**
 * The entries of {@link CLAUDE_CONTEXT_LIMITS} that bound this budget too.
 *
 * Exported so a test can pin the selection against a hand-written list rather
 * than against the module's own copy of it, and so a consumer can see WHICH of
 * the published context limits were carried across rather than having to diff two
 * arrays of sentences.
 */
export const BUDGET_LIMIT_IDS_FROM_CONTEXT: readonly string[] = [
  'claude-md-excludes',
  'setting-sources',
  'html-comments',
  'auto-memory',
  'managed-claude-md-key',
  'user-and-managed-scope',
  'add-dir',
  'unresolved-conditions-collapse',
  'variable-imports-unfollowed',
  'gitignored-not-realized',
  'main-conversation-only',
  'version-gated',
  'outside-root-is-not-external',
  'context-window-scope',
  'cliff-scope',
  'token-estimate',
];

/**
 * Select published limits by id, refusing to be quiet about one that moved.
 *
 * ⛔ Throws rather than filtering. A missing id means the source list was renamed
 * or an entry was removed, and the failure mode this guards is a bound silently
 * disappearing from a report that still looks complete — the reader cannot tell a
 * caveat that was dropped from one that never applied.
 *
 * @param ids - Ids of {@link CLAUDE_CONTEXT_LIMITS} entries, in the order wanted
 * @returns The entries themselves, by reference, in the requested order
 * @throws Error naming every id that is not in {@link CLAUDE_CONTEXT_LIMITS}
 */
export function limitsById(ids: readonly string[]): readonly StatedLimit[] {
  const byId = new Map(CLAUDE_CONTEXT_LIMITS.map((limit) => [limit.id, limit]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new Error(
      `No CLAUDE_CONTEXT_LIMITS entry has the id ${missing.join(', ')}.`
      + ' A stated limit was renamed or removed there without being ruled in or out here;'
      + ' fix the id or delete it deliberately, because dropping it silently un-publishes a bound.',
    );
  }
  return ids.map((id) => byId.get(id) as StatedLimit);
}

/**
 * Every limit `vat claude budget` states, in the order it prints them.
 *
 * The shared block first, in the query's own order, then the four bounds that
 * only a thresholded reading needs.
 */
export const ALWAYS_LOADED_BUDGET_LIMITS: readonly StatedLimit[] = [
  ...limitsById(BUDGET_LIMIT_IDS_FROM_CONTEXT),
  {
    id: 'import-hop-calibration',
    direction: 'under-report',
    statement: 'The budget was calibrated at ONE import hop and this sum honours that boundary:'
      + ' a row reached at depth 2 or deeper is counted into `excludedDeepImportRows` and left out'
      + ' of the total, though the harness loads it. `MAX_QUALIFYING_IMPORT_DEPTH` in'
      + ' `claude-context-budget.ts` is a calibration boundary, not a traversal limit — the closure'
      + ' still walks its full depth, so the rows are seen and declined rather than missed. A chain'
      + ' whose real weight sits two hops down is reported smaller than a session pays for it, and'
      + ' the excluded-row count in the finding is the only tell.',
  },
  {
    id: 'unattributed-imports-counted',
    direction: 'under-report',
    statement: 'An imported file VAT could not attribute to an importer (`depth: null`) is counted'
      + ' into `unattributedImportRows` and never summed. Attribution is what decides which side of'
      + ' the one-hop calibration boundary a row falls on, so a row carrying none cannot be placed'
      + ' on either side and is declined rather than guessed at. It is real always-loaded cost that'
      + ' the number does not carry.',
  },
  {
    id: 'path-scoped-rules-excluded',
    direction: 'scope',
    statement: 'A PATH-SCOPED rule — one carrying a `paths:` list — is never charged here. It loads'
      + ' when the agent touches a matching file rather than at launch, so it is on-demand cost and'
      + ' this budget is about launch cost. An UNSCOPED rule in the root `.claude/rules/` IS'
      + ' charged: nothing gates it on a path, so it loads at launch exactly as a CLAUDE.md does.'
      + ' `vat claude context` reports the on-demand half; silence here about a path-scoped rule is'
      + ' a scope decision and never a finding that it is free.',
  },
  {
    id: 'threshold-provenance',
    direction: 'assumption',
    statement: 'The default threshold is a MEASURED calibration across four corpora, not a tunable'
      + ' with a history. The measurement, the corpora and every re-measurement of it live in'
      + ' `claude-context-budget.ts` and are deliberately not restated here, so the two cannot rot'
      + ' apart. It was calibrated at one import hop and against the characters/4 estimator, so a'
      + ' threshold moved by configuration — and the default itself, read at a different import'
      + ' depth — is a number nobody measured.',
  },
];
