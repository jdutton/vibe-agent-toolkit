/**
 * The workspace resolve step: `workspace_packages`, `workspace_dependencies` and
 * `workspace_conditions`, derived per run from the `data` instance's rows and never stored, since
 * membership and names each depend on many files.
 *
 * It reads ONLY through the declared-reads handle, never the disk: the `json` pair of every
 * `package.json` the run holds (outside `node_modules`), and at each analysis root its
 * `package.json` (`json`) and `pnpm-workspace.yaml` (`yaml`) when the run holds them. Nothing else
 * is read; which lockfiles and `.yarnrc.yml` exist at a root is asked of the paths the run holds,
 * never their content. A root file is read only when the rules below need it, so an excluded
 * `pnpm-workspace.yaml` under an npm workspace refuses nothing.
 *
 * ## What `targetPath` is: the member a dependency NAMES, never what an install links
 *
 * `targetPath` is a structural fact of the repository: the workspace member a dependency names. It
 * is not the package an installer would link. That outcome depends on what no repository holds: the
 * registry's versions, the manager's version checks, `link-workspace-packages` from a user-global
 * `.npmrc` or the environment, catalogs, `enableTransparentWorkspaces`. A check judges policy over
 * `range` and `protocol` in SQL instead: "a dependency that names a member must use `workspace:`"
 * is `protocol <> 'workspace' AND targetPath IS NOT NULL`.
 *
 * - **A path** (`workspace:<path>`, `file:<path>`, `link:<path>`, or a bare path: a range with no
 *   protocol prefix that the manager's own test reads as a directory, such as `../b`): the member
 *   whose directory the path names. `file:`, `link:` and a bare path resolve from the declaring
 *   package's directory; a bare path is labelled `file`, or under pnpm `link` for a directory and
 *   `file` for a tarball. A `workspace:` path resolves by the manager's own rule
 *   ({@link MANAGER_RULES}): pnpm's and bun's from the declaring package, yarn berry's from the project
 *   root. A path that names no member's directory (a tarball, a directory outside the workspace, an
 *   absolute or home path, one climbing above the root), a `workspace:` path under a manager with no
 *   path form, or bun's `link:<package name>` (a `bun link` registration, not a directory) is null
 *   with `WORKSPACE_PATH_UNRESOLVED`.
 * - **Anything else** (`workspace:*`, `workspace:^1.2.0`, `catalog:`, a plain range, a git URL):
 *   the member whose name is the dependency's name. `npm:<name>@<range>`, and pnpm's and bun's
 *   `workspace:<name>@<range>` (each split by its own rule), name `<name>`. npm names a member with
 *   no `name` by its folder; under any other manager such a member is `WORKSPACE_MEMBER_NAMELESS`
 *   and no name reaches it. No version is checked and nothing is installed: the name is the whole
 *   question.
 * - **The root as a name.** The root package is a member a name can reach only where the manager
 *   makes it one ({@link MANAGER_RULES}): yarn berry and pnpm always, bun through `workspace:` only
 *   and only when no member carries the name (the member wins), npm and yarn 1 never. Its
 *   `workspace_packages` row is there either way, with `workspaceRoot` true, and a path can reach it.
 * - **Two members with one name**: each carries `WORKSPACE_DUPLICATE_NAME`, and a dependency on the
 *   name has `targetPath` null: it names no one member.
 * - **A member whose name is unknown** (no rows, or routed away): one `WORKSPACE_TARGET_UNKNOWN` per
 *   root names those members. Every name match in the root is then uncertain: a null `targetPath`
 *   may name one of them, and so may a match, since the name may be shared. A unique match is still
 *   picked.
 * - **A manifest read as JSONC** (a `jsonc` rule routes it): one `WORKSPACE_READ_AS_JSONC` at it,
 *   since every package manager parses package.json as strict JSON.
 *
 * ## Membership
 *
 * - **Which manager.** The root `package.json`'s `packageManager` (`pnpm@9.0.0`): `pnpm` reads
 *   `pnpm-workspace.yaml`; any other manager (`npm`, `yarn`, `bun`) reads `package.json#workspaces`.
 *   With no `packageManager`, the manager is inferred from which files exist at the root, by path
 *   only and never by reading them: a `pnpm-workspace.yaml` means pnpm, and otherwise exactly one
 *   manager's lockfiles ({@link LOCKFILES}) name it; a `WORKSPACE_MANAGER_INFERRED` condition names
 *   the evidence, whatever the inference decides. With none, or several managers' lockfiles, the
 *   manager is unknown (`WORKSPACE_MANAGER_UNKNOWN`): membership is still the `workspaces` field,
 *   which npm, yarn and bun all read, and a dependency whose target depends on the manager (the
 *   root's name, a nameless member's folder name, a `workspace:` path, a bare path the managers read
 *   differently, `link:<package name>`) has `targetPath` null with the same code. The manager's
 *   conditions sit at the root `package.json`, or at `.` when the run holds none. yarn is yarn 1 or
 *   berry by its version, and without one by `.yarnrc.yml` (berry) or `yarn.lock` without it
 *   (yarn 1), said the same way. pnpm with no `pnpm-workspace.yaml` is no workspace. A
 *   `pnpm-workspace.yaml` with no root `package.json` is a pnpm workspace with no root row.
 * - **yarn 1** enables `workspaces` only in a root `package.json` whose `private` is truthy as
 *   JavaScript reads it (its install fails "Workspaces can only be enabled in private projects",
 *   other commands drop them); a root listing at least one workspace package without it declares no
 *   workspace, with `WORKSPACE_NOT_DECLARED` at the root `package.json`. An empty list is a
 *   workspace with no member patterns.
 * - **Patterns.** `workspaces` is an array, or yarn's `{ packages: [...] }`. pnpm's `packages`:
 *   absent means every package (`['.', '**']`) when the file has no other key, and a refused file
 *   otherwise, before pnpm {@link PNPM_PACKAGES_ROOT_ONLY_FROM}; from it, the root only (`['.']`).
 *   With no pnpm version that is a `WORKSPACE_MANAGER_VERSION_UNKNOWN` condition, and the later
 *   rule is read. pnpm's workspace finder ignores `**\/node_modules/**` and `**\/bower_components/**`
 *   and nothing else. A pattern starting `!` excludes, whatever its position. Each pattern is
 *   canonicalised before matching (`./packages/*` is `packages/*`, `tools/../libs/*` is `libs/*`, a
 *   trailing `/` dropped); one that climbs above the root matches nothing here. A pattern names
 *   directories; a member is a held `package.json` whose directory it matches, decided from paths
 *   alone. A malformed pattern list (not an array, a non-string entry) is a
 *   `WORKSPACE_PACKAGES_MALFORMED` condition; its string entries are read.
 * - **The root.** The root `package.json` is the workspace root (`workspaceRoot` true) whether or
 *   not a pattern also matches it. A root that declares no workspace has no rows; when it holds a
 *   `package.json` and sits below its repository's top level, a `WORKSPACE_ROOT_MAY_BE_ABOVE`
 *   condition at `.` says a workspace may enclose it.
 *
 * ## The tools' rules on duplicate keys (consumer rules, spec 3.5)
 *
 * `package.json`: every manager reads it last-wins, so the step reads only unshadowed nodes.
 * `pnpm-workspace.yaml`: pnpm loads it with js-yaml, which refuses a duplicated key, so a
 * `DATA_DUPLICATE_KEY` at or beneath `packages` (the one key the step reads) refuses
 * `WORKSPACE_DUPLICATE_KEY`; js-yaml merges `<<`, which the rows hold literally, so a `<<` beneath
 * `packages`, or at the top level of a file with no `packages` key of its own (the merge may supply
 * it), refuses `WORKSPACE_MERGE_KEY`. The `data__*` relations over the same file answer as ever.
 *
 * ## A file with no rows (decided for this step under the owner's one-finding ruling)
 *
 * Every such file is already one `DATA_FILE_NO_ROWS` finding that fails the run. A **member**
 * `package.json` with no rows stays visible: its `workspace_packages` row has `name`, `version` and
 * `private` null, a `WORKSPACE_MEMBER_NO_ROWS` condition names its pair code, and it has no
 * dependency rows (they are unknown, not absent). A member **routed away** from `json` (an
 * `exclude`) is the same row with a `WORKSPACE_MEMBER_EXCLUDED` condition instead. A **root
 * input** that decides membership with no rows (`package.json`, `pnpm-workspace.yaml`) refuses that
 * root `WORKSPACE_ROOT_NO_ROWS`: its membership is unknown, and rows would be a guess.
 *
 * ## The other refusals
 *
 * - `DATA_REQUEST_UNROUTED`: a root input that decides membership is held but not routed as the
 *   variant it reads (a `pnpm-workspace.yaml` routed away), from the handle. Routing it is the one
 *   way back to rows for that root.
 *
 * ## A root that declares no workspace (conditions, never refusals)
 *
 * - `WORKSPACE_NOT_DECLARED`: the manager reads no workspace at the root although one is written
 *   (yarn 1 without `private: true`, at the root `package.json`), or pnpm is the manager, the root
 *   holds no `pnpm-workspace.yaml`, and a routed `package.json` under it declares a `workspace:`
 *   dependency (at that `package.json`).
 * - `WORKSPACE_ROOT_OUTSIDE_ROOT`: a workspace root may be above the analysis root. With no disk
 *   input the step cannot see one; what it can see is its trace: an analysis root that declares no
 *   workspace (or has no `package.json`) while a routed `package.json` under it declares a
 *   `workspace:` dependency, which only a workspace resolves; at that `package.json`. A test
 *   fixture is a common way to be here, so this is scoped to the manifest, and routing it away with
 *   `exclude` ends it. A `package.json` under a nested workspace (a directory holding a
 *   `pnpm-workspace.yaml`, or a `package.json` with `workspaces`) is passed over: that workspace
 *   resolves it. A root above whose members use only plain ranges leaves no such trace; the
 *   `WORKSPACE_ROOT_MAY_BE_ABOVE` condition is what marks it.
 *
 * ## How far a refusal reaches
 *
 * A refusal refuses its own root only. The other roots answer; the refused root has no package or
 * dependency rows and one `WORKSPACE_ROOT_REFUSED` condition at the refusing file, its message
 * leading with the refusal's code. Only when no root has a `workspace_packages` row does the family
 * refuse, with the most severe root refusal: one a rerun cannot answer before one it may, so the
 * family is retryable only when every refused root is.
 */

