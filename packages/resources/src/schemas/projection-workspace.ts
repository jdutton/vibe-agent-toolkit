/**
 * The workspace relations: which `package.json` files are members of a root's npm, yarn, bun or
 * pnpm workspace, and what each member's dependencies link. Derived per run by the workspace
 * resolve step (`projection/workspace-packages.ts`) from the `data` instance's rows, never stored:
 * membership, names and links each depend on many files.
 */

import { z } from 'zod';

const ROOT_DESC = 'The id of the root the path is under';
const PATH_DESC = 'The member\'s package.json, relative to its root';

/** How a dependency's range is resolved. */
export const WorkspaceProtocolSchema = z.enum(['workspace', 'catalog', 'npm', 'link', 'file'])
  .describe('`workspace`: a `workspace:` range, linked by name or (pnpm) by relative path; `catalog`: a pnpm `catalog:` range, `range` holding what the catalog resolves it to; `link` and `file`: a local path, linked when it is a member\'s directory; `npm`: anything else, a registry range linked only by the package manager\'s rule for a plain range');

export type WorkspaceProtocol = z.infer<typeof WorkspaceProtocolSchema>;

/** A row of the derived `workspace_packages` relation: the workspace root and each member. */
export const WorkspacePackageRowSchema = z.object({
  root: z.string().describe(ROOT_DESC),
  path: z.string().describe(PATH_DESC),
  dir: z.string().describe('The member\'s directory, relative to its root; `.` for the workspace root'),
  name: z.string().nullable().describe('The `name` field (the last occurrence when repeated), or null when absent, not a string, or the file has no rows'),
  version: z.string().nullable().describe('The `version` field, or null when absent, not a string, or the file has no rows'),
  private: z.boolean().nullable().describe('The `private` field, or null when absent, not a boolean, or the file has no rows'),
  workspaceRoot: z.boolean().describe('Whether this is the root package.json that declares the workspace'),
}).strict().describe('A row of the derived `workspace_packages` relation');

export type WorkspacePackageRow = z.infer<typeof WorkspacePackageRowSchema>;

/** A row of the derived `workspace_dependencies` relation: one per dependency a member declares. */
export const WorkspaceDependencyRowSchema = z.object({
  root: z.string().describe(ROOT_DESC),
  path: z.string().describe('The declaring member\'s package.json, relative to its root'),
  field: z.string().describe('`dependencies`, `devDependencies`, `peerDependencies` or `optionalDependencies`'),
  name: z.string().describe('The dependency\'s key in that field'),
  range: z.string().describe('The range as written, or for `catalog` the range the catalog resolves it to (as written when no catalog entry resolves it)'),
  targetPath: z.string().nullable().describe('The package.json of the member it links, or null when it links no member this run can name: a registry package, a range the manager does not link, or a name no member with rows carries (a WORKSPACE_TARGET_UNKNOWN condition marks the ones a member with no rows could be)'),
  protocol: WorkspaceProtocolSchema,
}).strict().describe('A row of the derived `workspace_dependencies` relation');

export type WorkspaceDependencyRow = z.infer<typeof WorkspaceDependencyRowSchema>;

/** What a workspace condition says. */
export const WorkspaceConditionCodeSchema = z.enum(['WORKSPACE_MEMBER_NO_ROWS', 'WORKSPACE_TARGET_UNKNOWN', 'WORKSPACE_CATALOG_UNRESOLVED'])
  .describe('`WORKSPACE_MEMBER_NO_ROWS`: a member\'s package.json has no rows this run, so its name, version and dependencies are unknown; `WORKSPACE_TARGET_UNKNOWN`: a dependency the manager would link by name matches no member with rows while some member\'s name is unknown, so it may link that member; `WORKSPACE_CATALOG_UNRESOLVED`: a `catalog:` range names no entry of pnpm-workspace.yaml\'s catalogs');

export type WorkspaceConditionCode = z.infer<typeof WorkspaceConditionCodeSchema>;

/** A row of the derived `workspace_conditions` relation. */
export const WorkspaceConditionRowSchema = z.object({
  root: z.string().describe(ROOT_DESC),
  path: z.string().describe('The package.json the condition is about, relative to its root'),
  code: WorkspaceConditionCodeSchema,
  seq: z.number().int().nonnegative().describe('0-based position among the path\'s conditions of this code'),
  message: z.string(),
}).strict().describe('A row of the derived `workspace_conditions` relation');

export type WorkspaceConditionRow = z.infer<typeof WorkspaceConditionRowSchema>;
