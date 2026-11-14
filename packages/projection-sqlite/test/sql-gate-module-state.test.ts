/**
 * The gate holds no state at module scope.
 *
 * The introspection gate's reference pointers are per connection: SQLite reuses virtual-table
 * addresses across connections, so a pointer memoized at module scope would admit, on a later
 * connection, whatever module landed at that address. The pointers live in each handle's private
 * gate state. This reads the syntax trees of `sql-gate.ts` and `run-database.ts` and refuses any
 * module-scope `let`/`var`; any module-scope collection — a Set, Map, array or object literal — a
 * function writes after the module evaluated, by method, by key, by property or by `delete`; and
 * any module-scope collection whose declared type would let such a write compile.
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

/** Whether an initializer builds a collection. */
function isCollection(initializer: ts.Expression | undefined): boolean {
  if (initializer === undefined) return false;
  const inner = unwrapped(initializer);
  if (ts.isArrayLiteralExpression(inner) || ts.isObjectLiteralExpression(inner)) return true;
  return ts.isNewExpression(inner) && ts.isIdentifier(inner.expression)
    && ['Set', 'Map', 'WeakMap', 'WeakSet', 'Array'].includes(inner.expression.text);
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

/** A write's label when `target` is a key or property of one of `names`, else undefined. */
function writtenMember(target: ts.Expression, names: ReadonlySet<string>): string | undefined {
  if (ts.isElementAccessExpression(target) && ts.isIdentifier(target.expression) && names.has(target.expression.text)) {
    return `${target.expression.text}[]`;
  }
  if (ts.isPropertyAccessExpression(target) && ts.isIdentifier(target.expression) && names.has(target.expression.text)) {
    return `${target.expression.text}.${target.name.text}`;
  }
  return undefined;
}

/** The write one node makes to any of `names`, or undefined. */
function writeAt(node: ts.Node, names: ReadonlySet<string>): string | undefined {
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const target = node.expression.expression;
    if (ts.isIdentifier(target) && names.has(target.text) && WRITING_METHODS.has(node.expression.name.text)) {
      return `${target.text}.${node.expression.name.text}`;
    }
  }
  if (ts.isBinaryExpression(node) && isAssignment(node.operatorToken.kind)) return writtenMember(node.left, names);
  if (ts.isDeleteExpression(node)) return writtenMember(node.expression, names);
  if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
    const counting = node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken;
    return counting ? writtenMember(node.operand, names) : undefined;
  }
  return undefined;
}

/** The writes inside function bodies to any of `names`. */
function writesIn(source: ts.SourceFile, names: ReadonlySet<string>): string[] {
  const writes: string[] = [];
  const visit = (node: ts.Node, inFunction: boolean): void => {
    const nowInFunction = inFunction || ts.isFunctionLike(node);
    const write = nowInFunction ? writeAt(node, names) : undefined;
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
  return { mutableBindings, collections, writtenAfterEvaluation: writesIn(source, new Set(collections)), notTypedReadonly };
}

/** The two modules that hold a caller statement's connection: the gate, and the run database. */
const GATED_MODULES: readonly (readonly [string, string])[] = ['sql-gate.ts', 'run-database.ts'].map((file) => [
  file,
  readFileSync(safePath.resolve(import.meta.dirname, '../src', file), 'utf8'),
] as const);

const GATE_SOURCE = readFileSync(safePath.resolve(import.meta.dirname, '../src/sql-gate.ts'), 'utf8');

describe.each(GATED_MODULES)('%s holds no module-scope state', (_file, text) => {
  it('declares no module-scope let or var, writes no module-scope collection after evaluation, and types each collection read-only', () => {
    const state = moduleStateOf(text);
    expect(state.mutableBindings).toStrictEqual([]);
    expect(state.writtenAfterEvaluation).toStrictEqual([]);
    expect(state.notTypedReadonly).toStrictEqual([]);
  });
});

describe('the scan is not vacuous', () => {
  it('saw the gate\'s module-scope collections it must leave alone', () => {
    expect(moduleStateOf(GATE_SOURCE).collections).toEqual(expect.arrayContaining([
      'QUERY_STATEMENT_KEYWORDS',
      'NAMED_PARAMETER_SIGILS',
      'READ_OPEN_OPCODES',
      'STATEMENT_REFUSAL_RESULT_CODES',
    ]));
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