import { appendAll, compareCodeUnits, toForwardSlash, toForwardSlashAnyPlatform, VatError } from '@vibe-agent-toolkit/utils';
import picomatch from 'picomatch';
import semver from 'semver';

import type { DataConditionRow, DataNodeRow, DataVariant } from '../schemas/projection-data.js';
import type {
  WorkspaceConditionCode,
  WorkspaceConditionRow,
  WorkspaceDependencyRow,
  WorkspacePackageRow,
  WorkspaceProtocol,
} from '../schemas/projection-workspace.js';

import type { DeclaredAnswer, DeclaredPair, DeclaredReads } from './declared-reads.js';
import { DERIVED_TABLES } from './derived-table-registry.js';
import { compareRows } from './export.js';

const PACKAGE_JSON = 'package.json';
const PNPM_WORKSPACE = 'pnpm-workspace.yaml';
const WORKSPACE_PREFIX = 'workspace:';
const LINK_PREFIX = 'link:';
const FILE_PREFIX = 'file:';
const NPM_PREFIX = 'npm:';

/** The dependency fields read, in this order. */
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const;

/** What pnpm's workspace finder ignores, always applied to its patterns. */
const PNPM_IGNORES = ['**/node_modules/**', '**/bower_components/**'];

/** A path under `node_modules`: never a member, never routed. */
const NODE_MODULES = picomatch('**/node_modules/**');

/** Every package, the root included. */
const EVERY_PACKAGE = ['.', '**'];

/** The root only. */
const ROOT_ONLY = ['.'];

/**
 * The pnpm release from which `pnpm-workspace.yaml` without `packages` means the root only (config
 * `workspaceManifest?.packages ?? ['.']`); before it, every package when the file has no other key,
 * and a refused file otherwise (read-manifest "packages field missing or empty"). A pnpm fact, read
 * from its source; the only pnpm version rule the step needs.
 */
const PNPM_PACKAGES_ROOT_ONLY_FROM = '10.5.0';

/**
 * The lockfiles that name a manager when the root has no `packageManager`: path existence only,
 * never their content. `.yarnrc.yml` tells yarn berry from yarn 1.
 */
const LOCKFILES: ReadonlyArray<readonly [file: string, manager: string]> = [
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['npm-shrinkwrap.json', 'npm'],
  ['package-lock.json', 'npm'],
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
];
const YARNRC = '.yarnrc.yml';
const YARN_LOCK = 'yarn.lock';

const PACKAGES_KEY = '/packages';
const WORKSPACES_KEY = '/workspaces';

/** A manager whose structural rules the step knows. */
type ManagerKind = 'npm' | 'yarn 1' | 'yarn berry' | 'bun' | 'pnpm';

/** A manager's structural rules: what a dependency can name, never what an install links. */
interface ManagerRules {
  /** Whether a `workspace:` range's name can reach the root package. */
  readonly rootByWorkspaceName: boolean;
  /** Whether any other range's name (a plain range, `catalog:`, `npm:`) can reach the root package. */
  readonly rootByName: boolean;
  /**
   * How a `workspace:` range names a directory: which specifiers are paths, what they resolve from,
   * and whether a member carrying the dependency's name wins first (bun); undefined for a manager
   * with no `workspace:` path form.
   */
  readonly workspacePath: {
    readonly isPath: (spec: string) => boolean;
    readonly from: 'declaring' | 'root';
    readonly nameFirst: boolean;
  } | undefined;
  /**
   * The `<alias>` a `workspace:<alias>@<range>` names, from the text after `workspace:`, or
   * undefined when the manager reads no alias there.
   */
  readonly workspaceAlias: (suffix: string) => string | undefined;
  /** Whether a range with no protocol prefix is a path to this manager (a directory or tarball). */
  readonly isBarePath: (range: string) => boolean;
  /** The protocol a bare path is labelled with under this manager. */
  readonly bareProtocol: (range: string) => WorkspaceProtocol;
  /** Whether a member carrying the root's name wins over the root, so the two are no duplicate (bun). */
  readonly memberShadowsRoot: boolean;
  /** Whether a member with no name is named by its folder (npm). */
  readonly namesByFolder: boolean;
  /** Whether `link:<package name>` is a `bun link` registration rather than a path (bun). */
  readonly linkRegistration: boolean;
}

/** No alias form. */
function noAlias(): undefined {
  return undefined;
}

/**
 * pnpm's alias split (crates/workspace-spec `split_alias_version`, the grammar
 * `^workspace:(?:(?<alias>[^._/][^@]*)@)?`): the alias runs to the first `@` after its first
 * character, and that character is not `.`, `_` or `/`.
 */
function pnpmAlias(suffix: string): string | undefined {
  const first = suffix.charAt(0);
  if (first === '' || first === '.' || first === '_' || first === '/') return undefined;
  const at = suffix.indexOf('@', 1);
  return at < 0 ? undefined : suffix.slice(0, at);
}

/**
 * bun's alias split (Package.rs and Package.zig, the `Workspace` arm of the dependency parse):
 * unless the trimmed specifier is exactly `*`, `^` or `~`, the alias runs to the last `@`, when
 * that `@` is not the first character.
 */
function bunAlias(suffix: string): string | undefined {
  const trimmed = suffix.trim();
  if (trimmed === '*' || trimmed === '^' || trimmed === '~') return undefined;
  const at = suffix.lastIndexOf('@');
  return at > 0 ? suffix.slice(0, at) : undefined;
}

/** npm (npa `isPosixFile`): `.`, `~/`, `/` or a drive letter. */
const NPM_BARE_PATH = /^(?:\.|~\/|\/|[A-Za-z]:)/;
/** pnpm (pnpm_local_spec `is_filespec`): `.`, `/`, `\`, `~/` or `~\`, or a letter and `:`. */
const PNPM_BARE_PATH = /^(?:[./\\]|~[/\\]|[A-Za-z]:)/;
/** bun (`Dependency.Tag.infer`, the `Folder` and `Tarball` arms): `.`, `~/`, `/`, or a drive letter and a separator. */
const BUN_BARE_PATH = /^(?:\.|~\/|\/|[A-Za-z]:[/\\])/;
/** yarn 1 (FileResolver `isVersion`): `./` or `../` (`prefixMatcher`), or an absolute path. */
const YARN1_BARE_PATH = /^(?:\.{1,2}\/|\/)/;
/** yarn berry (plugin-file `FILE_REGEXP`): a drive letter and a separator, or `/`, `./`, `../`. */
const BERRY_BARE_PATH = /^(?:[A-Za-z]:[/\\]|\.{0,2}\/)/;

/** @returns A rule reading a bare path by one pattern */
function barePathBy(pattern: RegExp): (range: string) => boolean {
  return (range) => pattern.test(range);
}

/** Every manager but pnpm labels a bare path `file`. */
function fileProtocol(): WorkspaceProtocol {
  return 'file';
}

/**
 * pnpm reads a bare directory as `link:` (parse_bare_specifier `local_protocol`: a directory, not
 * injected) and a bare tarball as `file:` (pnpm_local_spec `is_tarball_filename`).
 */
function pnpmBareProtocol(range: string): WorkspaceProtocol {
  return isTarballName(range) ? 'file' : 'link';
}

/** @returns Whether a path names a tarball (pnpm `is_tarball_filename`, bun `is_tarball`): `.tgz`, `.tar.gz` or `.tar`, any case */
function isTarballName(path: string): boolean {
  return /\.(?:tgz|tar\.gz|tar)$/i.test(path);
}

/** pnpm and bun: a `workspace:` specifier starting `.`, or an absolute path, is a path. */
function dotWorkspacePath(spec: string): boolean {
  return spec.startsWith('.') || isAbsolute(spec);
}

/** yarn berry: every `workspace:` specifier but `*`, `^`, `~` and a semver range is a path. */
function berryWorkspacePath(spec: string): boolean {
  return spec !== '*' && spec !== '^' && spec !== '~' && semver.validRange(spec) === null;
}

/** @returns Whether a `workspace:` specifier reads as a path to any manager */
function looksLikePath(spec: string): boolean {
  return spec.startsWith('.') || spec.startsWith('/') || isAbsolute(spec);
}

/**
 * Each known manager's structural rules, read from its own source and docs:
 * - npm: arborist's `Node.isWorkspace` is false for the project root, and the workspace map holds
 *   only what the `workspaces` globs match; `workspace:` is unsupported. npm names a member with no
 *   `name` by its folder (map-workspaces `pkg.name || getName(pathname)`, @npmcli/name-from-folder:
 *   the directory's base name, `@scope/base` under an `@` directory).
 * - yarn 1: the root is not a workspace; `workspace:` is unsupported.
 * - yarn berry: the root is the top-level workspace, in `workspacesByIdent` like every other;
 *   `Project.tryWorkspaceByDescriptor` reads every specifier but `^`, `~`, `*` and a semver range as
 *   a path, and `tryWorkspaceByCwd` resolves it from the project root (`ppath.resolve(this.cwd, ...)`).
 * - bun: "the root is not a workspace member" (lockfile `Package`), so a plain version never
 *   reaches it, but `workspace:` on the root's name does (its workspaces docs), and only when no
 *   member carries the name (Package.rs: the root is tried only while `workspace_path.is_none()`), so
 *   a member sharing the root's name wins; a `workspace:` specifier that no member's name answers
 *   resolves as a path from the declaring package; `workspace:<alias>@<range>` names `<alias>`
 *   ({@link bunAlias}), and the member is looked up by it. `link:<package name>` (bun-immutable
 *   `is_npm_package_name`, so bun-dependency `is_link_path` is false) is a `bun link` registration,
 *   never a directory.
 * - pnpm: the root project is always included ("The root package is always included, even when
 *   custom location wildcards are used", its settings docs); a `workspace:` specifier starting `.`,
 *   `/` or a drive letter is a path from the declaring package's directory; `workspace:<alias>@<range>`
 *   names `<alias>` ({@link pnpmAlias}).
 * - A range with no protocol prefix is a path where the manager's own test says so ({@link NPM_BARE_PATH}
 *   and its siblings), resolved like `file:` from the declaring package's directory. yarn 1's
 *   FileResolver resolves a relative path from `lockfileFolder` (the project root), not the
 *   declaring package; VAT resolves it, as it resolves `file:` for every manager, from the declaring
 *   package. That is an open question, not decided here.
 */
