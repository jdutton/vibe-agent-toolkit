/**
 * The lower-tier seeds' finder: reads a producer test file's syntax tree (never
 * its text) and says whether the test a manifest row names really plants the
 * row's member, and where every `expectAbsenceCause` call outside `utils` and
 * the harness sits, so the calls and the rows can be held both ways.
 *
 * The callee is resolved through the file's imports: a named import from
 * `@vibe-agent-toolkit/utils/testing` (aliased or not), or a namespace import
 * of that module used as `ns.expectAbsenceCause(...)`. Any other way of
 * reaching it (a local function of that name, a rebinding, element access,
 * destructuring, a re-export, a dynamic import) is a stray, and reds.
 *
 * A call counts only when it is a statement of the test's own body, or the
 * direct argument of an `expect(...)` statement there: never inside `try` or
 * `catch`, a nested function, or `expect(() => ...)`, and never after a
 * `return` the body could take first. Its rows are no literal and no binding of
 * one; its signature is a literal stating every field of the member's, each
 * with the member's value, a code named through its import's original name or
 * a string the file binds. A test does not plant anything when it is skipped:
 * by its own modifier (skip, fails, the to-do modifier, a `skipIf`/`runIf` that is not
 * a host gate of the right polarity), by an options object, by calling its
 * context's `skip`, or by an enclosing `describe` doing any of these.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';

import { safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import ts from 'typescript';

import { memberEntry, type AbsenceMember } from './absence-causes.js';

const CALLEE = 'expectAbsenceCause';
const TESTING_MODULE = '@vibe-agent-toolkit/utils/testing';
const TEST_BASES = new Set(['it', 'test']);
const DESCRIBE = 'describe';

/**
 * The host gates a test's own skipIf/runIf may name, each in the one polarity
 * that skips only on a host lacking the need: skip where reads cannot be
 * denied or symlinks are missing, run where permissions are enforced or
 * symlinks work.
 */
const HOST_GATES: Readonly<Record<string, ReadonlySet<string>>> = {
  skipIf: new Set(['CANNOT_DENY_READS', 'symlinkCapability()===null']),
  runIf: new Set(['PERMISSIONS_ENFORCED', 'symlinkCapability()!==null']),
};
/** The name each host gate starts with, which must be its own import. */
const GATE_NAMES = new Set(['CANNOT_DENY_READS', 'PERMISSIONS_ENFORCED', 'symlinkCapability']);
const SKIPPING = new Set(['skip', 'todo', 'fails']);

/** What a file's imports bind. */
interface Imports {
  /** Local names bound to the callee by a named import from the testing module. */
  readonly callees: ReadonlySet<string>;
  /** Local names bound to the testing module by a namespace import. */
  readonly testingNamespaces: ReadonlySet<string>;
  /** Local names bound to any module by a namespace import. */
  readonly namespaces: ReadonlySet<string>;
  /** Every local name a named import binds, mapped to the name it was exported under. */
  readonly originals: ReadonlyMap<string, string>;
}

/** One link of a callee chain: `it.each(table)` is `[it] [each(table)]`. */
interface ChainLink {
  readonly name: string;
  readonly args?: readonly ts.Expression[];
}

/**
 * What the file's import declarations bind.
 *
 * @param source - The file
 * @returns Its imports
 */
function importsOf(source: ts.SourceFile): Imports {
  const callees = new Set<string>();
  const testingNamespaces = new Set<string>();
  const namespaces = new Set<string>();
  const originals = new Map<string, string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const testing = statement.moduleSpecifier.text === TESTING_MODULE;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined) continue;
    if (ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
      if (testing) testingNamespaces.add(bindings.name.text);
      continue;
    }
    for (const element of bindings.elements) {
      const original = element.propertyName?.text ?? element.name.text;
      originals.set(element.name.text, original);
      if (testing && original === CALLEE) callees.add(element.name.text);
    }
  }
  return { callees, testingNamespaces, namespaces, originals };
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

