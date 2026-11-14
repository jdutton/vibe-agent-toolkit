/**
 * The gate holds no state at module scope.
 *
 * The introspection gate's reference pointers are per connection: SQLite reuses virtual-table
 * addresses across connections, so a pointer memoized at module scope would admit, on a later
 * connection, whatever module landed at that address. The pointers live in each handle's private
 * gate state. This reads the syntax trees of the gate, the run database, and the shared lexer and
 * relation scan the gate reads statements with, and refuses any module-scope `let`/`var`; any
 * module-scope collection — a literal, or whatever a call or `new` returns — a function writes after
 * the module evaluated, by method, by key, by property or by `delete`, directly or through an alias;
 * and any module-scope collection whose declared type would let such a write compile.
 */

import { readFileSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/** Methods that write a Set, Map, array or WeakMap in place. */
const WRITING_METHODS: ReadonlySet<string> = new Set([
  'add', 'set', 'delete', 'clear', 'push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin',
]);

/** What the scan found at module scope. */
interface ModuleState {
  /** Every module-scope `let` or `var` binding. */
  readonly mutableBindings: readonly string[];
  /** Every module-scope `const` bound to a collection (`new Set/Map/WeakMap/WeakSet/Array`, `[...]` or `{...}`). */
  readonly collections: readonly string[];
  /** Every collection some function writes, as `name.method`, `name[]` or `name.property`. */
  readonly writtenAfterEvaluation: readonly string[];
  /** Every collection whose declared type would let a write compile. */
  readonly notTypedReadonly: readonly string[];
}

/** An initializer without its `as` or `satisfies` wrapper. */
function unwrapped(initializer: ts.Expression): ts.Expression {
  return ts.isAsExpression(initializer) || ts.isSatisfiesExpression(initializer) ? initializer.expression : initializer;
}

/** Whether an initializer builds a collection: a literal, or whatever any call or `new` returns. */
function isCollection(initializer: ts.Expression | undefined): boolean {
  if (initializer === undefined) return false;
  const inner = unwrapped(initializer);
  return ts.isArrayLiteralExpression(inner) || ts.isObjectLiteralExpression(inner)
    || ts.isCallExpression(inner) || ts.isNewExpression(inner);
}

/** The type names that admit no write. */
const READONLY_TYPE_NAMES: ReadonlySet<string> = new Set(['ReadonlySet', 'ReadonlyMap', 'ReadonlyArray', 'Readonly']);

/** Whether a declaration's type, or its `as const`, admits no write. */
function isTypedReadonly(declaration: ts.VariableDeclaration): boolean {
  const { type, initializer } = declaration;
  if (type !== undefined) {
    if (ts.isTypeOperatorNode(type) && type.operator === ts.SyntaxKind.ReadonlyKeyword) return true;
    return ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName) && READONLY_TYPE_NAMES.has(type.typeName.text);
  }
  return initializer !== undefined && ts.isAsExpression(initializer) && ts.isTypeReferenceNode(initializer.type)
    && initializer.type.typeName.getText() === 'const';
}

/** The assignment operators, compound ones included: each writes its left side. */
function isAssignment(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

/**
 * Each name a write may reach a collection through, with the suffix its label carries: `''` for a
 * collection itself, ` (TARGET)` for an alias of one.
 */
type TrackedNames = ReadonlyMap<string, string>;

/** A write's label when `target` is a key or property of a tracked name, else undefined. */
function writtenMember(target: ts.Expression, tracked: TrackedNames): string | undefined {
  if (ts.isElementAccessExpression(target) && ts.isIdentifier(target.expression) && tracked.has(target.expression.text)) {
    return `${target.expression.text}[]${tracked.get(target.expression.text) ?? ''}`;
  }
  if (ts.isPropertyAccessExpression(target) && ts.isIdentifier(target.expression) && tracked.has(target.expression.text)) {
    return `${target.expression.text}.${target.name.text}${tracked.get(target.expression.text) ?? ''}`;
  }
  return undefined;
}

/** The write one node makes through any tracked name, or undefined. */
function writeAt(node: ts.Node, tracked: TrackedNames): string | undefined {
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const target = node.expression.expression;
    if (ts.isIdentifier(target) && tracked.has(target.text) && WRITING_METHODS.has(node.expression.name.text)) {
      return `${target.text}.${node.expression.name.text}${tracked.get(target.text) ?? ''}`;
    }
  }
  if (ts.isBinaryExpression(node) && isAssignment(node.operatorToken.kind)) return writtenMember(node.left, tracked);
  if (ts.isDeleteExpression(node)) return writtenMember(node.expression, tracked);
  if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
    const counting = node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken;
    return counting ? writtenMember(node.operand, tracked) : undefined;
  }
  return undefined;
}

