/**
 * The workspace resolve step: `workspace_packages`, `workspace_dependencies` and
 * `workspace_conditions`, derived per run from the `data` instance's rows and never stored, since
 * membership, names and links each depend on many files.
 *
 * It reads ONLY through the declared-reads handle, never the disk: the `json` pair of every
 * `package.json` the run holds (outside `node_modules`), and at each analysis root its `package.json` (`json`), `pnpm-workspace.yaml`
 * (`yaml`) and `.npmrc` (`ini`) when the run holds them. Nothing else. A root file is read only when
 * the rules below need it, so an excluded `pnpm-workspace.yaml` under an npm workspace refuses nothing.
 *
 * ## Membership
 *
 * - **Which manager.** The root `package.json`'s `packageManager` (`pnpm@9.0.0`): `pnpm` reads
 *   `pnpm-workspace.yaml`; any other manager (`npm`, `yarn`, `bun`) reads `package.json#workspaces`.
 *   With no `packageManager`, a `pnpm-workspace.yaml` at the root means pnpm, and otherwise the
 *   `workspaces` field (npm's rule; yarn and bun read the same field). pnpm with no
 *   `pnpm-workspace.yaml` is no workspace. A `pnpm-workspace.yaml` with no root `package.json` is a
 *   pnpm workspace with no root row (pnpm runs without one).
 * - **The manager's version.** pnpm's rules moved between releases; {@link PNPM_RULES} holds every
 *   version-dependent rule in one table, read with the `packageManager` version. An unknown or
 *   missing version takes the newest row.
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
 *   Both `catalog` and `catalogs.default` present is a `WORKSPACE_CATALOG_CONFLICT` condition (pnpm
 *   refuses the file; bun merges them): VAT merges them, `catalog` winning a name in both.
 *   Where the catalogs live depends on the manager in effect (decided as under Membership):
 *   - **pnpm**: `pnpm-workspace.yaml`.
 *   - **bun** (https://bun.com/docs/install/catalogs): the root `package.json`, either inside the
 *     `workspaces` object (`workspaces.catalog` / `workspaces.catalogs`) or at its top level
 *     (`catalog` / `catalogs`). bun's docs allow both and do not say which wins; VAT's choice: when
 *     the `workspaces` object holds `catalog` or `catalogs`, only that form is read, otherwise the
 *     top-level form. Both are read from the root `package.json`'s rows, already read for
 *     membership (unshadowed nodes, no further read).
 *   - **No `packageManager`** and no `pnpm-workspace.yaml`: the root `package.json`'s catalog
 *     fields are read as bun reads them, since only bun defines catalogs there. With a
 *     `pnpm-workspace.yaml` the pnpm rule holds.
 *   - **npm, yarn** (or any other named manager): no catalog is read, so every `catalog:` range is
 *     unresolved.
 * - **A plain range** links the same-named member when the member's `version` satisfies it (`*`
 *   links whatever the version). npm, yarn and bun workspaces always do this. pnpm does only with
 *   `link-workspace-packages` `true` or `deep`, read from `pnpm-workspace.yaml` first (camelCase
 *   `linkWorkspacePackages`, then `link-workspace-packages`) and, when it sets neither and the pnpm
 *   version still reads it there, from the root `.npmrc`; otherwise the version's default
 *   ({@link PNPM_RULES}). Any other value is off: a `${VAR}` in `.npmrc` is stored literally (the
 *   environment is not a file fact), so it is not `true` here even where pnpm's environment would
 *   make it so. `npm:` aliases never link.
 * - **Two members with one name** (npm and yarn refuse to install): the first by path keeps the
 *   name for linking, and each later one is a `WORKSPACE_DUPLICATE_NAME` condition naming both.
 *
 * ## The tools' rules on duplicate keys (consumer rules, spec 3.5)
 *
 * `package.json` and `.npmrc`: npm, pnpm, yarn and bun read them last-wins, so the step reads only
 * unshadowed nodes. `pnpm-workspace.yaml`: pnpm loads it with js-yaml, which refuses a duplicated
 * key, so a `DATA_DUPLICATE_KEY` at or beneath a key the step reads (`packages`, `catalog`,
 * `catalogs`, `link-workspace-packages`, `linkWorkspacePackages`) refuses `WORKSPACE_DUPLICATE_KEY`;
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
 * null there is not "links nothing". A **root input** with no rows (`package.json`,
 * `pnpm-workspace.yaml`, `.npmrc` when read) refuses that root `WORKSPACE_ROOT_NO_ROWS`: its
 * membership is unknown, and rows would be a guess.
 *
 * ## The other refusals
 *
 * - `DATA_REQUEST_UNROUTED`: a root input the step needs is held but not routed as the variant it
 *   reads (a `pnpm-workspace.yaml` routed away), from the handle.
 * - `WORKSPACE_NOT_DECLARED`: the root names pnpm, holds no `pnpm-workspace.yaml`, and a routed
 *   `package.json` under it declares a `workspace:` dependency.
 * - `WORKSPACE_ROOT_OUTSIDE_ROOT`: a workspace root above the analysis root. With no disk input the
 *   step cannot see one; what it can see is its trace: an analysis root that declares no workspace
 *   (or has no `package.json`) while a routed `package.json` under it declares a `workspace:`
 *   dependency, which only a workspace resolves. A `package.json` under a nested workspace (a
 *   directory holding a `pnpm-workspace.yaml`, or a `package.json` with `workspaces`) is passed over:
 *   that workspace resolves it. A root above whose members use only plain ranges leaves no such
 *   trace; the `WORKSPACE_ROOT_MAY_BE_ABOVE` condition is what marks it.
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
}

const PNPM_RULES: readonly PnpmRules[] = [
  { since: '0.0.0', packagesAbsent: 'every-or-refused', linkDefault: true, linkFromNpmrc: true },
  { since: '9.0.0', packagesAbsent: 'every-or-refused', linkDefault: false, linkFromNpmrc: true },
  { since: '10.5.0', packagesAbsent: 'root-only', linkDefault: false, linkFromNpmrc: true },
  { since: '11.0.0', packagesAbsent: 'root-only', linkDefault: false, linkFromNpmrc: false },
];

const PACKAGES_KEY = '/packages';
const WORKSPACES_KEY = '/workspaces';
const CATALOG_KEY = '/catalog';
const CATALOGS_KEY = '/catalogs';
const LINK_KEY = '/link-workspace-packages';
const LINK_KEY_CAMEL = '/linkWorkspacePackages';

/** The `pnpm-workspace.yaml` keys the step reads: a duplicate at or beneath one refuses. */
const PNPM_READ_KEYS = [PACKAGES_KEY, CATALOG_KEY, CATALOGS_KEY, LINK_KEY, LINK_KEY_CAMEL];

