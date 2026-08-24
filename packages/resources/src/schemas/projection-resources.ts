import { z } from 'zod';

import { ContentKeySchema, JsonValueSchema, ProjectionConditionSeveritySchema } from './projection-shared.js';

const EXTENT_FK_DESC = 'Foreign key to resolution_contexts.contextId, species "extent"';

/**
 * A row of the `roots` table — a federated corpus root.
 *
 * A table, not an implicit singleton: resource-projection.md §3 is explicit
 * that federating sibling corpora (two projects queried together) must stay
 * additive, which requires `path` alone to never be assumed unique — see
 * {@link ResourceRealizationRowSchema}'s note on the same point.
 */
export const RootRowSchema = z.object({
  id: z.string().min(1).describe('Stable identifier for this root, unique within a federated query'),
  path: z.string().min(1).describe('Absolute filesystem path this root was crawled from'),
}).strict().describe('A row of the path-dependent `roots` table');

export type RootRow = z.infer<typeof RootRowSchema>;

/**
 * Entity kind — an **open** vocabulary, because `resources` is an entity
 * table, not a file table.
 *
 * Zero realizations is legal: a plugin named in a marketplace manifest but
 * not installed has no local path — known, but not present. Plugins, skills,
 * marketplaces and external document libraries are all linkable resources
 * that are not markdown content, and each needs a kind VAT may not ship an
 * enum member for.
 */
export const ResourceKindSchema = z.string().min(1)
  .describe('Entity kind — open vocabulary, e.g. "file", "directory", "skill", "plugin", "marketplace"');

/**
 * A row of the `resources` table — **one identity**, however many paths it
 * is realized at.
 *
 * ## The origin zone is an attribute, never part of the hash
 *
 * `resourceId = hash(rootId, canonicalPath at first observation)`, opaque.
 * An earlier design hashed the *originating zone* alongside the path, and it
 * failed twice over:
 *
 * 1. **No precedence.** One file is simultaneously in `filesystem`, `git`,
 *    `tree:source`, `package:X` and `skill:Y`. All five plausibly
 *    "originate" it, nothing defined which wins, so the id was undefined.
 * 2. **Phase-dependence.** `vat build` populates at least twice, because the
 *    dist extent does not exist before the build. A stale artifact under
 *    `dist/` is `filesystem`-only pre-build and `tree:dist` post-build, so
 *    the same bytes at the same path mint **two ids inside one run** — and
 *    the source→bundle survival lens joins across exactly those two
 *    populations.
 *
 * The fix is not a precedence rule. Nothing ever reads the zone back out of
 * an opaque hash: it was doing zero work while creating two failure modes.
 * `origin` records where the knowledge came from as a queryable attribute.
 *
 * ## `canonicalPath` has an explicit rule
 *
 * **Git's own spelling for any path `git ls-files` lists — tracked *or*
 * untracked-but-unignored — otherwise the on-disk casing from
 * `realpathSync.native`, with symlinks resolved.** Not optional
 * precision: `pathLower`/`basenameLower` exist so case-insensitive matching
 * is a column rather than a function call, and hashing a raw path defeats
 * them — on a case-insensitive filesystem `docs/Readme.md` seen through the
 * filesystem extent and `docs/README.md` recorded in git's index would mint
 * two identities for one inode. Node's two `realpath` implementations
 * disagree about which casing they return, so this is not hypothetical.
 *
 * 🪤 **The consequence is NOT that a symlink and its target share one
 * identity.** Git's branch is taken first, so wherever git lists the path the
 * `realpath` fallback is never reached and the two spellings mint two ids. The
 * collapse holds only where git does not answer, and there a symlinked directory
 * loop mints one identity per real file rather than one per traversal. The
 * mechanism, the measurement and the still-open "should it realpath?" question
 * are written up once, under *"🪤 A symlink and its target do NOT reliably share
 * one identity"* in `src/projection/identity.ts` — do not restate them here.
 *
 * Every path-shaped and byte-shaped column lives on
 * {@link ResourceRealizationRowSchema} instead.
 */
