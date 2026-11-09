/**
 * Which test-tree files build a path into a workspace package's `dist/`, read
 * from their syntax tree — the half of `built-output-edges.ts` that needs no
 * turbo.
 *
 * A string counts only where it builds a path that is USED: an argument to a
 * path-joining call (any callee named `…join…`/`…resolve…`, `new URL`), or to a
 * call that loads or runs one (`import()`, `require`, `vi.mock`/`vi.doMock`,
 * `spawn*`, `exec*`, `fork`). A same-file `const`, a template literal and a
 * `+` concatenation are followed into those calls; comments and plain test data
 * never count.
 *
 * Each such expression is evaluated to path segments, an unknown value making
 * an unknown segment. A `dist` segment whose package segment sits under `..` or
 * `packages` names the package; a package segment that is not static is
 * reported as {@link UnresolvedReach}, never skipped.
 */

import { readFileSync } from 'node:fs';

import { safePath, toForwardSlashAnyPlatform } from '@vibe-agent-toolkit/utils';
import ts from 'typescript';

import type { WorkspaceGraph } from './workspace-graph.js';

/** A path into a workspace package's built output, as one file writes it. */
export interface FileReach {
  /** Repo-relative file that builds the path. */
  readonly site: string;
  /** Directory name under `packages/` of the package whose output it reads. */
  readonly dir: string;
  /** The path inside that package, from `dist` up to the first non-static segment. */
  readonly subpath: string;
}

/** A path into some package's `dist/` whose package segment is not static. */
export interface UnresolvedReach {
  readonly site: string;
  /** The expression, as written. */
  readonly expression: string;
}

/** What the scan reads out of the test tree. */
export interface TestTreeScan {
  readonly reaches: readonly FileReach[];
  readonly unresolved: readonly UnresolvedReach[];
  /** Every test-tree file → the test-tree files it imports (relative specifiers only). */
  readonly imports: ReadonlyMap<string, readonly string[]>;
  /** The files vitest runs: `*.test.*` in a package's `test/` or `src/`. */
  readonly entries: readonly string[];
}

/** A source file under a package's `test/`, or a test under its `src/`, outside fixture and golden trees. */
const TEST_TREE_FILE = /^packages\/[^/]+\/(?:test\/.+|src\/.+\.test)\.[cm]?[jt]sx?$/;
const NOT_TEST_CODE = /\/(?:fixtures|golden)\//;
const TEST_ENTRY = /\.test\.[cm]?[jt]sx?$/;

/** Callees whose arguments are joined into ONE path. */
const PATH_JOIN = /join|resolve/i;
/** Callees that load or run each argument (or each element of an array argument). */
const PATH_USE = /^(?:spawn|exec|fork$|require$|mock$|doMock$)/;
/** Calls that hand their first argument through as the same path. */
const PASS_THROUGH = new Set(['toForwardSlash', 'fileURLToPath', 'pathToFileURL', 'String']);

/** One evaluated path: its pieces, `null` where a value is not static. */
type Pieces = Array<string | null>;
const HOLE: Pieces = [null];

/** The name a call is made through: `safePath.join` → `join`, `pathResolve` → `pathResolve`. */
function calleeName(call: ts.CallExpression): string | undefined {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return undefined;
}

/** Evaluates expressions of one file to path pieces, following its `const` declarations. */
class PathEvaluator {
  private readonly consts = new Map<string, ts.Expression | null>();
  private readonly active = new Set<string>();