/** The alias a node binds — `const a = X` or `a = X` — as `[alias, X]`, or undefined. */
function aliasAt(node: ts.Node): readonly [string, string] | undefined {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
    const inner = unwrapped(node.initializer);
    return ts.isIdentifier(inner) ? [node.name.text, inner.text] : undefined;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && ts.isIdentifier(node.left) && ts.isIdentifier(unwrapped(node.right))) {
    return [node.left.text, (unwrapped(node.right) as ts.Identifier).text];
  }
  return undefined;
}

/**
 * The collections and every alias bound to one anywhere in the module, followed to a fixed point,
 * each alias labelled with the collection it reaches.
 */
function trackedNamesIn(source: ts.SourceFile, collections: readonly string[]): TrackedNames {
  const pairs: (readonly [string, string])[] = [];
  const collect = (node: ts.Node): void => {
    const alias = aliasAt(node);
    if (alias !== undefined) pairs.push(alias);
    ts.forEachChild(node, collect);
  };
  collect(source);
  const targetOf = new Map(collections.map((name) => [name, name]));
  for (let grew = true; grew;) {
    grew = false;
    for (const [alias, aliased] of pairs) {
      const target = targetOf.get(aliased);
      if (target !== undefined && !targetOf.has(alias)) {
        targetOf.set(alias, target);
        grew = true;
      }
    }
  }
  return new Map([...targetOf].map(([name, target]) => [name, name === target ? '' : ` (${target})`]));
}

/** The writes inside function bodies through any tracked name. */
function writesIn(source: ts.SourceFile, tracked: TrackedNames): string[] {
  const writes: string[] = [];
  const visit = (node: ts.Node, inFunction: boolean): void => {
    const nowInFunction = inFunction || ts.isFunctionLike(node);
    const write = nowInFunction ? writeAt(node, tracked) : undefined;
    if (write !== undefined) writes.push(write);
    ts.forEachChild(node, (child) => visit(child, nowInFunction));
  };
  visit(source, false);
  return writes;
}

/**
 * Scan one module's text for state held at module scope.
 *
 * @param text - The module's source
 * @returns What it holds
 */
function moduleStateOf(text: string): ModuleState {
  const source = ts.createSourceFile('module.ts', text, ts.ScriptTarget.ES2022, true);
  const mutableBindings: string[] = [];
  const collections: string[] = [];
  const notTypedReadonly: string[] = [];
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const { flags } = statement.declarationList;
    const isConst = (flags & ts.NodeFlags.Const) !== 0;
    for (const declaration of statement.declarationList.declarations) {
      const name = declaration.name.getText(source);
      if (!isConst) {
        mutableBindings.push(name);
      } else if (isCollection(declaration.initializer)) {
        collections.push(name);
        if (!isTypedReadonly(declaration)) notTypedReadonly.push(name);
      }
    }
  }
  return { mutableBindings, collections, writtenAfterEvaluation: writesIn(source, trackedNamesIn(source, collections)), notTypedReadonly };
}

/**
 * The modules a caller statement's text or connection passes through: the gate and the run
 * database, and the shared lexer and relation scan the gate reads the statement with.
 */
const GATED_MODULES: readonly (readonly [string, string])[] = [
  '../src/sql-gate.ts',
  '../src/run-database.ts',
  '../../resources/src/projection/statement-relations.ts',
  '../../resources/src/projection/sql-lexer.ts',
].map((file) => [file, readFileSync(safePath.resolve(import.meta.dirname, file), 'utf8')] as const);

/** The module-scope collections each scanned module holds, which the scan must see. */
const KNOWN_COLLECTIONS: Readonly<Record<string, readonly string[]>> = {
  '../src/sql-gate.ts': ['QUERY_STATEMENT_KEYWORDS', 'NAMED_PARAMETER_SIGILS', 'READ_OPEN_OPCODES', 'STATEMENT_REFUSAL_RESULT_CODES'],
  '../src/run-database.ts': [],
  '../../resources/src/projection/statement-relations.ts': ['CTE_PUNCTUATION', 'QUOTED_IDENTIFIER_CLOSERS'],
  '../../resources/src/projection/sql-lexer.ts': ['QUOTE_CLOSERS'],
};

/**
 * A memo appended to a scanned module: one built by a call and written by method, one built by
 * `new` and written through a local alias, neither typed read-only.
 */