const MANAGER_RULES: Readonly<Record<ManagerKind, ManagerRules>> = {
  'npm': {
    rootByWorkspaceName: false, rootByName: false, workspacePath: undefined, workspaceAlias: noAlias,
    isBarePath: barePathBy(NPM_BARE_PATH), bareProtocol: fileProtocol, memberShadowsRoot: false, namesByFolder: true, linkRegistration: false,
  },
  'yarn 1': {
    rootByWorkspaceName: false, rootByName: false, workspacePath: undefined, workspaceAlias: noAlias,
    isBarePath: barePathBy(YARN1_BARE_PATH), bareProtocol: fileProtocol, memberShadowsRoot: false, namesByFolder: false, linkRegistration: false,
  },
  'yarn berry': {
    rootByWorkspaceName: true, rootByName: true, workspacePath: { isPath: berryWorkspacePath, from: 'root', nameFirst: false }, workspaceAlias: noAlias,
    isBarePath: barePathBy(BERRY_BARE_PATH), bareProtocol: fileProtocol, memberShadowsRoot: false, namesByFolder: false, linkRegistration: false,
  },
  'bun': {
    rootByWorkspaceName: true, rootByName: false, workspacePath: { isPath: dotWorkspacePath, from: 'declaring', nameFirst: true }, workspaceAlias: bunAlias,
    isBarePath: barePathBy(BUN_BARE_PATH), bareProtocol: fileProtocol, memberShadowsRoot: true, namesByFolder: false, linkRegistration: true,
  },
  'pnpm': {
    rootByWorkspaceName: true, rootByName: true, workspacePath: { isPath: dotWorkspacePath, from: 'declaring', nameFirst: false }, workspaceAlias: pnpmAlias,
    isBarePath: barePathBy(PNPM_BARE_PATH), bareProtocol: pnpmBareProtocol, memberShadowsRoot: false, namesByFolder: false, linkRegistration: false,
  },
};

/** The managers that read `package.json#workspaces`: what an unknown manager may be. */
const WORKSPACES_READERS = (Object.keys(MANAGER_RULES) as ManagerKind[]).filter((kind) => kind !== 'pnpm');

/** The protocol prefixes a range may carry; a range with none may be a bare path. */
const PROTOCOL_PREFIXES = [WORKSPACE_PREFIX, LINK_PREFIX, FILE_PREFIX, NPM_PREFIX, 'catalog:'];

/** How the managers in question read a bare range: all as a path, none, or some. */
type BareReading = { readonly kind: 'path' } | { readonly kind: 'name' } | { readonly kind: 'mixed'; readonly readers: readonly ManagerKind[] };

/**
 * How a range with no protocol prefix reads: the manager's own test, or under an unknown manager,
 * every `workspaces` reader's.
 *
 * @param range - The range
 * @param resolution - The manager in effect
 * @returns The reading
 */
function bareReading(range: string, resolution: Resolution): BareReading {
  if (PROTOCOL_PREFIXES.some((prefix) => range.startsWith(prefix))) return { kind: 'name' };
  const managers = resolution.kind === 'unknown' ? WORKSPACES_READERS : [resolution.kind];
  const readers = managers.filter((kind) => MANAGER_RULES[kind].isBarePath(range));
  if (readers.length === 0) return { kind: 'name' };
  return readers.length === managers.length ? { kind: 'path' } : { kind: 'mixed', readers };
}

/** The `pnpm-workspace.yaml` key the step reads: a duplicate at or beneath it refuses. */
const PNPM_READ_KEYS = [PACKAGES_KEY];

/** What the step refuses with. */
type WorkspaceRefusalCode =
  | 'DATA_REQUEST_UNROUTED'
  | 'WORKSPACE_ROOT_NO_ROWS'
  | 'WORKSPACE_DUPLICATE_KEY'
  | 'WORKSPACE_MERGE_KEY';

/** Why a root has no rows this run. */
export interface WorkspaceRefusal {
  readonly code: WorkspaceRefusalCode;
  /** The root id of the file. */
  readonly root: string;
  /** The file, relative to its root. */
  readonly path: string;
  readonly message: string;
  readonly remedy: string;
  /**
   * Whether a rerun may answer: the run, not the bytes, decided (a root input changed or vanished
   * under the run, hit the time cap, lost its parse worker, or met a busy or exhausted machine).
   * False for everything the tree decides, a heap or stack cap included: the parse reaches it again.
   */
  readonly retryable: boolean;
}

/** The step's answer. */
export type WorkspaceAnswer =
  | {
    readonly outcome: 'rows';
    readonly packages: readonly WorkspacePackageRow[];
    readonly dependencies: readonly WorkspaceDependencyRow[];
    readonly conditions: readonly WorkspaceConditionRow[];
  }
  | { readonly outcome: 'refused'; readonly refusal: WorkspaceRefusal };

/** What the step reads. */
interface WorkspaceStepInput {
  /** Every root id of the run, in order. */
  readonly roots: readonly string[];
  /** Every path the run holds a file with content at, by root id. */
  readonly files: ReadonlyMap<string, ReadonlySet<string>>;
  /** The roots that sit below their repository's top level, by id: a workspace may enclose them. */
  readonly belowRepositoryTop: ReadonlySet<string>;
  /** The handle over the step's declared set. */
  readonly declaredReads: (declared: readonly DeclaredPair[]) => DeclaredReads;
}

/** Thrown inside the step to refuse one root; caught once per root, never past the step. */
class Refused extends VatError {
  constructor(readonly refusal: WorkspaceRefusal) {
    super(refusal.code, refusal.message);
  }
}

/** One file's unshadowed nodes of its first document, by pointer, and each node's children. */
interface Doc {
  readonly at: ReadonlyMap<string, DataNodeRow>;
  readonly children: ReadonlyMap<number, readonly DataNodeRow[]>;
}

/** One member while it is resolved. */
interface Member {
  readonly path: string;
  readonly dir: string;
  readonly workspaceRoot: boolean;
  /** Its rows, or undefined when the file has none or is routed away. */
  readonly doc: Doc | undefined;
}

/** The manager in effect at a workspace root, as far as names and paths are concerned. */
type Resolution =
  | { readonly kind: ManagerKind }
  /** The manager is unknown; `why` says so in words, for a condition. */
  | { readonly kind: 'unknown'; readonly why: string };

/** One root's rows. */
interface RootRows {
  readonly packages: WorkspacePackageRow[];
  readonly dependencies: WorkspaceDependencyRow[];
  readonly conditions: WorkspaceConditionRow[];
}

/**
 * Resolve the workspace relations of every root.
 *
 * @param input - The run's roots, routes, held files and declared-reads handle
 * @returns The rows, or the family's refusal when no root has a package row and one refused
 * @throws A `StoredRowsEvictedError` of the row-set tier, store on, from the handle
 */
export async function resolveWorkspace(input: WorkspaceStepInput): Promise<WorkspaceAnswer> {
  const packages: WorkspacePackageRow[] = [];
  const dependencies: WorkspaceDependencyRow[] = [];
  const conditions: WorkspaceConditionRow[] = [];
  const refusals: WorkspaceRefusal[] = [];
  const answers = await Promise.all(input.roots.map(async (root) => {
    try {
      return await resolveRoot(root, input);
    } catch (error) {
      if (error instanceof Refused) return error.refusal;
      throw error;
    }
  }));
  for (const answer of answers) {
    if ('code' in answer) {
      refusals.push(answer);
      conditions.push({ root: answer.root, path: answer.path, code: 'WORKSPACE_ROOT_REFUSED', seq: 0, message: `${answer.code}: ${answer.message} Fix: ${answer.remedy}.` });
      continue;
    }
    appendAll(packages, answer.packages);
    appendAll(dependencies, answer.dependencies);
    appendAll(conditions, answer.conditions);
  }
  const family = refusals.find((refusal) => !refusal.retryable) ?? refusals[0];
  if (family !== undefined && packages.length === 0) return { outcome: 'refused', refusal: family };
  return {
    outcome: 'rows',
    packages: packages.toSorted(compareRows(DERIVED_TABLES.workspacePackages)),
    dependencies: dependencies.toSorted(compareRows(DERIVED_TABLES.workspaceDependencies)),
    conditions: conditions.toSorted(compareRows(DERIVED_TABLES.workspaceConditions)),
  };
}

/**
 * One root's workspace.
 *
 * @param root - The root id
 * @param input - The step's input
 * @returns Its rows
 * @throws Refused when the root refuses
 */