  constructor(private readonly file: ts.SourceFile) {
    const visit = (node: ts.Node): void => {
      // Only a `const` holds one value; the list's keyword token says which it is.
      if (ts.isVariableDeclarationList(node) && node.getFirstToken(file)?.kind === ts.SyntaxKind.ConstKeyword) {
        for (const decl of node.declarations) {
          if (!ts.isIdentifier(decl.name) || decl.initializer === undefined) continue;
          // A name declared twice in one file has no single value.
          this.consts.set(decl.name.text, this.consts.has(decl.name.text) ? null : decl.initializer);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }

  /** The path pieces `node` evaluates to. */
  evaluate(node: ts.Expression): Pieces {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
    if (ts.isTemplateExpression(node)) {
      return [node.head.text, ...node.templateSpans.flatMap((span) => [...this.evaluate(span.expression), span.literal.text])];
    }
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) return this.evaluate(node.expression);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      return [...this.evaluate(node.left), ...this.evaluate(node.right)];
    }
    if (ts.isIdentifier(node)) return this.evaluateConst(node.text);
    if (ts.isPropertyAccessExpression(node) && (node.name.text === 'href' || node.name.text === 'pathname')) return this.evaluate(node.expression);
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL') {
      const first = node.arguments?.[0];
      return first === undefined ? HOLE : this.evaluate(first);
    }
    if (ts.isCallExpression(node)) return this.evaluateCall(node);
    return HOLE;
  }

  /** The pieces of a joined path call, segments separated by `/`. */
  joined(args: readonly ts.Expression[]): Pieces {
    return args.flatMap((arg, index) => (index === 0 ? this.evaluate(arg) : ['/', ...this.evaluate(arg)]));
  }

  private evaluateCall(call: ts.CallExpression): Pieces {
    const name = calleeName(call) ?? '';
    const first = call.arguments[0];
    if (PASS_THROUGH.has(name) && first !== undefined) return this.evaluate(first);
    return PATH_JOIN.test(name) ? this.joined(call.arguments) : HOLE;
  }

  private evaluateConst(name: string): Pieces {
    const init = this.consts.get(name);
    if (init === undefined || init === null || this.active.has(name)) return HOLE;
    this.active.add(name);
    try {
      return this.evaluate(init);
    } finally {
      this.active.delete(name);
    }
  }

  text(node: ts.Node): string {
    return node.getText(this.file);
  }
}

/** Path segments of `pieces`; a segment that holds any non-static piece is `null`. */
function segmentsOf(pieces: Pieces): Array<string | null> {
  const segments: Array<string | null> = [];
  let current = '';
  let unknown = false;
  const flush = (): void => {
    if (unknown) segments.push(null);
    else if (current !== '' && current !== '.') segments.push(current);
    current = '';
    unknown = false;
  };
  for (const piece of pieces) {
    if (piece === null) {
      unknown = true;
      continue;
    }
    // Authored text: a backslash in it is a separator on every platform.
    const [first = '', ...more] = toForwardSlashAnyPlatform(piece).split('/');
    current += first;
    for (const part of more) {
      flush();
      current += part;
    }
  }
  flush();
  return segments;
}

type Verdict = { kind: 'reach'; dir: string; subpath: string } | { kind: 'unresolved' };

/**
 * Every package `dist/` the segments reach. A `dist` counts when the segment
 * before its package segment is `..` or `packages` — the shape of a path into a
 * sibling package, from a test file or from the repository root.
 */
function verdictsOf(segments: ReadonlyArray<string | null>, dirs: ReadonlySet<string>): Verdict[] {
  const verdicts: Verdict[] = [];
  for (const [index, segment] of segments.entries()) {
    const pkg = segments[index - 1];
    const before = segments[index - 2];
    if (segment !== 'dist' || index < 2 || (before !== '..' && before !== 'packages')) continue;
    if (pkg === null) {
      verdicts.push({ kind: 'unresolved' });
    } else if (pkg !== undefined && dirs.has(pkg)) {
      const rest = segments.slice(index);
      const end = rest.indexOf(null);
      verdicts.push({ kind: 'reach', dir: pkg, subpath: (end === -1 ? rest : rest.slice(0, end)).join('/') });
    }
  }
  return verdicts;
}

