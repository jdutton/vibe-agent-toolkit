import { z } from 'zod';

import { ContentKeySchema, ProjectionConditionSeveritySchema } from './projection-shared.js';

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
 * **Git-index casing where the path is tracked, otherwise the on-disk casing
 * from `fs/promises.realpath`, with symlinks resolved.** Not optional
 * precision: `pathLower`/`basenameLower` exist so case-insensitive matching
 * is a column rather than a function call, and hashing a raw path defeats
 * them — on a case-insensitive filesystem `docs/Readme.md` seen through the
 * filesystem extent and `docs/README.md` recorded in git's index would mint
 * two identities for one inode. Node's two `realpath` implementations
 * disagree about which casing they return, so this is not hypothetical.
 * Consequences: a symlink and its target share one identity; a symlinked
 * directory loop mints one identity per real file, not per traversal.
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
 * A row of the `resource_realizations` table — **one path in one extent**.
 *
 * One source file bundled into three skills is one identity and four
 * realizations. A file generated only into a build tree is minted there.
 *
 * ## Why twelve columns live here and not on the identity
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
    .describe('Foreign key to blobs.contentKey for THIS realization\'s bytes, or null for a declared-but-unwritten node'),
  mtime: z.coerce.date().nullable().describe('Last modification time, or null when this path has never been observed on disk'),
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
 */
export const RealizationConditionRowSchema = z.object({
  extentId: z.string().min(1).describe(EXTENT_FK_DESC),
  path: z.string().min(1).describe('Root-relative path the condition is about'),
  code: z.string().min(1).describe('An enum member, e.g. "REALIZATION_PATH_COLLISION" — open vocabulary'),
  severity: ProjectionConditionSeveritySchema,
  message: z.string(),
  resourceId: z.string().min(1).nullable().describe('The identity this condition concerns, or null'),
}).strict().describe('A row of the path-dependent `realization_conditions` table');

export type RealizationConditionRow = z.infer<typeof RealizationConditionRowSchema>;

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
