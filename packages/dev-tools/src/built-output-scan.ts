/**
 * Which test files build a path into a workspace package's `dist/`, read from
 * their syntax tree — the half of `built-output-edges.ts` that needs no turbo.
 *
 * Scanned: every source file under a package's `test/`, every `src/**\/*.test.*`,
 * the test helpers under `src/` (`testing/`, `*test-helpers*`), and the vitest
 * setup and global-setup files at the repo root or a package root. NOT scanned
 * (out of scope, so a read there is not checked): product `src/` code a test
 * calls, and the TypeScript files a package script runs. In the scanned files, a
 * path is any expression handed to a path sink: a `join`/`resolve` call bound to
 * `node:path` or `safePath`, `new URL`, a module load (`import`, `import()`,
 * `require`, `createRequire(…)(…)`, `vi.mock`/`doMock`/`importActual`/`importMock`),
 * a specifier resolution (`require.resolve`, `import.meta.resolve`), a process
 * launch (`spawn*`/`exec*`/`fork`, also through `promisify`) or an fs read.
 *
 * Each alternative a sink receives that has a `dist` segment — compared
 * case-insensitively — is exactly one of (evaluation: `built-output-paths.ts`):
 *
 * - RESOLVED: every piece of it is known, and it lands in `packages/<dir>/dist/…`
 *   or in a workspace package linked as `node_modules/<name>/dist/…`, every
 *   segment matching exactly. It starts at the file's own directory
 *   (`__dirname`, `import.meta.dirname`, `new URL(…, import.meta.url)`, a relative
 *   specifier), at a workspace package specifier (`@scope/pkg/dist/…`), or at a
 *   value that traces to one; static relative text with no anchor resolves from
 *   the test's package directory. A {@link FileReach}.
 * - TEMP: it starts at `tmpdir()`, `mkdtemp*` or a temp-dir helper of the utils
 *   package — `underTemp(path, root)` among them — and no `..` climbs out of
 *   that temp dir. Not a reach. Nor is a path that starts with an absolute
 *   literal (`/project/dist`): a fixed location outside any checkout.
 * - UNRESOLVED: every other one — a piece not known statically anywhere in it
 *   (an untraceable parameter, a call site that cannot be enumerated, a value a
 *   cycle guard cut short, a dependency's specifier), a fully known path that
 *   lands on no package's `dist/` or names one only when case is ignored, a temp
 *   path a `..` climbs out of, and a relative path whose working directory is
 *   not the package's: handed to a launch with a `cwd` option or to a shell
 *   (`exec*`, `shell: true`), or built in a root-level setup file. A
 *   {@link ScanFinding} carrying file:line, never a skip.
 *
 * An alternative with no `dist` segment is none of them. A file that does not
 * parse is a finding; a scanned file the parser did not read throws. Comments,
 * and strings that reach no sink (plain test data), never count.
 */

import { compareCodeUnits, safePath } from '@vibe-agent-toolkit/utils';
import ts from 'typescript';

import { calleeName, literalPieces, locate, Module, nameOnlyProgram, PathEvaluator, type Piece, type Pieces, type Values } from './built-output-paths.js';
import type { WorkspaceGraph } from './workspace-graph.js';

/** A path into a workspace package's built output, as one file writes it. */
export interface FileReach {
  /** Repo-relative file that builds the path. */
  readonly site: string;
  /** `<site>:<line>` of the expression, for a finding. */
  readonly at: string;
  /** Directory name under `packages/` of the package whose output it reads. */
  readonly dir: string;
  /** The path inside that package, from `dist` up to the first non-static segment. */
  readonly subpath: string;
  /**
   * Whether the read may reach past `subpath`: a non-static tail, or a last
   * segment with no extension (a directory read whole). Every output under an
   * open path is read.
   */
  readonly open: boolean;
}

/** A located problem in a scanned file: an unresolved `dist` path or a parse error. */
export interface ScanFinding {
  /** `<repo-relative file>:<line>`. */
  readonly site: string;
  readonly message: string;
}

/** What the scan reads out of the scanned files. */
export interface TestTreeScan {
  readonly reaches: readonly FileReach[];
  readonly findings: readonly ScanFinding[];
  /** Every scanned file → the scanned files it loads through a relative specifier. */
  readonly imports: ReadonlyMap<string, readonly string[]>;
  /** The files vitest runs: `*.test.*`. */
  readonly entries: readonly string[];
  /** The vitest setup files: each runs before every test of its package, or, at the repo root, of every package. */
  readonly setups: readonly string[];
}