export const ResourceRowSchema = z.object({
  resourceId: z.string().min(1).describe('hash(rootId, canonicalPath at first observation) — opaque'),
  kind: ResourceKindSchema,
  origin: z.string().min(1)
    .describe('Where this row\'s knowledge came from. Deliberately an open string, not an enum: resource-scanning-and-caching.md has not yet settled the full non-git-lane taxonomy this column needs to cover.'),
  observed: z.boolean()
    .describe('False for a synthetic entity declared by config (e.g. a packaging files: target, or a plugin named in a marketplace manifest) that has never been seen'),
  fromEnumeration: z.boolean()
    .describe('False for an entity first discovered during parse (e.g. a resolved link target) and back-filled afterward'),
  vatId: z.string().nullable().describe('VAT-assigned resource id (frontmatter id, or a generated fallback), or null when not yet assigned'),
}).strict().describe('A row of the path-dependent `resources` table — one entity, zero or more realizations');

export type ResourceRow = z.infer<typeof ResourceRowSchema>;

/**
 * Why {@link ResourceRealizationRowSchema.shape.contentKey} is null — a
 * **closed** vocabulary, because the whole point of the column is that the
 * four cases must never collapse into one another.
 *
 * Before this column, `contentKey: null` said "directory", "absent",
 * "dangling symlink" and "the read threw" in one breath, and demand-driven
 * keying was about to add a fifth reading, "nobody asked for these bytes yet".
 * An unreadable file being indistinguishable from an un-visited one is exactly
 * the completeness failure `zone_provenance.extentDigest` exists to prevent: a
 * consumer counting null keys could no longer tell a corpus it failed to read
 * from a corpus it deliberately did not read.
 *
 * - `keyed` — the bytes were read and hashed; `contentKey` holds that hash.
 * - `deferred` — this path has bytes, but no consumer has asked for them yet,
 *   so they were never read. **This is not a failure**, and it is the only
 *   member that a later pass can legitimately turn into `keyed`.
 * - `unreadable` — a read was attempted and it threw. A fact about the corpus
 *   (a permissions quirk, a vanished file), never an error in the harness.
 * - `none` — there are no bytes here to key at all: the path is absent, or a
 *   directory, or a dangling symlink.
 */
export const ContentStateSchema = z.enum(['keyed', 'deferred', 'unreadable', 'none'])
  .describe('Why this realization does or does not carry a content key');

export type ContentState = z.infer<typeof ContentStateSchema>;

/**
 * A row of the `resource_realizations` table — **one path in one extent**.
 *
 * One source file bundled into three skills is one identity and four
 * realizations. A file generated only into a build tree is minted there.
 *
 * ## Why these columns live here and not on the identity
 *
 * `contentKey` forces the issue. The packager **rewrites content** on the way
 * into a bundle — `buildRewriteRules` / `transformContent`
 * (`skill-packager.ts:729-754`) repoint every bundled link at its flattened
 * dist path — so a resource's dist realization has different bytes and a
 * different content key from its source realization. A scalar
 * `resources.contentKey` would make the `resource → blob` join undefined for
 * any multi-zone resource, and every blob-derived fact (tokens, sections,
 * references) depends on that join.
 *
 * `gitignored` is the second obvious one: it is a *git-extent* fact, and the
 * proving ladder's visible-to-you/invisible-to-CI rung reads exactly this
 * column.
 *
 * ## `(extentId, path)` is unique
 *
 * The inverse of one-identity-many-paths also occurs in shipped code:
 * `skill-packager.ts:624` and `:1094` record that `a-b/c.html` and
 * `a/b-c.html` both flatten to `a-b-c-html`, and `files:` remapping can
 * produce the same condition. A contributor that would emit a second
 * realization at an occupied path emits a
 * {@link RealizationConditionRowSchema} row instead — preserving the
 * diagnostic that `registerBundledAssets`' `DuplicateResourceIdError` catch
 * is currently the only carrier of, and stopping any consumer resolving
 * `(extentId, path)` from getting a nondeterministic answer.
 *
 * Uniqueness is a population invariant, not a Zod constraint: a single row
 * cannot observe it. It is asserted by the population layer and by the
 * differential validation harness.
 *
 * `path` is root-relative and NEVER a standalone identifier — the root comes
 * from `resolution_contexts.rootId` via `extentId`, so a federated query over
 * two roots that happen to share a relative path stays unambiguous.
 */
