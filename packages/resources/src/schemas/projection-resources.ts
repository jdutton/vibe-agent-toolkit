import { z } from 'zod';

import { ContentKeySchema } from './projection-shared.js';
import { LinkTypeSchema } from './resource-metadata.js';

/**
 * A row of the `roots` table — a federated corpus root.
 *
 * A table, not an implicit singleton: resource-projection.md §3 is explicit
 * that federating sibling corpora (two projects queried together) must stay
 * additive, which requires `path` alone to never be assumed unique — see
 * {@link ResourceRowSchema}'s note on the same point.
 */
export const RootRowSchema = z.object({
  id: z.string().min(1).describe('Stable identifier for this root, unique within a federated query'),
  path: z.string().min(1).describe('Absolute filesystem path this root was crawled from'),
}).strict().describe('A row of the path-dependent `roots` table');

export type RootRow = z.infer<typeof RootRowSchema>;

/**
 * A row of the `resources` table — one per path VAT knows about, whether or
 * not it has been read.
 *
 * `path` is root-relative and NEVER a standalone identifier — always pair it
 * with `rootId`, or a federated query over two roots that happen to share a
 * relative path becomes ambiguous (resource-projection.md §3).
 */
export const ResourceRowSchema = z.object({
  rootId: z.string().min(1).describe('Foreign key to roots.id'),
  path: z.string().min(1).describe('Root-relative path, forward-slash separated'),
  pathLower: z.string().describe('path, lowercased — case-insensitive matching as a column, not a function call'),
  basenameLower: z.string().describe('The final path segment, lowercased'),
  contentKey: ContentKeySchema.nullable()
    .describe('Foreign key to blobs.contentKey, or null for a declared-but-unwritten node'),
  dir: z.string().describe('Root-relative directory containing this path'),
  depth: z.number().int().nonnegative().describe('Path segment count below the root'),
  ext: z.string().describe('Lowercased extension including the leading dot, or "" when none'),
  mtime: z.coerce.date().nullable().describe('Last modification time, or null when the node has never been observed on disk'),
  vatId: z.string().nullable().describe('VAT-assigned resource id (frontmatter id, or a generated fallback), or null when not yet assigned'),
  origin: z.string().min(1)
    .describe('Where this row\'s content-key knowledge came from. Deliberately an open string, not an enum: resource-scanning-and-caching.md has not yet settled the full non-git-lane taxonomy this column needs to cover.'),
  observed: z.boolean().describe('False for a synthetic node declared by config (e.g. a packaging files: target) that has not been written yet'),
  fromEnumeration: z.boolean().describe('False for a node first discovered during parse (e.g. a resolved link target) and back-filled afterward'),
  exists: z.boolean(),
  isDirectory: z.boolean(),
  gitignored: z.boolean(),
  isSymlink: z.boolean(),
  symlinkResolves: z.boolean().nullable().describe('Null when isSymlink is false'),
}).strict().describe('A row of the path-dependent `resources` table. Note: symlinkResolves must be null when isSymlink is false; this constraint is enforced by the Zod schema but not encoded in the generated JSON Schema.')
  .superRefine((row, ctx) => {
    if (!row.isSymlink && row.symlinkResolves !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'symlinkResolves must be null when isSymlink is false',
        path: ['symlinkResolves'],
      });
    }
  });

export type ResourceRow = z.infer<typeof ResourceRowSchema>;

/**
 * A row of the `resource_realizations` table — one resource id can have many
 * paths (e.g. a source registry and a build-output registry sharing node
 * identity). See resource-projection.md §3, requirement 1.
 */
export const ResourceRealizationRowSchema = z.object({
  resourceId: z.string().min(1).describe('The shared identity across realizations'),
  zoneId: z.string().min(1).describe('Foreign key to resource_zones.zoneId'),
  path: z.string().min(1).describe('Root-relative path this realization lives at'),
}).strict().describe('A row of the path-dependent `resource_realizations` table');

export type ResourceRealizationRow = z.infer<typeof ResourceRealizationRowSchema>;

export const ZoneKindSchema = z.enum(['skill', 'plugin', 'marketplace', 'collection', 'package', 'tree']);
export const TreeZoneRoleSchema = z.enum(['source', 'dist', 'vendored']);

/**
 * A row of the `resource_zones` table.
 *
 * `role` is meaningful only when `zoneKind === 'tree'` (source vs. dist vs.
 * vendored) — enforced below rather than left as a comment, since the
 * distinction is easy to get wrong silently.
 */
export const ResourceZoneRowSchema = z.object({
  resourceId: z.string().min(1),
  zoneKind: ZoneKindSchema,
  zoneId: z.string().min(1),
  role: TreeZoneRoleSchema.nullable(),
}).strict().describe('A row of the path-dependent `resource_zones` table. Note: role is only meaningful when zoneKind is "tree"; this constraint is enforced by the Zod schema but not encoded in the generated JSON Schema.')
  .superRefine((row, ctx) => {
    if (row.zoneKind !== 'tree' && row.role !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'role is only meaningful when zoneKind is "tree"',
        path: ['role'],
      });
    }
  });

export type ResourceZoneRow = z.infer<typeof ResourceZoneRowSchema>;

/**
 * A row of the `resource_tags` table — the open-vocabulary tagging
 * mechanism agentic-convention modeling (resource-projection.md §3) and
 * general classification both build on.
 */
export const ResourceTagSourceSchema = z.enum(['filename', 'config', 'frontmatter', 'zone', 'harness-convention']);

export const ResourceTagRowSchema = z.object({
  resourceId: z.string().min(1),
  tag: z.string().min(1),
  value: z.string().nullable().describe('Null for a boolean-presence tag with no associated value'),
  source: ResourceTagSourceSchema,
}).strict().describe('A row of the path-dependent `resource_tags` table');

export type ResourceTagRow = z.infer<typeof ResourceTagRowSchema>;

/**
 * A row of the `edges` table — one row per authored link, resolved.
 *
 * `zoneId` is part of the identity, not an afterthought: resolution is
 * per-zone (the same link can resolve differently depending on which
 * skill/plugin/collection is doing the resolving), and an earlier draft of
 * this design that omitted it from the key is the requirement this column
 * exists to satisfy (resource-projection.md §3).
 */
export const EdgeRowSchema = z.object({
  src: z.string().min(1).describe('Source resource id'),
  linkOrdinal: z.number().int().nonnegative().describe('Matches blob_links.ordinal for the src blob'),
  zoneId: z.string().min(1).describe('Which zone this resolution applies to'),
  dstResource: z.string().nullable().describe('Resolved target resource id, or null when unresolved/external'),
  dstAnchor: z.string().nullable().describe('Fragment target, or null'),
  kind: LinkTypeSchema,
  resolution: z.string().min(1).describe('Resolution state — open vocabulary, e.g. "resolved", "unresolved", "excluded"'),
}).strict().describe('A row of the path-dependent `edges` table');

export type EdgeRow = z.infer<typeof EdgeRowSchema>;
