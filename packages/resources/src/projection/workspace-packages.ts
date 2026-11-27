/**
 * The workspace resolve step: `workspace_packages`, `workspace_dependencies` and
 * `workspace_conditions`, derived per run from the `data` instance's rows and never stored, since
 * membership, names and links each depend on many files.
 *
 * It reads ONLY through the declared-reads handle, never the disk: the `json` pair of every
 * `package.json` the run holds (outside `node_modules`), and at each analysis root its `package.json` (`json`), `pnpm-workspace.yaml`
 * (`yaml`) and `.npmrc` (`ini`) when the run holds them. Nothing else is read; which lockfiles
 * and `.yarnrc.yml` exist at a root is asked of the paths the run holds, never their content. A root file is read only when
 * the rules below need it, so an excluded `pnpm-workspace.yaml` under an npm workspace refuses nothing.
 *
 * ## Membership
 *
 * - **Which manager.** The root `package.json`'s `packageManager` (`pnpm@9.0.0`): `pnpm` reads
 *   `pnpm-workspace.yaml`; any other manager (`npm`, `yarn`, `bun`) reads `package.json#workspaces`.
 *   With no `packageManager`, the manager is inferred from which files exist at the root, by path
 *   only and never by reading them: a `pnpm-workspace.yaml` means pnpm, and otherwise exactly one
 *   manager's lockfiles ({@link LOCKFILES}) name it; a `WORKSPACE_MANAGER_INFERRED` condition names
 *   the evidence. With none, or several managers' lockfiles, the manager is unknown
 *   (`WORKSPACE_MANAGER_UNKNOWN`): membership is still the `workspaces` field, which npm, yarn and
 *   bun all read, but a `workspace:` or `catalog:` dependency, whose meaning depends on the manager,
 *   links nothing and carries the same code. yarn is yarn 1 or berry by its version, and without
 *   one by `.yarnrc.yml` (berry) or `yarn.lock` without it (yarn 1), said the same way. pnpm with
 *   no `pnpm-workspace.yaml` is no workspace. A `pnpm-workspace.yaml` with no root `package.json` is
 *   a pnpm workspace with no root row (pnpm runs without one).
 * - **The manager's version.** pnpm's rules moved between releases; {@link PNPM_RULES} holds every
 *   version-dependent rule in one table, read with the `packageManager` version. An unknown version,
 *   or one past the newest major the table was checked against (pnpm 12), takes the newest row and
 *   is a `WORKSPACE_MANAGER_VERSION_UNCHECKED` condition.
 * - **Patterns.** `workspaces` is an array, or yarn's `{ packages: [...] }`. pnpm's `packages`:
 *   absent, before pnpm 10.5, means every package (`['.', '**']`) when the file has no other key,
 *   and pnpm refuses the file otherwise; from 10.5 it means the root only (`['.']`). pnpm's
 *   workspace finder ignores `**\/node_modules/**` and `**\/bower_components/**` and nothing else.
 *   A pattern starting `!` excludes, whatever its position. Each pattern is canonicalised before
 *   matching (`./packages/*` is `packages/*`, `tools/../libs/*` is `libs/*`, a trailing `/` dropped);
 *   one that climbs above the root matches nothing here (nested and enclosing roots are out of
 *   scope). A pattern names directories; a member is a held `package.json` whose directory it
 *   matches, decided from paths alone. A malformed pattern list (not an array, a non-string entry)
 *   is a `WORKSPACE_PACKAGES_MALFORMED` condition; its string entries are read.
 * - **The root.** The root `package.json` is the workspace root (`workspaceRoot` true) whether or
 *   not a pattern also matches it. A root that declares no workspace has no rows; when it holds a
 *   `package.json` and sits below its repository's top level, a `WORKSPACE_ROOT_MAY_BE_ABOVE`
 *   condition at `.` says a workspace may enclose it.
 *
 * ## Linking
 *
 * - `workspace:<path>` (a range starting `./` or `../`, pnpm): by directory, relative to the
 *   declaring member. Every other `workspace:` range (`*`, `^`, `~`, a range) by the dependency's
 *   name, and `workspace:<alias>@<range>` by the alias. npm and yarn 1 do not support the protocol
 *   and fail the install: such a range links nothing and is a `WORKSPACE_PROTOCOL_UNSUPPORTED`
 *   condition.
 * - `link:` and `file:`: by directory, when it is a member's.
 * - `catalog:` and `catalog:<name>` (`catalog:default` is `catalog:`): `range` is the entry of
 *   `catalog` (or `catalogs.default`) or `catalogs.<name>`, then linked as a plain range; no entry
 *   is a `WORKSPACE_CATALOG_UNRESOLVED` condition naming the manager, and `range` stays as written.
 *   Both `catalog` and `catalogs.default` present is a `WORKSPACE_CATALOG_CONFLICT` condition at the
 *   file. pnpm refuses the file, so every `catalog:` dependency on the default catalog links
 *   nothing; bun merges them and refuses a name in both, so a dependency on such a name links
 *   nothing; each carries the same code. pnpm before 9.5.0 has no catalogs: a `catalog:` range is
 *   `WORKSPACE_PROTOCOL_UNSUPPORTED`.
 *   Where the catalogs live depends on the manager in effect (decided as under Membership):
 *   - **pnpm**: `pnpm-workspace.yaml`.
 *   - **bun** (https://bun.com/docs/install/catalogs): the root `package.json`, either inside the
 *     `workspaces` object (`workspaces.catalog` / `workspaces.catalogs`) or at its top level
 *     (`catalog` / `catalogs`). bun's docs allow both and do not say which wins; VAT's choice: when
 *     the `workspaces` object holds `catalog` or `catalogs`, only that form is read, otherwise the
 *     top-level form. Both are read from the root `package.json`'s rows, already read for
 *     membership (unshadowed nodes, no further read).
 *   - **No `packageManager`**: the inferred manager's rule; an unknown manager reads none.
 *   - **npm, yarn** (or any other named manager): no catalog is read, so every `catalog:` range is
 *     unresolved.
 * - **A plain range** links the same-named member when the member's `version` satisfies it (`*`
 *   links whatever the version). npm, yarn and bun workspaces always do this. pnpm does only with
 *   `link-workspace-packages` `true` or `deep`, read from `pnpm-workspace.yaml` as camelCase
 *   `linkWorkspacePackages` from pnpm 10.5.0 (pnpm reads no setting from that file before, and no
 *   kebab-case key ever: either is a `WORKSPACE_SETTING_IGNORED` condition) and, when that sets
 *   nothing and the pnpm version still reads it there, from the root `.npmrc`; otherwise the
 *   version's default ({@link PNPM_RULES}). Any other value is off: a `${VAR}` in `.npmrc` is
 *   stored literally (the environment is not a file fact), so it is not `true` here even where
 *   pnpm's environment would make it so. An `.npmrc` the run cannot read (excluded, or no rows) is
 *   a `WORKSPACE_SETTING_UNKNOWN` condition, never a refusal: membership does not depend on it, and
 *   a plain range that would link a member links nothing, with `WORKSPACE_TARGET_UNKNOWN`. `npm:`
 *   aliases never link.
 * - **pnpm links by name and version.** Under pnpm, a `workspace:` range by name and a plain range
 *   link only when exactly one member of that name satisfies the range (by semver; `workspace:*`,
 *   `workspace:^` and `workspace:~` take any version). Several is `WORKSPACE_TARGET_AMBIGUOUS` and
 *   none (for a plain range, among same-named members) `WORKSPACE_TARGET_UNSATISFIED`; both link
 *   nothing, since VAT does not model which one pnpm picks.
 * - **Two members with one name** under npm, yarn or bun (which refuse to install it): the root,
 *   then the first by code-unit path order, keeps the name for linking, and each later one is a
 *   `WORKSPACE_DUPLICATE_NAME` condition naming both.
 *
 * ## The tools' rules on duplicate keys (consumer rules, spec 3.5)
 *
 * `package.json` and `.npmrc`: npm, pnpm, yarn and bun read them last-wins, so the step reads only
 * unshadowed nodes. `pnpm-workspace.yaml`: pnpm loads it with js-yaml, which refuses a duplicated
 * key, so a `DATA_DUPLICATE_KEY` at or beneath a key the step reads (`packages`, `catalog`,
 * `catalogs`, `linkWorkspacePackages`) refuses `WORKSPACE_DUPLICATE_KEY`;
 * js-yaml merges `<<`, which the rows hold literally, so a `<<` at the top level or beneath a read
 * key refuses `WORKSPACE_MERGE_KEY`. The `data__*` relations over the same file answer as ever.
 *
 * ## A file with no rows (decided for this step under the owner's one-finding ruling)
 *
 * Every such file is already one `DATA_FILE_NO_ROWS` finding that fails the run. A **member**
 * `package.json` with no rows stays visible: its `workspace_packages` row has `name`, `version` and
 * `private` null, a `WORKSPACE_MEMBER_NO_ROWS` condition names its pair code, and it has no
 * dependency rows (they are unknown, not absent). A member **routed away** from `json` (an
 * `exclude`) is the same row with a `WORKSPACE_MEMBER_EXCLUDED` condition instead. While any
 * member's name is unknown, a dependency the manager would link by name that matches no member with
 * rows gets `targetPath` null AND a `WORKSPACE_TARGET_UNKNOWN` condition: it may be that member, so
 * null there is not "links nothing". A **root input** that decides membership with no rows
 * (`package.json`, `pnpm-workspace.yaml`) refuses that root `WORKSPACE_ROOT_NO_ROWS`: its
 * membership is unknown, and rows would be a guess. The `.npmrc` decides only plain ranges: see
 * `WORKSPACE_SETTING_UNKNOWN` above.
 *
 * ## The other refusals
 *
 * - `DATA_REQUEST_UNROUTED`: a root input that decides membership is held but not routed as the
 *   variant it reads (a `pnpm-workspace.yaml` routed away), from the handle. Excluding it is a
 *   legitimate end state, and the remedy says so rather than sending the user back to route it.
 *
 * ## A root that declares no workspace (conditions, never refusals)
 *
 * - `WORKSPACE_NOT_DECLARED`: pnpm is the manager, the root holds no `pnpm-workspace.yaml`, and a
 *   routed `package.json` under it declares a `workspace:` dependency; at that `package.json`.
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
 * refuse, with the first refused root's refusal: an empty answer there would read as "no workspace".
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
const NPMRC = '.npmrc';
const WORKSPACE_PREFIX = 'workspace:';

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
 * The pnpm rules that moved between releases, one row per release that moved one; a version takes
 * the last row whose `since` it reaches, and an unknown or missing version takes the last row.
 * These are pnpm's facts, read from its source at each tag, never a version of VAT's.
 */
