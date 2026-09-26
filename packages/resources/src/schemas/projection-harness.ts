/**
 * The content-keyed harness tables — what one coding harness does with one
 * blob's bytes, keyed `(blob, harness)`.
 *
 * These facts are path-independent like every blob fact, but they are NOT
 * VAT's own reading of a blob: each is the named harness's reading, transcribed
 * from that harness (for `claude-code`, the shipped binary —
 * `docs/external/claude-code-memory-loader.md`). A second harness adds rows
 * under its own id rather than a second set of columns on `blobs`.
 *
 * ⛔ `blob` is the FIRST primary-key column of both tables: a store keys every
 * blob-tier select, delete and eviction on a blob-scoped table's first
 * primary-key column.
 */

import { z } from 'zod';

import { ContentKeySchema } from './projection-shared.js';

/** Every harness a harness table can name — held equal to `HARNESS_PROFILES`' keys by a test. */
export const HarnessIdSchema = z.enum(['claude-code'])
  .describe('The coding harness whose reading of the blob this row records');

/**
 * A row of the `harness_blob_facts` table — what the harness named by
 * `harness` injects for one blob when it reads it as a memory file.
 *
 * One row per `(blob, harness)` the harness's facts were DERIVED for. An
 * absent row means "not derived", never zero: read it through
 * `harnessFactsIndex`, whose `requireFacts` throws rather than coercing.
 */
export const HarnessBlobFactsRowSchema = z.object({
  blob: ContentKeySchema.describe('Foreign key to blobs.contentKey'),
  harness: HarnessIdSchema,
  injectedBytes: z.number().int().nonnegative()
    .describe('UTF-8 bytes of the text the harness named by `harness` INJECTS when it reads this blob as a memory file (a CLAUDE.md, a rules file or an @ import): the body after its frontmatter block, with every block-level HTML comment removed, trimmed — the shipped reader\'s own rule (`q7e`, then `s1n`\'s launch-path trim; docs/external/claude-code-memory-loader.md). 0 means the harness injects NOTHING for it and follows none of its imports. Path-independent: whether the harness reads the path at all (its extension, the 4 MiB cliff on `blobs.bytes`) is decided by the reader of the path, not here'),
  injectedTokens: z.number().int().nonnegative()
    .describe('The token estimate (UTF-16 code units / 4, rounded up) of that same injected text — what `vat claude context` charges for this blob'),
  paths: z.array(z.string().min(1)).min(1).nullable()
    .describe('The `paths:` globs the harness named by `harness` scopes this blob by when it reads it as a memory file, or null when it scopes it by none (it then loads unconditionally wherever it is reached). Read the harness\'s way, whatever the file\'s extension — NOT from `frontmatter`, which is VAT\'s parser\'s answer and is absent for a file routed to no parser: its own frontmatter splitter and YAML parse (a block that fails to parse declares nothing), `paths:` normalised (arrays flattened, strings split on commas at brace depth zero, other values dropped), and null when every survivor of brace expansion and the trailing-`/**` strip is empty or `**` (`kyn`; docs/external/claude-code-rules-paths-behaviour.md). The patterns are VERBATIM, in declaration order; their index is `claude_rule_patterns.ordinal`'),
}).strict().describe('A row of the blob-keyed `harness_blob_facts` table');

/**
 * A row of the `harness_blob_imports` table — one import the harness named by
 * `harness` reads out of a blob when it loads it as a memory file.
 *
 * NOT a subset of `blob_references`. That table is VAT's dialect-free reading
 * of every reference candidate; this one is the harness's own extractor (for
 * `claude-code`, `Ayn` in the shipped binary, transcribed in
 * `docs/external/claude-code-memory-loader.md`): `marked` 15.0.6 lexing the
 * frontmatter-stripped body with `gfm: false`, the `@` token scanned only in
 * TEXT tokens (never a code span, a code block or non-comment HTML), `\ `
 * unescaped, the `#` fragment cut, and the vendor's acceptance test applied.
 * The two disagree in both directions — `(@a.md)` and `@a.md.` are candidates
 * there and no import here (or a different one), `**@a.md**` the reverse — so
 * the harness's import walk reads THIS table and nothing else.
 *
 * Path-independent, like every blob fact: `target` is the spelling the harness
 * resolves against the importing file's directory, and resolution — which
 * needs a path — is the reader's.
 */
export const HarnessBlobImportRowSchema = z.object({
  blob: ContentKeySchema.describe('Foreign key to blobs.contentKey'),
  harness: HarnessIdSchema,
  ordinal: z.number().int().nonnegative()
    .describe('0-based document order of the FIRST occurrence of this target — the order the harness follows imports in'),
  rawRef: z.string().min(1)
    .describe('The token as authored, @ included and nothing unescaped or cut — what a condition row reports back to an author'),
  target: z.string()
    .describe('The path the harness resolves: rawRef without its @, its #fragment cut and every `\\ ` read as a space. Unique within a (blob, harness) — a repeated spelling is one import'),
  line: z.number().int().positive()
    .describe('1-based line of the @ in the blob. Exact wherever the enclosing markdown tokens\' source text is verbatim; inside a construct marked rewrites before lexing its content (a blockquote\'s continuation lines, a comment block\'s residue) it is the line that construct starts on'),
}).strict().describe('A row of the blob-keyed `harness_blob_imports` table');

export type HarnessBlobFactsRow = z.infer<typeof HarnessBlobFactsRowSchema>;
export type HarnessBlobImportRow = z.infer<typeof HarnessBlobImportRowSchema>;