async function resolveRoot(root: string, input: WorkspaceStepInput): Promise<RootRows> {
  const files = input.files.get(root) ?? new Set<string>();
  const candidates = [...files]
    .filter((path) => baseName(path) === PACKAGE_JSON && !NODE_MODULES(path))
    .toSorted(compareCodeUnits);
  const held = (path: string): boolean => files.has(path);
  const declared: DeclaredPair[] = candidates.map((path) => ({ root, path, variant: 'json' }));
  if (held(PNPM_WORKSPACE)) declared.push({ root, path: PNPM_WORKSPACE, variant: 'yaml' });
  const rows: RootRows = { packages: [], dependencies: [], conditions: [] };
  const conditionOf = conditionMaker(root, rows.conditions);
  const reads = jsoncNoting(input.declaredReads(declared), conditionOf);
  const rootDoc = held(PACKAGE_JSON) ? docOf(rootFile(await readOne(reads, root, PACKAGE_JSON, 'json', ['dataNodes'])).dataNodes) : undefined;
  const declaration = await workspaceDeclaration({ root, rootDoc, reads, held, conditionOf });
  if (declaration.kind === 'none') {
    if (declaration.said !== true) await reportUndeclared({ candidates, reads, files, why: declaration.why, conditionOf, root });
    if (candidates.length > 0 && input.belowRepositoryTop.has(root)) {
      conditionOf('.', 'WORKSPACE_ROOT_MAY_BE_ABOVE', 'The analysis root declares no workspace and sits below its repository\'s top level, so a workspace above it may hold these package.json files; the workspace relations have no rows for this root. Run VAT with the workspace root as its analysis root if there is one.');
    }
    return rows;
  }

  const matches = memberMatcher(declaration.patterns, declaration.resolution.kind === 'pnpm');
  const rootMember: Member[] = rootDoc === undefined ? [] : [{ path: PACKAGE_JSON, dir: '.', workspaceRoot: true, doc: rootDoc }];
  const members = [
    ...rootMember,
    ...await readMembers(root, candidates.filter((path) => path !== PACKAGE_JSON && matches(path)), reads, conditionOf),
  ];
  appendAll(rows.packages, members.map((member) => packageRow(root, member)));
  const { resolution } = declaration;
  const unknown = members.filter((member) => member.doc === undefined);
  if (unknown.length > 0) {
    const words = wordList(unknown.map((member) => quoted(member.path)));
    conditionOf(rootDoc === undefined ? '.' : PACKAGE_JSON, 'WORKSPACE_TARGET_UNKNOWN', `The name of ${words} is unknown (no rows, or routed away), so every name match in this root is uncertain: a dependency with targetPath null may name one of them, and a dependency matched to a member may name one of them too, since a name may be shared. A unique name match is still picked.`);
  }
  const target = targeter({ members, packages: rows.packages, resolution, conditionOf });
  for (const member of members) appendAll(rows.dependencies, dependencyRows(root, member, target, resolution, conditionOf));
  return rows;
}

/**
 * The handle, saying once per manifest when a `json` read is answered from `jsonc` rows: package
 * managers parse package.json as strict JSON, so a comment or trailing comma VAT accepted there
 * would fail every one of them.
 *
 * @param reads - The step's handle
 * @param conditionOf - Where the condition goes
 * @returns The same handle, noting each crossing
 */
function jsoncNoting(reads: DeclaredReads, conditionOf: ConditionWriter): DeclaredReads {
  const said = new Set<string>();
  return {
    read: async (pairs, request) => {
      const answers = await reads.read(pairs, request);
      for (const answer of answers) {
        if (answer.state !== 'present' || answer.readAs !== 'jsonc' || said.has(answer.pair.path)) continue;
        said.add(answer.pair.path);
        conditionOf(answer.pair.path, 'WORKSPACE_READ_AS_JSONC', `'${answer.pair.path}' was read as JSONC (a jsonc rule of resources.extractors.data routes it), and package managers parse package.json as strict JSON, so a comment or trailing comma VAT accepts here would fail every manager.`);
      }
      return answers;
    },
  };
}

/**
 * One member's dependency rows, each with its target; none for a file with no rows (they are unknown).
 *
 * @param root - The root id
 * @param member - The member
 * @param target - The root's targeter
 * @param resolution - The manager in effect, for a bare path's protocol
 * @param conditionOf - Where a target's condition goes
 * @returns The rows, field by field in source order
 */
function dependencyRows(root: string, member: Member, target: Targeter, resolution: Resolution, conditionOf: ConditionWriter): WorkspaceDependencyRow[] {
  const { doc } = member;
  if (doc === undefined) return [];
  return DEPENDENCY_FIELDS.flatMap((field) => entriesAt(doc, `/${field}`).map(([name, range]): WorkspaceDependencyRow => {
    const found = target(member, name, range);
    if (found.condition !== undefined) conditionOf(member.path, found.condition.code, found.condition.message);
    return { root, path: member.path, field, name, range, targetPath: found.targetPath, protocol: protocolOf(range, resolution) };
  }));
}

/**
 * The protocol a range is written in. A bare path is labelled as its manager reads it
 * ({@link ManagerRules.bareProtocol}); under an unknown manager, `file` when any `workspaces` reader
 * reads it as a path.
 *
 * @param range - The range
 * @param resolution - The manager in effect
 * @returns The protocol
 */
function protocolOf(range: string, resolution: Resolution): WorkspaceProtocol {
  if (range.startsWith(WORKSPACE_PREFIX)) return 'workspace';
  if (range.startsWith('catalog:')) return 'catalog';
  if (range.startsWith(LINK_PREFIX)) return 'link';
  if (range.startsWith(FILE_PREFIX)) return 'file';
  if (bareReading(range, resolution).kind === 'name') return 'npm';
  return resolution.kind === 'unknown' ? 'file' : MANAGER_RULES[resolution.kind].bareProtocol(range);
}

/** Writes one condition row. */
type ConditionWriter = (path: string, code: WorkspaceConditionCode, message: string) => void;

/**
 * Read the members (the root aside): each with its rows, or with a `WORKSPACE_MEMBER_NO_ROWS`
 * condition when its file has none, or a `WORKSPACE_MEMBER_EXCLUDED` one when it is routed away.
 *
 * @param root - The root id
 * @param paths - The members' package.json paths
 * @param reads - The handle
 * @param conditionOf - Where a condition goes
 * @returns The members, in `paths` order
 */
async function readMembers(root: string, paths: readonly string[], reads: DeclaredReads, conditionOf: ConditionWriter): Promise<Member[]> {
  if (paths.length === 0) return [];
  const answers = await reads.read(paths.map((path) => ({ root, path, variant: 'json' as const })), { tables: ['dataNodes'] });
  return answers.map((answer): Member => {
    const { path } = answer.pair;
    if (answer.state === 'present') return { path, dir: dirName(path), workspaceRoot: false, doc: docOf(answer.rows.dataNodes) };
    if (answer.cause === 'unrouted') {
      conditionOf(path, 'WORKSPACE_MEMBER_EXCLUDED', `'${path}' is a member and is not read as json (${answer.detail}), so it has no data rows: its name, version and dependencies are unknown.`);
    } else {
      conditionOf(path, 'WORKSPACE_MEMBER_NO_ROWS', `'${path}' is a member and has no rows this run (${answer.routeState} ${answer.code}): its name, version and dependencies are unknown.`);
    }
    return { path, dir: dirName(path), workspaceRoot: false, doc: undefined };
  });
}

/** @returns One member's `workspace_packages` row; null fields for a file with no rows */
function packageRow(root: string, member: Member): WorkspacePackageRow {
  const { doc } = member;
  return {
    root,
    path: member.path,
    dir: member.dir,
    name: doc === undefined ? null : stringAt(doc, '/name'),
    version: doc === undefined ? null : stringAt(doc, '/version'),
    private: doc === undefined ? null : booleanAt(doc, '/private'),
    workspaceRoot: member.workspaceRoot,
  };
}

/** A root's workspace declaration: its patterns and manager, or none. */
type Declaration =
  | { readonly kind: 'workspace'; readonly patterns: readonly string[]; readonly resolution: Resolution }
  /**
   * No workspace; `why` says why the manager reads none when one may be meant (pnpm with no
   * `pnpm-workspace.yaml`), for the `WORKSPACE_NOT_DECLARED` condition at a `workspace:` user.
   */
  | {
    readonly kind: 'none';
    readonly why: string | undefined;
    /** Whether the root's own condition already says why no workspace is read, so no manifest needs one. */
    readonly said?: true;
  };

/** What {@link workspaceDeclaration} reads. */
interface DeclarationInput {
  readonly root: string;
  /** The root package.json, or undefined when the run holds none. */
  readonly rootDoc: Doc | undefined;
  readonly reads: DeclaredReads;
  readonly held: (path: string) => boolean;
  readonly conditionOf: ConditionWriter;
}

/** The `packageManager` field, split. */
interface PackageManager {
  /** The name, or '' when there is none. */
  readonly name: string;
  /** The version, coerced, or undefined when absent or unparseable. */
  readonly version: string | undefined;
}

/** The manager in effect at a root, and what said so. */
interface Manager extends PackageManager {
  /**
   * The files the manager was inferred from (path existence only), or undefined when the root's
   * `packageManager` names it. Name '' with evidence: no file, or files naming several managers.
   */
  readonly inferredFrom: readonly string[] | undefined;
}

/** @returns The root's `packageManager`, split into name and coerced version */
function packageManagerOf(rootDoc: Doc | undefined): PackageManager {
  const field = rootDoc === undefined ? null : stringAt(rootDoc, '/packageManager');
  if (field === null) return { name: '', version: undefined };
  const at = field.indexOf('@', 1);
  const name = at < 0 ? field : field.slice(0, at);
  return { name, version: at < 0 ? undefined : semver.coerce(field.slice(at + 1))?.version };
}

/**
 * The manager in effect: the root's `packageManager`, or with none, inferred from which files exist
 * at the root (a `pnpm-workspace.yaml`, else exactly one manager's lockfiles). Never reads a lockfile.
 *
 * @param rootDoc - The root package.json, or undefined
 * @param held - Whether the run holds a path at the root
 * @returns The manager; name '' when nothing, or several managers' files, name one
 */
function managerOf(rootDoc: Doc | undefined, held: (path: string) => boolean): Manager {
  const named = packageManagerOf(rootDoc);
  if (named.name !== '') return { ...named, inferredFrom: undefined };
  if (held(PNPM_WORKSPACE)) return { name: 'pnpm', version: undefined, inferredFrom: [PNPM_WORKSPACE] };
  const found = LOCKFILES.filter(([file]) => held(file));
  const names = [...new Set(found.map(([, manager]) => manager))];
  const inferredFrom = found.map(([file]) => file);
  return { name: names.length === 1 ? names[0] ?? '' : '', version: undefined, inferredFrom };
}

/** @returns Where a root's manager conditions go: its package.json, or `.` when the run holds none */
function managerAt(rootDoc: Doc | undefined): string {
  return rootDoc === undefined ? '.' : PACKAGE_JSON;
}

/** What an unknown manager leaves unknown, in words, for its conditions. */
const UNKNOWN_CONSEQUENCE = 'whether the root package is a member a dependency\'s name can reach, and where a workspace: path resolves from, differ by manager, so such a dependency has targetPath null with this code';

/**
 * Say how the manager was decided when the root's `packageManager` did not name it: a
 * `WORKSPACE_MANAGER_INFERRED` condition naming the evidence, or `WORKSPACE_MANAGER_UNKNOWN`.
 *
 * @param manager - The manager
 * @param conditionOf - Where the condition goes
 * @param at - Where the root's manager conditions go: the root package.json, or `.` with none
 * @param consequence - What the inference decided, in words, appended to the message
 */