interface PnpmRules {
  /** The first pnpm release the row holds for. */
  readonly since: string;
  /**
   * `pnpm-workspace.yaml` without `packages`. `every-or-refused`: every package when the file has
   * no other key, and pnpm refuses the file otherwise (workspace/read-manifest "packages field
   * missing or empty"); `root-only`: the root only (config `workspaceManifest?.packages ?? ['.']`,
   * pnpm 10.5.0).
   */
  readonly packagesAbsent: 'every-or-refused' | 'root-only';
  /** `link-workspace-packages`'s default: true through pnpm 8, false from 9.0.0. */
  readonly linkDefault: boolean;
  /** Whether `.npmrc` sets `link-workspace-packages`: pnpm 11 reads only auth settings there. */
  readonly linkFromNpmrc: boolean;
  /**
   * Whether `pnpm-workspace.yaml` sets anything beyond `packages` and the catalogs: from 10.5.0
   * (config `Object.assign(pnpmConfig, getOptionsFromPnpmSettings(...))`), camelCase keys only.
   */
  readonly yamlSettings: boolean;
  /** Whether pnpm knows the `catalog:` protocol: from 9.5.0. */
  readonly catalogs: boolean;
}

/** Before 10.5.0, `packages` absent: every package, or a refused file. */
const EVERY_OR_REFUSED = 'every-or-refused';