/** Whether a gate is a host gate of the polarity its link allows, named through its own import. */
function isHostGate(link: string, gate: ts.Expression, source: ts.SourceFile, imports: Imports): boolean {
  if (HOST_GATES[link]?.has(compact(gate, source)) !== true) return false;
  const [name] = compact(gate, source).split(/\W/);
  return name !== undefined && GATE_NAMES.has(name) && imports.originals.get(name) === name && initializersOf(name, source).length === 0;
}

/**
 * Why a chain skips its test, or undefined when it does not.
 *
 * @param chain - The callee chain
 * @param source - The file, to read gate arguments
 * @param imports - The file's imports, which a host gate must be named through
 * @param allowGates - Whether a host-gated skipIf/runIf is allowed (a test's own; never a describe's)
 * @returns The reason, or undefined
 */
function chainSkipReason(chain: readonly ChainLink[], source: ts.SourceFile, imports: Imports, allowGates: boolean): string | undefined {
  for (const link of chain.slice(1)) {
    if (SKIPPING.has(link.name)) return `.${link.name}`;
    if (HOST_GATES[link.name] === undefined) continue;
    const [gate] = link.args ?? [];
    if (!allowGates || gate === undefined || !isHostGate(link.name, gate, source, imports)) {
      return `.${link.name}(${gate === undefined ? '' : gate.getText(source)})`;
    }
  }
  return undefined;
}

/** Why an options object skips, or undefined when it states no skipping key but `false`. */
function objectSkipReason(literal: ts.ObjectLiteralExpression, source: ts.SourceFile): string | undefined {
  for (const property of literal.properties) {
    if (ts.isSpreadAssignment(property)) return `an options object spreading ${property.expression.getText(source)}`;
    const name = ts.isIdentifier(property.name) ? property.name.text : undefined;
    if (name === undefined || !SKIPPING.has(name)) continue;
    const value = ts.isPropertyAssignment(property) ? unwrap(property.initializer) : undefined;
    if (value?.kind !== ts.SyntaxKind.FalseKeyword) return `an options object's ${property.getText(source)}`;
  }
  return undefined;
}

/**
 * Why a test's or describe's options argument skips it: every argument but the
 * title and the callback must be a number, or an options object (written there
 * or bound to a name) that states no skipping key but `false`.
 */
function optionsSkipReason(call: ts.CallExpression, source: ts.SourceFile): string | undefined {
  for (const argument of call.arguments.slice(1)) {
    const value = unwrap(argument);
    if (ts.isArrowFunction(value) || ts.isFunctionExpression(value) || ts.isNumericLiteral(value)) continue;
    const literals = ts.isIdentifier(value) ? initializersOf(value.text, source) : [value];
    if (literals.length === 0 || !literals.every((literal) => ts.isObjectLiteralExpression(literal))) {
      return `options the finder cannot read: ${value.getText(source)}`;
    }
    for (const literal of literals) {
      const reason = objectSkipReason(literal as ts.ObjectLiteralExpression, source);
      if (reason !== undefined) return reason;
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

/** Whether a call's callee resolves, through the file's imports, to `expectAbsenceCause`. */
function isAbsenceCall(call: ts.CallExpression, imports: Imports): boolean {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return imports.callees.has(callee.text);
  return ts.isPropertyAccessExpression(callee) && callee.name.text === CALLEE
    && ts.isIdentifier(callee.expression) && imports.testingNamespaces.has(callee.expression.text);
}

/** Every resolved `expectAbsenceCause(...)` call in a subtree. */
function absenceCallsIn(node: ts.Node, imports: Imports): ts.CallExpression[] {
  return callsIn(node).filter((call) => isAbsenceCall(call, imports));
}

/** Whether a node sits in an import declaration. */
function inImport(node: ts.Node): boolean {
  for (let parent: ts.Node = node.parent; !ts.isSourceFile(parent); parent = parent.parent) {
    if (ts.isImportDeclaration(parent)) return true;
  }
  return false;
}

/** Whether an identifier is a property name (of an access, an assignment or a member), not a reference. */
function isPropertyName(node: ts.Identifier): boolean {
  const { parent } = node;
  return (ts.isPropertyAccessExpression(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)
    || ts.isPropertySignature(parent) || ts.isMethodDeclaration(parent)) && parent.name === node;
}

/** Whether one identifier is a way of reaching the callee that the scan does not count. */
function isStrayIdentifier(node: ts.Identifier, imports: Imports): boolean {
  const { parent } = node;
  if (inImport(node)) return false;
  if (imports.testingNamespaces.has(node.text) && !isPropertyName(node)) {
    // A namespace of the testing module may only be read through `ns.<name>`.
    return !(ts.isPropertyAccessExpression(parent) && parent.expression === node);
  }
  const named = node.text === CALLEE || (imports.callees.has(node.text) && !isPropertyName(node));
  if (!named) return false;
  if (ts.isCallExpression(parent) && parent.expression === node) return !isAbsenceCall(parent, imports);
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
    return !(ts.isCallExpression(parent.parent) && parent.parent.expression === parent && isAbsenceCall(parent.parent, imports));
  }
  return true;
}

/**
 * Every way the file reaches the callee other than a resolved call.
 *
 * @param source - The file
 * @param imports - Its imports
 * @returns One `line: text` per stray
 */
function straysIn(source: ts.SourceFile, imports: Imports): string[] {
  const strays: string[] = [];
  const at = (node: ts.Node): string => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    return `${String(line)}: ${node.parent.getText(source)}`;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && isStrayIdentifier(node, imports)) strays.push(at(node));
    if (ts.isStringLiteralLike(node) && node.text === CALLEE && ts.isElementAccessExpression(node.parent)) strays.push(at(node));
    ts.forEachChild(node, visit);
  };
  visit(source);
  return strays;
}

