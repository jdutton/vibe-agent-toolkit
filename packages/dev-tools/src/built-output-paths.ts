/**
 * Evaluates a test file's path expressions to where they start and the
 * segments they name, for `built-output-scan.ts`.
 *
 * A value is a set of alternatives (a ternary, a parameter given different
 * arguments), each a list of pieces: text, `null` for a value not known
 * statically, or an anchor — the repository root, a temporary directory, or a
 * workspace package's root. Names resolve lexically through the compiler's
 * checker. A `const` is followed to its initializer, in this module or, by an
 * import from a relative specifier, in another. A function call is followed to
 * its returns, and a parameter to the arguments at every call site, in any
 * scanned module. A `let` is any value the module gives it, and unknown when
 * one is a compound assignment (`+=`).
 */

import { readFileSync } from 'node:fs';

import { safePath, toForwardSlashAnyPlatform } from '@vibe-agent-toolkit/utils';
import ts from 'typescript';

/** Where an evaluated path starts. */
export type Anchor =
  | { readonly anchor: 'repo' }
  | { readonly anchor: 'temp' }
  | { readonly anchor: 'package'; readonly dir: string }
  /** An absolute literal (`/project`, `C:\\x`): a fixed location outside any checkout. */
  | { readonly anchor: 'absolute' };
/** One piece of an evaluated path: text, a value not known statically (`null`), or where it starts. */
export type Piece = string | null | Anchor;
export type Pieces = readonly Piece[];
/** The alternatives an expression may evaluate to. */
export type Values = readonly Pieces[];

const HOLE: Values = [[null]];
const REPO: Anchor = { anchor: 'repo' };
const TEMP: Values = [[{ anchor: 'temp' }]];
const ABSOLUTE: Anchor = { anchor: 'absolute' };
/** Authored text that names an absolute location: POSIX root or a drive letter. */
const ABSOLUTE_TEXT = /^(?:\/|[A-Za-z]:[\\/])/;
/** Past this many `export { … } from` hops an import is treated as unknown. */
const MAX_REEXPORT_HOPS = 16;
/** Past this many alternatives a value is treated as unknown. */
const MAX_ALTERNATIVES = 256;

/** Callees whose arguments are joined into ONE path, by the name they are imported as (`resolve as pathResolve` is `resolve`). */
const PATH_JOIN = new Set(['join', 'resolve']);
/** Calls that hand their first argument through as the same path. */
const PASS_THROUGH = new Set(['toForwardSlash', 'fileURLToPath', 'pathToFileURL', 'String', 'normalize', 'realpathSync', 'realpath', 'mkdirSyncReal', 'normalizePath']);
/** Calls whose result is a fresh temporary directory, or a handle on one (`@vibe-agent-toolkit/utils/testing`). */
const TEMP_SOURCES = new Set([
  'tmpdir',
  'normalizedTmpdir',
  'mkdtemp',
  'mkdtempSync',
  'createTempDir',
  'createTempDirAsync',
  'tempDirTracker',
  'scratchTmpdirEnv',
  'registerScratchTmpdir',
  'setupAsyncTempDirSuite',
  'setupSyncTempDirSuite',
  // A path vouched for, and checked at runtime, as inside a temp dir the test owns.
  'underTemp',
]);

/** The name a call is made through: `safePath.join` → `join`, `pathResolve` → `pathResolve`. */
export function calleeName(call: ts.CallExpression): string | undefined {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return undefined;
}

/** Whether a value has alternatives and every one starts in a temporary directory. */
function isTemp(values: Values): boolean {
  return values.length > 0 && values.every((pieces) => pieces.some((piece) => piece !== null && typeof piece === 'object' && piece.anchor === 'temp'));
}

/** `''`, `undefined` or `null`: a `let`'s initial value before the real one is assigned. */
function isPlaceholder(node: ts.Expression): boolean {
  if (ts.isStringLiteral(node)) return node.text === '';
  return node.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(node) && node.text === 'undefined');
}

/** A literal's pieces: absolute text starts at {@link ABSOLUTE}. */
export function literalPieces(literal: string): Pieces {
  return ABSOLUTE_TEXT.test(literal) ? [ABSOLUTE, literal] : [literal];
}

/** Every combination of `a` then `b`. */
function concat(a: Values, b: Values): Values {
  if (a.length * b.length > MAX_ALTERNATIVES) return HOLE;
  return a.flatMap((left) => b.map((right) => [...left, ...right]));
}

/** Either value: alternatives naming the same location count once. No alternatives at all is a cycle cut short (see `guarded`). */
function union(values: readonly Values[]): Values {
  const distinct = new Map<string, Pieces>();
  for (const pieces of values.flat()) distinct.set(JSON.stringify(canonical(pieces)), pieces);
  return distinct.size > MAX_ALTERNATIVES ? HOLE : [...distinct.values()];
}

/** Pieces in normal form: an anchor, then the normalised segments. */
function canonical(pieces: Pieces): Pieces {
  const { anchor, segments } = locate(pieces);
  return [...(anchor === undefined ? [] : [anchor]), ...segments.flatMap((segment, index) => (index === 0 ? [segment] : ['/', segment]))];
}

/** A name bound by an import: which module and which of its exports. */
interface ImportBinding {
  readonly specifier: string;
  /** The export's name, or `*` for a namespace import. */
  readonly name: string;
}

/** A function-like declaration evaluated for its returns or its parameters. */
type FunctionNode = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration | ts.GetAccessorDeclaration;

function isFunctionNode(node: ts.Node | undefined): node is FunctionNode {
  return (
    node !== undefined &&
    (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node))
  );
}

/** Whether an object literal's member is named `name`. */
function isNamed(member: ts.ObjectLiteralElementLike, name: string): boolean {
  return member.name !== undefined && (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) && member.name.text === name;
}

/** One module: its syntax tree, its checker, and the bindings it imports and exports. */
export class Module {
  readonly imports = new Map<string, ImportBinding>();
  /** Exported name → local name, for `export { a as b }`. */
  readonly exported = new Map<string, string>();
  /** Exported name → where it is re-exported from. */
  readonly reexports = new Map<string, ImportBinding>();
  readonly dir: string;