/** What the step refuses with. */
export type WorkspaceRefusalCode =
  | 'DATA_REQUEST_UNROUTED'
  | 'WORKSPACE_ROOT_NO_ROWS'
  | 'WORKSPACE_DUPLICATE_KEY'
  | 'WORKSPACE_MERGE_KEY'
  | 'WORKSPACE_NOT_DECLARED'
  | 'WORKSPACE_ROOT_OUTSIDE_ROOT';

/** Why a root has no rows this run. */
export interface WorkspaceRefusal {
  readonly code: WorkspaceRefusalCode;
  /** The root id of the file. */
  readonly root: string;
  /** The file, relative to its root. */
  readonly path: string;
  readonly message: string;
  readonly remedy: string;
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

/** How one root links. */
interface Linking {
  readonly manager: 'pnpm' | 'workspaces';
  /** Whether a plain range links a same-named member. */
  readonly plainRanges: boolean;
  /** Whether the manager installs a `workspace:` range at all (npm and yarn 1 do not). */
  readonly workspaceProtocol: boolean;
  /** The catalogs by name (`default` for `catalog`), each entry's range by package name. */
  readonly catalogs: ReadonlyMap<string, ReadonlyMap<string, string>>;
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
    await refuseUndeclared({ root, candidates, reads, files, pnpmNamed: declaration.pnpmNamed });
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
  /** No workspace; `pnpmNamed` when the root names pnpm and holds no `pnpm-workspace.yaml`. */
  | { readonly kind: 'none'; readonly pnpmNamed: boolean };

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

/** @returns The root's `packageManager`, split into name and coerced version */
function packageManagerOf(rootDoc: Doc | undefined): PackageManager {
  const field = rootDoc === undefined ? null : stringAt(rootDoc, '/packageManager');
  if (field === null) return { name: '', version: undefined };
  const at = field.indexOf('@', 1);
  const name = at < 0 ? field : field.slice(0, at);
  return { name, version: at < 0 ? undefined : semver.coerce(field.slice(at + 1))?.version };
}

/** @returns The pnpm rules a version takes; the newest for an unknown version */
function pnpmRulesFor(version: string | undefined): PnpmRules {
  const newest = PNPM_RULES.at(-1);
  if (newest === undefined) throw new Error('PNPM_RULES is empty');
  if (version === undefined) return newest;
  return PNPM_RULES.findLast((rules) => semver.gte(version, rules.since)) ?? newest;
}

/**
 * What the root declares, reading `pnpm-workspace.yaml` and `.npmrc` only when pnpm needs them.
 *
 * @param input - The root, its package.json, the handle, the held files and the condition writer
 * @returns The declaration
 * @throws Refused when a needed file is unrouted, has no rows, or breaks pnpm's YAML rules
 */
async function workspaceDeclaration(input: DeclarationInput): Promise<Declaration> {
  const { root, rootDoc, reads, held, conditionOf } = input;
  const manager = packageManagerOf(rootDoc);
  const pnpm = manager.name === 'pnpm' || (manager.name === '' && held(PNPM_WORKSPACE));
  if (!pnpm) {
    if (rootDoc === undefined) return { kind: 'none', pnpmNamed: false };
    const patterns = workspacesPatterns(rootDoc, conditionOf);
    return patterns === undefined ? { kind: 'none', pnpmNamed: false } : { kind: 'workspace', patterns, linking: workspacesLinking(manager, rootDoc, conditionOf) };
  }
  if (!held(PNPM_WORKSPACE)) return { kind: 'none', pnpmNamed: true };
  const rules = pnpmRulesFor(manager.version);
  const yamlAnswer = rootFile(await readOne(reads, root, PNPM_WORKSPACE, 'yaml', ['dataNodes', 'dataConditions']));
  const yamlNodes = yamlAnswer.dataNodes;
  refuseYamlRules(root, yamlNodes, yamlAnswer.dataConditions);
  const yaml = docOf(yamlNodes);
  const yamlLink = settingAt(yaml, LINK_KEY_CAMEL) ?? settingAt(yaml, LINK_KEY);
  const npmrcLink = yamlLink === undefined && rules.linkFromNpmrc && held(NPMRC)
    ? settingAt(docOf(rootFile(await readOne(reads, root, NPMRC, 'ini', ['dataNodes'])).dataNodes), LINK_KEY)
    : undefined;
  const managerName = manager.version === undefined ? 'pnpm (version unknown, read as the newest)' : `pnpm ${manager.version}`;
  return {
    kind: 'workspace',
    patterns: pnpmPatterns(yaml, rules, managerName, conditionOf),
    linking: {
      manager: 'pnpm',
      plainRanges: yamlLink ?? npmrcLink ?? rules.linkDefault,
      workspaceProtocol: true,
      catalogs: catalogsOf(yaml, '', () => conditionOf(PNPM_WORKSPACE, 'WORKSPACE_CATALOG_CONFLICT', catalogConflict(PNPM_WORKSPACE, 'pnpm refuses the file (INVALID_CATALOGS_CONFIGURATION)'))),
      catalogsIn: PNPM_WORKSPACE,
      managerName,
    },
  };
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
  return `${where} sets both catalog and catalogs.default; ${consequence}. VAT merges them, catalog winning a name in both.`;
}

/**
 * How a `workspaces`-field root links: every plain range, and catalogs only where bun reads them.
 *
 * @param manager - The `packageManager`, name '' when there is none
 * @param rootDoc - The root package.json, already read
 * @param conditionOf - Where a catalog conflict's condition goes
 * @returns The linking
 */
function workspacesLinking(manager: PackageManager, rootDoc: Doc, conditionOf: ConditionWriter): Linking {
  const yarnClassic = manager.name === 'yarn' && manager.version !== undefined && semver.major(manager.version) < 2;
  const workspaceProtocol = manager.name !== 'npm' && !yarnClassic;
  if (manager.name !== '' && manager.name !== 'bun') {
    const managerName = manager.version === undefined ? manager.name : `${manager.name} ${manager.version}`;
    return { manager: 'workspaces', plainRanges: true, workspaceProtocol, catalogs: new Map(), catalogsIn: null, managerName };
  }
  const inWorkspaces = rootDoc.at.has(`${WORKSPACES_KEY}${CATALOG_KEY}`) || rootDoc.at.has(`${WORKSPACES_KEY}${CATALOGS_KEY}`);
  const base = inWorkspaces ? WORKSPACES_KEY : '';
  return {
    manager: 'workspaces',
    plainRanges: true,
    workspaceProtocol,
    catalogs: catalogsOf(rootDoc, base, () => conditionOf(PACKAGE_JSON, 'WORKSPACE_CATALOG_CONFLICT', catalogConflict(`The root ${PACKAGE_JSON}`, 'bun merges them and refuses a name in both'))),
    catalogsIn: `the root ${PACKAGE_JSON} (${inWorkspaces ? 'workspaces.catalog/catalogs' : 'catalog/catalogs'}), as bun reads it`,
    managerName: manager.name === '' ? 'bun (no packageManager)' : 'bun',
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
      ? 'run VAT again; the run could not read the file, and its DATA_FILE_NO_ROWS finding names why'
      : 'fix the file; its DATA_FILE_NO_ROWS finding names what failed',
  });
}

/** @returns The root's `DATA_REQUEST_UNROUTED` refusal for a declared pair */
function unroutedRefusal(answer: Extract<DeclaredAnswer<never>, { cause: 'unrouted' }>): Refused {
  const { root, path } = answer.pair;
  return new Refused({
    code: answer.code,
    root,
    path,
    message: `The workspace step needs '${path}' and cannot read it: ${answer.detail}.`,
    remedy: `${answer.remedy}; a workspace root input decides membership, so fix a broken one rather than exclude it`,
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
    });
  }
}

