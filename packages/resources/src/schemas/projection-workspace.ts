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
  .describe('`workspace`: a `workspace:` range; `catalog`: a `catalog:` range; `link` and `file`: a `link:` or `file:` path, or a bare path (no protocol prefix) the manager reads as a directory or tarball, labelled as the manager reads it (pnpm: `link` for a directory, `file` for a tarball; every other manager, and an unknown one, `file`); `npm`: anything else (a semver range, a tag, an `npm:` alias, a git or tarball URL). The protocol as written, so a check can judge policy over it: VAT does not decide what an install would make of it');

export type WorkspaceProtocol = z.infer<typeof WorkspaceProtocolSchema>;

/** A row of the derived `workspace_packages` relation: the workspace root and each member. */
export const WorkspacePackageRowSchema = z.object({
  root: z.string().describe(ROOT_DESC),
  path: z.string().describe(PATH_DESC),
  dir: z.string().describe('The member\'s directory, relative to its root; `.` for the workspace root'),
  name: z.string().nullable().describe('The `name` field as written (the last occurrence when repeated), or null when absent, not a string, or the file has no rows. npm matches a member with no name by its folder; that derived name is never written here'),
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
  targetPath: z.string().nullable().describe('The package.json of the workspace member the dependency names, a structural fact and never an install outcome: for a `workspace:` path, `file:`, `link:` or a bare path the manager reads as one, the member at that directory; for anything else, the member whose name is the dependency\'s name (`npm:<name>@`, and pnpm\'s and bun\'s `workspace:<name>@`, name `<name>`; npm names a member with no `name` by its folder), the root only where the manager lets a name reach it, and under bun a member sharing the root\'s name before the root. No version is checked and no registry, catalog or link setting is read. Null when it names no one member: no member carries the name, two do (WORKSPACE_DUPLICATE_NAME), the path holds no member or is a bun link registration (WORKSPACE_PATH_UNRESOLVED), or the answer depends on an unknown manager (WORKSPACE_MANAGER_UNKNOWN). While a member\'s name is unknown (WORKSPACE_TARGET_UNKNOWN, once per root) every name match in the root is uncertain, null or not'),
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
  'WORKSPACE_MEMBER_NAMELESS',
  'WORKSPACE_READ_AS_JSONC',
]).describe([
  '`WORKSPACE_MEMBER_NO_ROWS`: a member\'s package.json has no rows this run, so its name, version and dependencies are unknown',
  '`WORKSPACE_MEMBER_EXCLUDED`: a member\'s package.json is routed away from the data instance (an exclude), so its name, version and dependencies are unknown',
  '`WORKSPACE_TARGET_UNKNOWN`: some member\'s name is unknown (WORKSPACE_MEMBER_NO_ROWS or WORKSPACE_MEMBER_EXCLUDED), so every name match in the root is uncertain: a dependency with targetPath null may name one of them, and one matched to a member may too, since a name may be shared; a unique match is still picked. One per root, naming those members, at the root package.json (`.` when the run holds none)',
  '`WORKSPACE_DUPLICATE_NAME`: two members a dependency\'s name can reach carry one name (npm\'s folder name for a member with none included; the root only where a name reaches it beside a member, so never under bun, npm or yarn 1), at each of them; a dependency that names it by name has targetPath null',
  '`WORKSPACE_PATH_UNRESOLVED`: a `workspace:`, `file:`, `link:` or bare path names no member\'s directory (a tarball, a directory outside the workspace, an absolute or home path, one leaving the analysis root), is a `workspace:` path under a manager with no path form, or is bun\'s `link:<package name>`, which names a package registered with `bun link` rather than a directory; targetPath is null',
  '`WORKSPACE_PACKAGES_MALFORMED`: the member pattern list is not an array of strings, or pnpm refuses the file for a missing `packages`; VAT reads what it can and says so',
  '`WORKSPACE_ROOT_REFUSED`: this root\'s workspace rows are refused (the message leads with the refusal code) while other roots answer; the root has no package or dependency rows',
  '`WORKSPACE_ROOT_MAY_BE_ABOVE`: the analysis root declares no workspace, holds a package.json and sits below its repository\'s top level, so a workspace above it may hold its packages; path is `.`',
  '`WORKSPACE_ROOT_OUTSIDE_ROOT`: a package.json under an analysis root that declares no workspace declares a `workspace:` dependency, so its workspace root may lie above the analysis root; at that package.json',
  '`WORKSPACE_NOT_DECLARED`: the manager reads no workspace at the root although one may be meant: yarn 1 and a root package.json listing at least one workspace package whose private field is not truthy (at the root package.json), or pnpm with no pnpm-workspace.yaml and a package.json under the root declaring a `workspace:` dependency (at that package.json)',
  '`WORKSPACE_MANAGER_INFERRED`: the root names no packageManager (or yarn without a version), and VAT read the manager from which files exist at the root, never their content; the message names them and what the inference decided; at the root package.json (`.` when the run holds none)',
  '`WORKSPACE_MANAGER_UNKNOWN`: the manager is unknown (no packageManager and no lockfile or several managers\' lockfiles, yarn of unknown flavour, or a manager VAT does not know; at the root package.json, `.` when the run holds none), or a dependency whose target depends on it: the root package\'s name, a nameless member\'s folder name, a `workspace:` path, a bare path the managers read differently, or `link:<package name>` (at the member, targetPath null)',
  '`WORKSPACE_MANAGER_VERSION_UNKNOWN`: pnpm-workspace.yaml has no packages key, whose meaning pnpm changed at 10.5.0, and the pnpm version is unknown; VAT reads the root only; at the root package.json (`.` when the run holds none)',
  '`WORKSPACE_MEMBER_NAMELESS`: a member with rows has no name (absent, empty or not a string) under a manager that names no member by its folder, so no dependency can name it by name; under an unknown manager the message says npm would name it by its folder',
  '`WORKSPACE_READ_AS_JSONC`: a package.json the step read is routed as `jsonc` (a jsonc rule), and package managers parse package.json as strict JSON, so a comment or trailing comma VAT accepts would fail every manager; once per manifest',
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