  constructor(
    readonly file: ts.SourceFile,
    readonly rel: string,
    readonly checker: ts.TypeChecker,
  ) {
    this.dir = rel.slice(0, rel.lastIndexOf('/'));
    for (const statement of file.statements) {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) this.readImport(statement.importClause, statement.moduleSpecifier.text);
      else if (ts.isExportDeclaration(statement)) this.readExport(statement);
    }
  }

  private readImport(clause: ts.ImportClause | undefined, specifier: string): void {
    if (clause === undefined) return;
    if (clause.name !== undefined) this.imports.set(clause.name.text, { specifier, name: 'default' });
    const bindings = clause.namedBindings;
    if (bindings === undefined) return;
    if (ts.isNamespaceImport(bindings)) {
      this.imports.set(bindings.name.text, { specifier, name: '*' });
      return;
    }
    for (const element of bindings.elements) this.imports.set(element.name.text, { specifier, name: (element.propertyName ?? element.name).text });
  }

  private readExport(statement: ts.ExportDeclaration): void {
    if (statement.exportClause === undefined || !ts.isNamedExports(statement.exportClause)) return;
    const from = statement.moduleSpecifier !== undefined && ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : undefined;
    for (const element of statement.exportClause.elements) {
      const local = (element.propertyName ?? element.name).text;
      if (from === undefined) this.exported.set(element.name.text, local);
      else this.reexports.set(element.name.text, { specifier: from, name: local });
    }
  }

  /** The top-level declaration of `name`: a function, or a variable's declaration. */
  topLevel(name: string): ts.FunctionDeclaration | ts.VariableDeclaration | undefined {
    for (const statement of this.file.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return statement;
      if (ts.isVariableStatement(statement)) {
        const found = statement.declarationList.declarations.find((decl) => ts.isIdentifier(decl.name) && decl.name.text === name);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  }

  /** `<file>:<line>` of a node. */
  siteOf(node: ts.Node): string {
    const { line } = this.file.getLineAndCharacterOfPosition(node.getStart(this.file));
    return `${this.rel}:${(line + 1).toString()}`;
  }
}

/** A program over files parsed for syntax and names only: no lib, no module resolution. */
export function nameOnlyProgram(paths: readonly string[]): ts.Program {
  return ts.createProgram({ rootNames: paths, options: { noResolve: true, noLib: true, allowJs: true, types: [], noEmit: true } });
}

/** Parameters bound to the arguments of the calls being evaluated. */
type Bound = ReadonlyMap<ts.ParameterDeclaration, Values>;
/** A function found for a callee, with the arguments in force where it was found. */
interface FoundFunction {
  readonly module: Module;
  readonly fn: FunctionNode;
  readonly bound: Bound;
}
/** An object literal a value traces to, with the arguments in force where it was built. */
interface FoundLiteral {
  readonly module: Module;
  readonly literal: ts.ObjectLiteralExpression;
  readonly bound: Bound;
}
/** An object member found by name, with the arguments in force where its literal was built. */
interface FoundMember {
  readonly module: Module;
  readonly member: ts.ObjectLiteralElementLike;
  readonly bound: Bound;
}
/**
 * An object or function the scan cannot see inside (a parameter it cannot
 * follow, a dependency's result). A member of it, or its result, is TEMP when
 * the whole is a temp handle and unknown otherwise.
 */
interface Opaque {
  readonly opaque: ts.Expression;
  readonly module: Module;
  readonly bound: Bound;
}

function isOpaque<T extends object>(found: T | Opaque): found is Opaque {
  return 'opaque' in found;
}

/** A call of a function, in the module it is made in. */
interface CallSite {
  readonly module: Module;
  readonly call: ts.CallExpression;
}

/** A reference to a function: where it is named, in which module. */
interface Reference {
  readonly module: Module;
  readonly node: ts.Identifier;
}

/** The expression an object member holds: its initializer, or a shorthand's name. */
function memberExpression(member: ts.ObjectLiteralElementLike): ts.Expression | undefined {
  if (ts.isPropertyAssignment(member)) return member.initializer;
  return ts.isShorthandPropertyAssignment(member) ? member.name : undefined;
}

/** The function a declaration declares: itself, or a variable's initializer. */
function declaredFunction(decl: ts.Declaration): ts.Node | undefined {
  if (isFunctionNode(decl)) return decl;
  return ts.isVariableDeclaration(decl) ? decl.initializer : undefined;
}

/** The name a function is called by: a declaration's, or the variable it initialises. */
function functionName(fn: FunctionNode): ts.Identifier | undefined {
  if (ts.isFunctionDeclaration(fn)) return fn.name;
  return ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name) ? fn.parent.name : undefined;
}

/** A function that is an object literal's member (`fixture(r) {…}`, `fixture: (r) => …`): the literal and the member's name. */
function memberSlot(fn: FunctionNode): { literal: ts.Node; name: ts.PropertyName } | undefined {
  if (ts.isMethodDeclaration(fn)) return { literal: fn.parent, name: fn.name };
  const holder = fn.parent;
  return ts.isPropertyAssignment(holder) && holder.initializer === (fn as ts.Node) ? { literal: holder.parent, name: holder.name } : undefined;
}

/** Add `item` to the list under `key`. */
function appendTo<K, V>(index: Map<K, V[]>, key: K, item: V): void {
  const list = index.get(key);
  if (list === undefined) index.set(key, [item]);
  else list.push(item);
}

/** Reads modules lazily and evaluates expressions in them. */
export class PathEvaluator {
  private readonly modules = new Map<string, Module | undefined>();
  private readonly active = new Set<ts.Node>();
  private readonly memo = new Map<ts.Node, Values>();
  private readonly literalMemo = new Map<ts.Node, Array<FoundLiteral | Opaque>>();
  private readonly memberCallMemo = new Map<ts.ObjectLiteralExpression, Map<string, CallSite[]>>();
  /** Each module's identifiers by text: one walk per module, not one per reference lookup. */
  private readonly identifierIndex = new Map<Module, Map<string, ts.Identifier[]>>();
  /** The arguments of the calls being evaluated, by parameter: a call's returns are read with its own arguments. */
  private bound: Bound = new Map();
  private importIndex: Map<string, Reference[]> | undefined;
  private propertyCallIndex: Map<string, CallSite[]> | undefined;
  /** Whether a cycle was cut short under the evaluation in progress: its value is partial, so it is not kept. */
  private cut = false;

  /**
   * @param repoRoot - Absolute repository root
   * @param known - Every repo-relative file a relative specifier may name
   * @param packages - Workspace package name → its directory under `packages/`
   * @param scanned - The scanned modules, already parsed in one program
   */
  constructor(
    private readonly repoRoot: string,
    private readonly known: ReadonlySet<string>,
    private readonly packages: ReadonlyMap<string, string>,
    private readonly scanned: ReadonlyMap<string, Module>,
  ) {}