/** What {@link refuseUndeclared} reads. */
interface UndeclaredInput {
  readonly root: string;
  /** The root's held package.json paths, sorted. */
  readonly candidates: readonly string[];
  readonly reads: DeclaredReads;
  /** Every path the run holds under the root. */
  readonly files: ReadonlySet<string>;
  /** Whether the root names pnpm and holds no pnpm-workspace.yaml. */
  readonly pnpmNamed: boolean;
}

/**
 * Refuse when a routed package.json declares a `workspace:` dependency under a root that declares
 * no workspace, unless a nested workspace under the root resolves it.
 *
 * @param input - The root, its candidates, the handle, the held files and why it declares none
 * @throws Refused `WORKSPACE_NOT_DECLARED` (the root names pnpm without a pnpm-workspace.yaml) or
 *   `WORKSPACE_ROOT_OUTSIDE_ROOT`
 */
async function refuseUndeclared(input: UndeclaredInput): Promise<void> {
  const { root, candidates, reads } = input;
  if (candidates.length === 0) return;
  const answers = await reads.read(candidates.map((path) => ({ root, path, variant: 'json' as const })), { tables: ['dataNodes'] });
  const docs = answers.flatMap((answer) => (answer.state === 'present' ? [{ path: answer.pair.path, doc: docOf(answer.rows.dataNodes) }] : []));
  const nested = nestedWorkspaceDirs(docs, input.files);
  // A file with no rows is its own finding. An unrouted one cannot be read, and is passed over:
  // the scan sees only routed files (a limit of the trace, not a refusal of its own).
  for (const { path, doc } of docs) {
    if (path === PACKAGE_JSON || nested.some((dir) => isWithin(dirName(path), dir))) continue;
    const found = workspaceDependency(doc);
    if (found !== undefined) throw undeclaredRefusal(root, path, found, input.pnpmNamed);
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

/** @returns The refusal for a `workspace:` dependency under a root that declares no workspace */
function undeclaredRefusal(root: string, path: string, [field, name, range]: readonly [string, string, string], pnpmNamed: boolean): Refused {
  const declares = `'${path}' declares ${field}.${name}: '${range}', which only a workspace resolves`;
  if (pnpmNamed) {
    return new Refused({
      code: 'WORKSPACE_NOT_DECLARED',
      root,
      path,
      message: `${declares}, and the analysis root's packageManager names pnpm while the run holds no ${PNPM_WORKSPACE} at the root, so the root declares no workspace.`,
      remedy: `add ${PNPM_WORKSPACE} at the analysis root, or, when the workspace root is above it, run VAT from there`,
    });
  }
  return new Refused({
    code: 'WORKSPACE_ROOT_OUTSIDE_ROOT',
    root,
    path,
    message: `${declares}, and the analysis root declares no workspace, so its workspace root lies above the analysis root (or the root's declaration is missing).`,
    remedy: 'run VAT with the workspace root (the directory holding the root package.json or pnpm-workspace.yaml) as its analysis root, or declare the workspace at this root',
  });
}

/** How one dependency resolves. */
interface Link {
  readonly range: string;
  readonly targetPath: string | null;
  readonly protocol: WorkspaceProtocol;
  readonly condition?: { readonly code: WorkspaceConditionCode; readonly message: string };
}

/**
 * The members by name: the first by path wins a name, and each later one is a
 * `WORKSPACE_DUPLICATE_NAME` condition naming both.
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
    conditionOf(row.path, 'WORKSPACE_DUPLICATE_NAME', `'${row.path}' and '${kept.path}' are both named '${row.name}'; npm and yarn refuse to install such a workspace. VAT links the name to '${kept.path}'.`);
  }
  return byName;
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
  const byName = membersByName(packages, conditionOf);
  const byDir = new Map(packages.map((row) => [row.dir, row.path] as const));
  const unknownMember = packages.filter((row) => unknown.has(row.path));
  const nameUnknown = unknownMember.length > 0;

  const byNameLink = (name: string, range: string, protocol: WorkspaceProtocol, satisfies: (version: string | null) => boolean): Link => {
    const target = byName.get(name);
    if (target !== undefined && satisfies(target.version)) return { range, targetPath: target.path, protocol };
    if (target === undefined && nameUnknown) {
      return {
        range,
        targetPath: null,
        protocol,
        condition: { code: 'WORKSPACE_TARGET_UNKNOWN', message: `'${name}' (${range}) matches no member with rows, and ${wordList(unknownMember.map((row) => quoted(row.path)))} has no rows, so it may link that member.` },
      };
    }
    return { range, targetPath: null, protocol };
  };
  const plain = (name: string, range: string, protocol: WorkspaceProtocol): Link =>
    linking.plainRanges ? byNameLink(name, range, protocol, (version) => satisfiesRange(version, range)) : { range, targetPath: null, protocol };
  const byDirLink = (member: Member, relative: string, range: string, protocol: WorkspaceProtocol): Link => {
    const dir = joinedDir(member.dir, relative);
    return { range, targetPath: dir === undefined ? null : byDir.get(dir) ?? null, protocol };
  };
  const workspaceLink = (member: Member, name: string, range: string): Link => {
    if (!linking.workspaceProtocol) {
      return { range, targetPath: null, protocol: 'workspace', condition: { code: 'WORKSPACE_PROTOCOL_UNSUPPORTED', message: `'${name}' (${range}) uses the workspace: protocol, which ${linking.managerName} does not support, so the install fails and it links nothing.` } };
    }
    const rest = range.slice(WORKSPACE_PREFIX.length);
    if (rest.startsWith('./') || rest.startsWith('../')) return byDirLink(member, rest, range, 'workspace');
    const at = rest.lastIndexOf('@');
    return byNameLink(at > 0 ? rest.slice(0, at) : name, range, 'workspace', () => true);
  };

  return (member, name, range) => {
    if (range.startsWith(WORKSPACE_PREFIX)) return workspaceLink(member, name, range);
    if (range.startsWith('link:')) return byDirLink(member, range.slice('link:'.length), range, 'link');
    if (range.startsWith('file:')) return byDirLink(member, range.slice('file:'.length), range, 'file');
    if (range.startsWith('catalog:')) {
      const catalog = range.slice('catalog:'.length) || 'default';
      const resolved = linking.catalogs.get(catalog)?.get(name);
      if (resolved === undefined) {
        const message = linking.catalogsIn === null
          ? `'${name}' (${range}) is not resolved: this workspace's manager is ${linking.managerName}, for which VAT reads no catalog, so the range stays as written.`
          : `'${name}' (${range}) names no entry of the ${catalog} catalog in ${linking.catalogsIn} (${linking.managerName}).`;
        return { range, targetPath: null, protocol: 'catalog', condition: { code: 'WORKSPACE_CATALOG_UNRESOLVED', message } };
      }
      return plain(name, resolved, 'catalog');
    }
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
 * Both `catalog` and `catalogs.default` present are merged, `catalog` winning a name in both.
 *
 * @param doc - pnpm-workspace.yaml, or the root package.json for bun
 * @param base - The pointer the `catalog`/`catalogs` keys sit under ('' for the top level)
 * @param onConflict - Called once when both `catalog` and `catalogs.default` are present
 * @returns The catalogs by name
 */
function catalogsOf(doc: Doc, base: string, onConflict: () => void): Map<string, Map<string, string>> {
  const catalogs = new Map<string, Map<string, string>>();
  const named = doc.at.get(`${base}${CATALOGS_KEY}`);
  if (named?.type === 'object') {
    for (const child of doc.children.get(named.ordinal) ?? []) {
      if (child.key !== null) catalogs.set(child.key, new Map(entriesAt(doc, child.pointer)));
    }
  }
  const single = `${base}${CATALOG_KEY}`;
  if (doc.at.get(single)?.type !== 'object') return catalogs;
  const defaults = catalogs.get('default');
  if (defaults !== undefined) onConflict();
  catalogs.set('default', new Map([...(defaults ?? []), ...entriesAt(doc, single)]));
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