function reportInference(manager: Manager, conditionOf: ConditionWriter, at: string, consequence = ''): void {
  const evidence = manager.inferredFrom;
  if (evidence === undefined) return;
  if (manager.name !== '') {
    conditionOf(at, 'WORKSPACE_MANAGER_INFERRED', `The root package.json names no packageManager; VAT reads the manager as ${manager.name} because ${wordList(evidence.map(quoted))} exist(s) at the root (path only, never read)${consequence}.`);
    return;
  }
  const found = evidence.length === 0 ? 'no lockfile exists at the root' : `the root holds lockfiles of several managers (${wordList(evidence.map(quoted))})`;
  conditionOf(at, 'WORKSPACE_MANAGER_UNKNOWN', `The root package.json names no packageManager and ${found}, so the manager is unknown: membership is read from the workspaces field (npm, yarn and bun all read it), and ${UNKNOWN_CONSEQUENCE}.`);
}

/**
 * What the root declares, reading `pnpm-workspace.yaml` only when pnpm is the manager.
 *
 * @param input - The root, its package.json, the handle, the held files and the condition writer
 * @returns The declaration
 * @throws Refused when a needed file is unrouted, has no rows, or breaks pnpm's YAML rules
 */
function workspaceDeclaration(input: DeclarationInput): Promise<Declaration> {
  const { rootDoc, held, conditionOf } = input;
  const manager = managerOf(rootDoc, held);
  if (manager.name !== 'pnpm') return Promise.resolve(workspacesDeclaration(manager, rootDoc, held, conditionOf));
  if (!held(PNPM_WORKSPACE)) {
    if (rootDoc !== undefined) reportInference(manager, conditionOf, PACKAGE_JSON, `, and the root holds no ${PNPM_WORKSPACE}, so it declares no workspace`);
    const named = manager.inferredFrom === undefined ? 'the root\'s packageManager names pnpm' : 'pnpm-lock.yaml exists at the root, so VAT reads the manager as pnpm';
    return Promise.resolve({ kind: 'none', why: `${named} while the run holds no ${PNPM_WORKSPACE} at the root` });
  }
  reportInference(manager, conditionOf, managerAt(rootDoc));
  return pnpmDeclaration(input, manager.version);
}

/**
 * A `workspaces`-field root's declaration.
 *
 * @param manager - The manager in effect
 * @param rootDoc - The root package.json, or undefined
 * @param held - Whether the run holds a path at the root
 * @param conditionOf - Where a condition goes
 * @returns The declaration
 */
function workspacesDeclaration(manager: Manager, rootDoc: Doc | undefined, held: (path: string) => boolean, conditionOf: ConditionWriter): Declaration {
  const patterns = rootDoc === undefined ? undefined : workspacesPatterns(rootDoc, conditionOf);
  if (rootDoc === undefined || patterns === undefined) return { kind: 'none', why: undefined };
  reportInference(manager, conditionOf, PACKAGE_JSON);
  const resolution = workspacesResolution(manager, held, conditionOf);
  // yarn 1's config.js: `wsCopy.packages && wsCopy.packages.length > 0 && !manifest.private`.
  if (resolution.kind === 'yarn 1' && !truthy(rootDoc.at.get('/private')) && workspacesEntryCount(rootDoc) > 0) {
    conditionOf(PACKAGE_JSON, 'WORKSPACE_NOT_DECLARED', `The root ${PACKAGE_JSON} lists workspace packages and its private field is not truthy (absent, false, 0, "" or null), and yarn 1 enables workspaces only in a private root (its install fails "Workspaces can only be enabled in private projects"), so the root declares no workspace and the workspace relations have no rows for it. Fix: set "private": true in the root ${PACKAGE_JSON}.`);
    return { kind: 'none', why: undefined, said: true };
  }
  return { kind: 'workspace', patterns, resolution };
}

/**
 * The manager of a `workspaces`-field root: npm, yarn 1 or berry (by version, else `.yarnrc.yml`
 * for berry and `yarn.lock` without it for yarn 1, each a `WORKSPACE_MANAGER_INFERRED` condition),
 * or bun; otherwise unknown, with a `WORKSPACE_MANAGER_UNKNOWN` condition at the root.
 *
 * @param manager - The manager in effect
 * @param held - Whether the run holds a path at the root
 * @param conditionOf - Where a condition goes
 * @returns The resolution
 */
function workspacesResolution(manager: Manager, held: (path: string) => boolean, conditionOf: ConditionWriter): Resolution {
  if (manager.name === 'npm' || manager.name === 'bun') return { kind: manager.name };
  // A nameless manager's WORKSPACE_MANAGER_UNKNOWN is reportInference's.
  if (manager.name === '') return { kind: 'unknown', why: 'the manager is unknown (a WORKSPACE_MANAGER_UNKNOWN condition at the root says why)' };
  if (manager.name !== 'yarn') return unknownManager(`the root's packageManager names ${manager.name}, whose rules VAT does not know`, conditionOf);
  if (manager.version !== undefined) return { kind: semver.major(manager.version) < 2 ? 'yarn 1' : 'yarn berry' };
  let kind: ManagerKind;
  let evidence: string;
  if (held(YARNRC)) [kind, evidence] = ['yarn berry', YARNRC];
  else if (held(YARN_LOCK)) [kind, evidence] = ['yarn 1', `${YARN_LOCK} without ${YARNRC}`];
  else return unknownManager('the yarn version is unknown, and neither .yarnrc.yml nor yarn.lock exists at the root to tell yarn 1 from yarn berry', conditionOf);
  conditionOf(PACKAGE_JSON, 'WORKSPACE_MANAGER_INFERRED', `The root's packageManager names yarn without a version; VAT reads it as ${kind} because ${evidence} exists at the root (path only, never read).`);
  return { kind };
}

/** @returns An unknown resolution, said once at the root package.json */
function unknownManager(why: string, conditionOf: ConditionWriter): Resolution {
  conditionOf(PACKAGE_JSON, 'WORKSPACE_MANAGER_UNKNOWN', `${capitalised(why)}, so the manager is unknown: ${UNKNOWN_CONSEQUENCE}.`);
  return { kind: 'unknown', why };
}

/**
 * A pnpm root's declaration: its `pnpm-workspace.yaml`.
 *
 * @param input - The root, the handle, the held files and the condition writer
 * @param version - The pnpm version, or undefined
 * @returns The declaration
 * @throws Refused when `pnpm-workspace.yaml` is unrouted, has no rows, or breaks pnpm's YAML rules
 */
async function pnpmDeclaration(input: DeclarationInput, version: string | undefined): Promise<Declaration> {
  const { root, reads, conditionOf } = input;
  const yamlAnswer = rootFile(await readOne(reads, root, PNPM_WORKSPACE, 'yaml', ['dataNodes', 'dataConditions']));
  refuseYamlRules(root, yamlAnswer.dataNodes, yamlAnswer.dataConditions);
  const patterns = pnpmPatterns(docOf(yamlAnswer.dataNodes), version, conditionOf, managerAt(input.rootDoc));
  return { kind: 'workspace', patterns, resolution: { kind: 'pnpm' } };
}

/**
 * `pnpm-workspace.yaml`'s member patterns under one pnpm version.
 *
 * @param yaml - The file
 * @param version - The pnpm version, or undefined
 * @param conditionOf - Where a condition goes
 * @param versionAt - Where the version condition goes: the root package.json, or `.` with none
 * @returns The patterns
 */
function pnpmPatterns(yaml: Doc, version: string | undefined, conditionOf: ConditionWriter, versionAt: string): readonly string[] {
  const managerName = version === undefined ? 'pnpm' : `pnpm ${version}`;
  const packages = yaml.at.get(PACKAGES_KEY);
  if (packages !== undefined && packages.type !== 'null') {
    return stringPatterns(yaml, PACKAGES_KEY, PNPM_WORKSPACE, conditionOf, `${managerName} refuses the file`) ?? [];
  }
  if (version === undefined) {
    conditionOf(versionAt, 'WORKSPACE_MANAGER_VERSION_UNKNOWN', `${PNPM_WORKSPACE} has no packages key, which means the root only from pnpm ${PNPM_PACKAGES_ROOT_ONLY_FROM} and every package (or a refused file) before it, and the root's packageManager gives no pnpm version; VAT reads the root only.`);
    return ROOT_ONLY;
  }
  if (semver.gte(version, PNPM_PACKAGES_ROOT_ONLY_FROM)) return ROOT_ONLY;
  const top = yaml.at.get('');
  const empty = top === undefined || top.type === 'null' || (yaml.children.get(top.ordinal) ?? []).length === 0;
  if (empty) return EVERY_PACKAGE;
  conditionOf(PNPM_WORKSPACE, 'WORKSPACE_PACKAGES_MALFORMED', `${PNPM_WORKSPACE} has keys but no packages, which ${managerName} refuses ("packages field missing or empty"); VAT reads the root only.`);
  return ROOT_ONLY;
}

/**
 * `package.json#workspaces` (an array, or yarn's `{ packages: [...] }`).
 *
 * @param rootDoc - The root package.json
 * @param conditionOf - Where a malformed list's condition goes
 * @returns The patterns, or undefined when the field is absent (no workspace)
 */
function workspacesPatterns(rootDoc: Doc, conditionOf: ConditionWriter): readonly string[] | undefined {
  const field = rootDoc.at.get(WORKSPACES_KEY);
  if (field === undefined) return undefined;
  const pointer = field.type === 'object' ? `${WORKSPACES_KEY}${PACKAGES_KEY}` : WORKSPACES_KEY;
  return stringPatterns(rootDoc, pointer, PACKAGE_JSON, conditionOf, 'the package manager does not read it as written') ?? [];
}

/**
 * The string entries of a pattern list, with a `WORKSPACE_PACKAGES_MALFORMED` condition when it is
 * not an array of strings.
 *
 * @param doc - The file
 * @param pointer - The list's pointer
 * @param path - The file's path, for the condition
 * @param conditionOf - Where the condition goes
 * @param consequence - What the manager does with it, in words
 * @returns The string entries, or undefined when the list is no array
 */