  /** The module of a repo-relative file, parsing one outside the scanned set on first use. */
  moduleOf(rel: string): Module | undefined {
    const found = this.scanned.get(rel);
    if (found !== undefined) return found;
    if (!this.modules.has(rel)) this.modules.set(rel, this.known.has(rel) ? this.parseAlone(rel) : undefined);
    return this.modules.get(rel);
  }

  private parseAlone(rel: string): Module | undefined {
    const path = safePath.join(this.repoRoot, rel);
    const program = nameOnlyProgram([path]);
    const file = program.getSourceFile(path) ?? ts.createSourceFile(rel, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
    return new Module(file, rel, program.getTypeChecker());
  }

  /** The repo-relative module a relative specifier names, among known files. */
  resolveModule(from: string, specifier: string): string | undefined {
    if (!specifier.startsWith('.')) return undefined;
    const target = safePath.join(from.slice(0, from.lastIndexOf('/')), specifier);
    const stem = target.replace(/\.[cm]?jsx?$/, '');
    const candidates = [target, `${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.cts`, `${target}.ts`, `${target}/index.ts`];
    return candidates.find((candidate) => this.known.has(candidate));
  }

  /** The pieces a module specifier names: file-relative, a workspace package's file, or nothing (a dependency). */
  specifierPieces(module: Module, specifier: string): Pieces | undefined {
    if (specifier.startsWith('.')) return [REPO, module.dir, '/', specifier];
    for (const [name, dir] of this.packages) {
      if (specifier === name || specifier.startsWith(`${name}/`)) return [{ anchor: 'package', dir }, specifier.slice(name.length)];
    }
    return undefined;
  }

  /** The alternatives `node` evaluates to. */
  values(module: Module, node: ts.Expression): Values {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [literalPieces(node.text)];
    if (ts.isTemplateExpression(node)) {
      return node.templateSpans.reduce<Values>((sum, span) => concat(concat(sum, this.values(module, span.expression)), [[span.literal.text]]), [literalPieces(node.head.text)]);
    }
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isAwaitExpression(node) || ts.isSatisfiesExpression(node)) {
      return this.values(module, node.expression);
    }
    if (ts.isBinaryExpression(node)) return this.binary(module, node);
    if (ts.isConditionalExpression(node)) return union([this.values(module, node.whenTrue), this.values(module, node.whenFalse)]);
    if (ts.isIdentifier(node)) return this.name(module, node);
    if (ts.isPropertyAccessExpression(node)) return this.member(module, node);
    if (ts.isNewExpression(node)) return this.newUrl(module, node);
    if (ts.isCallExpression(node)) return this.call(module, node);
    return HOLE;
  }

  /**
   * A call that builds one path from its arguments — `join`, `resolve`,
   * `resolveFromImportMeta(url, ...segments)` — or `undefined` for any other call.
   */
  pathCall(module: Module, call: ts.CallExpression): Values | undefined {
    const name = this.callName(module, call);
    if (PATH_JOIN.has(name)) return this.joined(module, call.arguments, name === 'resolve');
    if (name !== 'resolveFromImportMeta') return undefined;
    const [url, ...segments] = call.arguments;
    if (url === undefined) return HOLE;
    const fileDir = concat(this.values(module, url), [['/', '..']]);
    return segments.length === 0 ? this.values(module, url) : concat(concat(fileDir, [['/']]), this.joined(module, segments, false));
  }

  /** The alternatives of joined path arguments, segments separated by `/`; only `resolve` restarts at an absolute one. */
  private joined(module: Module, args: readonly ts.Expression[], restarts: boolean): Values {
    return args.reduce<Values>((sum, arg, index) => {
      const values = this.values(module, arg);
      if (index === 0) return values;
      return concat(concat(sum, [['/']]), restarts ? values : values.map((pieces) => pieces.filter((piece) => piece !== ABSOLUTE)));
    }, [[]]);
  }

  private binary(module: Module, node: ts.BinaryExpression): Values {
    const operator = node.operatorToken.kind;
    if (operator === ts.SyntaxKind.PlusToken) return concat(this.values(module, node.left), this.values(module, node.right));
    if (operator === ts.SyntaxKind.QuestionQuestionToken || operator === ts.SyntaxKind.BarBarToken) {
      return union([this.values(module, node.left), this.values(module, node.right)]);
    }
    return HOLE;
  }

  private newUrl(module: Module, node: ts.NewExpression): Values {
    if (!ts.isIdentifier(node.expression) || node.expression.text !== 'URL') return HOLE;
    const [path, base] = node.arguments ?? [];
    if (path === undefined) return HOLE;
    if (base === undefined) return this.values(module, path);
    // A path resolves against its base's directory: the base itself when it ends in `/`.
    const baseDir = this.values(module, base).map((pieces) => {
      const last = pieces.at(-1);
      return typeof last === 'string' && last.endsWith('/') ? pieces : [...pieces, '/', '..'];
    });
    return concat(concat(baseDir, [['/']]), this.values(module, path));
  }

  private member(module: Module, node: ts.PropertyAccessExpression): Values {
    const property = node.name.text;
    if (ts.isMetaProperty(node.expression)) {
      if (property === 'dirname') return [[REPO, module.dir]];
      return property === 'url' || property === 'filename' ? [[REPO, module.rel]] : HOLE;
    }
    if (property === 'href' || property === 'pathname') return this.values(module, node.expression);
    if (ts.isIdentifier(node.expression)) {
      const binding = module.imports.get(node.expression.text);
      if (binding?.name === '*') return this.imported(module, { specifier: binding.specifier, name: property });
    }
    return this.property(module, node.expression, property);
  }

  /** `object.property`: its value in every object literal the object traces to. */
  private property(module: Module, object: ts.Expression, property: string): Values {
    const traced = this.objectLiterals(module, object);
    if (traced.length === 0) return this.opaqueValue({ opaque: object, module, bound: this.bound });
    return union(traced.flatMap((found) => (isOpaque(found) ? [this.opaqueValue(found)] : this.members(found, property).map((member) => this.memberValue(member, property)))));
  }

  /** A member of something the scan cannot see inside: TEMP when the whole is a temp handle (`suite.tempDir`). */
  private opaqueValue({ opaque, module, bound }: Opaque): Values {
    return this.withBound(bound, () => (isTemp(this.values(module, opaque)) ? TEMP : HOLE));
  }