const PNPM_RULES: readonly PnpmRules[] = [
  { since: '0.0.0', packagesAbsent: EVERY_OR_REFUSED, linkDefault: true, linkFromNpmrc: true, yamlSettings: false, catalogs: false },
  { since: '9.0.0', packagesAbsent: EVERY_OR_REFUSED, linkDefault: false, linkFromNpmrc: true, yamlSettings: false, catalogs: false },
  { since: '9.5.0', packagesAbsent: EVERY_OR_REFUSED, linkDefault: false, linkFromNpmrc: true, yamlSettings: false, catalogs: true },
  { since: '10.5.0', packagesAbsent: 'root-only', linkDefault: false, linkFromNpmrc: true, yamlSettings: true, catalogs: true },
  { since: '11.0.0', packagesAbsent: 'root-only', linkDefault: false, linkFromNpmrc: false, yamlSettings: true, catalogs: true },
];

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
const CATALOG_KEY = '/catalog';
const CATALOGS_KEY = '/catalogs';
const LINK_KEY = '/link-workspace-packages';
const LINK_KEY_CAMEL = '/linkWorkspacePackages';

/**
 * The `pnpm-workspace.yaml` keys the step reads: a duplicate at or beneath one refuses. The kebab
 * `link-workspace-packages` is not one: pnpm never reads a kebab-case key from this file.
 */
const PNPM_READ_KEYS = [PACKAGES_KEY, CATALOG_KEY, CATALOGS_KEY, LINK_KEY_CAMEL];

/** What the step refuses with. */
export type WorkspaceRefusalCode =
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
   * Whether a rerun may answer: the run, not the bytes, decided (a root input `refused` this run:
   * it changed under the run, or hit a per-run parse limit). False for everything the tree decides.
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

/** Whether something holds, or that VAT cannot tell: the reason, for a condition's message. */
type Known = boolean | { readonly unknown: string };

/** How one root links. */
interface Linking {
  readonly manager: 'pnpm' | 'workspaces';
  /** Whether a plain range links a same-named member. */
  readonly plainRanges: Known;
  /** Whether the manager installs a `workspace:` range at all (npm and yarn 1 do not). */
  readonly workspaceProtocol: Known;
  /** Whether the manager knows `catalog:` (pnpm before 9.5 does not). */
  readonly catalogProtocol: Known;
  /**
   * The catalogs by name (`default` for `catalog`), each entry's range by package name; null for a
   * name the manager refuses (a catalog conflict), which links nothing.
   */
  readonly catalogs: ReadonlyMap<string, ReadonlyMap<string, string | null>>;
  /** Where the catalogs were read, or null when the manager in effect has none VAT reads. */
  readonly catalogsIn: string | null;
  /** The manager in effect, for a condition's message. */
  readonly managerName: string;
}

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
  const [first] = refusals;
  if (first !== undefined && packages.length === 0) return { outcome: 'refused', refusal: first };
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
  if (held(NPMRC)) declared.push({ root, path: NPMRC, variant: 'ini' });
  const reads = input.declaredReads(declared);

  const rows: RootRows = { packages: [], dependencies: [], conditions: [] };
  const conditionOf = conditionMaker(root, rows.conditions);
  const rootDoc = held(PACKAGE_JSON) ? docOf(rootFile(await readOne(reads, root, PACKAGE_JSON, 'json', ['dataNodes'])).dataNodes) : undefined;
  const declaration = await workspaceDeclaration({ root, rootDoc, reads, held, conditionOf });
  if (declaration.kind === 'none') {
    await reportUndeclared({ candidates, reads, files, pnpm: declaration.pnpm, conditionOf, root });
    if (candidates.length > 0 && input.belowRepositoryTop.has(root)) {
      conditionOf('.', 'WORKSPACE_ROOT_MAY_BE_ABOVE', 'The analysis root declares no workspace and sits below its repository\'s top level, so a workspace above it may hold these package.json files; the workspace relations have no rows for this root. Run VAT with the workspace root as its analysis root if there is one.');
    }
    return rows;
  }

  const matches = memberMatcher(declaration.patterns, declaration.linking.manager === 'pnpm');
  const rootMember: Member[] = rootDoc === undefined ? [] : [{ path: PACKAGE_JSON, dir: '.', workspaceRoot: true, doc: rootDoc }];
  const members = [
    ...rootMember,
    ...await readMembers(root, candidates.filter((path) => path !== PACKAGE_JSON && matches(path)), reads, conditionOf),
  ];
  appendAll(rows.packages, members.map((member) => packageRow(root, member)));
  const links = linker(rows.packages, new Set(members.filter((member) => member.doc === undefined).map((member) => member.path)), declaration.linking, conditionOf);
  for (const member of members) appendAll(rows.dependencies, dependencyRows(root, member, links, conditionOf));
  return rows;
}

/**
 * One member's dependency rows, each resolved; none for a file with no rows (they are unknown).
 *
 * @param root - The root id
 * @param member - The member
 * @param links - The root's resolver
 * @param conditionOf - Where a resolution's condition goes
 * @returns The rows, field by field in source order
 */
