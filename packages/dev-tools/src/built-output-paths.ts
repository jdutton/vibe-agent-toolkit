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
 *
 * A library call counts by what it is bound to, never by its spelling: `join`,
 * `resolve`, `dirname`, `relative` only when imported from `node:path` (or
 * `path`) or as `safePath` members from `@vibe-agent-toolkit/utils`; a temp
 * source only from `node:os`, `node:fs`, `node:fs/promises` or the utils
 * package. `[a, b].join('/')`, or a local function named `tmpdir`, is neither.
 * A value cut short by a cycle guard, or past the alternatives cap, is unknown.
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

/**
 * What a callee is bound to, as `<library>#<export path>`: `node:path#join`,
 * `utils#safePath.join`, `global#process.cwd`. See {@link libraryOf}.
 */
type Binding = `${string}#${string}`;

/** Calls that join their arguments into ONE path → whether an absolute argument restarts it (`resolve`). */
const PATH_JOIN: ReadonlyMap<Binding, boolean> = new Map([
  ['node:path#join', false],
  ['node:path#posix.join', false],
  ['utils#safePath.join', false],
  ['node:path#resolve', true],
  ['node:path#posix.resolve', true],
  ['utils#safePath.resolve', true],
]);
const DIRNAME: ReadonlySet<Binding> = new Set(['node:path#dirname', 'node:path#posix.dirname']);
/** A path relative to another: no location the scan can place. */
const RELATIVE: ReadonlySet<Binding> = new Set(['node:path#relative', 'node:path#posix.relative', 'utils#safePath.relative']);
const RESOLVE_FROM_IMPORT_META: Binding = 'utils#resolveFromImportMeta';
const PROCESS_CWD: Binding = 'global#process.cwd';
const REQUIRE: Binding = 'global#require';
const CREATE_REQUIRE: Binding = 'node:module#createRequire';
/** Calls that hand their first argument through as the same path. */
const PASS_THROUGH: ReadonlySet<Binding> = new Set([
  'global#String',
  'node:path#normalize',
  'node:path#posix.normalize',
  'node:url#fileURLToPath',
  'node:url#pathToFileURL',
  'node:fs#realpathSync',
  'node:fs#realpathSync.native',
  'node:fs#realpath',
  'node:fs#promises.realpath',
  'node:fs/promises#realpath',
  'utils#toForwardSlash',
  'utils#normalizePath',
  'utils#mkdirSyncReal',
]);
/** Calls whose result is a fresh temporary directory, or a handle on one. */
const TEMP_SOURCES: ReadonlySet<Binding> = new Set([
  'node:os#tmpdir',
  'node:fs#mkdtemp',
  'node:fs#mkdtempSync',
  'node:fs#promises.mkdtemp',
  'node:fs/promises#mkdtemp',
  'utils#normalizedTmpdir',
  'utils#createTempDir',
  'utils#createTempDirAsync',
  'utils#tempDirTracker',
  'utils#scratchTmpdirEnv',
  'utils#registerScratchTmpdir',
  'utils#setupAsyncTempDirSuite',
  'utils#setupSyncTempDirSuite',
  // A path vouched for, and checked at runtime, as inside a temp dir the test owns.
  'utils#underTemp',
]);
const UTILS = '@vibe-agent-toolkit/utils';
/** The utils package's own sources, which its tests import by relative specifier. */
const UTILS_SOURCE = 'packages/utils/src/';
/** Node built-ins a bound callee may come from, without the `node:` prefix. */
const NODE_LIBRARIES: ReadonlySet<string> = new Set(['os', 'fs', 'fs/promises', 'url', 'util', 'module', 'child_process']);
/** A binding that is a whole module (`import * as path`, `import path from`): its member is an export. */
const WHOLE_MODULE = /#(?:\*|default)$/;

/** The library a bare module specifier names: `node:<lib>`, `utils` for any utils subpath, or the specifier itself. */
function libraryOf(specifier: string): string {
  const bare = specifier.replace(/^node:/, '');
  if (/^path(?:\/(?:posix|win32))?$/.test(bare)) return 'node:path';
  if (NODE_LIBRARIES.has(bare)) return `node:${bare}`;
  return specifier === UTILS || specifier.startsWith(`${UTILS}/`) ? 'utils' : specifier;
}