  /** The value of one object member. */
  private memberValue(found: FoundMember | Opaque, property: string): Values {
    if (isOpaque(found)) return this.opaqueValue(found);
    const { module, member, bound } = found;
    return this.withBound(bound, () => {
      if (ts.isShorthandPropertyAssignment(member)) return this.name(module, member.name);
      if (ts.isGetAccessorDeclaration(member)) return this.returns(module, member);
      if (!ts.isPropertyAssignment(member)) return HOLE;
      // A placeholder (`tempDir: ''`) is filled in later by `holder.tempDir = …`.
      const { initializer } = member;
      return isPlaceholder(initializer) && ts.isObjectLiteralExpression(member.parent)
        ? this.guarded(member, () => this.memberAssigned(module, member.parent, property))
        : this.values(module, initializer);
    });
  }

  /**
   * The member named `name` of an object literal: the last one written wins, and
   * a spread (`{ ...base, fixture }`) supplies it when nothing after it does.
   */
  private members(found: FoundLiteral, name: string): Array<FoundMember | Opaque> {
    const { module, literal, bound } = found;
    for (const member of [...literal.properties].reverse()) {
      if (ts.isSpreadAssignment(member)) {
        const spread = this.withBound(bound, () => this.objectLiterals(module, member.expression));
        const supplied = spread.flatMap((inner) => (isOpaque(inner) ? [inner] : this.members(inner, name)));
        if (supplied.length > 0) return supplied;
      } else if (isNamed(member, name)) {
        return [{ module, member, bound }];
      }
    }
    return [];
  }

  /** The name a call is made through, seen through an import alias (`dirname as pathDirname` → `dirname`). */
  callName(module: Module, call: ts.CallExpression): string {
    const binding = ts.isIdentifier(call.expression) ? module.imports.get(call.expression.text) : undefined;
    return binding === undefined || binding.name === '*' || binding.name === 'default' ? (calleeName(call) ?? '') : binding.name;
  }

  private call(module: Module, call: ts.CallExpression): Values {
    const name = this.callName(module, call);
    const [first] = call.arguments;
    if (TEMP_SOURCES.has(name)) return TEMP;
    // The working directory: a relative path, which the scan reads from the test's package.
    if (name === 'cwd' && ts.isPropertyAccessExpression(call.expression) && call.expression.expression.getText(module.file) === 'process') return [['.']];
    if (PASS_THROUGH.has(name) && first !== undefined) return this.values(module, first);
    if (name === 'dirname' && first !== undefined) return concat(this.values(module, first), [['/', '..']]);
    const path = this.pathCall(module, call);
    if (path !== undefined) return path;
    const functions = this.functionsOf(module, call.expression);
    // Calling a temp-dir handle (`tracker.create()`, `getTempDir()`) yields a temp dir.
    if (functions.length === 0) return this.opaqueValue({ opaque: call.expression, module, bound: this.bound });
    return union(functions.map((found) => (isOpaque(found) ? this.opaqueValue(found) : this.returnsAt(module, call, found))));
  }

  /**
   * Run `evaluate` once per node at a time. Re-entering a node adds no
   * alternatives (`r.root` handed back to the function that made `r` adds
   * nothing new), so a cycle is no alternatives, and a value reached
   * through one is partial and not kept. A value with no alternatives at all
   * is unknown to the scan.
   */
  private guarded(node: ts.Node, evaluate: () => Values): Values {
    // A value read under a call's arguments belongs to that call; only an unbound one is kept.
    const memoize = this.bound.size === 0;
    const known = memoize ? this.memo.get(node) : undefined;
    if (known !== undefined) return known;
    if (this.active.has(node)) {
      this.cut = true;
      return [];
    }
    const outerCut = this.cut;
    this.cut = false;
    this.active.add(node);
    try {
      const values = evaluate();
      if (memoize && !this.cut) this.memo.set(node, values);
      return values;
    } finally {
      this.active.delete(node);
      this.cut ||= outerCut;
    }
  }

  private name(module: Module, id: ts.Identifier): Values {
    if (id.text === '__dirname') return [[REPO, module.dir]];
    if (id.text === '__filename') return [[REPO, module.rel]];
    const decl = this.declarationOf(module, id);
    if (decl === undefined) return HOLE;
    return this.guarded(decl, () => this.declared(module, decl));
  }

  /** Where a name is declared, seen through a shorthand property. */
  private declarationOf(module: Module, id: ts.Identifier): ts.Declaration | undefined {
    const symbol = ts.isShorthandPropertyAssignment(id.parent) ? module.checker.getShorthandAssignmentValueSymbol(id.parent) : module.checker.getSymbolAtLocation(id);
    return symbol?.declarations?.[0];
  }

  private declared(module: Module, decl: ts.Declaration): Values {
    if (ts.isImportSpecifier(decl) || ts.isImportClause(decl) || ts.isNamespaceImport(decl)) {
      const local = decl.name?.text ?? '';
      const binding = module.imports.get(local);
      return binding === undefined ? HOLE : this.imported(module, binding);
    }
    if (ts.isVariableDeclaration(decl)) return this.variable(module, decl);
    if (ts.isBindingElement(decl)) return this.destructured(module, decl);
    if (ts.isParameter(decl)) return this.parameter(module, decl);
    return HOLE;
  }

  private variable(module: Module, decl: ts.VariableDeclaration): Values {
    const isConst = decl.parent.getFirstToken(module.file)?.kind === ts.SyntaxKind.ConstKeyword;
    if (isConst) return decl.initializer === undefined ? HOLE : this.values(module, decl.initializer);
    // A `let` holds whichever value it was last given: any of them.
    return this.anyGiven(module, [...(decl.initializer === undefined ? [] : [decl.initializer]), ...this.assignmentsOf(module, decl, undefined)]);
  }

  /**
   * Any of the values given — unknown when nothing real is given. A
   * placeholder (`''`, `undefined`, `null`: the value before the real one, or
   * after a reset) gives nothing.
   */
  private anyGiven(module: Module, given: readonly ts.Expression[]): Values {
    const real = given.filter((value) => !isPlaceholder(value));
    return real.length === 0 ? HOLE : union(real.map((value) => this.values(module, value)));
  }

  /** A placeholder member of an object literal held by a variable: the values `holder.member = …` gives it. */
  private memberAssigned(module: Module, literal: ts.ObjectLiteralExpression, property: string): Values {
    const holder = literal.parent;
    if (!ts.isVariableDeclaration(holder)) return HOLE;
    return this.anyGiven(module, this.assignmentsOf(module, holder, property));
  }