function dependencyRows(root: string, member: Member, links: ReturnType<typeof linker>, conditionOf: ConditionWriter): WorkspaceDependencyRow[] {
  const { doc } = member;
  if (doc === undefined) return [];
  return DEPENDENCY_FIELDS.flatMap((field) => entriesAt(doc, `/${field}`).map(([name, range]): WorkspaceDependencyRow => {
    const link = links(member, name, range);
    if (link.condition !== undefined) conditionOf(member.path, link.condition.code, link.condition.message);
    return { root, path: member.path, field, name, range: link.range, targetPath: link.targetPath, protocol: link.protocol };
  }));
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

/** A root's workspace declaration: its patterns and how it links, or none. */
type Declaration =
  | { readonly kind: 'workspace'; readonly patterns: readonly string[]; readonly linking: Linking }
  /** No workspace; `pnpm` says how pnpm was decided when it is the manager and no `pnpm-workspace.yaml` is held. */
  | { readonly kind: 'none'; readonly pnpm: string | undefined };

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

/**
 * Say how the manager was decided when the root's `packageManager` did not name it: a
 * `WORKSPACE_MANAGER_INFERRED` condition naming the evidence, or `WORKSPACE_MANAGER_UNKNOWN`.
 *
 * @param manager - The manager
 * @param conditionOf - Where the condition goes
 */
function reportInference(manager: Manager, conditionOf: ConditionWriter): void {
  const evidence = manager.inferredFrom;
  if (evidence === undefined) return;
  if (manager.name !== '') {
    conditionOf('.', 'WORKSPACE_MANAGER_INFERRED', `The root package.json names no packageManager; VAT reads the manager as ${manager.name} because ${wordList(evidence.map(quoted))} exist(s) at the root (path only, never read).`);
    return;
  }
  const found = evidence.length === 0 ? 'no lockfile exists at the root' : `the root holds lockfiles of several managers (${wordList(evidence.map(quoted))})`;
  conditionOf('.', 'WORKSPACE_MANAGER_UNKNOWN', `The root package.json names no packageManager and ${found}, so the manager is unknown: membership is read from the workspaces field (npm, yarn and bun all read it), and every workspace: or catalog: dependency, whose meaning depends on the manager, links nothing.`);
}

/** @returns The pnpm rules a version takes; the newest for an unknown version */
function pnpmRulesFor(version: string | undefined): PnpmRules {
  const newest = PNPM_RULES.at(-1);
  if (newest === undefined) throw new Error('PNPM_RULES is empty');
  if (version === undefined) return newest;
  return PNPM_RULES.findLast((rules) => semver.gte(version, rules.since)) ?? newest;
}

/**
 * A `WORKSPACE_MANAGER_VERSION_UNCHECKED` condition when the pnpm version is unknown, or past the
 * newest major {@link PNPM_RULES} was checked against; either way the newest row is read.
 *
 * @param version - The pnpm version, or undefined
 * @param conditionOf - Where the condition goes
 */
function reportPnpmVersion(version: string | undefined, conditionOf: ConditionWriter): void {
  const newest = PNPM_RULES.at(-1)?.since ?? '0.0.0';
  if (version !== undefined && semver.major(version) <= semver.major(newest)) return;
  const why = version === undefined ? 'The pnpm version is unknown' : `pnpm ${version} is past pnpm ${String(semver.major(newest))}, the newest major whose rules VAT checked`;
  conditionOf('.', 'WORKSPACE_MANAGER_VERSION_UNCHECKED', `${why}; VAT reads it with the rules of pnpm ${newest} and later (no packages key: the root only; link-workspace-packages from pnpm-workspace.yaml in camelCase, never .npmrc).`);
}

/**
 * What the root declares, reading `pnpm-workspace.yaml` and `.npmrc` only when pnpm needs them.
 *
 * @param input - The root, its package.json, the handle, the held files and the condition writer
 * @returns The declaration
 * @throws Refused when a needed file is unrouted, has no rows, or breaks pnpm's YAML rules
 */
function workspaceDeclaration(input: DeclarationInput): Promise<Declaration> {
  const { rootDoc, held, conditionOf } = input;
  const manager = managerOf(rootDoc, held);
  if (manager.name !== 'pnpm') {
    const patterns = rootDoc === undefined ? undefined : workspacesPatterns(rootDoc, conditionOf);
    if (rootDoc === undefined || patterns === undefined) return Promise.resolve({ kind: 'none', pnpm: undefined });
    reportInference(manager, conditionOf);
    return Promise.resolve({ kind: 'workspace', patterns, linking: workspacesLinking(manager, rootDoc, held, conditionOf) });
  }
  const named = manager.inferredFrom === undefined ? 'the root\'s packageManager names pnpm' : 'pnpm-lock.yaml exists at the root, so VAT reads the manager as pnpm';
  if (!held(PNPM_WORKSPACE)) return Promise.resolve({ kind: 'none', pnpm: named });
  reportInference(manager, conditionOf);
  reportPnpmVersion(manager.version, conditionOf);
  return pnpmDeclaration(input, manager.version);
}

/**
 * A pnpm root's declaration: its `pnpm-workspace.yaml`, and `.npmrc` when the version reads it there.
 *
 * @param input - The root, the handle, the held files and the condition writer
 * @param version - The pnpm version, or undefined
 * @returns The declaration
 * @throws Refused when `pnpm-workspace.yaml` is unrouted, has no rows, or breaks pnpm's YAML rules
 */
async function pnpmDeclaration(input: DeclarationInput, version: string | undefined): Promise<Declaration> {
  const { root, reads, conditionOf } = input;
  const rules = pnpmRulesFor(version);
  const yamlAnswer = rootFile(await readOne(reads, root, PNPM_WORKSPACE, 'yaml', ['dataNodes', 'dataConditions']));
  refuseYamlRules(root, yamlAnswer.dataNodes, yamlAnswer.dataConditions);
  const yaml = docOf(yamlAnswer.dataNodes);
  const managerName = version === undefined ? 'pnpm (version unknown, read as the newest)' : `pnpm ${version}`;
  const catalogs = rules.catalogs
    ? catalogsOf(yaml, '', 'all', () => conditionOf(PNPM_WORKSPACE, 'WORKSPACE_CATALOG_CONFLICT', catalogConflict(PNPM_WORKSPACE, 'pnpm refuses the file (INVALID_CATALOGS_CONFIGURATION), so every catalog: dependency on the default catalog links nothing')))
    : new Map<string, Map<string, string | null>>();
  return {
    kind: 'workspace',
    patterns: pnpmPatterns(yaml, rules, managerName, conditionOf),
    linking: {
      manager: 'pnpm',
      plainRanges: await pnpmLinkSetting(input, yaml, rules, managerName),
      workspaceProtocol: true,
      catalogProtocol: rules.catalogs,
      catalogs,
      catalogsIn: PNPM_WORKSPACE,
      managerName,
    },
  };
}

/**
 * pnpm's `link-workspace-packages`: from `pnpm-workspace.yaml` (camelCase, from 10.5.0), then the
 * root `.npmrc` (before 11.0.0), then the version's default. A key pnpm does not read there is a
 * `WORKSPACE_SETTING_IGNORED` condition; an `.npmrc` the run cannot read makes the setting unknown,
 * with a `WORKSPACE_SETTING_UNKNOWN` condition.
 *
 * @param input - The root, the handle, the held files and the condition writer
 * @param yaml - The root's `pnpm-workspace.yaml`
 * @param rules - The version's rules
 * @param managerName - The manager in words, for a condition
 * @returns Whether a plain range links, or why that is unknown
 */
async function pnpmLinkSetting(input: DeclarationInput, yaml: Doc, rules: PnpmRules, managerName: string): Promise<Known> {
  const { root, reads, held, conditionOf } = input;
  if (yaml.at.has(LINK_KEY)) {
    conditionOf(PNPM_WORKSPACE, 'WORKSPACE_SETTING_IGNORED', `${PNPM_WORKSPACE} sets link-workspace-packages in kebab case; pnpm reads only camelCase settings from this file (linkWorkspacePackages), so it is never read.`);
  }
  const camel = settingAt(yaml, LINK_KEY_CAMEL);
  if (camel !== undefined && !rules.yamlSettings) {
    conditionOf(PNPM_WORKSPACE, 'WORKSPACE_SETTING_IGNORED', `${PNPM_WORKSPACE} sets linkWorkspacePackages; ${managerName} reads no setting from this file (pnpm does from 10.5.0), so it is never read.`);
  }
  const yamlLink = rules.yamlSettings ? camel : undefined;
  if (yamlLink !== undefined) return yamlLink;
  if (!rules.linkFromNpmrc || !held(NPMRC)) return rules.linkDefault;
  const answer = await readOne(reads, root, NPMRC, 'ini', ['dataNodes']);
  if (answer.state === 'present') return settingAt(docOf(answer.rows.dataNodes), LINK_KEY) ?? rules.linkDefault;
  const why = answer.cause === 'unrouted' ? `is not read as ini (${answer.detail})` : `has no rows this run (${answer.routeState} ${answer.code})`;
  const unknown = `the root ${NPMRC}, where ${managerName} may set link-workspace-packages, ${why}`;
  conditionOf(NPMRC, 'WORKSPACE_SETTING_UNKNOWN', `${unknown}, so whether a plain range links a member is unknown: such a dependency links nothing here, with a WORKSPACE_TARGET_UNKNOWN condition. Membership is unaffected.`);
  return { unknown };
}

/**
 * `pnpm-workspace.yaml`'s member patterns under one pnpm version's rules.
 *
 * @param yaml - The file
 * @param rules - The version's rules
 * @param managerName - The manager in words, for a condition
 * @param conditionOf - Where a malformed list's condition goes
 * @returns The patterns
 */
function pnpmPatterns(yaml: Doc, rules: PnpmRules, managerName: string, conditionOf: ConditionWriter): readonly string[] {
  const packages = yaml.at.get(PACKAGES_KEY);
  if (packages !== undefined && packages.type !== 'null') {
    return stringPatterns(yaml, PACKAGES_KEY, PNPM_WORKSPACE, conditionOf, `${managerName} refuses the file`) ?? [];
  }
  if (rules.packagesAbsent === 'root-only') return ROOT_ONLY;
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

/** @returns A `WORKSPACE_CATALOG_CONFLICT` message */
function catalogConflict(where: string, consequence: string): string {
  return `${where} sets both catalog and catalogs.default; ${consequence}.`;
}

/** The manager of a `workspaces`-field root, as far as linking is concerned. */
const YARN_1 = 'yarn 1';
const YARN_BERRY = 'yarn berry';
type WorkspacesManager = 'npm' | typeof YARN_1 | typeof YARN_BERRY | 'bun' | { readonly unknown: string };

/**
 * The `workspaces`-field manager: npm, yarn 1 or berry (by version, else `.yarnrc.yml` for berry
 * and `yarn.lock` without it for yarn 1, each a `WORKSPACE_MANAGER_INFERRED` condition), or bun.
 *
 * @param manager - The manager in effect
 * @param held - Whether the run holds a path at the root
 * @param conditionOf - Where an inference's condition goes
 * @returns The manager, or why it is unknown
 */
function workspacesManagerOf(manager: Manager, held: (path: string) => boolean, conditionOf: ConditionWriter): WorkspacesManager {
  if (manager.name === 'npm' || manager.name === 'bun') return manager.name;
  if (manager.name !== 'yarn') {
    return { unknown: manager.name === '' ? 'the manager is unknown (a WORKSPACE_MANAGER_UNKNOWN condition at the root says why)' : `the manager is ${manager.name}, whose rules VAT does not read` };
  }
  if (manager.version !== undefined) return semver.major(manager.version) < 2 ? YARN_1 : YARN_BERRY;
  let flavour: WorkspacesManager;
  let evidence: string;
  if (held(YARNRC)) [flavour, evidence] = [YARN_BERRY, YARNRC];
  else if (held(YARN_LOCK)) [flavour, evidence] = [YARN_1, `${YARN_LOCK} without ${YARNRC}`];
  else return { unknown: 'the yarn version is unknown, and neither .yarnrc.yml nor yarn.lock exists at the root to tell yarn 1 from yarn berry' };
  conditionOf('.', 'WORKSPACE_MANAGER_INFERRED', `The root's packageManager names yarn without a version; VAT reads it as ${flavour} because ${evidence} exists at the root (path only, never read).`);
  return flavour;
}

/**
 * How a `workspaces`-field root links: every plain range, `workspace:` where the manager supports
 * it, and catalogs only where bun reads them.
 *
 * @param manager - The manager in effect
 * @param rootDoc - The root package.json, already read
 * @param held - Whether the run holds a path at the root
 * @param conditionOf - Where a condition goes
 * @returns The linking
 */
function workspacesLinking(manager: Manager, rootDoc: Doc, held: (path: string) => boolean, conditionOf: ConditionWriter): Linking {
  const kind = workspacesManagerOf(manager, held, conditionOf);
  if (typeof kind === 'object') {
    return { manager: 'workspaces', plainRanges: true, workspaceProtocol: kind, catalogProtocol: kind, catalogs: new Map(), catalogsIn: null, managerName: manager.name === '' ? 'an unknown manager' : manager.name };
  }
  if (kind !== 'bun') {
    const managerName = manager.version === undefined ? kind : `${manager.name} ${manager.version}`;
    return { manager: 'workspaces', plainRanges: true, workspaceProtocol: kind === YARN_BERRY, catalogProtocol: true, catalogs: new Map(), catalogsIn: null, managerName };
  }
  const inWorkspaces = rootDoc.at.has(`${WORKSPACES_KEY}${CATALOG_KEY}`) || rootDoc.at.has(`${WORKSPACES_KEY}${CATALOGS_KEY}`);
  const base = inWorkspaces ? WORKSPACES_KEY : '';
  return {
    manager: 'workspaces',
    plainRanges: true,
    workspaceProtocol: true,
    catalogProtocol: true,
    catalogs: catalogsOf(rootDoc, base, 'shared', (names) => conditionOf(PACKAGE_JSON, 'WORKSPACE_CATALOG_CONFLICT', catalogConflict(`The root ${PACKAGE_JSON}`, `bun merges them and refuses a name in both (${wordList(names.map(quoted))}), so a catalog: dependency on such a name links nothing`))),
    catalogsIn: `the root ${PACKAGE_JSON} (${inWorkspaces ? 'workspaces.catalog/catalogs' : 'catalog/catalogs'}), as bun reads it`,
    managerName: 'bun',
  };
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
    message: `'${path}' decides the workspace's membership and has no rows this run (${answer.routeState} ${answer.code}), so this root's membership is unknown and its workspace rows are refused.`,
    remedy: answer.routeState === 'refused'
      ? 'run VAT again; the run could not read the file, and its DATA_FILE_NO_ROWS finding, reported beside this refusal, names why'
      : 'fix the file; its DATA_FILE_NO_ROWS finding, reported beside this refusal, names what failed',
    retryable: answer.routeState === 'refused',
  });
}