export const ResourceRealizationRowSchema = z.object({
  resourceId: z.string().min(1).describe('Foreign key to resources.resourceId — the shared identity'),
  extentId: z.string().min(1).describe(EXTENT_FK_DESC),
  path: z.string().min(1).describe('Root-relative path, forward-slash separated'),
  pathLower: z.string().describe('path, lowercased — case-insensitive matching as a column, not a function call'),
  basenameLower: z.string().describe('The final path segment, lowercased'),
  dir: z.string().describe('Root-relative directory containing this path'),
  depth: z.number().int().nonnegative().describe('Path segment count below the root'),
  ext: z.string().describe('Lowercased extension including the leading dot, or "" when none'),
  contentKey: ContentKeySchema.nullable()
    .describe('Foreign key to blobs.contentKey for THIS realization\'s bytes, or null — read contentState for WHICH of the three null cases this is'),
  contentState: ContentStateSchema
    .describe('Why contentKey is or is not set. Pinned to contentKey in BOTH directions by a superRefine (keyed ⟺ non-null); like symlinkResolves, that constraint is NOT encoded in the generated JSON Schema'),
  mtime: z.coerce.date().nullable().describe('Last modification time, or null when nothing stat-ed this path — it is absent, or its shape came from git rather than from the filesystem'),
  exists: z.boolean(),
  isDirectory: z.boolean(),
  gitignored: z.boolean(),
  isSymlink: z.boolean(),
  symlinkResolves: z.boolean().nullable().describe('Null when isSymlink is false'),
}).strict().describe('A row of the path-dependent `resource_realizations` table. Note: symlinkResolves must be null when isSymlink is false; this constraint is enforced by the Zod schema but not encoded in the generated JSON Schema.')
  .superRefine((row, ctx) => {
    if (!row.isSymlink && row.symlinkResolves !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'symlinkResolves must be null when isSymlink is false',
        path: ['symlinkResolves'],
      });
    }
    // Both directions, because either half alone leaves a lie representable: a
    // `keyed` row with no key claims bytes it cannot name, and a keyed row
    // labelled `deferred`/`unreadable`/`none` says the read never happened
    // while carrying its result.
    if (row.contentState === 'keyed' && row.contentKey === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'contentState "keyed" requires a non-null contentKey',
        path: ['contentState'],
      });
    }
    if (row.contentState !== 'keyed' && row.contentKey !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `contentState must be "keyed" when contentKey is non-null, not "${row.contentState}"`,
        path: ['contentState'],
      });
    }
  });

export type ResourceRealizationRow = z.infer<typeof ResourceRealizationRowSchema>;

/**
 * A row of the `resource_extents` table — this resource is a member of this
 * extent. Nothing more.
 *
 * There is deliberately **no visibility relation** in the model. "The build
 * extent cannot see source" is simply what happens when a reference's target
 * is not a member of that extent, so it resolves to nothing. That is the
 * mechanism behind the `files:`-blindness defect family, converted from a
 * behaviour contributors must remember into a row anyone can query.
 *
 * Renamed from `resource_zones`, and stripped of `zoneKind` and `role`: both
 * are properties of the zone **entity** (`resolution_contexts`), and carrying
 * them on every membership row is what forced the tree/role `superRefine`
 * gate onto a table that had no business enforcing it.
 */
export const ResourceExtentRowSchema = z.object({
  resourceId: z.string().min(1).describe('Foreign key to resources.resourceId'),
  extentId: z.string().min(1).describe(EXTENT_FK_DESC),
}).strict().describe('A row of the path-dependent `resource_extents` table');

export type ResourceExtentRow = z.infer<typeof ResourceExtentRowSchema>;