  /**
   * Every `name = value` (or, given `property`, `name.property = value`) in the
   * module that assigns this declaration. A compound assignment (`+=`, `??=`)
   * is returned whole, which evaluates to unknown.
   */
  private assignmentsOf(module: Module, decl: ts.VariableDeclaration, property: string | undefined): ts.Expression[] {
    if (!ts.isIdentifier(decl.name)) return [];
    const found: ts.Expression[] = [];
    for (const { node } of this.localReferences(module, decl.name)) {
      // The assigned target: the name itself, or `name.property`.
      const left = property === undefined ? node : node.parent;
      if (property !== undefined && !(ts.isPropertyAccessExpression(left) && left.expression === node && left.name.text === property)) continue;
      const assignment = left.parent;
      if (!ts.isBinaryExpression(assignment) || assignment.left !== left) continue;
      const operator = assignment.operatorToken.kind;
      if (operator < ts.SyntaxKind.FirstAssignment || operator > ts.SyntaxKind.LastAssignment) continue;
      found.push(operator === ts.SyntaxKind.EqualsToken ? assignment.right : assignment);
    }
    return found;
  }

  /** `const { a } = value`: `value.a`. */
  private destructured(module: Module, element: ts.BindingElement): Values {
    const pattern = element.parent;
    const holder = pattern.parent;
    if (!ts.isVariableDeclaration(holder) || holder.initializer === undefined) return HOLE;
    const key = element.propertyName ?? element.name;
    if (ts.isObjectBindingPattern(pattern) && ts.isIdentifier(key)) return this.property(module, holder.initializer, key.text);
    return isTemp(this.values(module, holder.initializer)) ? TEMP : HOLE;
  }

  /** An imported binding's value, followed into a relative module's top-level declaration. */
  private imported(module: Module, binding: ImportBinding): Values {
    const target = this.resolveModule(module.rel, binding.specifier);
    const from = target === undefined ? undefined : this.moduleOf(target);
    if (from === undefined || binding.name === '*' || binding.name === 'default') return HOLE;
    const reexport = from.reexports.get(binding.name);
    if (reexport !== undefined) return this.imported(from, reexport);
    const decl = from.topLevel(from.exported.get(binding.name) ?? binding.name);
    if (decl === undefined || ts.isFunctionDeclaration(decl)) return HOLE;
    return this.guarded(decl, () => this.variable(from, decl));
  }

  /** The object literals an expression traces to, and what it may hold that the scan cannot see inside. */
  private objectLiterals(module: Module, node: ts.Expression): Array<FoundLiteral | Opaque> {
    // Kept, like a value, only when read under no call's arguments and through no cut cycle.
    const memoize = this.bound.size === 0;
    const known = memoize ? this.literalMemo.get(node) : undefined;
    if (known !== undefined) return known;
    const outerCut = this.cut;
    this.cut = false;
    try {
      const found = this.traceLiterals(module, node);
      if (memoize && !this.cut) this.literalMemo.set(node, found);
      return found;
    } finally {
      this.cut ||= outerCut;
    }
  }

  private traceLiterals(module: Module, node: ts.Expression): Array<FoundLiteral | Opaque> {
    if (ts.isParenthesizedExpression(node) || ts.isAwaitExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) return this.objectLiterals(module, node.expression);
    const opaque: Opaque[] = [{ opaque: node, module, bound: this.bound }];
    if (ts.isObjectLiteralExpression(node)) return [{ module, literal: node, bound: this.bound }];
    if (ts.isConditionalExpression(node)) return [...this.objectLiterals(module, node.whenTrue), ...this.objectLiterals(module, node.whenFalse)];
    if (ts.isElementAccessExpression(node)) return this.indexedLiterals(module, node);
    if (ts.isPropertyAccessExpression(node)) {
      // `a.b`: the literals `b` holds in each literal `a` traces to.
      return this.objectLiterals(module, node.expression).flatMap((found) => {
        if (isOpaque(found)) return opaque;
        return this.members(found, node.name.text).flatMap((member) => (isOpaque(member) ? [member] : this.memberLiterals(member)));
      });
    }
    if (ts.isCallExpression(node)) return this.returnedLiterals(module, node, opaque);
    return ts.isIdentifier(node) ? this.declaredLiterals(module, node, opaque) : opaque;
  }

  /** The literals a call returns, through each function it calls. */
  private returnedLiterals(module: Module, node: ts.CallExpression, opaque: Opaque[]): Array<FoundLiteral | Opaque> {
    const functions = this.functionsOf(module, node.expression);
    if (functions.length === 0) return opaque;
    return functions.flatMap((found) => {
      if (isOpaque(found)) return opaque;
      const bound = this.boundFor(module, node, found);
      return this.withBound(bound, () => this.returnExpressions(found.fn).flatMap((value) => this.objectLiterals(found.module, value)));
    });
  }

  /** The literals a name holds, through its declaration. */
  private declaredLiterals(module: Module, node: ts.Identifier, opaque: Opaque[]): Array<FoundLiteral | Opaque> {
    const decl = this.declarationOf(module, node);
    if (decl === undefined) return opaque;
    // Re-entering a declaration adds no literal (see `guarded`).
    if (this.active.has(decl)) {
      this.cut = true;
      return [];
    }
    this.active.add(decl);
    try {
      if (ts.isVariableDeclaration(decl) && decl.initializer !== undefined) return this.objectLiterals(module, decl.initializer);
      if (ts.isParameter(decl)) return this.parameterLiterals(module, decl) ?? opaque;
      if (ts.isBindingElement(decl)) return this.destructuredLiterals(module, decl) ?? opaque;
      if (ts.isImportSpecifier(decl)) return this.importedLiterals(module, decl) ?? opaque;
      return opaque;
    } finally {
      this.active.delete(decl);
    }
  }

  /** `const { a } = value`: the literals `value.a` holds, or `undefined` for a pattern the scan does not read. */
  private destructuredLiterals(module: Module, element: ts.BindingElement): Array<FoundLiteral | Opaque> | undefined {
    const holder = element.parent.parent;
    const key = element.propertyName ?? element.name;
    if (!ts.isObjectBindingPattern(element.parent) || !ts.isVariableDeclaration(holder) || holder.initializer === undefined || !ts.isIdentifier(key)) return undefined;
    return this.objectLiterals(module, holder.initializer).flatMap((found) =>
      isOpaque(found) ? [found] : this.members(found, key.text).flatMap((member) => (isOpaque(member) ? [member] : this.memberLiterals(member))),
    );
  }

