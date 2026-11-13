/**
 * The lower-tier seeds' finder: reads a producer test file's syntax tree (never
 * its text) and says whether the test a manifest row names really plants the
 * row's member, and where every `expectAbsenceCause` call outside `utils` and
 * the harness sits, so the calls and the rows can be held both ways.
 *
 * A call counts only when it is a statement of the test's own body, or the
 * direct argument of an `expect(...)` statement there: never inside `try` or
 * `catch`, a nested function, or `expect(() => ...)`. Its rows are no literal and
 * no binding of one; its signature is a literal stating every field of the
 * member's, each with the member's value. A test skipped by its own modifier or
 * by an enclosing `describe` does not plant anything.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';

import { safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import ts from 'typescript';

import { memberEntry, type AbsenceMember } from './absence-causes.js';

const CALLEE = 'expectAbsenceCause';
const TEST_BASES = new Set(['it', 'test']);
const DESCRIBE = 'describe';

/** A test's own skipIf/runIf may name one of these, the host gates every package uses, and nothing else. */
const HOST_GATES = new Set([
  'CANNOT_DENY_READS',
  '!CANNOT_DENY_READS',
  'PERMISSIONS_ENFORCED',
  '!PERMISSIONS_ENFORCED',
  'symlinkCapability()===null',
  'symlinkCapability()!==null',
]);
const GATED = new Set(['skipIf', 'runIf']);
const SKIPPING = new Set(['skip', 'todo']);

/** One link of a callee chain: `it.each(table)` is `[it] [each(table)]`. */
interface ChainLink {
  readonly name: string;
  readonly args?: readonly ts.Expression[];
}

/**
 * A callee as its chain, base first: `describe.concurrent.skip` is
 * describe, concurrent, skip; `it.skipIf(x)` carries skipIf's arguments.
 *
 * @param callee - A call's expression
 * @returns The chain, or undefined when it does not end at an identifier
 */
function chainOf(callee: ts.Expression): ChainLink[] | undefined {
  const links: ChainLink[] = [];
  let node: ts.Expression = callee;
  let args: readonly ts.Expression[] | undefined;
  for (;;) {
    if (ts.isCallExpression(node)) {
      args = node.arguments;
      node = node.expression;
    } else if (ts.isPropertyAccessExpression(node)) {
      links.unshift(args === undefined ? { name: node.name.text } : { name: node.name.text, args });
      args = undefined;
      node = node.expression;
    } else if (ts.isIdentifier(node)) {
      links.unshift({ name: node.text });
      return links;
    } else {
      return undefined;
    }
  }
}

/** The text of an expression with its whitespace removed, for comparing against {@link HOST_GATES}. */
function compact(node: ts.Expression, source: ts.SourceFile): string {
  return node.getText(source).replaceAll(/\s/g, '');
}

/**
 * Why a chain skips its test, or undefined when it does not.
 *
 * @param chain - The callee chain
 * @param source - The file, to read gate arguments
 * @param allowGates - Whether a host-gated skipIf/runIf is allowed (a test's own; never a describe's)
 * @returns The reason, or undefined
 */
function skipReason(chain: readonly ChainLink[], source: ts.SourceFile, allowGates: boolean): string | undefined {
  for (const link of chain.slice(1)) {
    if (SKIPPING.has(link.name)) return `.${link.name}`;
    if (!GATED.has(link.name)) continue;
    const [gate] = link.args ?? [];
    if (!allowGates || gate === undefined || !HOST_GATES.has(compact(gate, source))) {
      return `.${link.name}(${gate === undefined ? '' : gate.getText(source)})`;
    }
  }
  return undefined;
}

/** Whether a call declares a test (`it`/`test` in any chain form), with a title. */
function testTitle(call: ts.CallExpression): string | undefined {
  const chain = chainOf(call.expression);
  const [title] = call.arguments;
  if (chain?.[0] === undefined || !TEST_BASES.has(chain[0].name)) return undefined;
  return title !== undefined && ts.isStringLiteralLike(title) ? title.text : undefined;
}

/** Every call in a subtree. */
function callsIn(node: ts.Node): ts.CallExpression[] {
  const found: ts.CallExpression[] = [];
  const visit = (child: ts.Node): void => {
    if (ts.isCallExpression(child)) found.push(child);
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

/** Every `expectAbsenceCause(...)` call in a subtree. */
function absenceCallsIn(node: ts.Node): ts.CallExpression[] {
  return callsIn(node).filter((call) => ts.isIdentifier(call.expression) && call.expression.text === CALLEE);
}

/** Strip parentheses, `as`, `satisfies` and `!` from an expression. */
function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isNonNullExpression(current)) {
    current = current.expression;
  }
  return current;
}