/**
 * A row of the `realization_conditions` table — a population-time condition
 * about a path in an extent, chiefly the `(extentId, path)` collision that
 * uniqueness makes unrepresentable as a second realization.
 *
 * `skill-packager.ts:624` and `:1094` record that `a-b/c.html` and
 * `a/b-c.html` both flatten to `a-b-c-html`, and `registerBundledAssets`'
 * comment states that its `DuplicateResourceIdError` catch is **the only
 * place a bundled-asset collision is ever observable** — drop the structured
 * error there and the fact is gone. This table is where that fact goes
 * instead, so making `(extentId, path)` unique costs no diagnostic.
 *
 * `resourceId` is the identity that could NOT be realized at this path
 * (the loser of the collision), or null for a condition with no identity
 * attached.
 *
 * ## The six provenance columns, and why they are columns rather than a table
 *
 * A condition that a **reference** provoked can say which reference. The
 * closure contributor's reference-borne codes are the motivating set —
 * `CLOSURE_REFERENCE_UNRESOLVED`, `CLOSURE_REFERENCE_OUTSIDE_ROOT`,
 * `CLOSURE_DEPTH_EXCEEDED` and every refusal label a declaration
 * supplies — and they are exactly the facts `walk-link-graph.ts`'s
 * `LinkResolution` already carries (`sourcePath`, `sourceLine`, `linkHref`,
 * `targetExists`, `matchedRule`), which `walker-to-issues.ts` turns into an
 * issue location and `packaging-validator.ts` reads `patterns[0]` off. Without
 * them a projection can say *that* a file was turned away and *why*, but not
 * *where the author should look* — so no consumer of the projection can produce
 * the issue the shipped walker produces.
 *
 * **Columns, not a sibling table.** The relation is 1:1 with the row: the
 * table's key is `(extentId, path, code, resourceId)`, so a target refused
 * through three references records ONE row, and a sibling table would be a
 * one-to-one join keyed on a four-column composite — a join that buys nothing
 * and an FK no other table in the projection has. Sparsity is not an argument
 * against: `symlinkResolves`, `resourceId` and `vatId` are all "null unless
 * this row is that kind of row", and the alternative — an absent key — is the
 * two-null-states failure {@link ContentStateSchema} exists to prevent.
 *
 * **Null is the answer for every condition no reference provoked**, and that
 * is a documented reading rather than a gap: `REALIZATION_PATH_COLLISION` is a
 * fact about two identities meeting at one path, and `CLOSURE_ROOT_ABSENT`
 * about a declaration naming a path nothing realized. Neither has a referring
 * file, a line, or an href to name. Spread
 * {@link CONDITION_WITHOUT_REFERENCE} at those sites so the intent is stated
 * rather than inferred from six null literals.
 *
 * ⚠️ **The provenance is ONE witness, not the list.** The table's grain is
 * unchanged — the key does not include these columns, so `ProjectionBuilder`
 * keeps the first row and drops the rest, and the surviving row names the
 * first reference that provoked the condition (first in blob order, then
 * `blob_references.ordinal`). A consumer that needs every reference to a
 * refused path reads `blob_references`, which is where that list lives.
 *
 * `sourcePath` repeats `path` for a condition anchored to the referring file
 * (`CLOSURE_REFERENCE_UNRESOLVED` names the file an author can open, since its
 * target realizes nowhere), and differs from it for one anchored to the target
 * (a refusal names the refused file). Both spellings stay readable without a
 * join precisely because the column is always the *referring* file.
 */