/** @returns The root's `DATA_REQUEST_UNROUTED` refusal for a declared pair */
function unroutedRefusal(answer: Extract<DeclaredAnswer<never>, { cause: 'unrouted' }>): Refused {
  const { root, path } = answer.pair;
  return new Refused({
    code: answer.code,
    root,
    path,
    message: `The workspace step needs '${path}' and cannot read it: ${answer.detail}. It decides this root's membership, so while it is not read this root has no workspace rows; nothing else the run answers depends on it.`,
    remedy: `${answer.remedy} for this root's workspace rows, or leave it as it is and accept that the workspace relations refuse this root`,
    retryable: false,
  });
}

/**
 * Refuse a pnpm-workspace.yaml that js-yaml would refuse or read differently.
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
  const merge = first.find((node) => node.key === '<<' && (parentPointer(node.pointer) === '' || underReadKey(parentPointer(node.pointer))));
  if (merge !== undefined) {
    throw new Refused({
      code: 'WORKSPACE_MERGE_KEY',
      root,
      path: PNPM_WORKSPACE,
      message: `${PNPM_WORKSPACE} has a << merge key at ${merge.pointer} (line ${merge.line}); pnpm's js-yaml merges it and VAT's rows hold it literally, so a key the workspace step reads may come from the merge, and this root's workspace rows are refused.`,
      remedy: 'write the merged keys out in place of the << merge',
      retryable: false,
    });
  }
}

/** What {@link reportUndeclared} reads. */
interface UndeclaredInput {
  readonly root: string;
  /** The root's held package.json paths, sorted. */
  readonly candidates: readonly string[];
  readonly reads: DeclaredReads;
  /** Every path the run holds under the root. */
  readonly files: ReadonlySet<string>;
  /** How pnpm was decided, when it is the manager and the root holds no pnpm-workspace.yaml. */
  readonly pnpm: string | undefined;
  readonly conditionOf: ConditionWriter;
}

