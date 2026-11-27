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
 *   `pnpm-workspace.yaml` is no workspace.
 * - **Patterns.** `workspaces` is an array, or yarn's `{ packages: [...] }`. pnpm's `packages`
 *   absent is pnpm's documented default, every package (`['.', '**']`); pnpm also always ignores
 *   `**\/node_modules/**`, `**\/bower_components/**`, `**\/test/**` and `**\/tests/**`. A pattern
 *   starting `!` excludes, whatever its position. Each pattern is canonicalised before matching
 *   (`./packages/*` is `packages/*`, `tools/../libs/*` is `libs/*`, a trailing `/` dropped); one that
 *   climbs above the root matches nothing here (nested and enclosing roots are out of scope).
 *   A pattern names directories; a member is a held `package.json` whose directory it matches,
 *   decided from paths alone, so a member that is not routed as `json` (an `exclude`) refuses.
 * - **The root.** The root `package.json` is the workspace root (`workspaceRoot` true) whether or
 *   not a pattern also matches it. A root that declares no workspace has no rows.
 *
 * ## Linking
 *
 * - `workspace:<path>` (a range starting `./` or `../`, pnpm): by directory, relative to the
 *   declaring member. Every other `workspace:` range (`*`, `^`, `~`, a range) by the dependency's
 *   name, and `workspace:<alias>@<range>` by the alias.
 * - `link:` and `file:`: by directory, when it is a member's.
 * - `catalog:` and `catalog:<name>` (`catalog:default` is `catalog:`): `range` is the entry of
 *   `catalog` (or `catalogs.default`) or `catalogs.<name>`, then linked as a plain range; no entry
 *   is a `WORKSPACE_CATALOG_UNRESOLVED` condition naming the manager, and `range` stays as written.
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
 *   `linkWorkspacePackages`, then `link-workspace-packages`) and, when it sets neither, from the root
 *   `.npmrc`; pnpm 9's default is off. Any other value is off: a `${VAR}` in `.npmrc` is stored
 *   literally (the environment is not a file fact), so it is not `true` here even where pnpm's
 *   environment would make it so. `npm:` aliases never link.
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
 * dependency rows (they are unknown, not absent). While any member's name is unknown, a dependency
 * the manager would link by name that matches no member with rows gets `targetPath` null AND a
 * `WORKSPACE_TARGET_UNKNOWN` condition: it may be that member, so null there is not "links nothing".
 * A **root input** with no rows (`package.json`, `pnpm-workspace.yaml`, `.npmrc` when read) refuses
 * the family `WORKSPACE_ROOT_NO_ROWS`: membership itself is unknown, and rows would be a guess.
 *
 * ## The other refusals
 *
 * - `DATA_REQUEST_UNROUTED`: a file the step needs is held but not routed as the variant it reads
 *   (an `exclude`d member, a `pnpm-workspace.yaml` routed away), from the handle.
 * - `WORKSPACE_ROOT_OUTSIDE_ROOT`: a workspace root above the analysis root. With no disk input the
 *   step cannot see one; what it can see is its trace: an analysis root that declares no workspace
 *   (or has no `package.json`) while a routed `package.json` under it declares a `workspace:`
 *   dependency, which only a workspace resolves. ⚠️ The limit: a member above whose manifests use
 *   only plain ranges leaves no trace, and the step answers no rows for that root.
 *
 * A refusal refuses the whole family for the run, every root's rows with it.
 */

import { appendAll, toForwardSlashAnyPlatform, VatError } from '@vibe-agent-toolkit/utils';
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

/** pnpm's implicit ignores, always applied to its patterns. */
const PNPM_IGNORES = ['**/node_modules/**', '**/bower_components/**', '**/test/**', '**/tests/**'];

/** A path under `node_modules`: never a member, never routed. */
const NODE_MODULES = picomatch('**/node_modules/**');

/** pnpm's patterns when `packages` is absent. */
const PNPM_DEFAULT_PATTERNS = ['.', '**'];

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
  | 'WORKSPACE_ROOT_OUTSIDE_ROOT';

/** Why the family has no rows this run. */
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
  /** The handle over the step's declared set. */
  readonly declaredReads: (declared: readonly DeclaredPair[]) => DeclaredReads;
}

/** Thrown inside the step to refuse the family; caught once at its entry, never past it. */
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
  /** Its rows, or undefined when the file has none. */
  readonly doc: Doc | undefined;
}

/** How one root links. */
interface Linking {
  readonly manager: 'pnpm' | 'workspaces';
  /** Whether a plain range links a same-named member. */
  readonly plainRanges: boolean;
  /** The catalogs by name (`default` for `catalog`), each entry's range by package name. */
  readonly catalogs: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /** Where the catalogs were read, or null when the manager in effect has none VAT reads. */
  readonly catalogsIn: string | null;
  /** The manager in effect, for a condition's message. */
  readonly managerName: string;
}