const SOURCE = /\.[cm]?[jt]sx?$/;
const TEST_ENTRY = /\.test\.[cm]?[jt]sx?$/;
const NOT_TEST_CODE = /\/(?:fixtures|golden)\//;
const PACKAGE_FILE = /^packages\/[^/]+\/(test|src)\/(.+)$/;
const SRC_HELPER = /(?:^|\/)(?:testing\/|[^/]*test-helpers)/;
/** A vitest setup or global-setup file's name. */
const SETUP_NAME = /^(?:vitest\.[^/]*setup|[^/]*global-?setup)\.[cm]?[jt]s$/i;
/** A file directly in a package's root directory. */
const PACKAGE_ROOT_FILE = /^packages\/[^/]+\/[^/]+$/;

/** Whether a repo-relative file is a vitest setup or global-setup file at the repo root or a package root. */
function isSetupFile(rel: string): boolean {
  const name = rel.slice(rel.lastIndexOf('/') + 1);
  return SETUP_NAME.test(name) && (name === rel || PACKAGE_ROOT_FILE.test(rel));
}
/** The directory under `packages/` a file sits in. */
const PACKAGE_DIR = /^packages\/([^/]+)\//;

/** Whether a repo-relative file is test code the rule reads. */
function isScanned(rel: string): boolean {
  if (isSetupFile(rel)) return true;
  const match = PACKAGE_FILE.exec(rel);
  if (match === null || !SOURCE.test(rel) || NOT_TEST_CODE.test(rel)) return false;
  const [, tree, rest = ''] = match;
  return tree === 'test' || TEST_ENTRY.test(rest) || SRC_HELPER.test(rest);
}

/** Node's launches and fs reads: each argument (or element of an array argument) is a path they run or read. */
const PATH_USE = new Set(
  ['spawn', 'exec', 'execFile', 'fork', 'readFile', 'readdir', 'stat', 'lstat', 'cp', 'copyFile', 'access', 'opendir', 'existsSync'].flatMap((name) =>
    name.endsWith('Sync') || name === 'fork' ? [name] : [name, `${name}Sync`],
  ),
);
/** The launches, which may resolve a path from a `cwd` option or hand it to a shell. */
const LAUNCH = new Set(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']);
/** Launches that always run their command through a shell. */
const SHELL = new Set(['exec', 'execSync']);
/** Callees that load a module from their first argument. */
const MODULE_LOAD = new Set(['require', 'mock', 'doMock', 'importActual', 'importMock']);

/** `import()`, `require`, `createRequire(…)(…)`, `vi.mock`/`doMock`/`importActual`/`importMock`. */
function isModuleLoad(call: ts.CallExpression): boolean {
  if (call.expression.kind === ts.SyntaxKind.ImportKeyword) return true;
  if (ts.isCallExpression(call.expression) && calleeName(call.expression) === 'createRequire') return true;
  return MODULE_LOAD.has(calleeName(call) ?? '');
}

/** The module specifier a load names, when it is a string literal. */
function literalSpecifier(node: ts.Node): string | undefined {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
    return node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : undefined;
  }
  if (!ts.isCallExpression(node) || !isModuleLoad(node)) return undefined;
  const [arg] = node.arguments;
  return arg !== undefined && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) ? arg.text : undefined;
}

/** One expression handed to a sink, and the alternatives it evaluates to there. */
interface SinkUse {
  readonly values: Values;
  readonly at: ts.Node;
}

/** How a launch resolves the paths it is handed: through a shell, from a `cwd` option. */
interface LaunchContext {
  readonly shell: boolean;
  readonly cwd: boolean;
}

/** Whether a launch may set `shell` or `cwd`, through any argument after the command that may be its options. */
function launchContext(call: ts.CallExpression, name: string, module: Module, evaluator: PathEvaluator): LaunchContext {
  if (!LAUNCH.has(name)) return { shell: false, cwd: false };
  const options = call.arguments.slice(1).filter((arg) => !ts.isArrayLiteralExpression(arg) && !ts.isStringLiteralLike(arg) && !ts.isFunctionLike(arg));
  return {
    shell: SHELL.has(name) || options.some((option) => evaluator.maySet(module, option, 'shell')),
    cwd: options.some((option) => evaluator.maySet(module, option, 'cwd')),
  };
}