/** The name a call is made through, by spelling: `safePath.join` → `join`, `pathResolve` → `pathResolve`. */
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

/** A literal's pieces: absolute text starts at {@link ABSOLUTE} — which counts only as a value's FIRST piece (see {@link appended}). */
export function literalPieces(literal: string): Pieces {
  return ABSOLUTE_TEXT.test(literal) ? [ABSOLUTE, literal] : [literal];
}

/** A value appended to another (`a + b`, a later `join` argument): an absolute literal in it is a separator, not a restart. */
function appended(values: Values): Values {
  return values.map((pieces) => pieces.filter((piece) => piece !== ABSOLUTE));
}

/** Every combination of `a` then `b`. */
function concat(a: Values, b: Values): Values {
  if (a.length * b.length > MAX_ALTERNATIVES) return HOLE;
  return a.flatMap((left) => b.map((right) => [...left, ...right]));
}

/** Either value: alternatives naming the same location count once. */
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
  /** The export's name, `*` for a namespace import, `default` for a default import. */
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
  /** The specifiers of `export * from '…'`. */
  readonly starReexports: string[] = [];
  /** `export default <expression>` or `export default function …`. */
  readonly defaultExport: ts.Node | undefined;
  readonly dir: string;

  constructor(
    readonly file: ts.SourceFile,
    readonly rel: string,
    readonly checker: ts.TypeChecker,
  ) {
    // A root-level file (a vitest setup file) sits in the repo root itself.
    this.dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    let defaultExport: ts.Node | undefined;
    for (const statement of file.statements) {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) this.readImport(statement.importClause, statement.moduleSpecifier.text);
      else if (ts.isExportDeclaration(statement)) this.readExport(statement);
      else if (ts.isExportAssignment(statement) && statement.isExportEquals !== true) defaultExport = statement.expression;
      else if (ts.isFunctionDeclaration(statement) && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) === true) defaultExport = statement;
    }
    this.defaultExport = defaultExport;
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
    const from = statement.moduleSpecifier !== undefined && ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : undefined;
    const clause = statement.exportClause;
    if (clause === undefined || ts.isNamespaceExport(clause)) {
      if (from !== undefined && clause === undefined) this.starReexports.push(from);
      else if (from !== undefined && clause !== undefined) this.reexports.set(clause.name.text, { specifier: from, name: '*' });
      return;
    }
    for (const element of clause.elements) {
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

  /** The declaration an export names: a top-level function or variable, or the default export's value. */
  exportedDeclaration(name: string): ts.Node | undefined {
    if (name !== 'default') return this.topLevel(this.exported.get(name) ?? name);
    const local = this.exported.get('default');
    const value = this.defaultExport ?? (local === undefined ? undefined : this.topLevel(local));
    return value !== undefined && ts.isIdentifier(value) ? this.topLevel(value.text) : value;
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

/** The import binding a declaration is: a named, default or namespace import. */
function importBindingOf(module: Module, decl: ts.Declaration): ImportBinding | undefined {
  if (!ts.isImportSpecifier(decl) && !ts.isImportClause(decl) && !ts.isNamespaceImport(decl)) return undefined;
  return decl.name === undefined ? undefined : module.imports.get(decl.name.text);
}

/** A function handed over as an object member (`cwd: packageDir`, `{ packageDir }`): the literal and the member's name. */
function handedTo(reference: ts.Identifier): { literal: ts.ObjectLiteralExpression; name: string } | undefined {
  const holder = reference.parent;
  const named = ts.isShorthandPropertyAssignment(holder) || (ts.isPropertyAssignment(holder) && holder.initializer === reference) ? holder.name : undefined;
  return named !== undefined && ts.isIdentifier(named) && ts.isObjectLiteralExpression(holder.parent) ? { literal: holder.parent, name: named.text } : undefined;
}

/** The value a declaration holds: a variable's initializer, or an exported expression. */
function declaredValue(decl: ts.Node): ts.Expression | undefined {
  if (ts.isVariableDeclaration(decl)) return decl.initializer;
  return ts.isExpression(decl) ? decl : undefined;
}

/** Where an import leads: a declaration in a known module (`decl` undefined for the whole module), or a bare specifier's export. */
type Followed = { readonly module: Module; readonly decl: ts.Node | undefined } | ImportBinding;

/** Reads modules lazily and evaluates expressions in them. */
export class PathEvaluator {
  private readonly modules = new Map<string, Module | undefined>();
  private readonly active = new Set<ts.Node>();
  private readonly memo = new Map<ts.Node, Values>();
  private readonly literalMemo = new Map<ts.Node, Array<FoundLiteral | Opaque>>();
  /** The expressions whose object literals are being traced: re-entering one is a cycle. */
  private readonly tracing = new Set<ts.Node>();
  /** Each function's returns, by the arguments it was called with. */
  private readonly callMemo = new Map<FunctionNode, Map<string, Values>>();
  private readonly nodeIds = new Map<ts.Node, number>();
  /** Per literal and member name, the calls on it; `undefined` while they are being enumerated. */
  private readonly memberCallMemo = new Map<ts.ObjectLiteralExpression, Map<string, CallSite[] | undefined>>();
  /** Each module's identifiers by text: one walk per module, not one per reference lookup. */
  private readonly identifierIndex = new Map<Module, Map<string, ts.Identifier[]>>();
  /** The arguments of the calls being evaluated, by parameter: a call's returns are read with its own arguments. */
  private bound: Bound = new Map();
  private importIndex: Map<string, Reference[]> | undefined;
  private propertyCallIndex: Map<string, CallSite[]> | undefined;
  /** Whether a cycle was cut short under the evaluation in progress: its value is partial, so it is not kept. */
  private cut = false;
  private callsEvaluated = 0;

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

  /** How many function calls were evaluated rather than read back from the memo: a measure of the work, not of time. */
  get evaluatedCalls(): number {
    return this.callsEvaluated;
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
    const binding = this.qualifiedName(module, call.expression);
    const restarts = binding === undefined ? undefined : PATH_JOIN.get(binding);
    if (restarts !== undefined) return this.joined(module, call.arguments, restarts);
    if (binding !== RESOLVE_FROM_IMPORT_META) return undefined;
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
      return concat(concat(sum, [['/']]), restarts ? values : appended(values));
    }, [[]]);
  }

  private binary(module: Module, node: ts.BinaryExpression): Values {
    const operator = node.operatorToken.kind;
    if (operator === ts.SyntaxKind.PlusToken) return concat(this.values(module, node.left), appended(this.values(module, node.right)));
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

  /** The name a callee is spelled with, seen through an import alias (`readFileSync as read` → `readFileSync`). */
  private spelledName(module: Module, callee: ts.Expression): string {
    if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
    if (!ts.isIdentifier(callee)) return '';
    const binding = module.imports.get(callee.text);
    return binding === undefined || binding.name === '*' || binding.name === 'default' ? callee.text : binding.name;
  }

  /** The name a call is made through, for matching a sink by spelling: `promisify(execFile)(…)` is a call of `execFile`. */
  callName(module: Module, call: ts.CallExpression): string {
    const callee = call.expression;
    const [wrapped] = ts.isCallExpression(callee) ? callee.arguments : [];
    if (ts.isCallExpression(callee) && wrapped !== undefined && this.spelledName(module, callee.expression) === 'promisify') return this.spelledName(module, wrapped);
    return this.spelledName(module, callee);
  }

  /** What a callee is bound to (see {@link Binding}): through its import, or a global no module declares; `undefined` for a local name. */
  qualifiedName(module: Module, callee: ts.Expression): Binding | undefined {
    if (ts.isPropertyAccessExpression(callee)) {
      const base = this.qualifiedName(module, callee.expression);
      if (base === undefined) return undefined;
      return WHOLE_MODULE.test(base) ? `${base.slice(0, base.lastIndexOf('#'))}#${callee.name.text}` : `${base}.${callee.name.text}`;
    }
    if (!ts.isIdentifier(callee)) return undefined;
    const decl = this.declarationOf(module, callee);
    if (decl === undefined) return `global#${callee.text}`;
    const binding = importBindingOf(module, decl);
    return binding === undefined ? undefined : this.bindingOrigin(module, binding);
  }

  /** What an import is bound to, or `undefined` when it leads to code the scan reads as code (a scanned helper). */
  private bindingOrigin(module: Module, binding: ImportBinding): Binding | undefined {
    // The utils package's own tests import its sources by relative specifier.
    if (this.resolveModule(module.rel, binding.specifier)?.startsWith(UTILS_SOURCE) === true) return `utils#${binding.name}`;
    const found = this.follow(module, binding);
    if (found === undefined) return undefined;
    if ('module' in found) return found.module.rel.startsWith(UTILS_SOURCE) ? `utils#${binding.name}` : undefined;
    return `${libraryOf(found.specifier)}#${found.name}`;
  }

  /**
   * Where an import leads through `export … from` re-exports among the known
   * files; `undefined` past the hop limit or outside the known files. A name an
   * `export *` supplies comes from a relative module that has it, or else from
   * the one bare specifier that may.
   */
  private follow(from: Module, binding: ImportBinding, hops = 0): Followed | undefined {
    if (!binding.specifier.startsWith('.')) return binding;
    const target = hops < MAX_REEXPORT_HOPS ? this.resolveModule(from.rel, binding.specifier) : undefined;
    const module = target === undefined ? undefined : this.moduleOf(target);
    if (module === undefined) return undefined;
    if (binding.name === '*') return { module, decl: undefined };
    const reexport = module.reexports.get(binding.name);
    if (reexport !== undefined) return this.follow(module, reexport, hops + 1);
    const decl = module.exportedDeclaration(binding.name);
    if (decl !== undefined) return { module, decl };
    const stars = module.starReexports.map((specifier) => ({ specifier, name: binding.name }));
    const local = stars.filter(({ specifier }) => specifier.startsWith('.')).map((star) => this.follow(module, star, hops + 1));
    const bare = stars.filter(({ specifier }) => !specifier.startsWith('.'));
    return local.find((found) => found !== undefined) ?? (bare.length === 1 ? bare[0] : undefined);
  }

  /**
   * `require.resolve(spec)`, `<createRequire(…)>.resolve(spec)` or
   * `import.meta.resolve(spec)`: the specifier, resolved as a module specifier;
   * `undefined` for any other call.
   */
  specifierResolution(module: Module, call: ts.CallExpression): Values | undefined {
    const callee = call.expression;
    if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'resolve' || !this.isResolver(module, callee.expression)) return undefined;
    const [specifier] = call.arguments;
    return specifier === undefined ? HOLE : this.specifierValues(module, specifier);
  }

  /** `import.meta`, `require`, or a name holding `createRequire(…)`. */
  private isResolver(module: Module, node: ts.Expression): boolean {
    if (ts.isMetaProperty(node) || this.qualifiedName(module, node) === REQUIRE) return true;
    const decl = ts.isIdentifier(node) ? this.declarationOf(module, node) : undefined;
    const made = decl !== undefined && ts.isVariableDeclaration(decl) ? decl.initializer : undefined;
    return made !== undefined && ts.isCallExpression(made) && this.qualifiedName(module, made.expression) === CREATE_REQUIRE;
  }

  /**
   * A module specifier's alternatives. One whose static start is relative or a
   * workspace package name names a file-relative module or that package's file;
   * a dependency's is unknown where it lands. One already anchored
   * (`pathToFileURL(…).href`) is a path.
   */
  specifierValues(module: Module, node: ts.Expression): Values {
    return this.values(module, node).map((pieces): Pieces => {
      if (locate(pieces).anchor !== undefined) return pieces;
      const end = pieces.findIndex((piece) => typeof piece !== 'string');
      const lead = (end === -1 ? pieces : pieces.slice(0, end)) as readonly string[];
      const head = lead.length === 0 ? undefined : this.specifierPieces(module, lead.join(''));
      return head === undefined ? [null, '/', ...pieces] : [...head, ...pieces.slice(lead.length)];
    });
  }

  /**
   * Whether an options argument may set `name` to anything but `false`: through
   * the object literals it traces to, and yes when any part is unseen. An array
   * (a launch's argument list) sets nothing.
   */
  maySet(module: Module, node: ts.Expression, name: string): boolean {
    if (this.elementsOf(module, node) !== undefined) return false;
    return this.objectLiterals(module, node).some(
      (found) => isOpaque(found) || this.members(found, name).some((member) => isOpaque(member) || memberExpression(member.member)?.kind !== ts.SyntaxKind.FalseKeyword),
    );
  }

  /** A bound library call's value, or `undefined` for a binding the scan does not model. */
  private libraryCall(module: Module, binding: Binding, first: ts.Expression | undefined): Values | undefined {
    if (TEMP_SOURCES.has(binding)) return TEMP;
    // The working directory: a relative path, which the scan reads from the test's package.
    if (binding === PROCESS_CWD) return [['.']];
    if (RELATIVE.has(binding)) return HOLE;
    if (first === undefined) return undefined;
    if (PASS_THROUGH.has(binding)) return this.values(module, first);
    return DIRNAME.has(binding) ? concat(this.values(module, first), [['/', '..']]) : undefined;
  }

  private call(module: Module, call: ts.CallExpression): Values {
    const binding = this.qualifiedName(module, call.expression);
    const library = binding === undefined ? undefined : this.libraryCall(module, binding, call.arguments[0]);
    if (library !== undefined) return library;
    const specifier = this.specifierResolution(module, call);
    if (specifier !== undefined) return specifier;
    const path = this.pathCall(module, call);
    if (path !== undefined) return path;
    const functions = this.functionsOf(module, call.expression);
    // Calling a temp-dir handle (`tracker.create()`, `getTempDir()`) yields a temp dir.
    if (functions.length === 0) return this.opaqueValue({ opaque: call.expression, module, bound: this.bound });
    return union(functions.map((found) => (isOpaque(found) ? this.opaqueValue(found) : this.returnsAt(module, call, found))));
  }

  /**
   * Run `evaluate` once per node at a time. Re-entering a node is a cycle: it
   * is cut short as unknown, and a value reached through one is partial and
   * not kept.
   */
  private guarded(node: ts.Node, evaluate: () => Values): Values {
    // A value read under a call's arguments belongs to that call; only an unbound one is kept.
    const memoize = this.bound.size === 0;
    const known = memoize ? this.memo.get(node) : undefined;
    if (known !== undefined) return known;
    if (this.active.has(node)) {
      this.cut = true;
      return HOLE;
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

  /**
   * Where a name is declared in its own module, seen through a shorthand
   * property. A declaration in another file of the program is a script global
   * (a `process.env.X = …` in a setup file declares `process` there), so the
   * name is a global this module never declares.
   */
  private declarationOf(module: Module, id: ts.Identifier): ts.Declaration | undefined {
    const symbol = ts.isShorthandPropertyAssignment(id.parent) ? module.checker.getShorthandAssignmentValueSymbol(id.parent) : module.checker.getSymbolAtLocation(id);
    const decl = symbol?.declarations?.[0];
    return decl?.getSourceFile() === module.file ? decl : undefined;
  }

  private declared(module: Module, decl: ts.Declaration): Values {
    if (ts.isImportSpecifier(decl) || ts.isImportClause(decl) || ts.isNamespaceImport(decl)) {
      const binding = importBindingOf(module, decl);
      return binding === undefined ? HOLE : this.imported(module, binding);
    }
    if (ts.isVariableDeclaration(decl)) return this.variable(module, decl);
    if (ts.isBindingElement(decl)) return this.destructured(module, decl);
    if (ts.isParameter(decl)) return this.parameter(module, decl);
    return HOLE;
  }

  private variable(module: Module, decl: ts.VariableDeclaration): Values {
    const given = this.givenValues(module, decl);
    return given.length === 0 ? HOLE : union(given.map((value) => this.values(module, value)));
  }

  /**
   * The values a variable may hold: a `const` its initializer; a `let`
   * whichever it was last given — its initializer or any assignment, a
   * placeholder aside (see {@link anyGiven}).
   */
  private givenValues(module: Module, decl: ts.VariableDeclaration): ts.Expression[] {
    const initial = decl.initializer === undefined ? [] : [decl.initializer];
    if (decl.parent.getFirstToken(module.file)?.kind === ts.SyntaxKind.ConstKeyword) return initial;
    return [...initial, ...this.assignmentsOf(module, decl, undefined)].filter((value) => !isPlaceholder(value));
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

  /** An imported binding's value, followed to its declaration among the known files. */
  private imported(module: Module, binding: ImportBinding): Values {
    const found = this.follow(module, binding);
    if (found === undefined || !('module' in found) || found.decl === undefined) return HOLE;
    const { module: from, decl } = found;
    if (ts.isVariableDeclaration(decl)) return this.guarded(decl, () => this.variable(from, decl));
    return ts.isExpression(decl) ? this.values(from, decl) : HOLE;
  }

  /** The object literals an expression traces to, and what it may hold that the scan cannot see inside. */
  private objectLiterals(module: Module, node: ts.Expression): Array<FoundLiteral | Opaque> {
    // Kept, like a value, only when read under no call's arguments and through no cut cycle.
    const memoize = this.bound.size === 0;
    const known = memoize ? this.literalMemo.get(node) : undefined;
    if (known !== undefined) return known;
    // Re-entering an expression is a cycle: cut short, as something the scan cannot see inside.
    if (this.tracing.has(node)) {
      this.cut = true;
      return [{ opaque: node, module, bound: this.bound }];
    }
    const outerCut = this.cut;
    this.cut = false;
    this.tracing.add(node);
    try {
      const found = this.traceLiterals(module, node);
      if (memoize && !this.cut) this.literalMemo.set(node, found);
      return found;
    } finally {
      this.tracing.delete(node);
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
    // Re-entering a declaration is a cycle (see `guarded`).
    if (this.active.has(decl)) {
      this.cut = true;
      return opaque;
    }
    this.active.add(decl);
    try {
      if (ts.isVariableDeclaration(decl)) {
        const given = this.givenValues(module, decl);
        return given.length === 0 ? opaque : given.flatMap((value) => this.objectLiterals(module, value));
      }
      if (ts.isParameter(decl)) return this.parameterLiterals(module, decl) ?? opaque;
      if (ts.isBindingElement(decl)) return this.destructuredLiterals(module, decl) ?? opaque;
      if (ts.isImportSpecifier(decl) || ts.isImportClause(decl)) return this.importedLiterals(module, decl) ?? opaque;
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

  /** An imported binding's literals, from the value its declaration holds; `undefined` for anything else. */
  private importedLiterals(module: Module, decl: ts.ImportSpecifier | ts.ImportClause): Array<FoundLiteral | Opaque> | undefined {
    const binding = importBindingOf(module, decl);
    const found = binding === undefined ? undefined : this.follow(module, binding);
    if (found === undefined || !('module' in found) || found.decl === undefined) return undefined;
    const { module: from } = found;
    const value = declaredValue(found.decl);
    return value === undefined ? undefined : this.withBound(new Map(), () => this.objectLiterals(from, value));
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
    if (ts.isPropertyAccessExpression(callee)) return this.propertyFunctions(module, callee);
    if (!ts.isIdentifier(callee)) return [];
    const decl = this.declarationOf(module, callee);
    if (decl === undefined) return [];
    if (ts.isBindingElement(decl)) return this.destructuredFunctions(module, decl);
    if (ts.isImportSpecifier(decl) || ts.isImportClause(decl)) {
      const binding = importBindingOf(module, decl);
      return binding === undefined ? [] : this.importedFunction(module, binding);
    }
    const fn = declaredFunction(decl);
    return isFunctionNode(fn) && this.scanned.has(module.rel) ? [{ module, fn, bound: this.bound }] : [];
  }

  /** The functions `holder.f` names: a namespace import's export `f`, or an object's member. */
  private propertyFunctions(module: Module, callee: ts.PropertyAccessExpression): Array<FoundFunction | Opaque> {
    const holder = ts.isIdentifier(callee.expression) ? this.declarationOf(module, callee.expression) : undefined;
    const binding = holder !== undefined && ts.isNamespaceImport(holder) ? importBindingOf(module, holder) : undefined;
    if (binding !== undefined) return this.importedFunction(module, { specifier: binding.specifier, name: callee.name.text });
    return this.memberFunctions(module, callee.expression, callee.name.text);
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
    const found = this.follow(module, binding);
    if (found === undefined || !('module' in found)) return [];
    const { module: from, decl } = found;
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

  /**
   * What one call returns: the function's returns, its parameters bound to this
   * call's arguments — evaluated once per function and argument values, so a
   * helper chain that calls the next helper twice costs its depth, not 2^depth.
   */
  private returnsAt(caller: Module, call: ts.CallExpression, found: FoundFunction): Values {
    const bound = this.boundFor(caller, call, found);
    const key = JSON.stringify([...bound].map(([param, values]) => [this.idOf(param), values]));
    const byArguments = this.callMemo.get(found.fn) ?? new Map<string, Values>();
    this.callMemo.set(found.fn, byArguments);
    const known = byArguments.get(key);
    if (known !== undefined) return known;
    this.callsEvaluated += 1;
    const outerCut = this.cut;
    this.cut = false;
    try {
      const values = this.withBound(bound, () => this.returns(found.module, found.fn));
      if (!this.cut) byArguments.set(key, values);
      return values;
    } finally {
      this.cut ||= outerCut;
    }
  }

  /** A stable number for a node, for a memo key. */
  private idOf(node: ts.Node): number {
    const known = this.nodeIds.get(node);
    if (known !== undefined) return known;
    this.nodeIds.set(node, this.nodeIds.size);
    return this.nodeIds.size - 1;
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
      // A function handed over as an object member (`cwd: packageDir`) is called as `<object>.cwd(…)`.
      const handed = handedTo(node);
      const calls = handed === undefined ? undefined : this.memberCalls(handed.literal, handed.name);
      if (handed !== undefined && calls === undefined) return undefined;
      if (calls !== undefined) sites.push(...calls);
      else if (ts.isCallExpression(node.parent) && node.parent.expression === node) sites.push({ module: at, call: node.parent });
      else return undefined;
    }
    return sites;
  }

  /**
   * Every `<object>.<name>(…)` whose object traces to this literal; `undefined`
   * when asked again while they are still being enumerated (a cycle, cut short).
   * A call on an object the scan cannot see into is not counted: matching by
   * name alone would hand `fs.existsSync`'s every argument to a mock's
   * `existsSync`.
   */
  private memberCalls(literal: ts.ObjectLiteralExpression, name: string): CallSite[] | undefined {
    const byName = this.memberCallMemo.get(literal) ?? new Map<string, CallSite[] | undefined>();
    this.memberCallMemo.set(literal, byName);
    if (byName.has(name)) {
      const known = byName.get(name);
      if (known === undefined) this.cut = true;
      return known;
    }
    byName.set(name, undefined);
    const sites = (this.propertyCalls().get(name) ?? []).filter(({ module, call }) => this.mayCallOn(module, call, literal));
    byName.set(name, sites);
    return sites;
  }

  /** Whether `<receiver>.<name>(…)` may be a call on `literal`: its receiver traces to it, or tracing it was cut short. */
  private mayCallOn(module: Module, call: ts.CallExpression, literal: ts.ObjectLiteralExpression): boolean {
    const receiver = (call.expression as ts.PropertyAccessExpression).expression;
    const outerCut = this.cut;
    this.cut = false;
    try {
      const traced = this.withBound(new Map(), () => this.objectLiterals(module, receiver));
      return this.cut || traced.some((found) => !isOpaque(found) && found.literal === literal);
    } finally {
      this.cut ||= outerCut;
    }
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
