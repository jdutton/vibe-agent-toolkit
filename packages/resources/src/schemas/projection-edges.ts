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
 * Which namespace a candidate's {@link EdgeResolutionRowSchema.shape.dstKey}
 * belongs to — **closed**, unlike {@link EdgeKindSchema}.
 *
 * `dstResource` is a foreign key into `resources`, so it can only name
 * something the projection contains. Three real destination classes exist and
 * only one of them satisfies that:
 *
 * - `resource` — in the corpus. `dstResource` is non-null and `dstKey` **is**
 *   that resource id.
 * - `external` — a URL that must never be a resource; projecting it would mean
 *   projecting the web. `dstKey` is the normalized URI (see `dstKey`).
 * - `out-of-corpus` — a target the corpus simply stops short of, including a
 *   declared-but-unwritten one. `dstKey` is the normalized path.
 *
 * Before this column, all three collapsed into `dstResource: null`, which reads
 * as *"resolves to nothing"* and made a dangling-link count a fiction: it could
 * not separate "dead" from "outside the corpus".
 *
 * ## Closed on purpose
 *
 * The other two vocabularies here are open strings because a lens may
 * legitimately invent a kind or a tier. This one is not a lens's to extend: it
 * says which namespace `dstKey` is drawn from, and a fourth namespace changes
 * what a `GROUP BY (dstKind, dstKey)` means for every existing row. That is a
 * design change, and `.strict()` on a closed enum is what makes it arrive as a
 * failed parse rather than as a silently mis-grouped result.
 *
 * ## 🚨 This is a *class*, not an existence verdict
 *
 * `out-of-corpus` does **not** mean "dead", and nothing here says whether the
 * target exists. Nothing in the projection stats a path outside the population
 * — `RealizationConditionRowSchema.observed` is explicitly null for
 * `CLOSURE_REFERENCE_OUTSIDE_ROOT` — so a genuinely dead target and a live
 * out-of-corpus one are both `out-of-corpus` and are not told apart here.
 * Separating them needs a verdict column fed by something that actually
 * *looked*, which is a decision the design has not taken. See zones.md §5.
 */
export const EdgeDestinationKindSchema = z.enum(['resource', 'external', 'out-of-corpus'])
  .describe('Which namespace dstKey is drawn from — a destination CLASS, never an existence verdict');

export type EdgeDestinationKind = z.infer<typeof EdgeDestinationKindSchema>;

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
 * ## ⭐ There is no resolution column, and that is the correction
 *
 * This schema used to carry `resolution` — one open string mixing two
 * different vocabularies:
 *
 * - a **reachability tier** (`same-plugin`, `same-marketplace`,
 *   `auth-required`, `nonexistent`), and
 * - an **edge verdict** (`resolved`, `ambiguous`, `nonexistent`).
 *
 * Both were wrong here, for different reasons.
 *
 * **The tier grades a candidate, not an edge.** Every tier in that list is a
 * statement about a *target* — whether **it** is co-bundled, installable, or
 * dead. An edge with two candidates, one co-bundled and one in an uninstalled
 * marketplace, has no single tier, so one string on this table cannot describe
 * it. The tier now lives on {@link EdgeResolutionRowSchema}, once per candidate.
 *
 * **The verdict is derived, so storing it invites drift.** `resolved` /
 * `ambiguous` / `nonexistent` is a count over this edge's candidate rows — one
 * `GROUP BY (src, refOrdinal, contextId)` — and a stored copy is a second
 * source of truth that nothing keeps in step with the first. The same argument
 * this repository makes against a hand-maintained version integer applies
 * unchanged: derive it from the shape rather than authoring it beside the shape.
 *
 * Note the two absences a consumer can already read, without a verdict column:
 * an edge with **zero** candidate rows is one the lens looked at and found
 * nothing for, while an edge with a candidate whose `dstKind` is `external` or
 * `out-of-corpus` has a real, identifiable destination the corpus does not
 * contain. Those are different facts, and the old single column conflated them.
 */
