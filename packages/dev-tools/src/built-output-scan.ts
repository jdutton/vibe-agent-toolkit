/**
 * Which test files build a path into a workspace package's `dist/`, read from
 * their syntax tree — the half of `built-output-edges.ts` that needs no turbo.
 *
 * Scanned: every source file under a package's `test/`, every `src/**\/*.test.*`,
 * and the test helpers under `src/` (`testing/`, `*test-helpers*`). In them, a
 * path is any expression handed to a path sink: a `…join…`/`…resolve…` call,
 * `new URL`, a module load (`import`, `import()`, `require`, `createRequire(…)(…)`,
 * `vi.mock`/`doMock`/`importActual`/`importMock`), a process launch
 * (`spawn*`/`exec*`/`fork`) or an fs read. Each one that has a `dist` segment is
 * exactly one of (evaluation: `built-output-paths.ts`):
 *
 * - RESOLVED: its anchor is a repo location — the file's own directory
 *   (`__dirname`, `import.meta.dirname`, `new URL(…, import.meta.url)`, a relative
 *   module specifier), a workspace package specifier (`@scope/pkg/dist/…`), or a
 *   value that traces to one. Static relative text with no anchor resolves from
 *   the working directory — for a test, its package's directory. When it lands
 *   in `packages/<dir>/dist`, or in a workspace package linked under
 *   `node_modules`, it is a {@link FileReach}; anywhere else it reads no
 *   package's output.
 * - TEMP: its anchor traces to `tmpdir()`, `mkdtemp*` or a temp-dir helper of
 *   `@vibe-agent-toolkit/utils/testing` — `underTemp(path, root)` among them,
 *   which asserts at run time that `path` is inside the temp dir `root`. Not a
 *   reach.
 * - UNRESOLVED: anything else — an untraceable parameter or function result, a
 *   `let` given an unknown value, a non-relative import, or a package directory
 *   that differs only in case. A {@link ScanFinding}
 *   carrying file:line, never a skip.
 *
 * A file that does not parse is a finding, not a skip. Comments, and strings
 * that reach no sink (plain test data), never count.
 */

import { compareCodeUnits, safePath } from '@vibe-agent-toolkit/utils';
import ts from 'typescript';

import { calleeName, literalPieces, locate, Module, nameOnlyProgram, PathEvaluator, type Pieces, type Values } from './built-output-paths.js';
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
}

const SOURCE = /\.[cm]?[jt]sx?$/;
const TEST_ENTRY = /\.test\.[cm]?[jt]sx?$/;
const NOT_TEST_CODE = /\/(?:fixtures|golden)\//;
const PACKAGE_FILE = /^packages\/[^/]+\/(test|src)\/(.+)$/;
const SRC_HELPER = /(?:^|\/)(?:testing\/|[^/]*test-helpers)/;

/** Whether a repo-relative file is test code the rule reads. */
function isScanned(rel: string): boolean {
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

/** The paths a node hands to a sink; `specifier` is its {@link literalSpecifier}. */
function sinkUses(node: ts.Node, specifier: string | undefined, module: Module, evaluator: PathEvaluator): SinkUse[] {
  if (specifier !== undefined) {
    const pieces = evaluator.specifierPieces(module, specifier);
    return pieces === undefined ? [] : [{ values: [pieces], at: node }];
  }
  if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL') {
    return [{ values: evaluator.values(module, node), at: node }];
  }
  if (!ts.isCallExpression(node)) return [];
  const path = evaluator.pathCall(module, node);
  if (path !== undefined) return [{ values: path, at: node }];
  const load = isModuleLoad(node);
  if (!load && !PATH_USE.has(evaluator.callName(module, node))) return [];
  return (load ? node.arguments.slice(0, 1) : node.arguments)
    .flatMap((arg) => (ts.isArrayLiteralExpression(arg) ? [...arg.elements] : [arg]))
    .map((arg) => ({ values: evaluator.values(module, arg), at: arg }));
}

/** The workspace's package directories, and each package's directory by name. */
interface Workspace {
  readonly dirs: ReadonlySet<string>;
  readonly names: ReadonlyMap<string, string>;
}

type Reach = { kind: 'reach'; dir: string; subpath: string; open: boolean };
type Verdict = Reach | { kind: 'unresolved'; why: string } | { kind: 'none' };