/** The expressions in a call that are used as paths: the joined whole, or each argument. */
function usedPaths(node: ts.Node, evaluator: PathEvaluator): Array<{ pieces: Pieces; at: ts.Node }> {
  if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL') {
    return [{ pieces: evaluator.evaluate(node), at: node }];
  }
  if (!ts.isCallExpression(node)) return [];
  const name = node.expression.kind === ts.SyntaxKind.ImportKeyword ? 'import' : calleeName(node) ?? '';
  if (PATH_JOIN.test(name)) return [{ pieces: evaluator.joined(node.arguments), at: node }];
  if (name !== 'import' && !PATH_USE.test(name)) return [];
  return node.arguments
    .flatMap((arg) => (ts.isArrayLiteralExpression(arg) ? [...arg.elements] : [arg]))
    .map((arg) => ({ pieces: evaluator.evaluate(arg), at: arg }));
}

/** Relative module specifiers `file` imports, statically. */
function importSpecifiers(file: ts.SourceFile): string[] {
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [arg] = node.arguments;
      if (arg !== undefined && ts.isStringLiteral(arg)) specifiers.push(arg.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return specifiers.filter((specifier) => specifier.startsWith('.'));
}

/** The test-tree file a relative specifier names: NodeNext writes `.js` for a `.ts` source. */
function resolveImport(from: string, specifier: string, known: ReadonlySet<string>): string | undefined {
  const target = safePath.join(from.slice(0, from.lastIndexOf('/')), specifier);
  const stem = target.replace(/\.[cm]?jsx?$/, '');
  const candidates = [target, `${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.cts`, `${target}.ts`, `${target}/index.ts`];
  return candidates.find((candidate) => known.has(candidate));
}

/** Everything one file contributes to the scan. */
function scanFile(repoRoot: string, rel: string, dirs: ReadonlySet<string>, known: ReadonlySet<string>) {
  const file = ts.createSourceFile(rel, readFileSync(safePath.join(repoRoot, rel), 'utf8'), ts.ScriptTarget.Latest, true);
  const evaluator = new PathEvaluator(file);
  const reaches: FileReach[] = [];
  const unresolved: UnresolvedReach[] = [];
  const visit = (node: ts.Node): void => {
    for (const { pieces, at } of usedPaths(node, evaluator)) {
      for (const verdict of verdictsOf(segmentsOf(pieces), dirs)) {
        if (verdict.kind === 'reach') reaches.push({ site: rel, dir: verdict.dir, subpath: verdict.subpath });
        else unresolved.push({ site: rel, expression: evaluator.text(at) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  const imports = importSpecifiers(file)
    .map((specifier) => resolveImport(rel, specifier, known))
    .filter((target): target is string => target !== undefined);
  return { reaches, unresolved, imports };
}

/** Same reach written twice in one file (a const used by two calls) is one reach. */
function dedupe<T>(items: readonly T[]): T[] {
  return [...new Map(items.map((item) => [JSON.stringify(item), item] as const)).values()];
}

/**
 * Scan every test-tree file among `files` (repo-relative, forward slashes).
 *
 * @param repoRoot - Absolute repository root the files are relative to
 * @param graph - The workspace, whose directory names are the packages a reach can name
 * @param files - Candidate files; anything outside a package's test tree is ignored
 */
export function scanTestTree(repoRoot: string, graph: WorkspaceGraph, files: readonly string[]): TestTreeScan {
  const dirs = new Set(graph.packages.map((pkg) => pkg.dir));
  const testFiles = files.filter((rel) => TEST_TREE_FILE.test(rel) && !NOT_TEST_CODE.test(rel));
  const known = new Set(testFiles);
  const reaches: FileReach[] = [];
  const unresolved: UnresolvedReach[] = [];
  const imports = new Map<string, readonly string[]>();
  for (const rel of testFiles) {
    const scanned = scanFile(repoRoot, rel, dirs, known);
    reaches.push(...scanned.reaches);
    unresolved.push(...scanned.unresolved);
    imports.set(rel, scanned.imports);
  }
  return { reaches: dedupe(reaches), unresolved: dedupe(unresolved), imports, entries: testFiles.filter((rel) => TEST_ENTRY.test(rel)) };
}
