import { z } from 'zod';

/**
 * How one always-class row reaches — or fails to reach — the always-loaded
 * budget's total.
 *
 * 🔑 **This column is what makes the budget reproducible in SQL.** The verb's
 * total is narrower than `SUM(tokens) WHERE loadClass = 'always'`: qualifying
 * reads the admission LIST (several per row, one qualifying is enough) and the
 * 4 MiB cliff's verdict, neither of which survives into a flat relation. So the
 * decision is made once and STORED, and an adopter's `SUM(tokens) WHERE
 * budgetDisposition = 'charged'` is the same arithmetic rather than a
 * re-derivation free to drift.
 *
 * ⛔ An **open** vocabulary (a string, not an enum), for the same reason
 * `ClaudeRulePatternStatusSchema` is: a disposition added later must add rows,
 * never migrate a schema. Today's seven:
 *
 * - **`charged`** — qualified, measurable, and its `tokens` are in the total.
 * - **`unknown-size`** — qualified, but nothing measured it. COUNTED, never
 *   summed as zero: a confident zero is indistinguishable from a free file.
 * - **`oversize`** — qualified, and the 4 MiB cliff skipped it or an oversize
 *   ancestor pruned it. Adds nothing AND counts nothing: the harness genuinely
 *   did not load it, which is knowledge rather than ignorance.
 * - **`excluded-rule`** — every admission is an on-demand rule kind (or the row
 *   has no admission at all). Excluded by design, not by uncertainty.
 * - **`excluded-deep-import`** — every import admission is more than one hop
 *   from its root, past the depth the budget is calibrated for.
 * - **`excluded-unattributed-import`** — an import admission VAT could not
 *   attribute (`depth: null`). Reported ahead of `excluded-deep-import` when a
 *   row carries both, because "could not say where this came from" is the more
 *   urgent fact.
 * - **`not-always`** — an `on-demand` row. Silently outside this budget; it is
 *   not an exclusion anybody should count.
 */
export const ClaudeContextBudgetDispositionSchema = z.string().min(1)
  .describe(
    'How this row reaches the always-loaded budget — open vocabulary: "charged", "unknown-size",'
    + ' "oversize", "excluded-rule", "excluded-deep-import", "excluded-unattributed-import",'
    + ' "not-always"',
  );

/**
 * A row of the `claude_context_chains` relation — one working location, and the
 * instruction chain it inherits.
 *
 * One row per LOCATION, not per chain: this is the join table between "what does
 * a chain load" (`claude_context_loads`, keyed on {@link chainId}) and "how many
 * places pay it" (`COUNT(*) GROUP BY chainId`). See `docs/architecture/zones.md`
 * §2 for why the collapse is what keeps the load relation small.
 *
 * 🪤 {@link representative} is a column, not something to parse out of an id. It
 * is itself one of the {@link directory} values, and the corpus root is spelled
 * `''` — a legal, common representative that stripping a prefix off
 * {@link chainId} would mangle.
 */
export const ClaudeContextChainRowSchema = z.object({
  chainId: z.string().min(1)
    .describe('The instruction chain\'s id, derived from its representative so it is stable and predictable'),
  directory: z.string()
    .describe('A working location that loads this chain at launch. `` is the corpus root'),
  representative: z.string()
    .describe('The instructed directory whose chain this is — itself one of the directories. `` is the corpus root'),
}).strict().describe('A row of the derived `claude_context_chains` relation');

export type ClaudeContextChainRow = z.infer<typeof ClaudeContextChainRowSchema>;

/**
 * A row of the `claude_context_loads` relation — one resource the harness loads
 * for one instruction chain, with what it costs and how it was admitted.
 *
 * ⛔ **ONE row per (chain, resource). Never one per admission.** A resource can
 * be admitted several ways at once — a rules file that is also an ancestry
 * member is ordinary — and a row per admission would make every `SUM(tokens)`
 * double-count exactly the diamond `whatLoadsAt` dedupes by identity to avoid.
 * So the admission columns describe the **deciding** admission: the first that
 * qualifies for the budget, or the first carried when none does.
 * {@link admissionCount} says how many there were.
 *
 * {@link pattern} holds that admission's distinguishing string, which depends on
 * {@link admissionKind} and is null where the kind has none:
 *
 * | kind | `pattern` |
 * |---|---|
 * | `ancestry` | the directory whose `CLAUDE.md` pulled it in |
 * | `root-rule` | null — an unscoped root rules file has no selector |
 * | `nested-rule` | the directory the rules file is nested under |
 * | `glob-rule`, `glob-rule-covers-dir`, `glob-rule-may-fire` | the `paths:` glob |
 * | `import` | the closure ROOT's path |
 *
 * ⚠️ {@link tokens} and {@link bytes} are nullable and a null is UNKNOWN, never
 * zero. `blobs.tokenEstimate` is absent for a realization with no blob, and a
 * coalesced zero would assert a free file.
 */
export const ClaudeContextLoadRowSchema = z.object({
  chainId: z.string().min(1)
    .describe('Foreign key to claude_context_chains.chainId'),
  resourceId: z.string().min(1)
    .describe('Foreign key to resources.resourceId — the identity this chain loads'),
  path: z.string().min(1)
    .describe('Root-relative path of the loaded file'),
  loadClass: z.string().min(1)
    .describe('"always" (loaded at session start) or "on-demand" (loaded when the agent touches a matching file)'),
  admissionKind: z.string().min(1).nullable()
    .describe('Kind of the DECIDING admission, or null when nothing admitted this row'),
  pattern: z.string().nullable()
    .describe('The deciding admission\'s distinguishing string — a glob, a directory, or a closure root; null where its kind has none'),
  depth: z.number().int().nonnegative().nullable()
    .describe('Import hops from the closure root, for an `import` admission VAT could attribute; null otherwise'),
  admissionCount: z.number().int().nonnegative()
    .describe('How many admissions this row carries — the deciding one is a summary of them, not the whole list'),
  charge: z.string().min(1)
    .describe('The 4 MiB cliff\'s verdict: "charged", "oversize-skipped", "pruned-by-oversize" or "unknown-size"'),
  budgetDisposition: ClaudeContextBudgetDispositionSchema,
  tokens: z.number().int().nonnegative().nullable()
    .describe('blobs.tokenEstimate, or null when this realization has no blob. Null is UNKNOWN, never zero'),
  bytes: z.number().int().nonnegative().nullable()
    .describe('blobs.bytes, or null when this realization has no blob'),
}).strict().describe('A row of the derived `claude_context_loads` relation');

export type ClaudeContextLoadRow = z.infer<typeof ClaudeContextLoadRowSchema>;
