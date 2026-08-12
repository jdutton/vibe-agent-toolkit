import { z } from 'zod';

import { JsonValueSchema } from './projection-shared.js';

/**
 * The two species a zone can be (zones.md §2).
 *
 * - An **extent** answers *what exists here*: git, the working filesystem, a
 *   build tree, an installed plugin directory, a package or marketplace
 *   namespace.
 * - A **lens** answers *what does this reader traverse, and how does it
 *   resolve* — always **over** an extent.
 *
 * The split is not cosmetic. GitHub's renderer sees git and follows `[]()`
 * but not `@`; Claude sees the *filesystem*, including gitignored build
 * output, and follows `[]()`, `@` (four hops) and `.claude/rules` `paths:`
 * globs. "Claude sees output the git extent cannot" is not an intersection of
 * two zones — it is a different base.
 */
export const ZoneSpeciesSchema = z.enum(['extent', 'lens'])
  .describe('Whether this context defines what exists (extent) or how a reader reads it (lens)');

export type ZoneSpecies = z.infer<typeof ZoneSpeciesSchema>;

/**
 * Zone kind — an **open** vocabulary, deliberately a string and not an enum.
 *
 * Adding a kind must add rows, never migrate the schema (zones.md §3). The
 * kinds the model names today are `filesystem`, `git`, `tree`, `package`,
 * `skill`, `plugin`, `marketplace`, `install`, `registry`, `collection`
 * (extents) and `claude-context`, `github-render`, `wiki` (lenses) — but a
 * config-declared zone may name a kind VAT has never heard of, and an adopter
 * declaring an external document library is the motivating case.
 *
 * Was a closed 6-member enum in projection schema v1.
 */
export const ZoneKindSchema = z.string().min(1)
  .describe('Zone kind — open vocabulary, e.g. "git", "tree", "skill", "claude-context"');

/**
 * The role a `tree` extent plays. Meaningful only when `kind === 'tree'`.
 *
 * Lives on the zone **entity**, not on a membership row: a tree's role is a
 * property of the tree, and repeating it on every member was the shape that
 * forced v1's `superRefine` gate onto `resource_zones`.
 */
export const TreeRoleSchema = z.enum(['source', 'dist', 'vendored'])
  .describe('Role of a tree extent');

export type TreeRole = z.infer<typeof TreeRoleSchema>;

/**
 * A row of the `resolution_contexts` table — the half of a zone's identity
 * that **edges and extent memberships key on**: extent + resolution
 * semantics + interpretation + reference-class policy.
 *
 * ## Why this table exists at all
 *
 * A naive "one zone instance per directory" for the `claude-context` lens
 * gives 466 instances in this repository (measured 2026-08-12: 466
 * directories contain at least one tracked file). All 466 share extent,
 * resolution semantics, interpretation, and every part of traversal policy
 * except the ancestry chain — they differ *only in entry point*. With the
 * instance in the edges key, one link in `docs/README.md` produces 466
 * identical rows and the table grows as `O(|references| × |directories|)`.
 *
 * Materialising on demand does not rescue it, because the first named
 * consumer — the always-loaded context budget check — reports a per-directory
 * total, so its parameter set *is* every directory by definition. There is no
 * subset to narrow to.
 *
 * So all 466 share **one** resolution context and get 466 cheap
 * {@link LensEntryPointRowSchema} rows, and the budget check becomes a join.
 *
 * ## `extentContextId` is null exactly when this IS an extent
 *
 * An extent is its own base, so it points at nothing. A lens is always over
 * an extent, so it always points at one. Both directions are enforced.
 */
export const ResolutionContextRowSchema = z.object({
  contextId: z.string().min(1).describe('Stable identifier for this context, unique within a federated query'),
  species: ZoneSpeciesSchema,
  kind: ZoneKindSchema,
  rootId: z.string().min(1).describe('Foreign key to roots.id — the corpus root this context is scoped to'),
  extentContextId: z.string().min(1).nullable()
    .describe('For a lens, the contextId of the extent it reads over. Null for an extent, which is its own base.'),
  role: TreeRoleSchema.nullable().describe('Null unless kind is "tree"'),
}).strict().describe('A row of the path-dependent `resolution_contexts` table. Note: the species/extentContextId correspondence and the tree/role gate are enforced by the Zod schema but not encoded in the generated JSON Schema.')
  .superRefine((row, ctx) => {
    if (row.species === 'extent' && row.extentContextId !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'extentContextId must be null for an extent — an extent is its own base',
        path: ['extentContextId'],
      });
    }
    if (row.species === 'lens' && row.extentContextId === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a lens must name the extent it reads over',
        path: ['extentContextId'],
      });
    }
    if (row.kind !== 'tree' && row.role !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'role is only meaningful when kind is "tree"',
        path: ['role'],
      });
    }
  });

export type ResolutionContextRow = z.infer<typeof ResolutionContextRowSchema>;

/**
 * A row of the `lens_entry_points` table — the *parameter* half of a lens's
 * identity, joining to a shared {@link ResolutionContextRowSchema}.
 *
 * For the `claude-context` lens the parameter is a directory and `ancestry`
 * names the CLAUDE.md chain that directory inherits, nearest ancestor first.
 * Anthropic documents that `@` imports resolve **relative to the importing
 * file** and chain to a maximum depth of four hops, so the chain is a
 * property of the entry point, not of the context.
 *
 * `ancestry` may legitimately be empty: a directory with no context file
 * anywhere above it inherits nothing.
 */
export const LensEntryPointRowSchema = z.object({
  entryPointId: z.string().min(1).describe('Stable identifier for this entry point'),
  contextId: z.string().min(1).describe('Foreign key to resolution_contexts.contextId, species "lens"'),
  parameter: z.string().min(1).describe('The entry parameter — a root-relative directory for claude-context'),
  ancestry: z.array(z.string().min(1))
    .describe('Resource ids this entry point inherits, nearest ancestor first. May be empty.'),
}).strict().describe('A row of the path-dependent `lens_entry_points` table');

export type LensEntryPointRow = z.infer<typeof LensEntryPointRowSchema>;

/**
 * A row of the `zone_provenance` table.
 *
 * ## Why a contributor id alone is not enough
 *
 * Recording *which contributors ran* detects only total absence. Population
 * divergence is a difference in **extent**, and on-demand materialisation
 * makes partial divergence the common case. Concretely: a skill configured
 * `publish: false` is **inside** the extent `vat validate` asks for
 * (packaging correctness is not conditional on shipping) and **outside** the
 * distribution-consistency extent `vat verify` asks for. Both record an
 * identical contributor set. Both report complete. A gate counting broken
 * bundled references returns 12 and 11.
 *
 * So `extentDigest` is **required, not nullable**. A nullable digest would be
 * the weakened claim §7.4 explicitly refuses: it would be cited as protection
 * it does not provide. If the digest cannot be computed for a contributor,
 * that contributor does not get a provenance row and its extent is not
 * declarable by any check — which is the loud failure the design wants.
 */
export const ZoneProvenanceRowSchema = z.object({
  contextId: z.string().min(1).describe('Foreign key to resolution_contexts.contextId'),
  contributorId: z.string().min(1).describe('Identity of the contributor that produced these memberships'),
  parameterSet: JsonValueSchema.describe('The parameters this contributor ran under, verbatim'),
  extentDigest: z.string().min(1)
    .describe('Digest over the membership set this contributor produced — what makes two runs comparable'),
}).strict().describe('A row of the path-dependent `zone_provenance` table');

export type ZoneProvenanceRow = z.infer<typeof ZoneProvenanceRowSchema>;