function stringPatterns(doc: Doc, pointer: string, path: string, conditionOf: ConditionWriter, consequence: string): string[] | undefined {
  const node = doc.at.get(pointer);
  if (node?.type !== 'array') {
    const found = node === undefined ? 'absent' : `a ${node.type}`;
    conditionOf(path, 'WORKSPACE_PACKAGES_MALFORMED', `${pointer} in ${path} is ${found}, not an array of strings; ${consequence}. VAT reads no pattern from it.`);
    return undefined;
  }
  const entries = doc.children.get(node.ordinal) ?? [];
  const strings = entries.flatMap((child) => (child.type === 'string' && typeof child.value === 'string' && child.value !== '' ? [child.value] : []));
  if (strings.length < entries.length) {
    conditionOf(path, 'WORKSPACE_PACKAGES_MALFORMED', `${pointer} in ${path} holds ${String(entries.length - strings.length)} entry(ies) that are not non-empty strings; ${consequence}. VAT reads the string entries only.`);
  }
  return strings;
}

/** The rows of one root file, refusing when it has none. */
type RootFileAnswer<Table extends 'dataNodes' | 'dataConditions'> = DeclaredAnswer<Table>;

/**
 * Read one root file.
 *
 * @param reads - The handle
 * @param root - The root id
 * @param path - The file
 * @param variant - Its variant
 * @param tables - The tables to read
 * @returns Its answer
 */
async function readOne<Table extends 'dataNodes' | 'dataConditions'>(reads: DeclaredReads, root: string, path: string, variant: DataVariant, tables: readonly Table[]): Promise<RootFileAnswer<Table>> {
  const [answer] = await reads.read([{ root, path, variant }], { tables });
  if (answer === undefined) throw new Error(`The handle answered nothing for '${path}'.`);
  return answer;
}

/**
 * A root file's rows, or the root's refusal when it has none.
 *
 * @param answer - The handle's answer
 * @returns The rows
 * @throws Refused `DATA_REQUEST_UNROUTED` or `WORKSPACE_ROOT_NO_ROWS`
 */
function rootFile<Table extends 'dataNodes' | 'dataConditions'>(answer: RootFileAnswer<Table>): Extract<RootFileAnswer<Table>, { state: 'present' }>['rows'] {
  if (answer.state === 'present') return answer.rows;
  if (answer.cause === 'unrouted') throw unroutedRefusal(answer);
  const { root, path } = answer.pair;
  throw new Refused({
    code: 'WORKSPACE_ROOT_NO_ROWS',
    root,
    path,
    message: `'${path}' decides the workspace's membership and has no rows this run (${answer.routeState} ${answer.code}), so this root's membership is unknown and its workspace rows are refused; its DATA_FILE_NO_ROWS finding, reported beside this refusal, names what failed.`,
    // The data stage's one remedy for the file, so this and its finding never disagree.
    remedy: answer.remedy,
    retryable: answer.retryable,
  });
}

/**
 * Whether a path at a root is one of the step's root inputs: a file that decides the root's
 * membership, whose having no rows refuses the root ({@link rootFile}) rather than marking a member.
 * The data stage reads it so it never tells such a file to route itself away.
 *
 * @param path - A path relative to its root
 * @returns True for the root `package.json` and `pnpm-workspace.yaml`
 */
export function isWorkspaceRootInput(path: string): boolean {
  return path === PACKAGE_JSON || path === PNPM_WORKSPACE;
}

/** @returns The root's `DATA_REQUEST_UNROUTED` refusal for a declared pair */
function unroutedRefusal(answer: Extract<DeclaredAnswer<never>, { cause: 'unrouted' }>): Refused {
  const { root, path } = answer.pair;
  return new Refused({
    code: answer.code,
    root,
    path,
    message: `The workspace step needs '${path}' and cannot read it: ${answer.detail}. It decides this root's membership, so while it is not read this root has no workspace rows; nothing else the run answers depends on it.`,
    remedy: `${answer.remedy}; routing it is the only way this root's workspace rows come back`,
    retryable: false,
  });
}

/**
 * Refuse a pnpm-workspace.yaml that js-yaml would refuse or read differently where the step reads
 * it: a duplicate at or beneath `packages`, or a `<<` that may supply it.
 *
 * @param root - The root id
 * @param nodes - Its nodes, shadowed included
 * @param conditions - Its conditions
 * @throws Refused `WORKSPACE_DUPLICATE_KEY` or `WORKSPACE_MERGE_KEY`
 */
function refuseYamlRules(root: string, nodes: readonly DataNodeRow[], conditions: readonly DataConditionRow[]): void {
  const first = nodes.filter((node) => node.doc === 0);
  const byOrdinal = new Map(first.map((node) => [node.ordinal, node]));
  for (const condition of conditions) {
    if (condition.doc !== 0 || condition.code !== 'DATA_DUPLICATE_KEY' || condition.node === null) continue;
    const pointer = byOrdinal.get(condition.node)?.pointer;
    if (pointer === undefined || !underReadKey(pointer)) continue;
    const lines = first.filter((node) => node.pointer === pointer).map((node) => node.line).toSorted((left, right) => left - right);
    throw new Refused({
      code: 'WORKSPACE_DUPLICATE_KEY',
      root,
      path: PNPM_WORKSPACE,
      message: `${PNPM_WORKSPACE} repeats the key ${pointer} (lines ${wordList(lines.map(String))}); pnpm loads the file with js-yaml, which refuses a duplicated key, so this root's workspace rows are refused.`,
      remedy: 'remove the repeated key',
      retryable: false,
    });
  }
  const explicitPackages = first.some((node) => node.pointer === PACKAGES_KEY);
  const merge = first.find((node) => node.key === '<<' && mergeReaches(parentPointer(node.pointer), explicitPackages));
  if (merge !== undefined) {
    throw new Refused({
      code: 'WORKSPACE_MERGE_KEY',
      root,
      path: PNPM_WORKSPACE,
      message: `${PNPM_WORKSPACE} has a << merge key at ${merge.pointer} (line ${merge.line}); pnpm's js-yaml merges it and VAT's rows hold it literally, so the packages the workspace step reads may come from the merge, and this root's workspace rows are refused.`,
      remedy: 'write the merged keys out in place of the << merge',
      retryable: false,
    });
  }
}

/** @returns Whether a `<<` under `parent` may supply what the step reads: under `packages`, or at the top with no `packages` of its own */
function mergeReaches(parent: string, explicitPackages: boolean): boolean {
  return underReadKey(parent) || (parent === '' && !explicitPackages);
}

/** What {@link reportUndeclared} reads. */
interface UndeclaredInput {
  readonly root: string;
  /** The root's held package.json paths, sorted. */
  readonly candidates: readonly string[];
  readonly reads: DeclaredReads;
  /** Every path the run holds under the root. */
  readonly files: ReadonlySet<string>;
  /** Why the manager reads no workspace at the root when one may be meant, or undefined. */
  readonly why: string | undefined;
  readonly conditionOf: ConditionWriter;
}

/**
 * One condition per routed package.json that declares a `workspace:` dependency under a root that
 * declares no workspace, unless a nested workspace under the root resolves it: scoped to that
 * manifest, never a refusal, since a fixture's manifest is a common way to be here.
 *
 * @param input - The root, its candidates, the handle, the held files, why no workspace is read and the condition writer
 */
async function reportUndeclared(input: UndeclaredInput): Promise<void> {
  const { root, candidates, reads, conditionOf } = input;
  if (candidates.length === 0) return;
  const answers = await reads.read(candidates.map((path) => ({ root, path, variant: 'json' as const })), { tables: ['dataNodes'] });
  const docs = answers.flatMap((answer) => (answer.state === 'present' ? [{ path: answer.pair.path, doc: docOf(answer.rows.dataNodes) }] : []));
  const nested = nestedWorkspaceDirs(docs, input.files);
  // A file with no rows is its own finding. An unrouted one cannot be read, and is passed over:
  // the scan sees only routed files (a limit of the trace, not a condition of its own).
  for (const { path, doc } of docs) {
    if (path === PACKAGE_JSON || nested.some((dir) => isWithin(dirName(path), dir))) continue;
    const found = workspaceDependency(doc);
    if (found !== undefined) undeclaredCondition(path, found, input.why, conditionOf);
  }
}

/** @returns The directories under the root (never `.`) that hold a nested workspace declaration */
function nestedWorkspaceDirs(docs: ReadonlyArray<{ readonly path: string; readonly doc: Doc }>, files: ReadonlySet<string>): string[] {
  const declaring = docs.filter(({ doc }) => doc.at.has(WORKSPACES_KEY)).map(({ path }) => path);
  const pnpm = [...files].filter((path) => baseName(path) === PNPM_WORKSPACE);
  return [...declaring, ...pnpm].map(dirName).filter((dir) => dir !== '.');
}

/** @returns Whether `dir` is `ancestor` or beneath it */
function isWithin(dir: string, ancestor: string): boolean {
  return dir === ancestor || toForwardSlash(dir).startsWith(`${ancestor}/`);
}

/** @returns The first `workspace:` dependency a file declares, as field, name and range */
function workspaceDependency(doc: Doc): readonly [string, string, string] | undefined {
  for (const field of DEPENDENCY_FIELDS) {
    const found = entriesAt(doc, `/${field}`).find(([, range]) => range.startsWith(WORKSPACE_PREFIX));
    if (found !== undefined) return [field, found[0], found[1]];
  }
  return undefined;
}

/** The fix both undeclared conditions end on: excluding a fixture is a real end state. */
const UNDECLARED_FIXTURE = 'if it is a fixture or other manifest no workspace installs, route it away with resources.extractors.data.exclude';

/** Write the condition for a `workspace:` dependency under a root that declares no workspace. */
function undeclaredCondition(path: string, [field, name, range]: readonly [string, string, string], why: string | undefined, conditionOf: ConditionWriter): void {
  const declares = `'${path}' declares ${field}.${name}: '${range}', which only a workspace resolves`;
  if (why !== undefined) {
    conditionOf(path, 'WORKSPACE_NOT_DECLARED', `${declares}, and ${why}, so the root declares no workspace. Fix: add ${PNPM_WORKSPACE} at the analysis root; when the workspace root is above it, run VAT from there; ${UNDECLARED_FIXTURE}.`);
    return;
  }
  conditionOf(path, 'WORKSPACE_ROOT_OUTSIDE_ROOT', `${declares}, and the analysis root declares no workspace, so its workspace root lies above the analysis root (or the root's declaration is missing). Fix: run VAT with the workspace root (the directory holding the root package.json or pnpm-workspace.yaml) as its analysis root, or declare the workspace at this root; ${UNDECLARED_FIXTURE}.`);
}