export const RealizationConditionRowSchema = z.object({
  extentId: z.string().min(1).describe(EXTENT_FK_DESC),
  path: z.string().min(1)
    .describe('Path the condition is about, stated against the root. Root-relative for every condition about something the projection realizes, and "../"-prefixed for the one class that is deliberately about a path OUTSIDE the root (CLOSURE_REFERENCE_OUTSIDE_ROOT): a reference may name a real file the population was never defined over, and the row has to be able to name it. Never a bare absolute path.'),
  code: z.string().min(1).describe('An enum member, e.g. "REALIZATION_PATH_COLLISION" — open vocabulary'),
  severity: ProjectionConditionSeveritySchema,
  message: z.string(),
  resourceId: z.string().min(1).nullable().describe('The identity this condition concerns, or null'),
  sourcePath: z.string().min(1).nullable()
    .describe('Root-relative path of the file whose reference provoked this condition — the file an author opens. Null when no reference provoked it (a collision, an absent declared root).'),
  sourceLine: z.number().int().positive().nullable()
    .describe('1-based line of that reference within sourcePath, or null when no reference provoked this condition. The reference\'s column is deliberately NOT carried: nothing consumes it, and a column with no consumer and no counterpart to compare against cannot be shown to be right.'),
  sourceRef: z.string().nullable()
    .describe('The reference exactly as authored (blob_references.rawRef — anchor and all), or null when no reference provoked this condition. Not min(1): an empty href is authorable markdown.'),
  targetExists: z.boolean().nullable()
    .describe('Whether the referenced target existed when the contributor classified it. Null when nothing observed the target — including CLOSURE_REFERENCE_UNRESOLVED, where "no realization holds this path" is a statement about the projection and not about the filesystem, and CLOSURE_REFERENCE_OUTSIDE_ROOT, where the target lies outside the population entirely. A consumer comparing this column against a walker that stats the path must exclude those two codes rather than read the null as "absent".'),
  matchedPattern: z.string().min(1).nullable()
    .describe('The FIRST glob declared by the refusal rule that matched — the rule\'s identifying pattern, read the same way packaging-validator.ts reads matchedRule.patterns[0]. Names WHICH rule, not which of its globs fired; the code column already says why. Null when the matching rule declares no patterns (it refused by basename, kind or flag), and for every condition no refusal rule produced.'),
  matchedPayload: JsonValueSchema
    .describe('The matched refusal rule\'s OPAQUE payload, copied verbatim from the declaration and never interpreted — the channel for caller vocabulary the primitive has no column for (the skill translation carries an excludeReferencesFromBundle rule\'s index and its template here). Null when the rule declared none, and for every condition no refusal rule produced.'),
}).strict().describe('A row of the path-dependent `realization_conditions` table');

export type RealizationConditionRow = z.infer<typeof RealizationConditionRowSchema>;

/**
 * The six provenance columns, all null — a condition **no reference provoked**.
 *
 * Spread at every such producer (`REALIZATION_PATH_COLLISION`,
 * `CLOSURE_ROOT_ABSENT`, the package and plugin extents' locate failures) so
 * the row states "there is no reference behind this" once, by name, instead of
 * repeating six null literals that a reader has to recognise as a set.
 */
export const CONDITION_WITHOUT_REFERENCE = {
  sourcePath: null,
  sourceLine: null,
  sourceRef: null,
  targetExists: null,
  matchedPattern: null,
  matchedPayload: null,
} as const satisfies Pick<
  RealizationConditionRow,
  'sourcePath' | 'sourceLine' | 'sourceRef' | 'targetExists' | 'matchedPattern' | 'matchedPayload'
>;

/**
 * Where a tag came from — an **open** vocabulary that IS the contributor id.
 *
 * Was a closed 5-member enum (`filename`, `config`, `frontmatter`, `zone`,
 * `harness-convention`) in projection schema v1. Extensible tagging is meant
 * to add no plugin API, so a config-declared contributor must be able to name
 * itself here without a schema migration. The five historical members remain
 * valid values.
 */
export const ResourceTagSourceSchema = z.string().min(1)
  .describe('Contributor id that produced this tag — open vocabulary, e.g. "filename", "config", "frontmatter"');

/**
 * A row of the `resource_tags` table — the open-vocabulary tagging
 * mechanism agentic-convention modeling (resource-projection.md §3) and
 * general classification both build on.
 */
export const ResourceTagRowSchema = z.object({
  resourceId: z.string().min(1),
  tag: z.string().min(1),
  value: z.string().nullable().describe('Null for a boolean-presence tag with no associated value'),
  source: ResourceTagSourceSchema,
}).strict().describe('A row of the path-dependent `resource_tags` table');

export type ResourceTagRow = z.infer<typeof ResourceTagRowSchema>;
