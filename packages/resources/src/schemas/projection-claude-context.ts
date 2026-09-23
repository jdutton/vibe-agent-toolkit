import { z } from 'zod';

// Values from two projection modules whose own imports are type-only, so the
// schema stays loadable on its own and each vocabulary has one list.
import { SIZE_CLIFF_STATES } from '../projection/claude-context-accounting.js';
import { LAUNCH_CHARGES } from '../projection/claude-context-launch-charge.js';
import type { Admission } from '../projection/claude-context-query.js';

/**
 * Every admission kind a `claude_context_loads` row can name.
 *
 * `satisfies` holds this list inside the `Admission` union, and
 * `claude-context-relations.ts` holds the union inside this list where it
 * writes the column, so the published description cannot name a kind that no
 * longer exists or miss one that does.
 */
export const CLAUDE_CONTEXT_ADMISSION_KINDS = [
  'ancestry',
  'root-rule',
  'nested-rule',
  'glob-rule',
  'glob-rule-covers-dir',
  'glob-rule-may-fire',
  'import',
] as const satisfies readonly Admission['kind'][];

/** One member of {@link CLAUDE_CONTEXT_ADMISSION_KINDS}. */
export type ClaudeContextAdmissionKind = (typeof CLAUDE_CONTEXT_ADMISSION_KINDS)[number];

/**
 * Whether a row's bytes are paid when a session starts.
 *
 * 🔑 **This column is the filter a launch-cost sum needs.** It folds `loadClass`
 * and `sizeCliff`, because neither alone is the right `WHERE`: `sizeCliff =
 * 'loaded'` also holds every on-demand rule, and `loadClass = 'always'` also
 * holds a `CLAUDE.md` the 4 MiB cliff skipped. `SUM(tokens) WHERE launchCharge =
 * 'charged'` over one chain is `vat claude context`'s `alwaysTokens` for any of
 * its locations.
 *
 * ⛔ An **open** vocabulary (a string, not an enum), for the same reason
 * `ClaudeRulePatternStatusSchema` is: a value added later must add rows, never
 * migrate a schema. Today's four:
 *
 * - **`charged`** — loaded at launch, and its `tokens` are measured.
 * - **`unknown-size`** — loaded at launch, but nothing measured it. COUNT these
 *   beside the sum: a confident zero is indistinguishable from a free file.
 * - **`oversize`** — always-class, but the 4 MiB cliff skipped it or an oversize
 *   ancestor pruned it. The harness genuinely does not load it — knowledge, not
 *   ignorance.
 * - **`not-always`** — an `on-demand` row: loaded when the agent touches a
 *   matching file, never at launch.
 */
export const ClaudeContextLaunchChargeSchema = z.string().min(1)
  .describe(
    'Whether this row\'s bytes are paid when a session starts — sum tokens or bytes WHERE this is "charged". Open vocabulary: '
    + LAUNCH_CHARGES.map((charge) => `"${charge}"`).join(', '),
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
 * can load at launch, or the first carried when none can.
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
 * zero. `blobs.claudeInjectedTokens` is absent for a realization with no blob, and a
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
    .describe(
      'Kind of the DECIDING admission, or null when nothing admitted this row: '
      + CLAUDE_CONTEXT_ADMISSION_KINDS.map((kind) => `"${kind}"`).join(', '),
    ),
  pattern: z.string().nullable()
    .describe('The deciding admission\'s distinguishing string — a glob, a directory, or a closure root; null where its kind has none'),
  depth: z.number().int().nonnegative().nullable()
    .describe('Import hops from the closure root, for an `import` admission VAT could attribute; null otherwise'),
  admissionCount: z.number().int().nonnegative()
    .describe('How many admissions this row carries — the deciding one is a summary of them, not the whole list'),
  sizeCliff: z.enum(SIZE_CLIFF_STATES)
    .describe('The 4 MiB memory-file cliff\'s verdict on this file — NOT whether it is paid at launch; that is launchCharge. "unmeasured" means no blob, so no size'),
  launchCharge: ClaudeContextLaunchChargeSchema,
  tokens: z.number().int().nonnegative().nullable()
    .describe('blobs.claudeInjectedTokens — the text Claude Code injects, frontmatter and HTML comment blocks removed — or null when this realization has no blob. Null is UNKNOWN, never zero'),
  bytes: z.number().int().nonnegative().nullable()
    .describe('blobs.bytes, or null when this realization has no blob'),
}).strict().describe('A row of the derived `claude_context_loads` relation');

export type ClaudeContextLoadRow = z.infer<typeof ClaudeContextLoadRowSchema>;