/** The whitespace-separated words of a command a shell parses: each is judged as a path of its own. */
function shellWords(pieces: Pieces): Pieces[] {
  const words: Pieces[] = [];
  let current: Piece[] = [];
  for (const piece of pieces) {
    if (typeof piece !== 'string') {
      current.push(piece);
      continue;
    }
    const [first = '', ...rest] = piece.split(/\s+/);
    current.push(first);
    for (const part of rest) {
      words.push(current);
      current = [...literalPieces(part)];
    }
  }
  words.push(current);
  return words.filter((word) => word.some((piece) => piece !== ''));
}

/** A path anchored nowhere, resolved from a working directory the scan cannot know: unknown where it starts. */
function unrooted(pieces: Pieces): Pieces {
  return locate(pieces).anchor === undefined ? [null, '/', ...pieces] : pieces;
}

/** What a launch's argument names: split into shell words, and rooted nowhere when a shell or a `cwd` option resolves it. */
function launched(values: Values, { shell, cwd }: LaunchContext): Values {
  const words = shell ? values.flatMap(shellWords) : values;
  return shell || cwd ? words.map(unrooted) : words;
}

/** The paths a node hands to a sink; `specifier` is its {@link literalSpecifier}. */
function sinkUses(node: ts.Node, specifier: string | undefined, module: Module, evaluator: PathEvaluator): SinkUse[] {
  if (specifier !== undefined) {
    return [{ values: [evaluator.specifierPieces(module, specifier) ?? [null, '/', specifier]], at: node }];
  }
  if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL') {
    return [{ values: evaluator.values(module, node), at: node }];
  }
  if (!ts.isCallExpression(node)) return [];
  const resolution = evaluator.specifierResolution(module, node) ?? evaluator.pathCall(module, node);
  if (resolution !== undefined) return [{ values: resolution, at: node }];
  if (isModuleLoad(node)) {
    const [arg] = node.arguments;
    return arg === undefined ? [] : [{ values: evaluator.specifierValues(module, arg), at: arg }];
  }
  const name = evaluator.callName(module, node);
  if (!PATH_USE.has(name)) return [];
  const context = launchContext(node, name, module, evaluator);
  return node.arguments
    .flatMap((arg) => (ts.isArrayLiteralExpression(arg) ? [...arg.elements] : [arg]))
    .map((arg) => ({ values: launched(evaluator.values(module, arg), context), at: arg }));
}

/** The workspace's package directories, and each package's directory by name. */
interface Workspace {
  readonly dirs: ReadonlySet<string>;
  readonly names: ReadonlyMap<string, string>;
}

type Reach = { kind: 'reach'; dir: string; subpath: string; open: boolean };
type Verdict = Reach | { kind: 'unresolved'; why: string } | { kind: 'none' };

const NONE: Verdict = { kind: 'none' };
/** A `dist` segment, compared case-insensitively: `Dist` is still a reach to judge, never a pass. */
const DIST = /^dist$/i;

function unresolved(why: string): Verdict {
  return { kind: 'unresolved', why };
}

/** A reach into `dir`: `dist` and every segment after it. Open when the last one has no extension (a directory read whole). */
function reachFrom(dir: string, segments: readonly string[], dist: number): Reach {
  const rest = segments.slice(dist);
  return { kind: 'reach', dir, subpath: rest.join('/'), open: !/\.[^.]+$/.test(rest.at(-1) ?? '') };
}

/** The reach a fully known repo path makes when every segment matches exactly: `packages/<dir>/dist/…` or `…/node_modules/<name>/dist/…`. */
function exactReach(segments: readonly string[], dist: number, { dirs, names }: Workspace): Reach | undefined {
  if (segments[dist] !== 'dist') return undefined;
  const dir = segments[1] ?? '';
  if (dist === 2 && segments[0] === 'packages' && dirs.has(dir)) return reachFrom(dir, segments, dist);
  const link = segments.lastIndexOf('node_modules', dist);
  const linked = link === -1 ? undefined : names.get(segments.slice(link + 1, dist).join('/'));
  return linked === undefined ? undefined : reachFrom(linked, segments, dist);
}

