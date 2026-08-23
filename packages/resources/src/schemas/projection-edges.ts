import { z } from 'zod';

const SRC_DESC = 'Source resource id';
const REF_ORDINAL_DESC = 'Matches blob_references.ordinal for the src blob. Null for an implicit edge, which has no authored reference.';
const CONTEXT_DESC = 'Foreign key to resolution_contexts.contextId — resolution is per-context';

/**
 * How an edge came to exist.
 *
 * - `authored` — a reference someone wrote, with a `blob_references` row.
 * - `implicit` — a relation the reader's rules create with nothing written:
 *   the CLAUDE.md ancestry chain, a `.claude/rules` file matching a `paths:`
 *   glob. No blob reference exists, so `refOrdinal` is null.
 * - `inferred` — a path-shaped token promoted to a reference by a scoring
 *   lens. Has a blob reference (the token) but no authored intent.
 *
 * **Cannot be retrofitted:** adding it later changes the meaning of every
 * pre-existing row, because rows written before it existed would silently
 * read as `authored`.
 */
export const EdgeOriginSchema = z.enum(['authored', 'implicit', 'inferred'])
  .describe('Whether this edge was authored, implied by the reader\'s rules, or inferred by a scoring lens');

export type EdgeOrigin = z.infer<typeof EdgeOriginSchema>;

/**
 * Edge kind — an **open** vocabulary.
 *
 * Was `LinkTypeSchema` (`local_file` | `local_directory` | `anchor` |
 * `external` | `email` | `embedded` | `unknown`), which cannot express
 * `ancestor-context` or `rules-glob-match`. Every `LinkType` member remains a
 * valid value.
 */
export const EdgeKindSchema = z.string().min(1)
  .describe('Edge kind — open vocabulary, e.g. "local_file", "external", "ancestor-context", "rules-glob-match"');

/**
 * A row of the `edges` table — **that** a reader relates one resource to
 * something, under one resolution context. **What** it resolves to lives in
 * {@link EdgeResolutionRowSchema}.
 *
 * ## A row exists only where the lens traverses that kind
 *
 * A markdown renderer's relation to an `@` import is **no edge**, not an
 * unresolved one. Conflating the two would report false brokenness on every
 * `@` import in every repository. Absence is interpretable precisely because
 * the lens carries its own traversal policy, and because a requested zone
 * kind with no registered contributor throws rather than yielding an empty
 * extent.
 *
 * ## `resolution` is graded, over an open vocabulary
 *
 * | tier | meaning for the reader |
 * |---|---|
 * | same plugin | co-bundled — available whenever the referrer is |
 * | same marketplace | installable from an already-trusted source; may not be installed |
 * | known other marketplace | reachable, plugin not installed |
 * | unknown marketplace | no path to it at all |
 * | auth-required | reachable only with credentials (linkAuth) |
 * | nonexistent | dead |
 *
 * Already an open string in v1, and correct as shipped.
 */
export const EdgeRowSchema = z.object({
  src: z.string().min(1).describe(SRC_DESC),
  refOrdinal: z.number().int().nonnegative().nullable().describe(REF_ORDINAL_DESC),
  contextId: z.string().min(1).describe(CONTEXT_DESC),
  kind: EdgeKindSchema,
  origin: EdgeOriginSchema,
  resolution: z.string().min(1).describe('Resolution tier — open vocabulary, e.g. "resolved", "same-marketplace", "auth-required", "nonexistent"'),
}).strict().describe('A row of the path-dependent `edges` table. Note: the implicit/refOrdinal correspondence is enforced by the Zod schema but not encoded in the generated JSON Schema.')
  .superRefine((row, ctx) => {
    const isImplicit = row.origin === 'implicit';
    const hasOrdinal = row.refOrdinal !== null;
    if (isImplicit === hasOrdinal) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: isImplicit
          ? 'an implicit edge has no authored reference, so refOrdinal must be null'
          : 'an authored or inferred edge is anchored to a blob reference, so refOrdinal is required',
        path: ['refOrdinal'],
      });
    }
  });

export type EdgeRow = z.infer<typeof EdgeRowSchema>;

/**
 * A row of the `edge_resolutions` table — **one candidate target** for one
 * edge, in one resolution context.
 *
 * ## Why this is a separate table
 *
 * A scalar `dstResource` on `edges` cannot hold what the model needs:
 *
 * - **Wiki resolution is many-candidate by nature.** `[[Configuration]]` in a
 *   flat, case- and space-forgiving namespace matches four files. Multiple
 *   rows were forbidden by the old key; `resolution: 'ambiguous'` with a null
 *   target discards N *and* the candidate set, making the design's own N-way
 *   ambiguity metric unbuildable; and picking a winner **is**
 *   last-write-wins, the shipped defect per-lens resolution exists to remove.
 * - **Scored inference needs candidates.** "A 95% match in the git extent but
 *   not in the skill extent" is a scored candidate; one column holds zero of
 *   them.
 *
 * Single-target resolution is the N=1 case at the cost of one join.
 * Ambiguity, interwiki prefixes and scored inference become rows instead of
 * migrations.
 *
 * `score` is null for a certain resolution — a markdown link that resolves is
 * not 100% confident, it is simply resolved, and a fabricated 1.0 would make
 * "has a score" stop meaning "was inferred".
 */
export const EdgeResolutionRowSchema = z.object({
  src: z.string().min(1).describe(SRC_DESC),
  refOrdinal: z.number().int().nonnegative().nullable().describe(REF_ORDINAL_DESC),
  contextId: z.string().min(1).describe(CONTEXT_DESC),
  candidateOrdinal: z.number().int().nonnegative()
    .describe('0-based rank among this edge\'s candidates — 0 is the best candidate this context found'),
  dstResource: z.string().min(1).nullable().describe('Resolved target resource id, or null when this candidate resolves to nothing'),
  dstAnchor: z.string().nullable().describe('Fragment target, or null'),
  score: z.number().min(0).max(1).nullable()
    .describe('Confidence for an inferred candidate, or null for a certain resolution'),
}).strict().describe('A row of the path-dependent `edge_resolutions` table');

export type EdgeResolutionRow = z.infer<typeof EdgeResolutionRowSchema>;
