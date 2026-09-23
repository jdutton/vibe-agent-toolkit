import { existsSync, readdirSync, readFileSync } from 'node:fs';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { parseEnvBoolean } from '../src/env-flag.js';
import { resolveFromImportMeta } from '../src/fs.js';
import { safePath } from '../src/path.js';

describe('parseEnvBoolean', () => {
  it.each(['1', 'true', 'TRUE', 'True', 'yes', 'Yes', 'y', 'on', 'ON', ' true ', '\t1\n'])(
    '%j reads as true',
    (raw) => {
      expect(parseEnvBoolean(raw)).toBe(true);
    },
  );

  it.each(['0', 'false', 'FALSE', 'False', 'no', 'No', 'n', 'off', 'OFF', ' 0', '0 '])(
    '%j reads as false',
    (raw) => {
      expect(parseEnvBoolean(raw)).toBe(false);
    },
  );

  it.each([undefined, '', '   ', '2', '-1', 'maybe', 'null', 'undefined', 'truthy', 'onward'])(
    '%j is not a boolean, so it reads as undefined rather than guessing',
    (raw) => {
      expect(parseEnvBoolean(raw)).toBeUndefined();
    },
  );

  it('never returns a truthy non-boolean — callers branch on `=== undefined`', () => {
    for (const raw of ['1', '0', 'nonsense', undefined]) {
      const parsed = parseEnvBoolean(raw);
      expect(parsed === undefined || typeof parsed === 'boolean').toBe(true);
    }
  });
});

function tsFilesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.ts'))
    .map((entry) => safePath.join(dir, entry));
}

const PARSER_NAME = 'parseEnvBoolean';
/** A module the parser can be imported from: the package barrel, or (inside utils) its own file. */
const PARSER_MODULE = /^@vibe-agent-toolkit\/utils$|\/env-flag(?:\.js)?$/u;
const ENV_NAME = /^VAT_[A-Z0-9_]+$/u;
/** What a call whose argument no rule below can trace resolves to — never a table row. */
const UNRESOLVED = '<unresolved>';

interface ParserBindings {
  /** Local names bound to the parser: `parseEnvBoolean`, or an alias of it. */
  direct: Set<string>;
  /** Namespace imports (`import * as u`), through which `u.parseEnvBoolean(` calls it. */
  namespaces: Set<string>;
}

function parserBindings(source: ts.SourceFile): ParserBindings {
  const bindings: ParserBindings = { direct: new Set(), namespaces: new Set() };
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!PARSER_MODULE.test(statement.moduleSpecifier.text)) continue;
    const named = statement.importClause?.namedBindings;
    if (named === undefined) continue;
    if (ts.isNamespaceImport(named)) {
      bindings.namespaces.add(named.name.text);
      continue;
    }
    for (const element of named.elements) {
      if ((element.propertyName ?? element.name).text === PARSER_NAME) bindings.direct.add(element.name.text);
    }
  }
  return bindings;
}

function isParserCall(call: ts.CallExpression, bindings: ParserBindings): boolean {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return bindings.direct.has(callee.text);
  return (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === PARSER_NAME &&
    ts.isIdentifier(callee.expression) &&
    bindings.namespaces.has(callee.expression.text)
  );
}