/** A fully known repo path with a `dist` segment: a reach when it lands on a package's `dist/` exactly; unresolved otherwise. */
function landing(segments: readonly string[], workspace: Workspace): Verdict {
  const dist = segments.findIndex((segment) => DIST.test(segment));
  const exact = exactReach(segments, dist, workspace);
  if (exact !== undefined) return exact;
  const folded: Workspace = {
    dirs: new Set([...workspace.dirs].map((dir) => dir.toLowerCase())),
    names: new Map([...workspace.names].map(([name, dir]) => [name.toLowerCase(), dir] as const)),
  };
  return exactReach(segments.map((segment) => segment.toLowerCase()), dist, folded) === undefined
    ? unresolved("it lands on no workspace package's `dist/`")
    : unresolved("it names a package's `dist/` only when case is ignored");
}

/** Whether a `..` climbs above where a path starts: past every segment before it, an unknown one counting as one. */
function climbsOut(segments: ReadonlyArray<string | null>): boolean {
  let depth = 0;
  for (const segment of segments) {
    depth += segment === '..' ? -1 : 1;
    if (depth < 0) return true;
  }
  return false;
}

/**
 * Which kind of path one alternative is (see the module header). A path that
 * starts with static relative text resolves against the working directory: a
 * test's package directory (`owner`), unknown for a file in no package.
 */
function classify(pieces: Pieces, workspace: Workspace, owner: string | undefined): Verdict {
  const { anchor, segments } = locate(pieces);
  if (!segments.some((segment) => segment !== null && DIST.test(segment)) || anchor?.anchor === 'absolute') return NONE;
  if (anchor?.anchor === 'temp') return climbsOut(segments) ? unresolved('a `..` in it climbs out of its temp dir') : NONE;
  if (segments.includes(null)) {
    return unresolved(
      'part of it is not known statically (a parameter or function result the rule cannot follow, a call site it cannot enumerate, a `let` given an unknown value, a cycle, a dependency\'s specifier, or a working directory it cannot know)',
    );
  }
  if (anchor === undefined && owner === undefined) return unresolved('it is relative to a working directory the rule cannot know');
  // Relative text resolves from the owner's directory, a package specifier from that package's.
  const base = anchor?.anchor === 'package' ? anchor.dir : owner;
  const rooted = anchor?.anchor === 'repo' ? pieces : [{ anchor: 'repo' } as const, 'packages', '/', base ?? '', '/', ...withoutAnchor(pieces)];
  return landing(locate(rooted).segments as readonly string[], workspace);
}

/** The pieces after the last anchor. */
function withoutAnchor(pieces: Pieces): Pieces {
  const last = pieces.findLastIndex((piece) => piece !== null && typeof piece === 'object');
  return pieces.slice(last + 1);
}

/** Longest stretch of an expression a finding quotes. */
const EXPRESSION_SHOWN = 160;