/** The member a dependency names, and the condition that says why it is null when it may not be. */
interface Target {
  readonly targetPath: string | null;
  readonly condition?: { readonly code: WorkspaceConditionCode; readonly message: string };
}

/** Finds the member a dependency names. */
type Targeter = (member: Member, name: string, range: string) => Target;

/** What {@link targeter} is built over. */
interface TargeterInput {
  /** The root's members, the root first and then by path. */
  readonly members: readonly Member[];
  /** Their package rows. */
  readonly packages: readonly WorkspacePackageRow[];
  readonly resolution: Resolution;
  /** Where a duplicate or nameless member's condition goes. */
  readonly conditionOf: ConditionWriter;
}

/** A member's row and the name a dependency's name matches it by. */
interface NamedRow {
  readonly row: WorkspacePackageRow;
  /** The name matched, or null when it has none or it is unknown. */
  readonly name: string | null;
  /** Whether npm's folder name supplies it, the `name` field being absent or empty. */
  readonly byFolder: boolean;
}

/** Everything one root's targets are decided over. */
interface TargetContext {
  readonly resolution: Resolution;
  /** The manager's rules, or undefined when it is unknown. */
  readonly rules: ManagerRules | undefined;
  /** The non-root members by the name matched. */
  readonly byName: ReadonlyMap<string, readonly WorkspacePackageRow[]>;
  /** Each member's package.json by its directory. */
  readonly byDir: ReadonlyMap<string, string>;
  readonly root: WorkspacePackageRow | undefined;
  /** Under an unknown manager, the nameless members npm would name by their folder, by that name. */
  readonly folderNamed: ReadonlyMap<string, readonly string[]>;
}

/** @returns A null target, with a condition */
function noTarget(code: WorkspaceConditionCode, message: string): Target {
  return { targetPath: null, condition: { code, message } };
}

/** @returns Why the manager is unknown, in words, or '' when it is known */
function unknownWhy(resolution: Resolution): string {
  return resolution.kind === 'unknown' ? resolution.why : '';
}

/**
 * The name a dependency's name matches a member by: its `name`, or under npm its folder when the
 * field is absent or empty. A member with rows and no name (the root aside, which commonly has
 * none) is a `WORKSPACE_MEMBER_NAMELESS` condition under every other manager; under an unknown
 * manager it also enters `folderNamed`, since npm would name it by its folder.
 *
 * @param member - The member
 * @param resolution - The manager in effect
 * @param conditionOf - Where the condition goes
 * @param folderNamed - Where an unknown manager's folder names go
 * @returns The name matched, and whether the folder supplies it
 */
function memberName(member: Member, resolution: Resolution, conditionOf: ConditionWriter, folderNamed: Map<string, string[]>): Omit<NamedRow, 'row'> {
  const { doc, path } = member;
  const none = { name: null, byFolder: false };
  if (doc === undefined) return none;
  const written = stringAt(doc, '/name');
  if (written !== null && written !== '') return { name: written, byFolder: false };
  if (member.workspaceRoot) return none;
  // npm: `pkg.name || getName(pathname)`, so any falsy name is replaced by the folder's.
  const byNpmFolder = !truthy(doc.at.get('/name'));
  const folder = nameFromFolder(member.dir);
  if (resolution.kind === 'npm' && byNpmFolder) return { name: folder, byFolder: true };
  if (resolution.kind === 'unknown' && byNpmFolder) {
    folderNamed.set(folder, [...folderNamed.get(folder) ?? [], path]);
    conditionOf(path, 'WORKSPACE_MEMBER_NAMELESS', `'${path}' has no name field (absent or empty): npm names it '${folder}' by its folder, and yarn and bun give it no name, and ${unknownWhy(resolution)}, so whether a dependency named '${folder}' names it is unknown.`);
    return none;
  }
  const under = resolution.kind === 'unknown' ? 'any manager' : resolution.kind;
  conditionOf(path, 'WORKSPACE_MEMBER_NAMELESS', `'${path}' has no name (its name field is absent, empty or not a string), so under ${under} no dependency can name it by name; a path still can.`);
  return none;
}

/** @returns The name npm gives a directory's package (@npmcli/name-from-folder): its base name, `@scope/base` under an `@` directory */
function nameFromFolder(dir: string): string {
  const base = baseName(dir);
  const parent = baseName(dirName(dir));
  return parent.startsWith('@') ? `${parent}/${base}` : base;
}

/**
 * The members by name, the root aside, and a `WORKSPACE_DUPLICATE_NAME` condition at each member
 * that shares its name with another a dependency's name can reach (the root included where a
 * name reaches it and no member shadows it).
 *
 * @param named - The root's rows with their names
 * @param rootReachable - Whether names reach the root beside a member carrying its name
 * @param conditionOf - Where a duplicate's condition goes
 * @returns The non-root rows by name
 */
function membersByName(named: readonly NamedRow[], rootReachable: boolean, conditionOf: ConditionWriter): Map<string, WorkspacePackageRow[]> {
  const byName = new Map<string, NamedRow[]>();
  for (const entry of named) {
    if (entry.name === null || entry.row.workspaceRoot) continue;
    byName.set(entry.name, [...byName.get(entry.name) ?? [], entry]);
  }
  const root = named.find((entry) => entry.row.workspaceRoot && entry.name !== null);
  for (const [name, members] of byName) {
    const entries = rootReachable && root?.name === name ? [root, ...members] : members;
    if (entries.length < 2) continue;
    for (const entry of entries) {
      const others = wordList(entries.filter((other) => other !== entry).map((other) => quoted(other.row.path)));
      const folder = entry.byFolder ? ` (npm's name for it, from its folder, since its name field is absent or empty)` : '';
      conditionOf(entry.row.path, 'WORKSPACE_DUPLICATE_NAME', `'${entry.row.path}' shares the name '${name}'${folder} with ${others}, so a dependency that names '${name}' by name, not by path, names no one member and its targetPath is null.`);
    }
  }
  return new Map([...byName].map(([name, entries]) => [name, entries.map((entry) => entry.row)]));
}

/**
 * The targeter over one root's members: a path by directory, anything else by name.
 *
 * @param input - The root's members and package rows, the manager and the condition writer
 * @returns The targeter
 */
function targeter(input: TargeterInput): Targeter {
  const { members, packages, resolution, conditionOf } = input;
  const rules = resolution.kind === 'unknown' ? undefined : MANAGER_RULES[resolution.kind];
  const folderNamed = new Map<string, string[]>();
  const rowOf = new Map(packages.map((row) => [row.path, row] as const));
  const named = members.flatMap((member): NamedRow[] => {
    const row = rowOf.get(member.path);
    return row === undefined ? [] : [{ row, ...memberName(member, resolution, conditionOf, folderNamed) }];
  });
  const context: TargetContext = {
    resolution,
    rules,
    byName: membersByName(named, rules !== undefined && rules.rootByWorkspaceName && !rules.memberShadowsRoot, conditionOf),
    byDir: new Map(packages.map((row) => [row.dir, row.path] as const)),
    root: packages.find((row) => row.workspaceRoot),
    folderNamed,
  };
  return (member, name, range) => {
    if (range.startsWith(WORKSPACE_PREFIX)) return workspaceTarget(context, member, name, range);
    if (range.startsWith(LINK_PREFIX)) return linkTarget(context, member, name, range);
    if (range.startsWith(FILE_PREFIX)) return atDirTarget(context, member.dir, range.slice(FILE_PREFIX.length), name, range);
    if (range.startsWith(NPM_PREFIX)) return namedTarget(context, aliasName(range.slice(NPM_PREFIX.length)), range, false);
    return bareTarget(context, member, name, range);
  };
}

/** @returns The rows a name reaches: its members, and the root where the manager lets the name reach it */
function reached(context: TargetContext, name: string, viaWorkspace: boolean): readonly WorkspacePackageRow[] {
  const { rules, root } = context;
  const members = context.byName.get(name) ?? [];
  if (rules === undefined || root?.name !== name) return members;
  if (rules.memberShadowsRoot && members.length > 0) return members;
  const reaches = viaWorkspace ? rules.rootByWorkspaceName : rules.rootByName;
  return reaches ? [root, ...members] : members;
}

/** @returns The member a name names; null when none or several do, or the answer depends on an unknown manager */
function namedTarget(context: TargetContext, name: string, range: string, viaWorkspace: boolean): Target {
  const rows = reached(context, name, viaWorkspace);
  if (rows.length > 1) return { targetPath: null };
  const { resolution } = context;
  if (resolution.kind === 'unknown') {
    if (name === context.root?.name) {
      return noTarget('WORKSPACE_MANAGER_UNKNOWN', `'${name}' (${range}) is the root package's name, which some managers let a dependency name and others do not, and ${resolution.why}, so whether it names the root is unknown.`);
    }
    const folders = context.folderNamed.get(name);
    if (folders !== undefined) {
      return noTarget('WORKSPACE_MANAGER_UNKNOWN', `'${name}' (${range}) is the folder name of ${wordList(folders.map(quoted))}, which npm names it by and yarn and bun do not, and ${resolution.why}, so the member it names is unknown.`);
    }
  }
  return { targetPath: rows[0]?.path ?? null };
}

/** @returns The member at a directory a path names, from `from`; null with `WORKSPACE_PATH_UNRESOLVED` when none */
function atDirTarget(context: TargetContext, from: string, relative: string, name: string, range: string): Target {
  // A home path (`~/`) is outside the analysis root, like an absolute one.
  const dir = isAbsolute(relative) || /^~[/\\]/.test(relative) ? undefined : joinedDir(from, relative);
  const path = dir === undefined ? undefined : context.byDir.get(dir);
  if (path !== undefined) return { targetPath: path };
  const where = dir === undefined ? `'${relative}', which leaves the analysis root` : `the directory '${dir}', which holds no member of this workspace`;
  return noTarget('WORKSPACE_PATH_UNRESOLVED', `'${name}' (${range}) names ${where}, so it names no member.`);
}

