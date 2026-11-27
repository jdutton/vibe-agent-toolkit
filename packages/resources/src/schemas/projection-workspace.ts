/**
 * The workspace relations: which `package.json` files are members of a root's npm, yarn, bun or
 * pnpm workspace, and which member each member's dependencies name. Derived per run by the workspace
 * resolve step (`projection/workspace-packages.ts`) from the `data` instance's rows, never stored:
 * membership and names each depend on many files.
 */

import { z } from 'zod';

const ROOT_DESC = 'The id of the root the path is under';
const PATH_DESC = 'The member\'s package.json, relative to its root';

/** The protocol a dependency's range is written in. */
export const WorkspaceProtocolSchema = z.enum(['workspace', 'catalog', 'npm', 'link', 'file'])
  .describe('`workspace`: a `workspace:` range; `catalog`: a `catalog:` range; `link` and `file`: a `link:` or `file:` path; `npm`: anything else (a semver range, a tag, an `npm:` alias, a git or tarball URL). The protocol as written, so a check can judge policy over it: VAT does not decide what an install would make of it');

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
  range: z.string().describe('The range as written'),
  targetPath: z.string().nullable().describe('The package.json of the workspace member the dependency names, a structural fact and never an install outcome: for a `workspace:` path, `file:` or `link:`, the member at that directory; for anything else, the member whose `name` is the dependency\'s name (`npm:<name>@` and pnpm\'s `workspace:<name>@` name `<name>`), the root only where the manager lets a name reach it. No version is checked and no registry, catalog or link setting is read. Null when it names no one member: no member carries the name, two do (WORKSPACE_DUPLICATE_NAME), the path holds no member (WORKSPACE_PATH_UNRESOLVED), a member of unknown name may be it (WORKSPACE_TARGET_UNKNOWN), or the answer depends on an unknown manager (WORKSPACE_MANAGER_UNKNOWN)'),
  protocol: WorkspaceProtocolSchema,
}).strict().describe('A row of the derived `workspace_dependencies` relation');

export type WorkspaceDependencyRow = z.infer<typeof WorkspaceDependencyRowSchema>;

/** What a workspace condition says. */
export const WorkspaceConditionCodeSchema = z.enum([
  'WORKSPACE_MEMBER_NO_ROWS',
  'WORKSPACE_MEMBER_EXCLUDED',
  'WORKSPACE_TARGET_UNKNOWN',
  'WORKSPACE_DUPLICATE_NAME',
  'WORKSPACE_PATH_UNRESOLVED',
  'WORKSPACE_PACKAGES_MALFORMED',
  'WORKSPACE_ROOT_REFUSED',
  'WORKSPACE_ROOT_MAY_BE_ABOVE',
  'WORKSPACE_ROOT_OUTSIDE_ROOT',
  'WORKSPACE_NOT_DECLARED',
  'WORKSPACE_MANAGER_INFERRED',
  'WORKSPACE_MANAGER_UNKNOWN',
  'WORKSPACE_MANAGER_VERSION_UNKNOWN',
]).describe([
  '`WORKSPACE_MEMBER_NO_ROWS`: a member\'s package.json has no rows this run, so its name, version and dependencies are unknown',
  '`WORKSPACE_MEMBER_EXCLUDED`: a member\'s package.json is routed away from the data instance (an exclude), so its name, version and dependencies are unknown',
  '`WORKSPACE_TARGET_UNKNOWN`: a dependency names no member with rows while some member\'s name is unknown (WORKSPACE_MEMBER_NO_ROWS or WORKSPACE_MEMBER_EXCLUDED), so it may name that member; targetPath is null',
  '`WORKSPACE_DUPLICATE_NAME`: two members a dependency\'s name can reach carry one name, at each of them; a dependency on that name has targetPath null',
  '`WORKSPACE_PATH_UNRESOLVED`: a `workspace:`, `file:` or `link:` path names no member\'s directory (a tarball, a directory outside the workspace, an absolute path, one leaving the analysis root), or is a `workspace:` path under a manager with no path form; targetPath is null',
  '`WORKSPACE_PACKAGES_MALFORMED`: the member pattern list is not an array of strings, or pnpm refuses the file for a missing `packages`; VAT reads what it can and says so',
  '`WORKSPACE_ROOT_REFUSED`: this root\'s workspace rows are refused (the message leads with the refusal code) while other roots answer; the root has no package or dependency rows',
  '`WORKSPACE_ROOT_MAY_BE_ABOVE`: the analysis root declares no workspace, holds a package.json and sits below its repository\'s top level, so a workspace above it may hold its packages; path is `.`',
  '`WORKSPACE_ROOT_OUTSIDE_ROOT`: a package.json under an analysis root that declares no workspace declares a `workspace:` dependency, so its workspace root may lie above the analysis root; at that package.json',
  '`WORKSPACE_NOT_DECLARED`: the manager reads no workspace at the root although one may be meant: yarn 1 and a root package.json with workspaces but without private: true (at the root package.json), or pnpm with no pnpm-workspace.yaml and a package.json under the root declaring a `workspace:` dependency (at that package.json)',
  '`WORKSPACE_MANAGER_INFERRED`: the root names no packageManager (or yarn without a version), and VAT read the manager from which files exist at the root, never their content; the message names them and what the inference decided; path is `.`',
  '`WORKSPACE_MANAGER_UNKNOWN`: the manager is unknown (no packageManager and no lockfile or several managers\' lockfiles, yarn of unknown flavour, or a manager VAT does not know; path `.`), or a dependency whose target depends on it: the root package\'s name, or a `workspace:` path (at the member, targetPath null)',
  '`WORKSPACE_MANAGER_VERSION_UNKNOWN`: pnpm-workspace.yaml has no packages key, whose meaning pnpm changed at 10.5.0, and the pnpm version is unknown; VAT reads the root only; path is `.`',
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