  /**
   * `table[key]`: the literals the member holds, every member's when the key is
   * not a literal; an array's elements, whatever the index.
   */
  private indexedLiterals(module: Module, node: ts.ElementAccessExpression): Array<FoundLiteral | Opaque> {
    const key = ts.isStringLiteral(node.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(node.argumentExpression) ? node.argumentExpression.text : undefined;
    const elements = this.elementsOf(module, node.expression);
    if (elements !== undefined) return elements;
    return this.objectLiterals(module, node.expression).flatMap((found) => {
      if (isOpaque(found)) return [{ opaque: node, module, bound: this.bound }];
      const members = key === undefined ? found.literal.properties.map((member) => ({ module: found.module, member, bound: found.bound })) : this.members(found, key);
      return members.flatMap((member) => (isOpaque(member) ? [member] : this.memberLiterals(member)));
    });
  }

  /** The object literals an array literal's elements trace to, or `undefined` when the value is no array literal. */
  private elementsOf(module: Module, node: ts.Expression): Array<FoundLiteral | Opaque> | undefined {
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) return this.elementsOf(module, node.expression);
    if (ts.isArrayLiteralExpression(node)) {
      return node.elements.flatMap((element) => (ts.isSpreadElement(element) ? (this.elementsOf(module, element.expression) ?? [{ opaque: element.expression, module, bound: this.bound }]) : this.objectLiterals(module, element)));
    }
    const decl = ts.isIdentifier(node) ? this.declarationOf(module, node) : undefined;
    if (decl === undefined || !ts.isVariableDeclaration(decl) || decl.initializer === undefined || this.active.has(decl)) return undefined;
    this.active.add(decl);
    try {
      return this.elementsOf(module, decl.initializer);
    } finally {
      this.active.delete(decl);
    }
  }

  /** An imported binding's literals, from a relative module's top-level `const`; `undefined` for anything else. */
  private importedLiterals(module: Module, decl: ts.ImportSpecifier): Array<FoundLiteral | Opaque> | undefined {
    let binding = module.imports.get(decl.name.text);
    if (binding === undefined) return undefined;
    let from = module;
    for (let hops = 0; hops < MAX_REEXPORT_HOPS; hops += 1) {
      const target = this.resolveModule(from.rel, binding.specifier);
      const next = target === undefined ? undefined : this.moduleOf(target);
      if (next === undefined) return undefined;
      from = next;
      const reexport = from.reexports.get(binding.name);
      if (reexport === undefined) break;
      binding = reexport;
    }
    if (from === module) return undefined;
    const declared = from.topLevel(from.exported.get(binding.name) ?? binding.name);
    if (declared === undefined || !ts.isVariableDeclaration(declared) || declared.initializer === undefined) return undefined;
    return this.withBound(new Map(), () => this.objectLiterals(from, declared.initializer as ts.Expression));
  }

  /** The object literals one member holds. */
  private memberLiterals({ module, member, bound }: FoundMember): Array<FoundLiteral | Opaque> {
    const value = memberExpression(member);
    return value === undefined ? [] : this.withBound(bound, () => this.objectLiterals(module, value));
  }

  /** The table of a vitest `<api>.each(table)(name, fn)` / `.for(table)(name, fn)` that runs `fn` once per row. */
  private tableOf(fn: FunctionNode): ts.Expression | undefined {
    const run = fn.parent;
    if (!ts.isCallExpression(run) || !run.arguments.includes(fn as ts.Expression) || !ts.isCallExpression(run.expression)) return undefined;
    const name = calleeName(run.expression);
    return name === 'each' || name === 'for' ? run.expression.arguments[0] : undefined;
  }

  /** The object literals a parameter is given at every call site, or `undefined` when a call site may be unseen. */
  private parameterLiterals(module: Module, param: ts.ParameterDeclaration): Array<FoundLiteral | Opaque> | undefined {
    const fn = param.parent;
    if (!isFunctionNode(fn) || param.dotDotDotToken !== undefined) return undefined;
    const index = fn.parameters.indexOf(param);
    const table = index === 0 ? this.tableOf(fn) : undefined;
    if (table !== undefined) return this.elementsOf(module, table);
    const sites = this.callSitesOf(module, fn);
    if (sites === undefined || sites.length === 0) return undefined;
    const found = sites.flatMap(({ module: at, call }): Array<FoundLiteral | Opaque> => {
      const arg = call.arguments[index];
      // No argument: the parameter is `undefined` (or its default) there, which holds no member.
      if (arg === undefined) return param.initializer === undefined ? [] : this.objectLiterals(module, param.initializer);
      if (ts.isSpreadElement(arg)) return [{ opaque: call, module: at, bound: new Map() }];
      return this.withBound(new Map(), () => this.objectLiterals(at, arg));
    });
    // Many call sites hand over the same literal; it is read once.
    return [...new Map(found.map((entry) => [isOpaque(entry) ? entry.opaque : entry.literal, entry] as const)).values()];
  }

  /** The functions a callee names, in this module or one imported by a relative specifier. */
  private functionsOf(module: Module, callee: ts.Expression): Array<FoundFunction | Opaque> {
    if (ts.isPropertyAccessExpression(callee)) return this.memberFunctions(module, callee.expression, callee.name.text);
    if (!ts.isIdentifier(callee)) return [];
    const decl = this.declarationOf(module, callee);
    if (decl === undefined) return [];
    if (ts.isBindingElement(decl)) return this.destructuredFunctions(module, decl);
    if (ts.isImportSpecifier(decl)) {
      const binding = module.imports.get(decl.name.text);
      return binding === undefined ? [] : this.importedFunction(module, binding);
    }
    const fn = declaredFunction(decl);
    return isFunctionNode(fn) && this.scanned.has(module.rel) ? [{ module, fn, bound: this.bound }] : [];
  }

  /** `const { f } = value`, then `f()`: the functions `value.f` names. */
  private destructuredFunctions(module: Module, element: ts.BindingElement): Array<FoundFunction | Opaque> {
    const holder = element.parent.parent;
    const key = element.propertyName ?? element.name;
    if (!ts.isObjectBindingPattern(element.parent) || !ts.isVariableDeclaration(holder) || holder.initializer === undefined || !ts.isIdentifier(key)) return [];
    return this.memberFunctions(module, holder.initializer, key.text);
  }

  /** The functions `object.name` names, through the object literals the object traces to. */
  private memberFunctions(module: Module, object: ts.Expression, name: string): Array<FoundFunction | Opaque> {
    const traced = this.objectLiterals(module, object);
    return traced.flatMap((found) => (isOpaque(found) ? [found] : this.members(found, name).flatMap((member) => this.memberFunction(member))));
  }