/** Strip parentheses, `as`, `satisfies` and `!` from an expression. */
function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isNonNullExpression(current)) {
    current = current.expression;
  }
  return current;
}

/** Whether an expression is a literal a test could have written rows into. */
function isLiteral(node: ts.Expression): boolean {
  return ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node) || ts.isLiteralExpression(node)
    || node.kind === ts.SyntaxKind.NullKeyword || node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword;
}

/**
 * Whether a rows argument is rows the test wrote by hand: a literal, or a name
 * bound to one.
 *
 * The limit: rows that come out of a helper call (`rowsOf(contribution)`) are
 * trusted, because the finder does not follow the helper. A helper that builds
 * rows by hand would pass, so a producer test must build its rows from what
 * production wrote (a projection, a contribution, a realization), and a helper
 * there may only reshape those rows.
 */
function isHandWritten(argument: ts.Expression, source: ts.SourceFile): boolean {
  const rows = unwrap(argument);
  if (isLiteral(rows)) return true;
  return ts.isIdentifier(rows) && initializersOf(rows.text, source).some((initializer) => isLiteral(initializer));
}

/**
 * The value a signature property states, as JSON text: a string, a boolean, or
 * a code's name. A name the file binds reads as its string literal (anything
 * else bound to it reads as unresolvable); a name no declaration binds reads as
 * the name its import was exported under; `ns.NAME` on a namespace import reads
 * as NAME. Anything else (an unbound name included) reads as its own source
 * text in angle brackets, which no member's value equals.
 */
function stated(node: ts.Expression, source: ts.SourceFile, imports: Imports): string {
  const value = unwrap(node);
  const unresolved = `<${value.getText(source)}>`;
  if (ts.isStringLiteralLike(value)) return JSON.stringify(value.text);
  if (value.kind === ts.SyntaxKind.TrueKeyword || value.kind === ts.SyntaxKind.FalseKeyword) return value.getText(source);
  if (ts.isPropertyAccessExpression(value)) {
    return ts.isIdentifier(value.expression) && imports.namespaces.has(value.expression.text) ? JSON.stringify(value.name.text) : unresolved;
  }
  if (!ts.isIdentifier(value)) return unresolved;
  const bound = initializersOf(value.text, source);
  if (bound.length > 0) {
    const [only] = bound;
    return bound.length === 1 && only !== undefined && ts.isStringLiteralLike(only) ? JSON.stringify(only.text) : unresolved;
  }
  const original = imports.originals.get(value.text);
  return original === undefined ? unresolved : JSON.stringify(original);
}