export const EdgeRowSchema = z.object({
  src: z.string().min(1).describe(SRC_DESC),
  refOrdinal: z.number().int().nonnegative().nullable().describe(REF_ORDINAL_DESC),
  contextId: z.string().min(1).describe(CONTEXT_DESC),
  kind: EdgeKindSchema,
  origin: EdgeOriginSchema,
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
 * ## `dstKey` — one grouping key across three destination classes
 *
 * *"Which document is cited most often?"* and *"which references can be
 * deduplicated?"* are both `GROUP BY destination`, and before `dstKey` an
 * external destination had no key to group on: its identity survived only as
 * unnormalized text in `blob_references.rawRef`, where `https://x/y`,
 * `https://x/y#frag` and `https://X/y` are three strings for one destination.
 *
 * ⚠️ **The grouping key is the pair `(dstKind, dstKey)`, never `dstKey`
 * alone.** Three namespaces share the column, so a bare `GROUP BY dstKey`
 * cannot say what class it grouped without re-parsing the key string — which
 * is the same "identity survives only as text" failure moved one column over.
 *
 * How each class keys itself:
 *
 * - **`resource`** — the resource id, which is already
 *   `hash(rootId, canonicalPath)` and already opaque. `dstKey === dstResource`
 *   is enforced below rather than left as a convention, so the uniform
 *   `GROUP BY` is a fact about the data instead of a hope about its producers.
 * - **`external`** — the normalized URI: scheme and host lowercased (RFC 3986
 *   §3.2.2 makes both case-insensitive), a default port for the scheme
 *   removed, **any `user:pw@` userinfo cleared** — this column is printed
 *   verbatim by `vat resources query`, so retaining it republishes a credential
 *   — and **path, query and fragment left exactly as authored**. Path
 *   case is significant on any case-sensitive server, so a blanket case-fold
 *   would merge genuinely distinct targets. The fragment is *removed* from the
 *   key — it names a location within a destination, and two links to `#a` and
 *   `#b` of one page cite the same page — and is carried on `dstAnchor`.
 * - **`out-of-corpus`** — the normalized path, forward-slashed and
 *   lexically resolved (`.`/`..` collapsed), relative to the corpus root.
 *
 * ⚠️ **`dstKey` is NOT stable across extent widening, by design.** Widening an
 * extent moves a destination out of `out-of-corpus` and into `resource`: the
 * key changes *class*, not merely value — and widening is the design's
 * preferred answer wherever it is available, since a reachable out-of-corpus
 * target is evidence the extent was drawn too small. This is recorded rather
 * than engineered away, because the alternative is a key that lies about which
 * class a destination is in. `dstKind` is what makes the change legible: a
 * cross-run comparator that keys on the pair sees a class change as a change,
 * instead of silently mis-grouping. The same applies on the `out-of-corpus`
 * branch to case-only renames, symlinks, and one relative link resolved from
 * two bundle roots — that branch has no identity service the way the `resource`
 * branch has `identity.ts`.
 *
 * ## `tier` and `score` are both nullable, for the same reason
 *
 * `score` is null for a certain resolution — a markdown link that resolves is
 * not 100% confident, it is simply resolved, and a fabricated 1.0 would make
 * "has a score" stop meaning "was inferred".
 *
 * `tier` is null on exactly that argument: it is the reader's *reachability*
 * verdict on this candidate, and a lens with no reachability model has no
 * honest value to write. A fabricated `resolved` would make "has a tier" stop
 * meaning "reachability was assessed".
 */
export const EdgeResolutionRowSchema = z.object({
  src: z.string().min(1).describe(SRC_DESC),
  refOrdinal: z.number().int().nonnegative().nullable().describe(REF_ORDINAL_DESC),
  contextId: z.string().min(1).describe(CONTEXT_DESC),
  candidateOrdinal: z.number().int().nonnegative()
    .describe('0-based rank among this edge\'s candidates — 0 is the best candidate this context found'),
  dstKind: EdgeDestinationKindSchema,
  dstKey: z.string().min(1)
    .describe('Canonical destination key within dstKind\'s namespace — GROUP BY the PAIR (dstKind, dstKey), never this column alone. Equals dstResource when dstKind is "resource"; a normalized fragment-less URI for "external"; a normalized root-relative path for "out-of-corpus". NOT stable across extent widening: widening moves a destination between classes'),
  dstResource: z.string().min(1).nullable()
    .describe('Resolved target resource id — non-null exactly when dstKind is "resource", so null is the FACT that the target is not in THE EVALUATING LENS\'S EXTENT — the corpus for that lens, not the tree — rather than an absence standing in for several. Which destination class it is instead is dstKind. A count of nulls is therefore NOT a dangling-link count: it sums the external and out-of-corpus classes, and an external URL is not broken at all — `SELECT dstKind, COUNT(*) FROM edge_resolutions WHERE dstResource IS NULL GROUP BY dstKind` shows that split on your own corpus. The out-of-corpus half is lens-relative on top of that, varying by an order of magnitude between two lenses over the identical tree, so it is not a defect count either unless the lens\'s extent IS the tree'),
  // `.min(1)` because an empty anchor is not "an anchor that is empty" — it is
  // the ABSENCE of one, which is spelled null. Every sibling string column
  // carries the same floor; this one did not, so `resourceDestination(id, '')`
  // produced a row that parsed while making "has an anchor" true for a
  // reference naming no section.
  dstAnchor: z.string().min(1).nullable()
    .describe('Fragment target, or null. For dstKind "resource" it joins blob_sections.slug (via resources → resource_realizations.contentKey, and a consumer must say WHICH realization: a packaged resource\'s source and dist bytes differ). For "external" and "out-of-corpus" it is the raw fragment, which nothing in the projection can resolve'),
  tier: z.string().min(1).nullable()
    .describe('Reachability tier for THIS candidate — open vocabulary, e.g. "same-plugin", "same-marketplace", "known-other-marketplace", "auth-required", "nonexistent". Null when the lens has no reachability model, so that "has a tier" keeps meaning "reachability was assessed"'),
  score: z.number().min(0).max(1).nullable()
    .describe('Confidence for an inferred candidate, or null for a certain resolution'),
}).strict().describe('A row of the path-dependent `edge_resolutions` table. Note: the dstKind/dstResource correspondence and the dstKey-equals-dstResource rule for the resource class are enforced by the Zod schema but NOT encoded in the generated JSON Schema — a consumer validating against the published artifact alone must treat both as producer convention.')
  .superRefine((row, ctx) => {
    const isResource = row.dstKind === 'resource';
    if (isResource !== (row.dstResource !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: isResource
          ? 'a candidate in the corpus must name its target, so dstResource is required when dstKind is "resource"'
          : 'dstResource is a foreign key into `resources`, so it must be null for a destination outside the corpus',
        path: ['dstResource'],
      });
      return;
    }
    if (isResource && row.dstKey !== row.dstResource) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a resource destination keys itself on its own resource id, so dstKey must equal dstResource',
        path: ['dstKey'],
      });
    }
  });

export type EdgeResolutionRow = z.infer<typeof EdgeResolutionRowSchema>;