/**
 * Resolve the workspace relations of every root.
 *
 * @param input - The run's roots, routes, held files and declared-reads handle
 * @returns The rows, or the family's refusal
 * @throws A `StoredRowsEvictedError` of the row-set tier, store on, from the handle
 */
export async function resolveWorkspace(input: WorkspaceStepInput): Promise<WorkspaceAnswer> {
  const packages: WorkspacePackageRow[] = [];
  const dependencies: WorkspaceDependencyRow[] = [];
  const conditions: WorkspaceConditionRow[] = [];
  try {
    for (const rows of await Promise.all(input.roots.map((root) => resolveRoot(root, input)))) {
      appendAll(packages, rows.packages);
      appendAll(dependencies, rows.dependencies);
      appendAll(conditions, rows.conditions);
    }
  } catch (error) {
    if (error instanceof Refused) return { outcome: 'refused', refusal: error.refusal };
    throw error;
  }
  return {
    outcome: 'rows',
    packages: packages.toSorted(compareRows(DERIVED_TABLES.workspacePackages)),
    dependencies: dependencies.toSorted(compareRows(DERIVED_TABLES.workspaceDependencies)),
    conditions: conditions.toSorted(compareRows(DERIVED_TABLES.workspaceConditions)),
  };
}

/** One root's rows. */
interface RootRows {
  readonly packages: WorkspacePackageRow[];
  readonly dependencies: WorkspaceDependencyRow[];
  readonly conditions: WorkspaceConditionRow[];
}

/**
 * One root's workspace.
 *
 * @param root - The root id
 * @param input - The step's input
 * @returns Its rows
 * @throws Refused when the family refuses
 */