/**
 * One condition per routed package.json that declares a `workspace:` dependency under a root that
 * declares no workspace, unless a nested workspace under the root resolves it: scoped to that
 * manifest, never a refusal, since a fixture's manifest is a common way to be here.
 *
 * @param input - The root, its candidates, the handle, the held files, how pnpm was decided and the condition writer
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
    if (found !== undefined) undeclaredCondition(path, found, input.pnpm, conditionOf);
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
function undeclaredCondition(path: string, [field, name, range]: readonly [string, string, string], pnpm: string | undefined, conditionOf: ConditionWriter): void {
  const declares = `'${path}' declares ${field}.${name}: '${range}', which only a workspace resolves`;
  if (pnpm !== undefined) {
    conditionOf(path, 'WORKSPACE_NOT_DECLARED', `${declares}, and ${pnpm} while the run holds no ${PNPM_WORKSPACE} at the root, so the root declares no workspace. Fix: add ${PNPM_WORKSPACE} at the analysis root; when the workspace root is above it, run VAT from there; ${UNDECLARED_FIXTURE}.`);
    return;
  }
  conditionOf(path, 'WORKSPACE_ROOT_OUTSIDE_ROOT', `${declares}, and the analysis root declares no workspace, so its workspace root lies above the analysis root (or the root's declaration is missing). Fix: run VAT with the workspace root (the directory holding the root package.json or pnpm-workspace.yaml) as its analysis root, or declare the workspace at this root; ${UNDECLARED_FIXTURE}.`);
}

/** How one dependency resolves. */
interface Link {
  readonly range: string;
  readonly targetPath: string | null;
  readonly protocol: WorkspaceProtocol;
  readonly condition?: { readonly code: WorkspaceConditionCode; readonly message: string };
}