/** Every initializer the file binds a name to. */
function initializersOf(name: string, source: ts.SourceFile): ts.Expression[] {
  const found: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer !== undefined) {
      found.push(unwrap(node.initializer));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Whether an expression is a literal a test could have written rows into. */
function isLiteral(node: ts.Expression): boolean {
  return ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node) || ts.isLiteralExpression(node)
    || node.kind === ts.SyntaxKind.NullKeyword || node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword;
}

/** Whether a rows argument is rows the test wrote by hand: a literal, or a name bound to one. */
function isHandWritten(argument: ts.Expression, source: ts.SourceFile): boolean {
  const rows = unwrap(argument);
  if (isLiteral(rows)) return true;
  return ts.isIdentifier(rows) && initializersOf(rows.text, source).some((initializer) => isLiteral(initializer));
}

/**
 * The value a signature property states, as JSON text: a string, a boolean, or
 * a name's value. A name the file binds to a string literal reads as that
 * string; any other name reads as itself, which is a code constant's value
 * (codes are named for themselves). Anything else reads as its own source text,
 * which no member's value equals.
 */
function stated(node: ts.Expression, source: ts.SourceFile): string {
  const value = unwrap(node);
  if (ts.isStringLiteralLike(value)) return JSON.stringify(value.text);
  if (value.kind === ts.SyntaxKind.TrueKeyword || value.kind === ts.SyntaxKind.FalseKeyword) return value.getText(source);
  if (!ts.isIdentifier(value)) return `<${value.getText(source)}>`;
  const bound = initializersOf(value.text, source).find((initializer) => ts.isStringLiteralLike(initializer));
  return JSON.stringify(bound !== undefined && ts.isStringLiteralLike(bound) ? bound.text : value.text);
}

/** A signature's fields as sorted `name=JSON` pairs, one text to compare. */
function signatureText(fields: Readonly<Record<string, string>>): string {
  return Object.entries(fields).map(([name, value]) => `${name}=${value}`).sort((left, right) => left.localeCompare(right)).join(', ');
}

/** A signature literal's fields, or undefined when the argument is no object literal of plain properties. */
function signatureOf(argument: ts.Expression | undefined, source: ts.SourceFile): Record<string, string> | undefined {
  if (argument === undefined) return undefined;
  const literal = unwrap(argument);
  if (!ts.isObjectLiteralExpression(literal)) return undefined;
  const fields: Record<string, string> = {};
  for (const property of literal.properties) {
    if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) return undefined;
    fields[property.name.text] = stated(property.initializer, source);
  }
  return fields;
}

/** Whether a node is a statement of the test body itself. */
function isBodyStatement(node: ts.Node, body: ts.Block): boolean {
  return ts.isExpressionStatement(node) && node.parent === body;
}

/**
 * Whether a call counts: a statement of the body, or the direct argument of an
 * `expect(...)` whose chain (`.toHaveLength(1)` and the like) is one.
 */
function counts(call: ts.CallExpression, body: ts.Block): boolean {
  if (isBodyStatement(call.parent, body)) return true;
  const expectCall = call.parent;
  if (!ts.isCallExpression(expectCall) || expectCall.arguments[0] !== call) return false;
  if (!ts.isIdentifier(expectCall.expression) || expectCall.expression.text !== 'expect') return false;
  let node: ts.Node = expectCall;
  while ((ts.isPropertyAccessExpression(node.parent) || ts.isCallExpression(node.parent)) && (node.parent as ts.PropertyAccessExpression | ts.CallExpression).expression === node) {
    node = node.parent;
  }
  return isBodyStatement(node.parent, body);
}

/** The test's callback body, when it is a block. */
function bodyOf(test: ts.CallExpression): ts.Block | undefined {
  const callback = test.arguments.find((argument) => ts.isArrowFunction(argument) || ts.isFunctionExpression(argument));
  return callback !== undefined && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) && ts.isBlock(callback.body) ? callback.body : undefined;
}

/** Why a test is skipped, by its own chain or an enclosing describe's, or undefined. */
function testSkipped(test: ts.CallExpression, source: ts.SourceFile): string | undefined {
  const own = skipReason(chainOf(test.expression) ?? [], source, true);
  if (own !== undefined) return `skipped by its own ${own}`;
  for (let parent: ts.Node = test.parent; !ts.isSourceFile(parent); parent = parent.parent) {
    if (!ts.isCallExpression(parent)) continue;
    const chain = chainOf(parent.expression);
    if (chain?.[0]?.name !== DESCRIBE) continue;
    const reason = skipReason(chain, source, false);
    if (reason !== undefined) return `skipped by an enclosing describe${reason}`;
  }
  return undefined;
}