/** A reach into `dir`: `dist` and the static segments after it, up to the first unknown one. */
function reachFrom(dir: string, segments: ReadonlyArray<string | null>, index: number): Reach {
  const rest = segments.slice(index);
  const end = rest.indexOf(null);
  const known = (end === -1 ? rest : rest.slice(0, end)) as string[];
  const last = known.at(-1) ?? '';
  return { kind: 'reach', dir, subpath: known.join('/'), open: end !== -1 || !/\.[^.]+$/.test(last) };
}

/** The workspace package a repo path reaches through an install link: `…/node_modules/<name>/dist`. */
function linkedPackage(segments: ReadonlyArray<string | null>, dist: number, workspace: Workspace): string | undefined {
  const at = segments.lastIndexOf('node_modules', dist);
  return at === -1 ? undefined : workspace.names.get(segments.slice(at + 1, dist).join('/'));
}

/** A repo-anchored path: a reach when it lands in `packages/<dir>/dist`, or in a workspace package linked under `node_modules`. */
function classifyRepoPath(segments: ReadonlyArray<string | null>, dist: number, workspace: Workspace): Verdict {
  const { dirs } = workspace;
  const unknownAt = segments.slice(0, dist).indexOf(null);
  if (unknownAt !== -1) {
    // An unknown segment that could be the package directory, or that a later `..` climbs out of.
    // Segment values of authored text, not a containment check on a real path.
    const between = segments.slice(unknownAt, dist);
    const climbs = between.includes('..');
    return unknownAt <= 1 || climbs ? { kind: 'unresolved', why: 'its package segment is not static' } : { kind: 'none' };
  }
  const linked = linkedPackage(segments, dist, workspace);
  if (linked !== undefined) return reachFrom(linked, segments, dist);
  if (segments[0] !== 'packages' || dist !== 2) return { kind: 'none' };
  const dir = segments[1] ?? '';
  if (dirs.has(dir)) return reachFrom(dir, segments, dist);
  const lower = dir.toLowerCase();
  return [...dirs].some((known) => known.toLowerCase() === lower)
    ? { kind: 'unresolved', why: `\`${dir}\` names a package directory only when case is ignored` }
    : { kind: 'none' };
}

/**
 * Which kind of path one alternative is, when it has a `dist` segment. A path
 * that starts with static relative text resolves against the working directory,
 * which for a test is its package's directory (`owner`).
 */
function classify(pieces: Pieces, workspace: Workspace, owner: string): Verdict {
  const { anchor, segments } = locate(pieces);
  if (!segments.includes('dist') || anchor?.anchor === 'temp' || anchor?.anchor === 'absolute') return { kind: 'none' };
  if (anchor === undefined) {
    if (segments[0] === null) {
      return { kind: 'unresolved', why: 'it starts from no location the rule can trace (a parameter or function result it cannot follow, a `let` given one, or a non-relative import)' };
    }
    return classify([{ anchor: 'repo' }, 'packages', '/', owner, '/', ...pieces], workspace, owner);
  }
  if (anchor.anchor === 'package') return segments[0] === 'dist' ? reachFrom(anchor.dir, segments, 0) : { kind: 'none' };
  return classifyRepoPath(segments, segments.indexOf('dist'), workspace);
}

/** Longest stretch of an expression a finding quotes. */
const EXPRESSION_SHOWN = 160;

/** Everything one scanned module contributes. */
function scanModule(module: Module, evaluator: PathEvaluator, workspace: Workspace) {
  const owner = /^packages\/([^/]+)\//.exec(module.rel)?.[1] ?? '';
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

/** The scanned files parsed in one program, and a finding for each that does not parse. */
function parseScanned(repoRoot: string, files: readonly string[]): { modules: Map<string, Module>; findings: ScanFinding[] } {
  const byPath = new Map(files.map((rel) => [safePath.join(repoRoot, rel), rel] as const));
  const program = nameOnlyProgram([...byPath.keys()]);
  const checker = program.getTypeChecker();
  const modules = new Map<string, Module>();
  for (const file of program.getSourceFiles()) {
    const rel = byPath.get(safePath.resolve(file.fileName));
    if (rel !== undefined) modules.set(rel, new Module(file, rel, checker));
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
 * judges a path: relative to the package's directory (the script's working
 * directory). `undefined` when it builds no `dist/` path.
 *
 * @param word - The word, quotes stripped
 * @param owner - Directory under `packages/` of the package the script belongs to
 * @param graph - The workspace
 */
export function judgeScriptWord(word: string, owner: string, graph: WorkspaceGraph): ScriptWordVerdict {
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
  return { reaches: dedupe(reaches), findings: dedupe(findings), imports, entries: scanned.filter((rel) => TEST_ENTRY.test(rel)) };
}