/** Everything one scanned module contributes. */
function scanModule(module: Module, evaluator: PathEvaluator, workspace: Workspace) {
  const owner = PACKAGE_DIR.exec(module.rel)?.[1];
  const reaches: FileReach[] = [];
  const findings: ScanFinding[] = [];
  const loads: string[] = [];
  const visit = (node: ts.Node): void => {
    const specifier = literalSpecifier(node);
    const loaded = specifier === undefined ? undefined : evaluator.resolveModule(module.rel, specifier);
    if (loaded !== undefined) loads.push(loaded);
    for (const { values, at } of sinkUses(node, specifier, module, evaluator)) {
      // No alternatives at all (a value only a cycle reaches) is a value the scan does not know.
      const known: Values = values.length === 0 ? [[null]] : values;
      for (const verdict of known.map((pieces) => classify(pieces, workspace, owner))) {
        if (verdict.kind === 'reach') reaches.push({ site: module.rel, at: module.siteOf(at), dir: verdict.dir, subpath: verdict.subpath, open: verdict.open });
        if (verdict.kind === 'unresolved') {
          findings.push({
            site: module.siteOf(at),
            message: `\`${at.getText(module.file).replaceAll(/\s+/g, ' ').slice(0, EXPRESSION_SHOWN)}\` builds a dist/ path, but ${verdict.why}, so no rule can tell whose build it reads. Anchor it to a static repo location or a temp dir.`,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(module.file);
  return { reaches, findings, loads: [...new Set(loads)] };
}

/** Same item found twice (a const used by two calls) is one item. */
function dedupe<T>(items: readonly T[]): T[] {
  return [...new Map(items.map((item) => [JSON.stringify(item), item] as const)).values()];
}

/** A path as a key: absolute, forward slashes, the drive letter upper-cased (TypeScript and Node disagree on its case). */
function pathKey(path: string): string {
  return safePath.resolve(path).replace(/^[a-z]:/, (drive) => drive.toUpperCase());
}

/**
 * The scanned files parsed in one program, and a finding for each that does not parse.
 *
 * @throws When the parser read back fewer files than it was given: a file the
 *   rule never read would otherwise pass unchecked
 */
function parseScanned(repoRoot: string, files: readonly string[]): { modules: Map<string, Module>; findings: ScanFinding[] } {
  const byPath = new Map(files.map((rel) => [pathKey(safePath.join(repoRoot, rel)), rel] as const));
  const program = nameOnlyProgram(files.map((rel) => safePath.join(repoRoot, rel)));
  const checker = program.getTypeChecker();
  const modules = new Map<string, Module>();
  for (const file of program.getSourceFiles()) {
    const rel = byPath.get(pathKey(file.fileName));
    if (rel !== undefined) modules.set(rel, new Module(file, rel, checker));
  }
  const dropped = files.filter((rel) => !modules.has(rel));
  if (dropped.length > 0) {
    throw new Error(`the parser read back ${modules.size.toString()} of ${files.length.toString()} scanned files; not read: ${dropped.slice(0, 5).join(', ')}`);
  }
  const relOf = new Map([...modules.values()].map((module) => [module.file, module.rel] as const));
  const findings = program.getSyntacticDiagnostics().map((diagnostic) => {
    const { file, start } = diagnostic;
    const line = file.getLineAndCharacterOfPosition(start).line + 1;
    const rel = relOf.get(file) ?? file.fileName;
    return { site: `${rel}:${line.toString()}`, message: `does not parse, so the rule cannot read it: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}` };
  });
  return { modules, findings };
}

/** The workspace as the classifier reads it. */
function workspaceOf(graph: WorkspaceGraph): Workspace {
  return { dirs: new Set(graph.packages.map((pkg) => pkg.dir)), names: new Map(graph.packages.map((pkg) => [pkg.name, pkg.dir] as const)) };
}

/** What one word of a package script reads, judged as the scan judges a path. */
export type ScriptWordVerdict = { readonly reach: Omit<FileReach, 'site' | 'at'> } | { readonly unresolved: string } | undefined;

/** Script words a shell expands, so their text is not the path they name. */
const SHELL_EXPANDED = /[$`]/;

/**
 * Judge one whitespace-separated word of a package script the way the scan
 * judges a path: relative to the script's working directory. `undefined` when
 * it builds no `dist/` path.
 *
 * @param word - The word, quotes stripped
 * @param owner - Directory under `packages/` of the package the script runs in;
 *   `undefined` once a `cd` has moved it
 * @param graph - The workspace
 */
export function judgeScriptWord(word: string, owner: string | undefined, graph: WorkspaceGraph): ScriptWordVerdict {
  const verdict = classify(SHELL_EXPANDED.test(word) ? [null, word] : literalPieces(word), workspaceOf(graph), owner);
  if (verdict.kind === 'reach') return { reach: { dir: verdict.dir, subpath: verdict.subpath, open: verdict.open } };
  return verdict.kind === 'unresolved' ? { unresolved: verdict.why } : undefined;
}

/**
 * Scan every test file among `files` (repo-relative, forward slashes).
 *
 * @param repoRoot - Absolute repository root the files are relative to
 * @param graph - The workspace: its directories are what a reach can name, its names what a specifier can
 * @param files - Every file of the packages; the scanned ones are picked out, the rest resolve imports
 */
export function scanTestTree(repoRoot: string, graph: WorkspaceGraph, files: readonly string[]): TestTreeScan {
  const workspace = workspaceOf(graph);
  const scanned = files.filter((rel) => isScanned(rel)).sort(compareCodeUnits);
  const { modules, findings } = parseScanned(repoRoot, scanned);
  const evaluator = new PathEvaluator(repoRoot, new Set(files), workspace.names, modules);
  const reaches: FileReach[] = [];
  const imports = new Map<string, readonly string[]>();
  for (const module of modules.values()) {
    const result = scanModule(module, evaluator, workspace);
    reaches.push(...result.reaches);
    findings.push(...result.findings);
    imports.set(module.rel, result.loads.filter((loaded) => modules.has(loaded)));
  }
  return {
    reaches: dedupe(reaches),
    findings: dedupe(findings),
    imports,
    entries: scanned.filter((rel) => TEST_ENTRY.test(rel)),
    setups: scanned.filter((rel) => isSetupFile(rel)),
  };
}