/** A signature's fields as sorted `name=JSON` pairs, one text to compare. */
function signatureText(fields: Readonly<Record<string, string>>): string {
  return Object.entries(fields).map(([name, value]) => `${name}=${value}`).sort((left, right) => left.localeCompare(right)).join(', ');
}

/** A signature literal's fields, or undefined when the argument is no object literal of plain properties. */
function signatureOf(argument: ts.Expression | undefined, source: ts.SourceFile, imports: Imports): Record<string, string> | undefined {
  if (argument === undefined) return undefined;
  const literal = unwrap(argument);
  if (!ts.isObjectLiteralExpression(literal)) return undefined;
  const fields: Record<string, string> = {};
  for (const property of literal.properties) {
    if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) return undefined;
    fields[property.name.text] = stated(property.initializer, source, imports);
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

/** The test's callback, when its body is a block. */
function callbackOf(test: ts.CallExpression): (ts.ArrowFunction | ts.FunctionExpression) & { body: ts.Block } | undefined {
  for (const argument of test.arguments) {
    if ((ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) && ts.isBlock(argument.body)) {
      return argument as (ts.ArrowFunction | ts.FunctionExpression) & { body: ts.Block };
    }
  }
  return undefined;
}

/** Every `return` the body itself can take (never one of a nested function). */
function returnsIn(body: ts.Block): ts.ReturnStatement[] {
  const found: ts.ReturnStatement[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isReturnStatement(node)) found.push(node);
    if (!ts.isFunctionLike(node)) ts.forEachChild(node, visit);
  };
  ts.forEachChild(body, visit);
  return found;
}

/**
 * Why the test's own body skips it through its context: a call to the
 * context's `skip` (destructured, renamed or read off the context), or the
 * context handed on whole, where the finder cannot see what is called.
 */
function contextSkipReason(callback: ts.ArrowFunction | ts.FunctionExpression, source: ts.SourceFile): string | undefined {
  const [context] = callback.parameters;
  if (context === undefined) return undefined;
  if (ts.isObjectBindingPattern(context.name)) {
    const skips = new Set(context.name.elements
      .filter((element) => (element.propertyName ?? element.name).getText(source) === 'skip' && ts.isIdentifier(element.name))
      .map((element) => element.name.getText(source)));
    const called = callsIn(callback.body).find((call) => ts.isIdentifier(call.expression) && skips.has(call.expression.text));
    return called === undefined ? undefined : `a call to its context's skip: ${called.getText(source)}`;
  }
  const name = context.name.getText(source);
  let reason: string | undefined;
  const visit = (node: ts.Node): void => {
    if (reason !== undefined) return;
    if (ts.isIdentifier(node) && node.text === name && !isPropertyName(node)) {
      const { parent } = node;
      const read = ts.isPropertyAccessExpression(parent) && parent.expression === node;
      if (!read) reason = `its context handed on: ${parent.getText(source)}`;
      else if (parent.name.text === 'skip') reason = `a call to its context's skip: ${parent.parent.getText(source)}`;
    }
    ts.forEachChild(node, visit);
  };
  visit(callback.body);
  return reason;
}

/** Why a test is skipped, by its own chain, options or context, or by an enclosing describe's chain or options; or undefined. */
function testSkipped(test: ts.CallExpression, source: ts.SourceFile, imports: Imports): string | undefined {
  const own = chainSkipReason(chainOf(test.expression) ?? [], source, imports, true) ?? optionsSkipReason(test, source);
  if (own !== undefined) return `skipped by its own ${own}`;
  const callback = callbackOf(test);
  const context = callback === undefined ? undefined : contextSkipReason(callback, source);
  if (context !== undefined) return `skipped by ${context}`;
  for (let parent: ts.Node = test.parent; !ts.isSourceFile(parent); parent = parent.parent) {
    if (!ts.isCallExpression(parent)) continue;
    const chain = chainOf(parent.expression);
    if (chain?.[0]?.name !== DESCRIBE) continue;
    const reason = chainSkipReason(chain, source, imports, false) ?? optionsSkipReason(parent, source);
    if (reason !== undefined) return `skipped by an enclosing describe's ${reason}`;
  }
  return undefined;
}

