import { SeveritySchema } from '@vibe-agent-toolkit/schema';
import { z } from 'zod';

// Values from two projection modules whose own imports are type-only, so the
// schema stays loadable on its own and each vocabulary has one list.
import { SIZE_CLIFF_STATES } from '../projection/claude-context-accounting.js';
import { LAUNCH_CHARGES } from '../projection/claude-context-launch-charge.js';
import type { Admission } from '../projection/claude-context-query.js';

import { HarnessIdSchema } from './projection-harness.js';

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
 * holds a `CLAUDE.md` the 4 MiB cliff skipped. `SUM(tokens + headerTokens)
 * WHERE launchCharge = 'charged'` over one chain, **plus that chain's own
 * `claude_context_chains.preambleTokens`**, is `vat claude context`'s
 * `alwaysTokens` for any of that chain's locations: `tokens + headerTokens` is
 * each charged file's own content plus the one-line header Claude Code renders
 * before it, and `preambleTokens` is the once-per-launch preamble — a fact of
 * the CHAIN (charged at most once, however many files it loads), not of any one
 * row, which is why it is not a `claude_context_loads` column at all.
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
    'Whether this row\'s bytes are paid when a session starts — SUM(tokens + headerTokens) WHERE '
    + 'this is "charged", plus the chain\'s own claude_context_chains.preambleTokens (charged at '
    + 'most once per chain, not per row), is the launch total. Open vocabulary: '
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
 *
 * 🔑 {@link preambleTokens} is repeated on every location row of a chain, the
 * same way {@link representative} is: it is a fact of the CHAIN, and this is
 * the one relation keyed one row per location rather than one row per chain.
 */
export const ClaudeContextChainRowSchema = z.object({
  chainId: z.string().min(1)
    .describe('The instruction chain\'s id, derived from its representative so it is stable and predictable'),
  directory: z.string()
    .describe('A working location that loads this chain at launch. `` is the corpus root'),
  representative: z.string()
    .describe('The instructed directory whose chain this is — itself one of the directories. `` is the corpus root'),
  preambleTokens: z.number().int().nonnegative()
    .describe(
      'CLAUDE_CODE.launchPreamble, estimated, charged AT MOST ONCE for this chain — when at least '
      + 'one of its claude_context_loads rows is launchCharge = "charged" — and 0 for a chain that '
      + 'loads nothing. A fact of the chain, not of any one loaded file, so it lives here rather '
      + 'than on claude_context_loads; add it to SUM(tokens + headerTokens) WHERE chainId = this '
      + 'chain\'s AND launchCharge = "charged" to reproduce vat claude context\'s alwaysTokens',
    ),
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
 * zero. `harness_blob_facts.injectedTokens` is absent for a realization with no blob, and a
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
    .describe('harness_blob_facts.injectedTokens — the text Claude Code injects, frontmatter and HTML comment blocks removed — or null when this realization has no blob. Null is UNKNOWN, never zero'),
  bytes: z.number().int().nonnegative().nullable()
    .describe('blobs.bytes, or null when this realization has no blob'),
  headerTokens: z.number().int().nonnegative()
    .describe(
      'Tokens of the header line Claude Code renders immediately before this file\'s content — '
      + '`Contents of <absolute path>(<kind>):\\n` at launch, `Contents of <absolute path>:\\n` on '
      + 'read; no inter-file joiner. Machine-dependent because the path is absolute, but always '
      + 'known: it depends only on the path, the kind (Project/Local) and the trigger '
      + '(launch/read), never on the content, so it is never null',
    ),
}).strict().describe('A row of the derived `claude_context_loads` relation');

export type ClaudeContextLoadRow = z.infer<typeof ClaudeContextLoadRowSchema>;

