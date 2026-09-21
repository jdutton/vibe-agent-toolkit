import { z } from 'zod';

/**
 * Pattern status — a **closed** vocabulary of exactly four states.
 *
 * ⛔ Closed, unlike `ZoneKindSchema`, because this column has a consumer that
 * fails CLOSED on an exact string: the default-on `claude-rule-glob-inert` check
 * reports a row only when `status` is `inert`. Open, a status that arrived as
 * `inert ` or `INERT` parsed clean and was silently read as healthy. A fifth
 * state is a schema change, and the store's shape digest already invalidates on
 * one.
 *
 * The last two states are the ones that carry the design — each is a null
 * witness that does NOT mean the glob is dead:
 *
 * - **`matched`** — the pattern was evaluated against the tree and
 *   {@link ClaudeRulePatternRowSchema.witnessPath} names a path it matched.
 * - **`inert`** — the pattern was evaluated against the tree and matched
 *   nothing. The rule declares a scope no file in this tree occupies, so it can
 *   never fire here. This is the defect the table exists to make queryable.
 * - **`unevaluated`** — the pattern was **never run**. A rule whose whole
 *   `paths:` list blows the vendor's shared expansion budget
 *   (`EXPANDED_PATTERN_BUDGET` / `PATTERN_BYTE_BUDGET` in
 *   `claude-context-rules.ts`) is used unexpanded by the harness and is skipped
 *   here rather than matched, so no matcher ever touched it.
 * - **`gitignored`** — the pattern was evaluated and matched no file VAT can
 *   see, and its territory is **gitignored** (a file beneath its literal prefix,
 *   or the file a wholly-literal pattern names, would be ignored). VAT never
 *   realizes an ignored file, but the harness reads the filesystem, so a rule
 *   scoped to `dist/**` may well fire. VAT declines to judge it rather than
 *   call it dead. A glob with an EMPTY literal prefix is never judged this way
 *   and stays `inert`.
 *
 * 🚨 **Two states would have to read a null witness as inertness, and it is
 * not** — for an over-budget rule a null witness records a refusal to evaluate,
 * and for an ignored territory it records what VAT chose not to look at.
 * 🚨 **A witness, never a `matchCount`**: the shipped prune stops at the first
 * hit, and a count would delete that early exit for an answer nobody asks for.
 * Both, in full: `docs/architecture/zones.md` §4, "The `claude_rule_patterns`
 * table — four statuses, one witness".
 */
export const ClaudeRulePatternStatusSchema = z.enum(['matched', 'inert', 'unevaluated', 'gitignored'])
  .describe('Pattern status: "matched" (witnessPath names a match), "inert" (evaluated, matched nothing), "unevaluated" (never run — the paths: list blew the expansion budget) or "gitignored" (matched nothing VAT can see, and its territory is gitignored — VAT declines to judge it, since the harness reads ignored files)');

export type ClaudeRulePatternStatus = z.infer<typeof ClaudeRulePatternStatusSchema>;

/**
 * A row of the `claude_rule_patterns` table — one `paths:` glob of one
 * `.claude/rules` file, and what it scopes in this tree.
 *
 * Keyed `(resourceId, ordinal)` — on the identity, not on an extent — and
 * extent-scoped rather than blob-scoped. `literalPrefix` is stored so SQL can do
 * ∀ containment with no matcher; ⛔ a wholly literal pattern yields ITSELF, a
 * FILE path and not a directory, so read the column as *"the longest path every
 * match lives at or below"*. Why each of those: `docs/architecture/zones.md` §4,
 * "The `claude_rule_patterns` table — four statuses, one witness".
 */
export const ClaudeRulePatternRowSchema = z.object({
  resourceId: z.string().min(1)
    .describe('Foreign key to resources.resourceId — the `.claude/rules` file that declares this pattern'),
  ordinal: z.number().int().nonnegative()
    .describe('Index of this glob in the rule file\'s own `paths:` list, from 0'),
  pattern: z.string().min(1)
    .describe('The `paths:` glob verbatim, exactly as the rule file declares it'),
  literalPrefix: z.string()
    .describe('The glob-free leading segments of `pattern`; may be empty. The longest path every match lives at or below.'),
  witnessPath: z.string().min(1).nullable()
    .describe('First tree path this pattern matches — non-null exactly when status is "matched". Pinned by a superRefine that is NOT encoded in the generated JSON Schema'),
  status: ClaudeRulePatternStatusSchema,
}).strict().describe('A row of the path-dependent `claude_rule_patterns` table. Note: witnessPath is non-null exactly when status is "matched"; this constraint is enforced by the Zod schema but not encoded in the generated JSON Schema.')
  .superRefine((row, ctx) => {
    // Both directions, as `resource_realizations` pins contentState ⟺
    // contentKey: a `matched` row with no witness is unfalsifiable, and a witness
    // beside any other status names a match the status says never happened.
    if ((row.status === 'matched') !== (row.witnessPath !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `status "${row.status}" requires witnessPath to be ${row.status === 'matched' ? 'non-null' : 'null'}`,
        path: ['witnessPath'],
      });
    }
  });

export type ClaudeRulePatternRow = z.infer<typeof ClaudeRulePatternRowSchema>;