function collect<T extends ts.Node>(root: ts.Node, pick: (node: ts.Node) => node is T): T[] {
  const found: T[] = [];
  const visit = (node: ts.Node): void => {
    if (pick(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

/**
 * The `VAT_*` variables an expression reads. It follows a string literal, an
 * `env['X']` / `env.X` access, a variable's initializer, and a function
 * parameter back to the argument at every call of that function in the same
 * file — the shapes the real call sites use. Anything else contributes nothing;
 * a call that resolves to nothing is reported as {@link UNRESOLVED}, so the test
 * fails instead of dropping the row.
 */
function envNamesOf(expr: ts.Node, source: ts.SourceFile, seen: Set<ts.Node>): Set<string> {
  const names = new Set<string>();
  if (seen.has(expr)) return names;
  seen.add(expr);
  const add = (node: ts.Node): void => {
    for (const name of envNamesOf(node, source, seen)) names.add(name);
  };
  if (ts.isStringLiteralLike(expr)) {
    if (ENV_NAME.test(expr.text)) names.add(expr.text);
  } else if (ts.isPropertyAccessExpression(expr) && ENV_NAME.test(expr.name.text)) {
    names.add(expr.name.text);
  } else if (ts.isIdentifier(expr)) {
    for (const origin of identifierOrigins(expr.text, source)) add(origin);
  } else {
    ts.forEachChild(expr, add);
  }
  return names;
}

/** The expressions an identifier can hold: its initializers, and the arguments passed for it as a parameter. */
function identifierOrigins(identifier: string, source: ts.SourceFile): ts.Expression[] {
  const origins: ts.Expression[] = [];
  for (const declaration of collect(source, ts.isVariableDeclaration)) {
    if (ts.isIdentifier(declaration.name) && declaration.name.text === identifier && declaration.initializer) {
      origins.push(declaration.initializer);
    }
  }
  const calls = collect(source, ts.isCallExpression);
  for (const fn of collect(source, ts.isFunctionDeclaration)) {
    const index = fn.parameters.findIndex((p) => ts.isIdentifier(p.name) && p.name.text === identifier);
    const fnName = fn.name?.text;
    if (index < 0 || fnName === undefined) continue;
    for (const call of calls) {
      const argument = call.arguments[index];
      if (ts.isIdentifier(call.expression) && call.expression.text === fnName && argument) origins.push(argument);
    }
  }
  return origins;
}

/** Every `(file, variable)` pair a source file passes to the parser, as `file | VAR`. */
function callerPairs(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const bindings = parserBindings(source);
  if (bindings.direct.size === 0 && bindings.namespaces.size === 0) return [];
  const pairs: string[] = [];
  for (const call of collect(source, ts.isCallExpression)) {
    if (!isParserCall(call, bindings)) continue;
    const argument = call.arguments[0];
    const names = argument === undefined ? new Set<string>() : envNamesOf(argument, source, new Set());
    if (names.size === 0) names.add(UNRESOLVED);
    for (const name of names) pairs.push(`${file} | ${name}`);
  }
  return pairs;
}

const byName = (a: string, b: string): number => a.localeCompare(b);

describe('callerPairs — the scanner the caller-table test trusts', () => {
  it('sees an aliased import, a namespace import, a constant, a parameter and an unresolvable argument', () => {
    const text = [
      `import { parseEnvBoolean as readFlag } from '@vibe-agent-toolkit/utils';`,
      `import * as u from '@vibe-agent-toolkit/utils';`,
      `const KEY = 'VAT_A';`,
      `function read(raw: string | undefined) { return readFlag(raw); }`,
      `read(process.env['VAT_B']);`,
      `readFlag(process.env[KEY]);`,
      `u.parseEnvBoolean(process.env.VAT_C);`,
      `readFlag(somethingElse());`,
    ].join('\n');

    expect(callerPairs('x.ts', text).sort(byName)).toEqual(
      ['x.ts | <unresolved>', 'x.ts | VAT_A', 'x.ts | VAT_B', 'x.ts | VAT_C'].sort(byName),
    );
  });

  it('ignores a file that only mentions the parser in text', () => {
    expect(callerPairs('x.ts', '// parseEnvBoolean(process.env.VAT_A)\nexport const s = "parseEnvBoolean(";')).toEqual([]);
  });
});

/**
 * The caller table in `env-flag.ts`'s docblock is the record of which way each
 * call site reads `undefined` — the one decision this parser refuses to make. A
 * hand-kept table rots silently, so it is asserted BOTH ways against the source,
 * per (file, variable) rather than per file: a caller that starts reading a
 * second variable, or stops reading one, turns this red. Calls are found through
 * the import binding, so an aliased or namespace import cannot hide one.
 */
describe('parseEnvBoolean caller table', () => {
  const packagesDir = resolveFromImportMeta(import.meta.url, '..', '..');
  const TABLE_ROW = /^ \* \| `([^`]+)` \| `([^`]+)` \|/gmu;

  it('names every (src file, variable) that reaches parseEnvBoolean, and no other', () => {
    const callers = new Set<string>();
    for (const pkg of readdirSync(packagesDir)) {
      const srcDir = safePath.join(packagesDir, pkg, 'src');
      if (!existsSync(srcDir)) continue;
      for (const file of tsFilesUnder(srcDir)) {
        const relative = `${pkg}/${safePath.relative(srcDir, file)}`;
        for (const pair of callerPairs(relative, readFileSync(file, 'utf8'))) callers.add(pair);
      }
    }
    const docblock = readFileSync(safePath.join(packagesDir, 'utils', 'src', 'env-flag.ts'), 'utf8');
    const rows = new Set([...docblock.matchAll(TABLE_ROW)].map(([, file = '', name = '']) => `${file} | ${name}`));

    expect(callers.size).toBeGreaterThan(0);
    expect([...rows].sort(byName)).toEqual([...callers].sort(byName));
  });
});