/**
 * One condition `vat claude context` grades for its answer — what is broken,
 * which harness loader rule (or, absent one, which VAT check) makes it so, and
 * what it affects.
 *
 * `claude-context-query.ts`'s `GradedCondition` is `z.infer<typeof
 * ClaudeContextFindingSchema>`: this is the query's own report-time shape, not
 * a materialised table — `realization_conditions` (`projection-resources.ts`)
 * is the stored fact this is graded FROM, once per answer, and nothing here is
 * written back to the projection.
 *
 * `harness` is carried on every row, even one `realization_conditions` emits
 * with no harness in mind (`REALIZATION_PATH_COLLISION`, a refusal label): this
 * report is scoped to one harness's context, so every finding it prints is read
 * in that harness's terms, whichever primitive originally raised it.
 *
 * `path`/`line`/`ref` collapse `realization_conditions`' `sourcePath ??
 * path`/`sourceLine`/`sourceRef` into the ONE navigable location a reader opens
 * to act on the finding — the referring file when a reference provoked the
 * condition, else the condition's own subject.
 *
 * `subject` is what `path` alone would otherwise DROP: a condition anchored to
 * its REFUSED TARGET rather than its referrer (`CLOSURE_REFERENCE_OUTSIDE_ROOT`,
 * a refusal label, `CLOSURE_DEPTH_EXCEEDED`) has a stored
 * `realization_conditions.path` distinct from `sourcePath` — the file the
 * decision was actually ABOUT, not the file an author opens to act on it. That
 * distinct value is `subject` here (null whenever it coincides with `path`, as
 * it does for `CLOSURE_REFERENCE_UNRESOLVED`, which is anchored to its referrer
 * already). It is never re-derived from `sourcePath ?? path`: it IS the stored
 * row's own `path` when that differs.
 */
export const ClaudeContextFindingSchema = z.object({
  code: z.string().min(1)
    .describe('realization_conditions.code verbatim — an enum member or a refusal rule\'s label, open vocabulary'),
  severity: SeveritySchema
    .describe('The report\'s severity, never weaker than realization_conditions.severity (strongerSeverity only escalates)'),
  harness: HarnessIdSchema
    .describe('The harness this report is scoped to — every finding here is read in its terms'),
  path: z.string()
    .describe('Root-relative file a reader opens to act on this finding: the referring file when a reference provoked the condition (realization_conditions.sourcePath), else the condition\'s own subject (realization_conditions.path). `\'\'` is the corpus root'),
  subject: z.string().nullable()
    .describe('realization_conditions.path when it differs from `path` above — the file the condition is actually ABOUT (a refused or escaping target), distinct from the file a reader opens to act on it. Null when the two coincide, including every CLOSURE_REFERENCE_UNRESOLVED finding, which is anchored to its referrer already'),
  line: z.number().int().positive().nullable()
    .describe('1-based line of the reference within `path` — realization_conditions.sourceLine — or null when no reference provoked this finding'),
  ref: z.string().nullable()
    .describe('The reference exactly as authored — realization_conditions.sourceRef, `@` included — or null when no reference provoked this finding'),
  message: z.string().min(1)
    .describe('WHAT is broken — realization_conditions.message verbatim'),
  why: z.string().min(1)
    .describe('WHICH harness loader rule makes it so, citing the loader function or branch by name (docs/external/claude-code-memory-loader.md) — or, for a condition no loader branch produced (a path collision, an absent declared root), which VAT check raised it, named honestly rather than papered over with a loader citation. Never a restatement of `message`'),
  affects: z.object({
    chain: z.array(z.string()).min(1)
      .describe('The import chain from this finding\'s closure entry point through `path`, root-relative, in load order'),
    hop: z.number().int().nonnegative()
      .describe('Import hops from the chain\'s entry point (0) to `path`'),
  }).strict().nullable()
    .describe('The walked import closure `path` belongs to, or null when this finding has no import closure to attribute one from (a base-extent condition, or a closure member `closureProvenance` could not attribute)'),
}).strict().describe(
  'One condition graded for a `vat claude context` answer — what is broken, which harness loader'
  + ' rule (or VAT check) makes it so, and what import chain it affects',
);

export type ClaudeContextFinding = z.infer<typeof ClaudeContextFindingSchema>;