/** @returns The member a `workspace:` range names, by the manager's path and alias rules */
function workspaceTarget(context: TargetContext, member: Member, name: string, range: string): Target {
  const { rules, resolution } = context;
  const suffix = range.slice(WORKSPACE_PREFIX.length);
  const spec = suffix.trim();
  if (rules === undefined) {
    if (!berryWorkspacePath(spec)) return namedTarget(context, name, range, true);
    return noTarget('WORKSPACE_MANAGER_UNKNOWN', `'${name}' (${range}) may be a path, which pnpm and bun resolve from the declaring package and yarn berry from the project root, and ${unknownWhy(resolution)}, so the member it names is unknown.`);
  }
  const path = rules.workspacePath;
  if (path === undefined) {
    if (!looksLikePath(spec)) return namedTarget(context, name, range, true);
    return noTarget('WORKSPACE_PATH_UNRESOLVED', `'${name}' (${range}) is a workspace: path, and ${resolution.kind} has no workspace: path form, so it names no member.`);
  }
  const lookup = rules.workspaceAlias(suffix) ?? name;
  const nameAnswers = path.nameFirst && reached(context, lookup, true).length > 0;
  if (!nameAnswers && path.isPath(spec)) return atDirTarget(context, path.from === 'root' ? '.' : member.dir, spec, name, range);
  return namedTarget(context, lookup, range, true);
}

/** @returns The member a `link:` range names: a directory, except bun's `bun link` registration of a package name */
function linkTarget(context: TargetContext, member: Member, name: string, range: string): Target {
  const target = range.slice(LINK_PREFIX.length);
  if (isNpmPackageName(target)) {
    if (context.rules?.linkRegistration === true) {
      return noTarget('WORKSPACE_PATH_UNRESOLVED', `'${name}' (${range}) names '${target}', a package registered with bun link, not a directory, so it names no member.`);
    }
    if (context.resolution.kind === 'unknown') {
      return noTarget('WORKSPACE_MANAGER_UNKNOWN', `'${name}' (${range}) is a package registered with bun link to bun and a path to the other managers, and ${context.resolution.why}, so the member it names is unknown.`);
    }
  }
  return atDirTarget(context, member.dir, target, name, range);
}

/** @returns The member a range with no `workspace:`, `link:`, `file:` or `npm:` prefix names: a path where the manager reads one, else by name */
function bareTarget(context: TargetContext, member: Member, name: string, range: string): Target {
  const reading = bareReading(range, context.resolution);
  if (reading.kind === 'path') return atDirTarget(context, member.dir, range, name, range);
  if (reading.kind === 'name') return namedTarget(context, name, range, false);
  return noTarget('WORKSPACE_MANAGER_UNKNOWN', `'${name}' (${range}) is a path to ${wordList(reading.readers)} and a name to the other managers that read workspaces, and ${unknownWhy(context.resolution)}, so the member it names is unknown.`);
}

/**
 * Whether a string is an npm package name as bun tests one (bun-immutable `is_npm_package_name`,
 * ported as written): at most 214 characters; unscoped, a letter, digit, `$` or `-` first and then
 * letters, digits, `-`, `_` and `.`; scoped, `@scope/name` with one slash, a non-empty name, and
 * `!~*'()` allowed in the scope only.
 *
 * @param target - The string
 * @returns Whether it is a package name
 */
function isNpmPackageName(target: string): boolean {
  if (target.length > 214 || target === '') return false;
  const first = target.charAt(0);
  if (first !== '@' && !/^[A-Za-z0-9$-]$/.test(first)) return false;
  const scoped = first === '@';
  let slashIndex = 0;
  for (let index = 1; index < target.length; index++) {
    const char = target.charAt(index);
    if (/^[\w.-]$/.test(char)) continue;
    const inScope = scoped && slashIndex === 0;
    if (char === '/' && inScope) slashIndex = index;
    else if (!inScope || !"!~*'()".includes(char)) return false;
  }
  return !scoped || (slashIndex > 0 && slashIndex + 1 < target.length);
}

/** @returns The package an `npm:<name>@<range>` alias names */
function aliasName(spec: string): string {
  const at = spec.lastIndexOf('@');
  return at > 0 ? spec.slice(0, at) : spec;
}

/** @returns Whether a path is absolute (POSIX, or a Windows drive or UNC path) */
function isAbsolute(path: string): boolean {
  return /^(?:[/\\]|[A-Za-z]:)/.test(path);
}

/**
 * The matcher of member package.json paths for some workspace patterns.
 *
 * @param patterns - The patterns, `!` negating
 * @param pnpm - Whether pnpm's finder ignores apply
 * @returns Whether a package.json path is a member
 */
function memberMatcher(patterns: readonly string[], pnpm: boolean): (path: string) => boolean {
  const include: string[] = [];
  const exclude: string[] = pnpm ? [...PNPM_IGNORES] : [];
  for (const pattern of patterns) {
    const negated = pattern.startsWith('!');
    const dir = canonicalDir(negated ? pattern.slice(1) : pattern);
    if (dir === undefined) continue;
    const glob = dir === '.' ? PACKAGE_JSON : `${dir}/${PACKAGE_JSON}`;
    (negated ? exclude : include).push(glob);
  }
  if (include.length === 0) return () => false;
  const included = picomatch(include);
  const excluded = exclude.length === 0 ? () => false : picomatch(exclude);
  return (path) => included(path) && !excluded(path);
}

/**
 * A pattern or relative directory, canonicalised: `./` and `.` segments dropped, `..` applied,
 * a trailing `/` dropped.
 *
 * @param pattern - The pattern
 * @returns The directory (`.` for the root), or undefined when it climbs above the root
 */
function canonicalDir(pattern: string): string | undefined {
  const segments: string[] = [];
  for (const segment of toForwardSlashAnyPlatform(pattern).split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) return undefined;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.length === 0 ? '.' : segments.join('/');
}

/** @returns `relative` against `dir`, canonicalised, or undefined above the root */
function joinedDir(dir: string, relative: string): string | undefined {
  return canonicalDir(dir === '.' ? relative : `${dir}/${relative}`);
}

/** @returns A path's directory, `.` at the root */
function dirName(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '.' : path.slice(0, slash);
}

/** @returns A path's last segment */
function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** @returns The pointer of a node's parent */
function parentPointer(pointer: string): string {
  return pointer.slice(0, Math.max(0, pointer.lastIndexOf('/')));
}

/** @returns Whether a pointer is at or beneath a key the step reads in pnpm-workspace.yaml */
function underReadKey(pointer: string): boolean {
  return PNPM_READ_KEYS.some((key) => pointer === key || pointer.startsWith(`${key}/`));
}

/**
 * A file's first document as the tools read it: unshadowed nodes only (the last occurrence wins).
 *
 * @param nodes - The file's nodes
 * @returns The document
 */
function docOf(nodes: readonly DataNodeRow[]): Doc {
  const kept = nodes.filter((node) => node.doc === 0 && !node.shadowed);
  const children = new Map<number, DataNodeRow[]>();
  for (const node of kept) {
    if (node.parent === null) continue;
    const held = children.get(node.parent);
    if (held === undefined) children.set(node.parent, [node]);
    else held.push(node);
  }
  for (const list of children.values()) list.sort((left, right) => left.ordinal - right.ordinal);
  return { at: new Map(kept.map((node) => [node.pointer, node])), children };
}

/** @returns The string at a pointer, or null */
function stringAt(doc: Doc, pointer: string): string | null {
  const node = doc.at.get(pointer);
  return node?.type === 'string' && typeof node.value === 'string' ? node.value : null;
}

/** @returns The boolean at a pointer, or null */
function booleanAt(doc: Doc, pointer: string): boolean | null {
  const node = doc.at.get(pointer);
  return node?.type === 'boolean' && typeof node.value === 'boolean' ? node.value : null;
}

/** @returns Whether a node is truthy as JavaScript reads the value: absent, null, false, 0 and '' are not; an object or array is */
function truthy(node: DataNodeRow | undefined): boolean {
  if (node === undefined) return false;
  if (node.type === 'object' || node.type === 'array') return true;
  if (node.type === 'number') return Number(node.lexeme ?? node.value) !== 0;
  return Boolean(node.value);
}

/** @returns The length of `workspaces` (or `workspaces.packages`) as yarn 1 reads it: an array's entries or a string's characters, else 0 */
function workspacesEntryCount(rootDoc: Doc): number {
  const field = rootDoc.at.get(WORKSPACES_KEY);
  const node = field?.type === 'object' ? rootDoc.at.get(`${WORKSPACES_KEY}${PACKAGES_KEY}`) : field;
  if (node?.type === 'array') return node.childCount;
  return node?.type === 'string' && typeof node.value === 'string' ? node.value.length : 0;
}

/** @returns The string members of the object at a pointer, in source order; a non-string member is skipped */
function entriesAt(doc: Doc, pointer: string): Array<[string, string]> {
  const node = doc.at.get(pointer);
  if (node?.type !== 'object') return [];
  return (doc.children.get(node.ordinal) ?? []).flatMap((child): Array<[string, string]> =>
    child.key !== null && child.type === 'string' && typeof child.value === 'string' ? [[child.key, child.value]] : []);
}

/**
 * A condition writer numbering each (path, code)'s conditions from 0.
 *
 * @param root - The root id
 * @param into - Where the rows go
 * @returns The writer
 */
function conditionMaker(root: string, into: WorkspaceConditionRow[]): ConditionWriter {
  const seqs = new Map<string, number>();
  return (path, code, message) => {
    const key = `${path}\0${code}`;
    const seq = seqs.get(key) ?? 0;
    seqs.set(key, seq + 1);
    into.push({ root, path, code, seq, message });
  };
}

/** @returns A path in quotes */
function quoted(path: string): string {
  return `'${path}'`;
}

/** @returns The text with its first letter upper-cased */
function capitalised(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** @returns `a`, `a and b`, `a, b and c` */
function wordList(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1) ?? ''}`;
}