/** The problems with one counted call: rows written by hand, a signature not the member's own. */
function callProblems(call: ts.CallExpression, member: AbsenceMember, source: ts.SourceFile): string[] {
  const problems: string[] = [];
  const [rows, signatureArgument] = call.arguments;
  if (rows === undefined || isHandWritten(rows, source)) problems.push(`rows written by hand: ${call.getText(source)}`);
  const wanted = signatureText(Object.fromEntries(Object.entries(memberEntry(member).signature).map(([name, value]) => [name, JSON.stringify(value)])));
  const found = signatureOf(signatureArgument, source);
  if (found === undefined || signatureText(found) !== wanted) problems.push(`signature is not ${member}'s own ${wanted}: ${signatureArgument?.getText(source) ?? '(none)'}`);
  return problems;
}

/**
 * Judge the test a lower-tier manifest row names.
 *
 * @param text - The test file's source
 * @param fileName - Its name, for the parser
 * @param testName - The title as written
 * @param member - The member the row seeds
 * @returns Every problem found; empty when the test plants the member
 */
export function judgeLowerTierTest(text: string, fileName: string, testName: string, member: AbsenceMember): string[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const tests = callsIn(source).filter((call) => testTitle(call) === testName);
  const [test] = tests;
  if (tests.length !== 1 || test === undefined) return [`exactly one test titled '${testName}' wanted, found ${String(tests.length)}`];
  const skipped = testSkipped(test, source);
  if (skipped !== undefined) return [skipped];
  const body = bodyOf(test);
  const counted = body === undefined ? [] : absenceCallsIn(test).filter((call) => counts(call, body));
  if (counted.length === 0) return [`no counted ${CALLEE} call: one must be a statement of the test body, or the direct argument of expect(...) there`];
  const judged = counted.map((call) => callProblems(call, member, source));
  return judged.some((problems) => problems.length === 0) ? [] : judged.flat();
}

/** One `expectAbsenceCause` call site: its file and the title of the test around it. */
interface CallSite {
  /** Repository-relative. */
  readonly file: string;
  /** Undefined when no test encloses the call. */
  readonly test: string | undefined;
}

/** The trees the call-site scan reads, and what it leaves out: `utils` (the helper and its own tests) and the harness. */
const SCANNED_TREES = ['src', 'test'] as const;
const NOT_SCANNED = new Set(['packages/cli/test/helpers/cache-differential.ts']);
const NOT_SCANNED_PACKAGE = 'utils';

/**
 * Every scanned TypeScript file: repository-relative, forward-slashed.
 *
 * @param repoRoot - The repository root
 * @returns The files
 */
function scannedFiles(repoRoot: string): string[] {
  const packagesDir = safePath.join(repoRoot, 'packages');
  const files: string[] = [];
  for (const pkg of readdirSync(packagesDir, { withFileTypes: true })) {
    // A linked package directory is not this repository's source.
    if (pkg.isSymbolicLink() || !pkg.isDirectory() || pkg.name === NOT_SCANNED_PACKAGE) continue;
    for (const tree of SCANNED_TREES) {
      const treeDir = safePath.join(packagesDir, pkg.name, tree);
      if (!existsSync(treeDir)) continue;
      const entries = readdirSync(treeDir, { recursive: true, encoding: 'utf-8' }).filter((name) => name.endsWith('.ts'));
      files.push(...entries.map((entry) => `packages/${pkg.name}/${tree}/${toForwardSlash(entry)}`));
    }
  }
  return files.filter((file) => !NOT_SCANNED.has(file));
}

/**
 * Every `expectAbsenceCause` call outside `utils` and the harness.
 *
 * @param repoRoot - The repository root
 * @returns One site per call
 */
export function lowerTierCallSites(repoRoot: string): CallSite[] {
  const sites: CallSite[] = [];
  for (const file of scannedFiles(repoRoot)) {
    const text = readFileSync(safePath.join(repoRoot, file), 'utf-8');
    if (!text.includes(CALLEE)) continue;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    for (const call of absenceCallsIn(source)) sites.push({ file, test: enclosingTest(call) });
  }
  return sites;
}

/** The title of the nearest test enclosing a node. */
function enclosingTest(node: ts.Node): string | undefined {
  for (let parent: ts.Node = node.parent; !ts.isSourceFile(parent); parent = parent.parent) {
    if (ts.isCallExpression(parent)) {
      const title = testTitle(parent);
      if (title !== undefined) return title;
    }
  }
  return undefined;
}
