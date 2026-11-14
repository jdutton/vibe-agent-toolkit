/**
 * The gate holds no state at module scope.
 *
 * The introspection gate's reference pointers are per connection: SQLite reuses virtual-table
 * addresses across connections, so a pointer memoized at module scope would admit, on a later
 * connection, whatever module landed at that address. The pointers live in each handle's private
 * gate state. This reads `sql-gate.ts`'s syntax tree and refuses any module-scope `let`/`var`, and
 * any module-scope collection a function writes after the module evaluated.
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
  /** Every module-scope `const` bound to a collection (`new Set/Map/WeakMap/WeakSet/Array` or `[...]`). */
  readonly collections: readonly string[];
  /** Every collection some function writes, as `name.method` or `name[]`. */
  readonly writtenAfterEvaluation: readonly string[];
}

/** Whether an initializer builds a collection. */
function isCollection(initializer: ts.Expression | undefined): boolean {
  if (initializer === undefined) return false;
  const inner = ts.isAsExpression(initializer) || ts.isSatisfiesExpression(initializer) ? initializer.expression : initializer;
  if (ts.isArrayLiteralExpression(inner)) return true;
  return ts.isNewExpression(inner) && ts.isIdentifier(inner.expression)
    && ['Set', 'Map', 'WeakMap', 'WeakSet', 'Array'].includes(inner.expression.text);
}

/** The writes inside function bodies to any of `names`. */
function writesIn(source: ts.SourceFile, names: ReadonlySet<string>): string[] {
  const writes: string[] = [];
  const visit = (node: ts.Node, inFunction: boolean): void => {
    const nowInFunction = inFunction || ts.isFunctionLike(node);
    if (nowInFunction && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const target = node.expression.expression;
      if (ts.isIdentifier(target) && names.has(target.text) && WRITING_METHODS.has(node.expression.name.text)) {
        writes.push(`${target.text}.${node.expression.name.text}`);
      }
    }
    if (nowInFunction && ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isElementAccessExpression(node.left) && ts.isIdentifier(node.left.expression) && names.has(node.left.expression.text)) {
      writes.push(`${node.left.expression.text}[]`);
    }
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
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const { flags } = statement.declarationList;
    const isConst = (flags & ts.NodeFlags.Const) !== 0;
    for (const declaration of statement.declarationList.declarations) {
      const name = declaration.name.getText(source);
      if (!isConst) mutableBindings.push(name);
      else if (isCollection(declaration.initializer)) collections.push(name);
    }
  }
  return { mutableBindings, collections, writtenAfterEvaluation: writesIn(source, new Set(collections)) };
}

const GATE_SOURCE = readFileSync(safePath.resolve(import.meta.dirname, '../src/sql-gate.ts'), 'utf8');

describe('sql-gate.ts holds no module-scope state', () => {
  it('declares no module-scope let or var, and writes no module-scope collection after evaluation', () => {
    const state = moduleStateOf(GATE_SOURCE);
    expect(state.mutableBindings).toStrictEqual([]);
    expect(state.writtenAfterEvaluation).toStrictEqual([]);
  });

  it('saw the module-scope collections it must leave alone, so the scan above is not vacuous', () => {
    expect(moduleStateOf(GATE_SOURCE).collections).toEqual(expect.arrayContaining([
      'QUERY_STATEMENT_KEYWORDS',
      'NAMED_PARAMETER_SIGILS',
      'STATEMENT_REFUSAL_RESULT_CODES',
    ]));
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