const SEEDED_MEMO = [
  '',
  'const SEEDED_BY_CALL = makeMemo();',
  'const SEEDED_BY_NEW = new Map<string, string>();',
  'export function seededWrite(key: string): void {',
  '  SEEDED_BY_CALL.set(key, key);',
  '  const alias = SEEDED_BY_NEW;',
  '  alias.set(key, key);',
  '}',
].join('\n');

describe.each(GATED_MODULES)('%s holds no module-scope state', (file, text) => {
  it('declares no module-scope let or var, writes no module-scope collection after evaluation, and types each collection read-only', () => {
    const state = moduleStateOf(text);
    expect(state.mutableBindings).toStrictEqual([]);
    expect(state.writtenAfterEvaluation).toStrictEqual([]);
    expect(state.notTypedReadonly).toStrictEqual([]);
  });

  it('is not vacuous here: it sees the module\'s collections, and a memo seeded into the module', () => {
    expect(moduleStateOf(text).collections).toEqual(expect.arrayContaining([...(KNOWN_COLLECTIONS[file] ?? ['missing from KNOWN_COLLECTIONS'])]));
    const seeded = moduleStateOf(text + SEEDED_MEMO);
    expect(seeded.writtenAfterEvaluation).toStrictEqual(['SEEDED_BY_CALL.set', 'alias.set (SEEDED_BY_NEW)']);
    expect(seeded.notTypedReadonly).toStrictEqual(['SEEDED_BY_CALL', 'SEEDED_BY_NEW']);
  });
});

describe('the scan is not vacuous', () => {
  it('counts a module-scope value built by any call as a collection', () => {
    const seeded = moduleStateOf([
      'const A = makeMap();',
      'const B = Object.create(null);',
      "const C = ['a'].map((x) => x);",
      'const D = /x/u;',
      "const E = 'text';",
      'const F = (x: string): string => x;',
    ].join('\n'));
    expect(seeded.collections).toStrictEqual(['A', 'B', 'C']);
  });

  it('follows an alias declared at module scope or assigned in a function', () => {
    const seeded = moduleStateOf([
      'const TARGET: Record<string, string> = {};',
      'const ALIAS = TARGET;',
      'export function write(key: string): void {',
      '  ALIAS[key] = key;',
      '  let other;',
      '  other = TARGET;',
      '  other.extra = key;',
      '}',
    ].join('\n'));
    expect(seeded.writtenAfterEvaluation).toStrictEqual(['ALIAS[] (TARGET)', 'other.extra (TARGET)']);
  });

  it('refuses a seeded object-literal memo, written by key, by property and by delete', () => {
    const seeded = moduleStateOf([
      'const BY_KEY: Record<string, string> = {};',
      'const BY_NAME: { last?: string } = {};',
      'export function read(key: string): string | undefined {',
      '  BY_KEY[key] = key;',
      '  BY_NAME.last = key;',
      '  delete BY_KEY[key];',
      '  BY_KEY[key] ??= key;',
      '  return BY_NAME.last;',
      '}',
    ].join('\n'));
    expect(seeded.writtenAfterEvaluation).toStrictEqual(['BY_KEY[]', 'BY_NAME.last', 'BY_KEY[]', 'BY_KEY[]']);
    expect(seeded.notTypedReadonly).toStrictEqual(['BY_KEY', 'BY_NAME']);
  });

  it('refuses a module-scope collection whose declared type would let a write compile', () => {
    const seeded = moduleStateOf([
      'const A: string[] = [];',
      'const B = new Set<string>();',
      'const C: Map<string, string> = new Map();',
      'const D: readonly string[] = [];',
      'const E: ReadonlySet<string> = new Set();',
      'const F: ReadonlyMap<string, string> = new Map();',
      'const G: Readonly<Record<string, string>> = {};',
      "const H = ['a'] as const;",
    ].join('\n'));
    expect(seeded.notTypedReadonly).toStrictEqual(['A', 'B', 'C']);
  });

  it('refuses a seeded module memo, in each shape it can take', () => {
    const seeded = moduleStateOf([
      'let cached: string | undefined;',
      'const POINTERS = new Map<string, string>();',
      'const SEEN: string[] = [];',
      'export function read(key: string): string | undefined {',
      '  POINTERS.set(key, key);',
      '  SEEN[0] = key;',
      '  return cached;',
      '}',
    ].join('\n'));
    expect(seeded.mutableBindings).toStrictEqual(['cached']);
    expect(seeded.writtenAfterEvaluation).toStrictEqual(['POINTERS.set', 'SEEN[]']);
  });
});