  /** The functions one member names: a method, a function value, or a name that holds one. */
  private memberFunction(found: FoundMember | Opaque): Array<FoundFunction | Opaque> {
    if (isOpaque(found)) return [found];
    const { module, member, bound } = found;
    if (ts.isMethodDeclaration(member)) return [{ module, fn: member, bound }];
    if (ts.isPropertyAssignment(member) && isFunctionNode(member.initializer)) return [{ module, fn: member.initializer, bound }];
    const named = memberExpression(member);
    return named === undefined ? [] : this.withBound(bound, () => this.functionsOf(module, named));
  }

  private importedFunction(module: Module, binding: ImportBinding): FoundFunction[] {
    const target = this.resolveModule(module.rel, binding.specifier);
    const from = target === undefined ? undefined : this.moduleOf(target);
    if (from === undefined) return [];
    const reexport = from.reexports.get(binding.name);
    if (reexport !== undefined) return this.importedFunction(from, reexport);
    const decl = from.topLevel(from.exported.get(binding.name) ?? binding.name);
    const fn = decl !== undefined && ts.isVariableDeclaration(decl) ? decl.initializer : decl;
    // Product code's functions are not followed: a path the test never wrote is not the test's reach.
    return isFunctionNode(fn) && this.scanned.has(from.rel) ? [{ module: from, fn, bound: new Map() }] : [];
  }