/**
 * The members by name, for a manager that refuses two members with one name (npm, yarn, bun): the
 * root, then the first by code-unit path order, keeps the name, and each later one is a
 * `WORKSPACE_DUPLICATE_NAME` condition naming both. pnpm keys members by name and version, so it
 * has none of these conditions.
 *
 * @param packages - The root's package rows, the root first and then by path
 * @param conditionOf - Where a duplicate's condition goes
 * @returns The members by name
 */
function membersByName(packages: readonly WorkspacePackageRow[], conditionOf: ConditionWriter): Map<string, WorkspacePackageRow> {
  const byName = new Map<string, WorkspacePackageRow>();
  for (const row of packages) {
    if (row.name === null) continue;
    const kept = byName.get(row.name);
    if (kept === undefined) {
      byName.set(row.name, row);
      continue;
    }
    conditionOf(row.path, 'WORKSPACE_DUPLICATE_NAME', `'${row.path}' and '${kept.path}' are both named '${row.name}'; npm, yarn and bun refuse to install such a workspace. VAT links the name to '${kept.path}'.`);
  }
  return byName;
}

/** @returns A link to nothing, with a condition */
function unlinked(range: string, protocol: WorkspaceProtocol, code: WorkspaceConditionCode, message: string): Link {
  return { range, targetPath: null, protocol, condition: { code, message } };
}

/** @returns Whether a `workspace:` range's version part (after any alias) takes a version: `*`, `^`, `~` and the empty part take any */
function satisfiesWorkspaceRange(version: string | null, part: string): boolean {
  return part === '' || part === '*' || part === '^' || part === '~' || satisfiesRange(version, part);
}

/**
 * The dependency resolver over one root's members.
 *
 * @param packages - The root's package rows
 * @param unknown - The members whose file has no rows, by path
 * @param linking - How the root links
 * @param conditionOf - Where a duplicate name's condition goes
 * @returns The resolver
 */
function linker(packages: readonly WorkspacePackageRow[], unknown: ReadonlySet<string>, linking: Linking, conditionOf: ConditionWriter): (member: Member, name: string, range: string) => Link {
  const pnpm = linking.manager === 'pnpm';
  const byName = pnpm ? new Map<string, WorkspacePackageRow>() : membersByName(packages, conditionOf);
  const byDir = new Map(packages.map((row) => [row.dir, row.path] as const));
  const unknownMember = packages.filter((row) => unknown.has(row.path));
  const unknownWords = wordList(unknownMember.map((row) => quoted(row.path)));

  /** Under pnpm: exactly one same-named member whose version satisfies links; zero or several link nothing, said. */
  const pnpmLink = (name: string, range: string, protocol: WorkspaceProtocol, satisfies: (version: string | null) => boolean): Link => {
    const named = packages.filter((row) => row.name === name);
    const satisfying = named.filter((row) => satisfies(row.version));
    const [only] = satisfying;
    if (satisfying.length === 1 && only !== undefined) return { range, targetPath: only.path, protocol };
    if (satisfying.length > 1) {
      return unlinked(range, protocol, 'WORKSPACE_TARGET_AMBIGUOUS', `'${name}' (${range}) is satisfied by ${wordList(satisfying.map((row) => quoted(row.path)))}; VAT does not model which one pnpm picks, so it links nothing.`);
    }
    if (unknownMember.length > 0) return unlinked(range, protocol, 'WORKSPACE_TARGET_UNKNOWN', `'${name}' (${range}) is satisfied by no member with rows, and ${unknownWords} has no rows, so it may link that member.`);
    if (named.length === 0 && protocol !== 'workspace') return { range, targetPath: null, protocol };
    const versions = wordList(named.map((row) => quoted(row.path) + ' at ' + (row.version ?? 'no version')));
    const found = named.length === 0 ? 'no member is named so' : `no member so named (${versions}) satisfies it`;
    const outcome = protocol === 'workspace' ? 'pnpm fails the install' : 'pnpm resolves it from the registry';
    return unlinked(range, protocol, 'WORKSPACE_TARGET_UNSATISFIED', `'${name}' (${range}): ${found}, so ${outcome} and it links nothing.`);
  };
  const byNameLink = (name: string, range: string, protocol: WorkspaceProtocol, satisfies: (version: string | null) => boolean): Link => {
    if (pnpm) return pnpmLink(name, range, protocol, satisfies);
    const target = byName.get(name);
    if (target !== undefined && satisfies(target.version)) return { range, targetPath: target.path, protocol };
    if (target === undefined && unknownMember.length > 0) {
      return unlinked(range, protocol, 'WORKSPACE_TARGET_UNKNOWN', `'${name}' (${range}) matches no member with rows, and ${unknownWords} has no rows, so it may link that member.`);
    }
    return { range, targetPath: null, protocol };
  };
  const plain = (name: string, range: string, protocol: WorkspaceProtocol): Link => {
    const setting = linking.plainRanges;
    if (setting === false) return { range, targetPath: null, protocol };
    const link = byNameLink(name, range, protocol, (version) => satisfiesRange(version, range));
    if (setting === true || link.targetPath === null) return link;
    return unlinked(range, protocol, 'WORKSPACE_TARGET_UNKNOWN', `'${name}' (${range}) would link '${link.targetPath}' if pnpm links plain ranges, and ${setting.unknown}, so it links nothing here.`);
  };
  const byDirLink = (member: Member, relative: string, range: string, protocol: WorkspaceProtocol): Link => {
    const dir = joinedDir(member.dir, relative);
    return { range, targetPath: dir === undefined ? null : byDir.get(dir) ?? null, protocol };
  };
  const workspaceLink = (member: Member, name: string, range: string): Link => {
    const support = linking.workspaceProtocol;
    if (typeof support === 'object') return unlinked(range, 'workspace', 'WORKSPACE_MANAGER_UNKNOWN', `'${name}' (${range}) uses the workspace: protocol, which some managers support and some fail on, and ${support.unknown}, so it links nothing.`);
    if (!support) return unlinked(range, 'workspace', 'WORKSPACE_PROTOCOL_UNSUPPORTED', `'${name}' (${range}) uses the workspace: protocol, which ${linking.managerName} does not support, so the install fails and it links nothing.`);
    const rest = range.slice(WORKSPACE_PREFIX.length);
    if (rest.startsWith('./') || rest.startsWith('../')) return byDirLink(member, rest, range, 'workspace');
    const at = rest.lastIndexOf('@');
    const part = at > 0 ? rest.slice(at + 1) : rest;
    return byNameLink(at > 0 ? rest.slice(0, at) : name, range, 'workspace', pnpm ? (version) => satisfiesWorkspaceRange(version, part.trim()) : () => true);
  };
  const catalogLink = (name: string, range: string): Link => {
    const support = linking.catalogProtocol;
    if (typeof support === 'object') return unlinked(range, 'catalog', 'WORKSPACE_MANAGER_UNKNOWN', `'${name}' (${range}) uses the catalog: protocol, whose catalogs live where the manager reads them, and ${support.unknown}, so it links nothing.`);
    if (!support) return unlinked(range, 'catalog', 'WORKSPACE_PROTOCOL_UNSUPPORTED', `'${name}' (${range}) uses the catalog: protocol, which ${linking.managerName} does not support (pnpm does from 9.5.0), so the install fails and it links nothing.`);
    const catalog = range.slice('catalog:'.length) || 'default';
    const resolved = linking.catalogs.get(catalog)?.get(name);
    if (resolved === null) return unlinked(range, 'catalog', 'WORKSPACE_CATALOG_CONFLICT', `'${name}' (${range}) names an entry the manager refuses (catalog and catalogs.default conflict, said at ${linking.catalogsIn ?? 'the root'}), so it links nothing.`);
    if (resolved !== undefined) return plain(name, resolved, 'catalog');
    const message = linking.catalogsIn === null
      ? `'${name}' (${range}) is not resolved: this workspace's manager is ${linking.managerName}, for which VAT reads no catalog, so the range stays as written.`
      : `'${name}' (${range}) names no entry of the ${catalog} catalog in ${linking.catalogsIn} (${linking.managerName}).`;
    return unlinked(range, 'catalog', 'WORKSPACE_CATALOG_UNRESOLVED', message);
  };

  return (member, name, range) => {
    if (range.startsWith(WORKSPACE_PREFIX)) return workspaceLink(member, name, range);
    if (range.startsWith('link:')) return byDirLink(member, range.slice('link:'.length), range, 'link');
    if (range.startsWith('file:')) return byDirLink(member, range.slice('file:'.length), range, 'file');
    if (range.startsWith('catalog:')) return catalogLink(name, range);
    if (range.startsWith('npm:')) return { range, targetPath: null, protocol: 'npm' };
    return plain(name, range, 'npm');
  };
}