async function resolveRoot(root: string, input: WorkspaceStepInput): Promise<RootRows> {
  const files = input.files.get(root) ?? new Set<string>();
  const candidates = [...files]
    .filter((path) => baseName(path) === PACKAGE_JSON && !NODE_MODULES(path))
    .toSorted((left, right) => left.localeCompare(right));
  const held = (path: string): boolean => files.has(path);
  const declared: DeclaredPair[] = candidates.map((path) => ({ root, path, variant: 'json' }));
  if (held(PNPM_WORKSPACE)) declared.push({ root, path: PNPM_WORKSPACE, variant: 'yaml' });
  if (held(NPMRC)) declared.push({ root, path: NPMRC, variant: 'ini' });
  const reads = input.declaredReads(declared);

  const rootDoc = held(PACKAGE_JSON) ? docOf(rootFile(await readOne(reads, root, PACKAGE_JSON, 'json', ['dataNodes'])).dataNodes) : undefined;
  const declaration = rootDoc === undefined ? undefined : await workspaceDeclaration(root, rootDoc, reads, held);
  if (declaration === undefined) {
    await refuseOutsideRoot(root, candidates, reads);
    return { packages: [], dependencies: [], conditions: [] };
  }

  const matches = memberMatcher(declaration.patterns, declaration.linking.manager === 'pnpm');
  const rows: RootRows = { packages: [], dependencies: [], conditions: [] };
  const conditionOf = conditionMaker(root, rows.conditions);
  const members = [
    { path: PACKAGE_JSON, dir: '.', workspaceRoot: true, doc: rootDoc },
    ...await readMembers(root, candidates.filter((path) => path !== PACKAGE_JSON && matches(path)), reads, conditionOf),
  ];
  appendAll(rows.packages, members.map((member) => packageRow(root, member)));
  const links = linker(rows.packages, new Set(members.filter((member) => member.doc === undefined).map((member) => member.path)), declaration.linking);
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
 * condition when its file has none.
 *
 * @param root - The root id
 * @param paths - The members' package.json paths
 * @param reads - The handle
 * @param conditionOf - Where a condition goes
 * @returns The members, in `paths` order
 * @throws Refused `DATA_REQUEST_UNROUTED` for a member not routed as `json`
 */
async function readMembers(root: string, paths: readonly string[], reads: DeclaredReads, conditionOf: ConditionWriter): Promise<Member[]> {
  if (paths.length === 0) return [];
  const answers = await reads.read(paths.map((path) => ({ root, path, variant: 'json' as const })), { tables: ['dataNodes'] });
  return answers.map((answer): Member => {
    if (answer.state === 'absent' && answer.cause === 'unrouted') throw unroutedRefusal(answer);
    const { path } = answer.pair;
    if (answer.state === 'present') return { path, dir: dirName(path), workspaceRoot: false, doc: docOf(answer.rows.dataNodes) };
    conditionOf(path, 'WORKSPACE_MEMBER_NO_ROWS', `'${path}' is a member and has no rows this run (${answer.routeState} ${answer.code}): its name, version and dependencies are unknown.`);
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

/** A root's workspace declaration: its patterns and how it links. */
interface Declaration {
  readonly patterns: readonly string[];
  readonly linking: Linking;
}

/**
 * What the root declares, reading `pnpm-workspace.yaml` and `.npmrc` only when pnpm needs them.
 *
 * @param root - The root id
 * @param rootDoc - The root package.json
 * @param reads - The handle
 * @param held - Whether the run holds a root file
 * @returns The declaration, or undefined when the root declares no workspace
 * @throws Refused when a needed file is unrouted, has no rows, or breaks pnpm's YAML rules
 */
async function workspaceDeclaration(root: string, rootDoc: Doc, reads: DeclaredReads, held: (path: string) => boolean): Promise<Declaration | undefined> {
  const manager = (stringAt(rootDoc, '/packageManager') ?? '').split('@')[0] ?? '';
  const pnpm = manager === 'pnpm' || (manager === '' && held(PNPM_WORKSPACE));
  if (!pnpm) {
    const patterns = stringsAt(rootDoc, WORKSPACES_KEY) ?? stringsAt(rootDoc, `${WORKSPACES_KEY}${PACKAGES_KEY}`);
    return patterns === undefined ? undefined : { patterns, linking: workspacesLinking(manager, rootDoc) };
  }
  if (!held(PNPM_WORKSPACE)) return undefined;
  const yamlAnswer = rootFile(await readOne(reads, root, PNPM_WORKSPACE, 'yaml', ['dataNodes', 'dataConditions']));
  const yamlNodes = yamlAnswer.dataNodes;
  refuseYamlRules(root, yamlNodes, yamlAnswer.dataConditions);
  const yaml = docOf(yamlNodes);
  const yamlLink = settingAt(yaml, LINK_KEY_CAMEL) ?? settingAt(yaml, LINK_KEY);
  const npmrcLink = yamlLink === undefined && held(NPMRC)
    ? settingAt(docOf(rootFile(await readOne(reads, root, NPMRC, 'ini', ['dataNodes'])).dataNodes), LINK_KEY)
    : undefined;
  return {
    patterns: yaml.at.has(PACKAGES_KEY) ? stringsAt(yaml, PACKAGES_KEY) ?? [] : PNPM_DEFAULT_PATTERNS,
    linking: { manager: 'pnpm', plainRanges: yamlLink ?? npmrcLink ?? false, catalogs: catalogsOf(yaml, ''), catalogsIn: PNPM_WORKSPACE, managerName: 'pnpm' },
  };
}

/**
 * How a `workspaces`-field root links: every plain range, and catalogs only where bun reads them.
 *
 * @param manager - The `packageManager` name, or '' when there is none
 * @param rootDoc - The root package.json, already read
 * @returns The linking
 */
function workspacesLinking(manager: string, rootDoc: Doc): Linking {
  if (manager !== '' && manager !== 'bun') {
    return { manager: 'workspaces', plainRanges: true, catalogs: new Map(), catalogsIn: null, managerName: manager };
  }
  const inWorkspaces = rootDoc.at.has(`${WORKSPACES_KEY}${CATALOG_KEY}`) || rootDoc.at.has(`${WORKSPACES_KEY}${CATALOGS_KEY}`);
  return {
    manager: 'workspaces',
    plainRanges: true,
    catalogs: catalogsOf(rootDoc, inWorkspaces ? WORKSPACES_KEY : ''),
    catalogsIn: `the root ${PACKAGE_JSON} (${inWorkspaces ? 'workspaces.catalog/catalogs' : 'catalog/catalogs'}), as bun reads it`,
    managerName: manager === '' ? 'bun (no packageManager)' : 'bun',
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
 * A root file's rows, or the family's refusal when it has none.
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
    message: `'${path}' decides the workspace's membership and has no rows this run (${answer.routeState} ${answer.code}), so membership is unknown and the workspace relations are refused.`,
    remedy: 'fix the file; its DATA_FILE_NO_ROWS finding names what failed',
  });
}

/** @returns The family's `DATA_REQUEST_UNROUTED` refusal for a declared pair */
function unroutedRefusal(answer: Extract<DeclaredAnswer<never>, { cause: 'unrouted' }>): Refused {
  const { root, path } = answer.pair;
  return new Refused({
    code: answer.code,
    root,
    path,
    message: `The workspace step needs '${path}' and cannot read it: ${answer.detail}.`,
    remedy: answer.remedy,
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
      message: `${PNPM_WORKSPACE} repeats the key ${pointer} (lines ${wordList(lines.map(String))}); pnpm loads the file with js-yaml, which refuses a duplicated key, so the workspace relations are refused.`,
      remedy: 'remove the repeated key',
    });
  }
  const merge = first.find((node) => node.key === '<<' && (parentPointer(node.pointer) === '' || underReadKey(parentPointer(node.pointer))));
  if (merge !== undefined) {
    throw new Refused({
      code: 'WORKSPACE_MERGE_KEY',
      root,
      path: PNPM_WORKSPACE,
      message: `${PNPM_WORKSPACE} has a << merge key at ${merge.pointer} (line ${merge.line}); pnpm's js-yaml merges it and VAT's rows hold it literally, so a key the workspace step reads may come from the merge, and the workspace relations are refused.`,
      remedy: 'write the merged keys out in place of the << merge',
    });
  }
}

/**
 * Refuse when a routed package.json declares a `workspace:` dependency under a root that declares
 * no workspace: its workspace root lies above the analysis root.
 *
 * @param root - The root id
 * @param candidates - The root's routed package.json paths
 * @param reads - The handle
 * @throws Refused `WORKSPACE_ROOT_OUTSIDE_ROOT`
 */
async function refuseOutsideRoot(root: string, candidates: readonly string[], reads: DeclaredReads): Promise<void> {
  if (candidates.length === 0) return;
  const answers = await reads.read(candidates.map((path) => ({ root, path, variant: 'json' as const })), { tables: ['dataNodes'] });
  for (const answer of answers) {
    // A file with no rows is its own finding. An unrouted one cannot be read, and is passed over:
    // the scan sees only routed files (a limit of the trace, not a refusal of its own).
    if (answer.state !== 'present') continue;
    const doc = docOf(answer.rows.dataNodes);
    for (const field of DEPENDENCY_FIELDS) {
      const found = entriesAt(doc, `/${field}`).find(([, range]) => range.startsWith(WORKSPACE_PREFIX));
      if (found === undefined) continue;
      const { path } = answer.pair;
      throw new Refused({
        code: 'WORKSPACE_ROOT_OUTSIDE_ROOT',
        root,
        path,
        message: `'${path}' declares ${field}.${found[0]}: '${found[1]}', which only a workspace resolves, and the analysis root declares no workspace, so its workspace root lies above the analysis root.`,
        remedy: 'run VAT with the workspace root (the directory holding the root package.json or pnpm-workspace.yaml) as its analysis root',
      });
    }
  }
}

/** How one dependency resolves. */
interface Link {
  readonly range: string;
  readonly targetPath: string | null;
  readonly protocol: WorkspaceProtocol;
  readonly condition?: { readonly code: WorkspaceConditionCode; readonly message: string };
}

/**
 * The dependency resolver over one root's members.
 *
 * @param packages - The root's package rows
 * @param unknown - The members whose file has no rows, by path
 * @param linking - How the root links
 * @returns The resolver
 */
function linker(packages: readonly WorkspacePackageRow[], unknown: ReadonlySet<string>, linking: Linking): (member: Member, name: string, range: string) => Link {
  const byName = new Map<string, WorkspacePackageRow>();
  for (const row of packages) if (row.name !== null && !byName.has(row.name)) byName.set(row.name, row);
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

  return (member, name, range) => {
    if (range.startsWith(WORKSPACE_PREFIX)) {
      const rest = range.slice(WORKSPACE_PREFIX.length);
      if (rest.startsWith('./') || rest.startsWith('../')) return byDirLink(member, rest, range, 'workspace');
      const at = rest.lastIndexOf('@');
      return byNameLink(at > 0 ? rest.slice(0, at) : name, range, 'workspace', () => true);
    }
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
 * @param pnpm - Whether pnpm's implicit ignores apply
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

/** @returns The strings of the array at a pointer, or undefined when it is no array */
function stringsAt(doc: Doc, pointer: string): string[] | undefined {
  const node = doc.at.get(pointer);
  if (node?.type !== 'array') return undefined;
  return (doc.children.get(node.ordinal) ?? []).flatMap((child) => (child.type === 'string' && typeof child.value === 'string' ? [child.value] : []));
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
 *
 * @param doc - pnpm-workspace.yaml, or the root package.json for bun
 * @param base - The pointer the `catalog`/`catalogs` keys sit under ('' for the top level)
 * @returns The catalogs by name
 */
function catalogsOf(doc: Doc, base: string): Map<string, Map<string, string>> {
  const catalogs = new Map<string, Map<string, string>>();
  const named = doc.at.get(`${base}${CATALOGS_KEY}`);
  if (named?.type === 'object') {
    for (const child of doc.children.get(named.ordinal) ?? []) {
      if (child.key !== null) catalogs.set(child.key, new Map(entriesAt(doc, child.pointer)));
    }
  }
  const single = `${base}${CATALOG_KEY}`;
  if (doc.at.get(single)?.type === 'object') catalogs.set('default', new Map(entriesAt(doc, single)));
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