  /** The expressions a function returns: its concise body, or each `return` not inside a nested function. */
  private returnExpressions(fn: FunctionNode): ts.Expression[] {
    if (fn.body === undefined) return [];
    if (!ts.isBlock(fn.body)) return [fn.body];
    const found: ts.Expression[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isReturnStatement(node) && node.expression !== undefined) found.push(node.expression);
      if (!isFunctionNode(node)) ts.forEachChild(node, visit);
    };
    ts.forEachChild(fn.body, visit);
    return found;
  }

  /** What one call returns: the function's returns, its parameters bound to this call's arguments. */
  private returnsAt(caller: Module, call: ts.CallExpression, found: FoundFunction): Values {
    return this.withBound(this.boundFor(caller, call, found), () => this.returns(found.module, found.fn));
  }

  /** The bindings a call runs its function under: where the function was found, plus this call's arguments. */
  private boundFor(caller: Module, call: ts.CallExpression, { module, fn, bound }: FoundFunction): Bound {
    const args = new Map(bound);
    for (const [index, param] of fn.parameters.entries()) {
      const arg = call.arguments[index];
      if (arg !== undefined) args.set(param, ts.isSpreadElement(arg) ? HOLE : this.values(caller, arg));
      else if (param.initializer !== undefined) args.set(param, this.values(module, param.initializer));
    }
    return args;
  }

  /** Evaluate under other bindings. */
  private withBound<T>(bound: Bound, evaluate: () => T): T {
    const saved = this.bound;
    this.bound = bound;
    try {
      return evaluate();
    } finally {
      this.bound = saved;
    }
  }

  private returns(module: Module, fn: FunctionNode): Values {
    return this.guarded(fn, () => {
      const returned = this.returnExpressions(fn);
      return returned.length === 0 ? HOLE : union(returned.map((value) => this.values(module, value)));
    });
  }

  /** A parameter: the argument at every call site, when every reference to its function is a call. */
  private parameter(module: Module, param: ts.ParameterDeclaration): Values {
    const bound = this.bound.get(param);
    if (bound !== undefined) return bound;
    const fn = param.parent;
    const index = fn.parameters.indexOf(param);
    if (!isFunctionNode(fn) || !ts.isIdentifier(param.name) || param.dotDotDotToken !== undefined) return HOLE;
    const sites = this.callSitesOf(module, fn);
    if (sites === undefined || sites.length === 0) return HOLE;
    return union(
      sites.map(({ module: at, call }) => {
        const arg = call.arguments[index];
        // No argument and no default: the parameter is `undefined` there, which builds no path.
        if (arg === undefined) return param.initializer === undefined ? [] : this.values(module, param.initializer);
        return ts.isSpreadElement(arg) ? HOLE : this.values(at, arg);
      }),
    );
  }

  /**
   * Every call of a function, or `undefined` when one of its references is not a
   * call (the function escapes as a value, so a call site may be unseen). A
   * callback has the calls {@link callbackSitesOf} finds.
   */
  private callSitesOf(module: Module, fn: FunctionNode): CallSite[] | undefined {
    const named = functionName(fn);
    if (named === undefined) return this.callbackSitesOf(module, fn);
    const references = [...this.localReferences(module, named), ...this.importedReferences(module, named.text)];
    const sites: CallSite[] = [];
    for (const { module: at, node } of references) {
      // `typeof f` in a type is no use of the value.
      if (ts.isTypeQueryNode(node.parent)) continue;
      const handed = this.handedSites(node);
      if (handed !== undefined) sites.push(...handed);
      else if (ts.isCallExpression(node.parent) && node.parent.expression === node) sites.push({ module: at, call: node.parent });
      else return undefined;
    }
    return sites;
  }

  /** A function handed over as an object member (`cwd: packageDir`, `{ packageDir }`) is called as `<object>.cwd(…)`. */
  private handedSites(reference: ts.Identifier): CallSite[] | undefined {
    const holder = reference.parent;
    const named = ts.isShorthandPropertyAssignment(holder) || (ts.isPropertyAssignment(holder) && holder.initializer === reference) ? holder.name : undefined;
    return named !== undefined && ts.isIdentifier(named) && ts.isObjectLiteralExpression(holder.parent) ? this.memberCalls(holder.parent, named.text) : undefined;
  }

  /**
   * Every `<object>.<name>(…)` whose object traces to this literal. A call on
   * an object the scan cannot see into is not counted: matching by name
   * alone would hand `fs.existsSync`'s every argument to a mock's `existsSync`.
   */
  private memberCalls(literal: ts.ObjectLiteralExpression, name: string): CallSite[] {
    const byName = this.memberCallMemo.get(literal) ?? new Map<string, CallSite[]>();
    this.memberCallMemo.set(literal, byName);
    const known = byName.get(name);
    if (known !== undefined) return known;
    const sites = (this.propertyCalls().get(name) ?? []).filter(({ module, call }) => {
      const receiver = (call.expression as ts.PropertyAccessExpression).expression;
      return this.withBound(new Map(), () => this.objectLiterals(module, receiver)).some((found) => !isOpaque(found) && found.literal === literal);
    });
    byName.set(name, sites);
    return sites;
  }

  /**
   * The calls of a callback: a member of an object literal (`fixture: (r) => …`,
   * `fixture(r) {…}`) is called by every `<object>.fixture(…)` in the scanned
   * modules; an argument of a call to a scanned function is called wherever that
   * function calls the parameter it lands in. A callback handed to code the scan
   * does not read has no call it can see.
   */
  private callbackSitesOf(module: Module, fn: FunctionNode): CallSite[] | undefined {
    const slot = memberSlot(fn);
    if (slot !== undefined) {
      const { literal, name } = slot;
      return ts.isIdentifier(name) && ts.isObjectLiteralExpression(literal) ? this.memberCalls(literal, name.text) : undefined;
    }
    const holder = fn.parent;
    return ts.isCallExpression(holder) ? this.argumentSites(module, holder, fn) : undefined;
  }

  /** The calls of a function handed as an argument to `holder`: wherever each callee calls the parameter it lands in. */
  private argumentSites(module: Module, holder: ts.CallExpression, fn: FunctionNode): CallSite[] | undefined {
    const index = holder.arguments.indexOf(fn as ts.Expression);
    const callees = this.functionsOf(module, holder.expression);
    if (index === -1 || callees.length === 0) return undefined;
    const sites: CallSite[] = [];
    for (const found of callees) {
      if (isOpaque(found)) return undefined;
      const { module: at, fn: callee } = found;
      const param = callee.parameters[index];
      if (param === undefined || !ts.isIdentifier(param.name)) return undefined;
      const references = this.localReferences(at, param.name);
      if (references.some(({ node }) => !ts.isCallExpression(node.parent) || node.parent.expression !== node)) return undefined;
      sites.push(...references.map(({ node }) => ({ module: at, call: node.parent as ts.CallExpression })));
    }
    return sites;
  }

  /** Every `<object>.<name>(…)` call in the scanned modules, by `name`. */
  private propertyCalls(): Map<string, CallSite[]> {
    if (this.propertyCallIndex !== undefined) return this.propertyCallIndex;
    const index = new Map<string, CallSite[]>();
    for (const module of this.scanned.values()) {
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
          appendTo(index, node.expression.name.text, { module, call: node });
        }
        ts.forEachChild(node, visit);
      };
      visit(module.file);
    }
    this.propertyCallIndex = index;
    return index;
  }

  /** References to a declaration's name in its own module, the declaration itself excluded. */
  private localReferences(module: Module, named: ts.Identifier): Reference[] {
    const symbol = module.checker.getSymbolAtLocation(named);
    if (symbol === undefined) return [];
    return (this.identifiersOf(module).get(named.text) ?? [])
      .filter((node) => node !== named && !ts.isExportSpecifier(node.parent) && module.checker.getSymbolAtLocation(node) === symbol)
      .map((node) => ({ module, node }));
  }

  /** A module's identifiers, by text. */
  private identifiersOf(module: Module): Map<string, ts.Identifier[]> {
    const known = this.identifierIndex.get(module);
    if (known !== undefined) return known;
    const index = new Map<string, ts.Identifier[]>();
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) appendTo(index, node.text, node);
      ts.forEachChild(node, visit);
    };
    visit(module.file);
    this.identifierIndex.set(module, index);
    return index;
  }

  /** References in OTHER scanned modules to an export of `module` named `name`. */
  private importedReferences(module: Module, name: string): Reference[] {
    const exportedAs = [...module.exported].filter(([, local]) => local === name).map(([as]) => as);
    return [name, ...exportedAs].flatMap((as) => this.index().get(`${module.rel}#${as}`) ?? []);
  }

  /** `<module>#<export>` where an imported binding is declared, through `export { … } from` re-exports. */
  private origin(from: string, binding: ImportBinding): string {
    let at = from;
    let current = binding;
    for (const seen = new Set<string>(); ; ) {
      const target = this.resolveModule(at, current.specifier);
      const key = `${target ?? '?'}#${current.name}`;
      // Only a scanned module's functions are followed, so only scanned barrels are worth parsing through.
      const reexport = target === undefined || seen.has(key) ? undefined : this.scanned.get(target)?.reexports.get(current.name);
      if (target === undefined || reexport === undefined) return key;
      seen.add(key);
      at = target;
      current = reexport;
    }
  }

  /** Every use of a name imported by a relative specifier, across the scanned modules, by `<module>#<export>` of its declaration. */
  private index(): Map<string, Reference[]> {
    if (this.importIndex !== undefined) return this.importIndex;
    const index = new Map<string, Reference[]>();
    for (const module of this.scanned.values()) {
      const targets = new Map([...module.imports].map(([local, binding]) => [local, this.origin(module.rel, binding)] as const));
      const visit = (node: ts.Node): void => {
        const target = ts.isIdentifier(node) && !ts.isImportSpecifier(node.parent) && !ts.isImportClause(node.parent) ? targets.get(node.text) : undefined;
        if (target !== undefined) appendTo(index, target, { module, node: node as ts.Identifier });
        ts.forEachChild(node, visit);
      };
      visit(module.file);
    }
    this.importIndex = index;
    return index;
  }
}

/** An evaluated path: where it starts and its normalised segments (`null` where not static). */
export interface Located {
  readonly anchor: Anchor | undefined;
  readonly segments: ReadonlyArray<string | null>;
}

/** Normalise pieces to segments; the LAST anchor wins, as `resolve` does; `..` folds where it can. */
export function locate(pieces: Pieces): Located {
  let anchor: Anchor | undefined;
  const segments: Array<string | null> = [];
  let current = '';
  let unknown = false;
  const push = (segment: string | null): void => {
    const last = segments.at(-1);
    if (segment === '..' && typeof last === 'string' && last !== '..') segments.pop();
    else segments.push(segment);
  };
  const flush = (): void => {
    if (unknown) push(null);
    else if (current !== '' && current !== '.') push(current);
    current = '';
    unknown = false;
  };
  for (const piece of pieces) {
    if (piece === null) {
      unknown = true;
    } else if (typeof piece === 'object') {
      anchor = piece;
      segments.length = 0;
      current = '';
      unknown = false;
    } else {
      // Authored text: a backslash in it is a separator on every platform.
      const [first = '', ...more] = toForwardSlashAnyPlatform(piece).split('/');
      current += first;
      for (const part of more) {
        flush();
        current += part;
      }
    }
  }
  flush();
  return { anchor, segments };
}