/** The problems with one counted call: rows written by hand, a signature not the member's own. */
function callProblems(call: ts.CallExpression, member: AbsenceMember, source: ts.SourceFile, imports: Imports): string[] {
  const problems: string[] = [];
  const [rows, signatureArgument] = call.arguments;
  if (rows === undefined || isHandWritten(rows, source)) problems.push(`rows written by hand: ${call.getText(source)}`);
  const wanted = signatureText(Object.fromEntries(Object.entries(memberEntry(member).signature).map(([name, value]) => [name, JSON.stringify(value)])));
  const found = signatureOf(signatureArgument, source, imports);
  if (found === undefined || signatureText(found) !== wanted) problems.push(`signature is not ${member}'s own ${wanted}: ${signatureArgument?.getText(source) ?? '(none)'}`);
  return problems;
}

/** The problems with the test's calls: none counted, a return before every counted one, or no counted one with a clean call. */
function callsProblems(test: ts.CallExpression, member: AbsenceMember, source: ts.SourceFile, imports: Imports): string[] {
  const callback = callbackOf(test);
  const candidates = callback === undefined ? [] : absenceCallsIn(test, imports).filter((call) => counts(call, callback.body));
  if (candidates.length === 0) return [`no counted ${CALLEE} call: one must be a statement of the test body, or the direct argument of expect(...) there`];
  const returns = callback === undefined ? [] : returnsIn(callback.body);
  const counted = candidates.filter((call) => !returns.some((statement) => statement.getStart(source) < call.getStart(source)));
  if (counted.length === 0) return [`a return the body can take precedes every ${CALLEE} call: ${returns.map((statement) => statement.parent.getText(source)).join('; ')}`];
  const judged = counted.map((call) => callProblems(call, member, source, imports));
  return judged.some((problems) => problems.length === 0) ? [] : judged.flat();
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
  const imports = importsOf(source);
  const strays = straysIn(source, imports);
  if (strays.length > 0) return strays.map((stray) => `reaches ${CALLEE} other than by a resolved call at ${stray}`);
  const tests = callsIn(source).filter((call) => testTitle(call) === testName);
  const [test] = tests;
  if (tests.length !== 1 || test === undefined) return [`exactly one test titled '${testName}' wanted, found ${String(tests.length)}`];
  const skipped = testSkipped(test, source, imports);
  if (skipped !== undefined) return [skipped];
  return callsProblems(test, member, source, imports);
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
const SCANNED_EXTENSIONS = /\.[cm]?ts$/;
const NOT_SCANNED = new Set(['packages/cli/test/helpers/cache-differential.ts']);
const NOT_SCANNED_PACKAGE = 'utils';

/**
 * Every scanned TypeScript file (`.ts`, `.mts`, `.cts`): repository-relative, forward-slashed.
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
      const entries = readdirSync(treeDir, { recursive: true, encoding: 'utf-8' }).filter((name) => SCANNED_EXTENSIONS.test(name));
      files.push(...entries.map((entry) => `packages/${pkg.name}/${tree}/${toForwardSlash(entry)}`));
    }
  }
  return files.filter((file) => !NOT_SCANNED.has(file));
}

/**
 * Every `expectAbsenceCause` call outside `utils` and the harness, and every
 * other way a scanned file reaches it.
 *
 * @param repoRoot - The repository root
 * @returns One site per resolved call, and one `file:line: text` per stray
 */
export function lowerTierCallSites(repoRoot: string): { readonly sites: CallSite[]; readonly strays: string[] } {
  const sites: CallSite[] = [];
  const strays: string[] = [];
  for (const file of scannedFiles(repoRoot)) {
    const text = readFileSync(safePath.join(repoRoot, file), 'utf-8');
    if (!text.includes(CALLEE)) continue;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const imports = importsOf(source);
    strays.push(...straysIn(source, imports).map((stray) => `${file}:${stray}`));
    for (const call of absenceCallsIn(source, imports)) sites.push({ file, test: enclosingTest(call) });
  }
  return { sites, strays };
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
