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
  .describe('`workspace`: a `workspace:` range, linked by name or (pnpm) by relative path; `catalog`: a `catalog:` range (pnpm, or bun from the root package.json), `range` holding what the catalog resolves it to; `link` and `file`: a local path, linked when it is a member\'s directory; `npm`: anything else, a registry range linked only by the package manager\'s rule for a plain range');

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
export const WorkspaceConditionCodeSchema = z.enum([
  'WORKSPACE_MEMBER_NO_ROWS',
  'WORKSPACE_MEMBER_EXCLUDED',
  'WORKSPACE_TARGET_UNKNOWN',
  'WORKSPACE_CATALOG_UNRESOLVED',
  'WORKSPACE_CATALOG_CONFLICT',
  'WORKSPACE_DUPLICATE_NAME',
  'WORKSPACE_PROTOCOL_UNSUPPORTED',
  'WORKSPACE_PACKAGES_MALFORMED',
  'WORKSPACE_ROOT_REFUSED',
  'WORKSPACE_ROOT_MAY_BE_ABOVE',
]).describe([
  '`WORKSPACE_MEMBER_NO_ROWS`: a member\'s package.json has no rows this run, so its name, version and dependencies are unknown',
  '`WORKSPACE_MEMBER_EXCLUDED`: a member\'s package.json is routed away from the data instance (an exclude), so its name, version and dependencies are unknown',
  '`WORKSPACE_TARGET_UNKNOWN`: a dependency the manager would link by name matches no member with rows while some member\'s name is unknown, so it may link that member',
  '`WORKSPACE_CATALOG_UNRESOLVED`: a `catalog:` range names no entry of the catalogs the manager in effect reads (pnpm-workspace.yaml for pnpm, the root package.json for bun; none for npm or yarn)',
  '`WORKSPACE_CATALOG_CONFLICT`: both `catalog` and `catalogs.default` are set; VAT merges them, `catalog` winning a name in both',
  '`WORKSPACE_DUPLICATE_NAME`: two members carry one name; the first by path keeps it for linking',
  '`WORKSPACE_PROTOCOL_UNSUPPORTED`: a `workspace:` range under npm or yarn 1, which fail the install; it links nothing',
  '`WORKSPACE_PACKAGES_MALFORMED`: the member pattern list is not an array of strings, or pnpm refuses the file for a missing `packages`; VAT reads what it can and says so',
  '`WORKSPACE_ROOT_REFUSED`: this root\'s workspace rows are refused (the message leads with the refusal code) while other roots answer; the root has no package or dependency rows',
  '`WORKSPACE_ROOT_MAY_BE_ABOVE`: the analysis root declares no workspace, holds a package.json and sits below its repository\'s top level, so a workspace above it may hold its packages; path is `.`',
].join('; '));

export type WorkspaceConditionCode = z.infer<typeof WorkspaceConditionCodeSchema>;

/** A row of the derived `workspace_conditions` relation. */
export const WorkspaceConditionRowSchema = z.object({
  root: z.string().describe(ROOT_DESC),
  path: z.string().describe('The file the condition is about (a package.json, pnpm-workspace.yaml), relative to its root; `.` for the analysis root itself'),
  code: WorkspaceConditionCodeSchema,
  seq: z.number().int().nonnegative().describe('0-based position among the path\'s conditions of this code'),
  message: z.string(),
}).strict().describe('A row of the derived `workspace_conditions` relation');

export type WorkspaceConditionRow = z.infer<typeof WorkspaceConditionRowSchema>;
