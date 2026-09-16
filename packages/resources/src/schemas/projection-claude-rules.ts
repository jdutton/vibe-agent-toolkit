import { z } from 'zod';

/**
 * Pattern status — an **open** vocabulary, deliberately a string and not an
 * enum, for the same reason `ZoneKindSchema` is: a status added later must add
 * rows, never migrate the schema.
 *
 * Three states ship, and the third is the one that carries the design:
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
 *
 * 🚨 **Two states would have to read a null witness as inertness, and it is
 * not** — for an over-budget rule a null witness records a refusal to evaluate.
 * 🚨 **A witness, never a `matchCount`**: the shipped prune stops at the first
 * hit, and a count would delete that early exit for an answer nobody asks for.
 * Both, in full: `docs/architecture/zones.md` §4, "The `claude_rule_patterns`
 * table — three statuses, one witness".
 */
export const ClaudeRulePatternStatusSchema = z.string().min(1)
  .describe('Pattern status — open vocabulary: "matched", "inert" or "unevaluated"');

/**
 * A row of the `claude_rule_patterns` table — one `paths:` glob of one
 * `.claude/rules` file, and what it scopes in this tree.
 *
 * Keyed `(resourceId, ordinal)` — on the identity, not on an extent — and
 * extent-scoped rather than blob-scoped. `literalPrefix` is stored so SQL can do
 * ∀ containment with no matcher; ⛔ a wholly literal pattern yields ITSELF, a
 * FILE path and not a directory, so read the column as *"the longest path every
 * match lives at or below"*. Why each of those: `docs/architecture/zones.md` §4,
 * "The `claude_rule_patterns` table — three statuses, one witness".
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
    .describe('First tree path this pattern matches, or null when it matched nothing or was never evaluated'),
  status: ClaudeRulePatternStatusSchema,
}).strict().describe('A row of the path-dependent `claude_rule_patterns` table');

export type ClaudeRulePatternRow = z.infer<typeof ClaudeRulePatternRowSchema>;