/** @returns Whether a member's version satisfies a plain range; `*` and the empty range take any version */
function satisfiesRange(version: string | null, range: string): boolean {
  const trimmed = range.trim();
  if (trimmed === '*' || trimmed === '') return true;
  if (version === null || semver.valid(version) === null || semver.validRange(trimmed) === null) return false;
  return semver.satisfies(version, trimmed);
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

/** @returns The string members of the object at a pointer, in source order; a non-string member is skipped */
function entriesAt(doc: Doc, pointer: string): Array<[string, string]> {
  const node = doc.at.get(pointer);
  if (node?.type !== 'object') return [];
  return (doc.children.get(node.ordinal) ?? []).flatMap((child): Array<[string, string]> =>
    child.key !== null && child.type === 'string' && typeof child.value === 'string' ? [[child.key, child.value]] : []);
}

/** @returns A `link-workspace-packages` setting: on for `true` and `deep`, off for anything else, undefined when absent */
function settingAt(doc: Doc, pointer: string): boolean | undefined {
  const node = doc.at.get(pointer);
  if (node === undefined) return undefined;
  return node.value === true || node.value === 'true' || node.value === 'deep';
}

/**
 * The catalogs under `base`: `catalog` (and `catalogs.default`) as `default`, and every named one.
 * With both `catalog` and `catalogs.default` set, a name the manager refuses maps to null (links
 * nothing): every default entry under pnpm, which refuses the file (`all`), and only a name in both
 * under bun, which merges them (`shared`).
 *
 * @param doc - pnpm-workspace.yaml, or the root package.json for bun
 * @param base - The pointer the `catalog`/`catalogs` keys sit under ('' for the top level)
 * @param refuses - What the manager refuses when both are set
 * @param onConflict - Called once when both are set and something is refused, with the names refused
 * @returns The catalogs by name
 */
function catalogsOf(doc: Doc, base: string, refuses: 'all' | 'shared', onConflict: (names: readonly string[]) => void): Map<string, Map<string, string | null>> {
  const catalogs = new Map<string, Map<string, string | null>>();
  const named = doc.at.get(`${base}${CATALOGS_KEY}`);
  if (named?.type === 'object') {
    for (const child of doc.children.get(named.ordinal) ?? []) {
      if (child.key !== null) catalogs.set(child.key, new Map(entriesAt(doc, child.pointer)));
    }
  }
  const single = `${base}${CATALOG_KEY}`;
  if (doc.at.get(single)?.type !== 'object') return catalogs;
  const entries = entriesAt(doc, single);
  const defaults = catalogs.get('default');
  if (defaults === undefined) {
    catalogs.set('default', new Map(entries));
    return catalogs;
  }
  const merged = new Map<string, string | null>([...defaults, ...entries]);
  const refused = refuses === 'all' ? [...merged.keys()] : entries.map(([name]) => name).filter((name) => defaults.has(name));
  for (const name of refused) merged.set(name, null);
  catalogs.set('default', merged);
  if (refused.length > 0 || refuses === 'all') onConflict(refused);
  return catalogs;
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

/** @returns `a`, `a and b`, `a, b and c` */
function wordList(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1) ?? ''}`;
}
