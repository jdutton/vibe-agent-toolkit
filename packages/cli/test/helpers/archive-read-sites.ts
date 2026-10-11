/**
 * Where a set of source files READS an archive — computed from their syntax trees, for
 * `archive-lane-coverage.integration.test.ts`. Pure over the texts it is given, so the same scan
 * runs over the repository and over a fixture of three lines.
 *
 * A READER is one of the archive module's (`extractArchive`, `openArchive`, `listArchive`), or —
 * to a fixpoint — any function that reaches one and is called from another file. A SITE is a
 * call, from one file, of a reader defined in another: `<file> › <reader>`.
 *
 * What is FOLLOWED: a named import (aliased or not), a default import, a destructured
 * `await import(...)`; a re-export (`export { r } from`, `export * from`, or an imported binding
 * exported again), to any depth; an export by declaration, by list (`export { f as g }`) or as
 * default; a call from a callback inside the function (it runs as part of it), except a
 * commander `.action(...)`, which is where a lane STARTS.
 *
 * What is NOT followed FAILS CLOSED — it is reported in `unfollowed`, and the coverage test
 * requires that list to be empty — because each is an ordinary way to reach a reader that a scan
 * of names cannot see through: a namespace import (`import * as x`) or a non-destructured
 * `import()` of a module that exposes a reader; a reader reached from a class member; a reader
 * used as a VALUE (stored, passed, aliased) rather than called.
 *
 * What remains unseen, and is not detected: a module loaded by a specifier computed at run time or
 * through `require`; a reader's local name shadowed by a parameter or a local of the same name;
 * a wrapper reached only through a property of an object (`tools.extract(...)`) built elsewhere.
 */

import { safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import ts from 'typescript';

/** The archive module: the three readers every site leads to. Its own files are not scanned. */
export const ARCHIVE_SPECIFIER = '@vibe-agent-toolkit/utils/archive';
const BASE_READERS: ReadonlySet<string> = new Set(['extractArchive', 'openArchive', 'listArchive']);

/** A name bound from another module: what it is called there (`default` for a default import), and the specifier. */
interface Imported { readonly name: string; readonly from: string }

/** A function, by the module that defines it and its name there. */
interface Defined { readonly file: string; readonly name: string }

/** What one source file says. */
interface FileFacts {
  readonly file: string;
  readonly imports: Map<string, Imported>;
  /** A whole module bound to one name: how (`import * as x`, `import()`), and its specifier. */
  readonly wholeModules: Array<{ readonly how: string; readonly from: string }>;
  /** Top-level functions, by name. */
  readonly functions: Set<string>;
  /** Exported name → the local it exports. */
  readonly exports: Map<string, string>;
  /** `export … from`: the target, and exported name → name in the target (`'*'`: everything). */
  readonly reexports: Array<{ readonly from: string; readonly names: ReadonlyMap<string, string> | '*' }>;
  /** A call of a plain identifier: the local called, and the top-level function it is made in (`''`: module scope; `class X`: a class member). */
  readonly calls: Array<{ readonly callee: string; readonly within: string }>;
  /** An identifier read as a value rather than called. */
  readonly values: Array<{ readonly name: string }>;
}

const key = (defined: Defined): string => `${defined.file}#${defined.name}`;

const hasModifier = (node: ts.Node, kind: ts.SyntaxKind): boolean => ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind);

/** The bindings of `const { a, b: c } = await import('spec')`, or the whole module when it is not destructured. */
function dynamicImport(node: ts.CallExpression, facts: FileFacts): void {
  const [specifier] = node.arguments;
  if (node.expression.kind !== ts.SyntaxKind.ImportKeyword || specifier === undefined || !ts.isStringLiteralLike(specifier)) return;
  const awaited = ts.isAwaitExpression(node.parent) ? node.parent : node;
  const declaration = awaited.parent;
  if (ts.isVariableDeclaration(declaration) && ts.isObjectBindingPattern(declaration.name)) {
    for (const element of declaration.name.elements) {
      if (ts.isIdentifier(element.name)) facts.imports.set(element.name.text, { name: (element.propertyName ?? element.name).getText(), from: specifier.text });
    }
    return;
  }
  facts.wholeModules.push({ how: 'a non-destructured import()', from: specifier.text });
}

function staticImport(statement: ts.ImportDeclaration, facts: FileFacts): void {
  if (!ts.isStringLiteral(statement.moduleSpecifier)) return;
  const from = statement.moduleSpecifier.text;
  const clause = statement.importClause;
  if (clause?.name !== undefined) facts.imports.set(clause.name.text, { name: 'default', from });
  const named = clause?.namedBindings;
  if (named === undefined) return;
  if (ts.isNamespaceImport(named)) {
    facts.wholeModules.push({ how: 'a namespace import (import * as)', from });
    return;
  }
  for (const element of named.elements) facts.imports.set(element.name.text, { name: (element.propertyName ?? element.name).text, from });
}

function exportDeclaration(statement: ts.ExportDeclaration, facts: FileFacts): void {
  const from = statement.moduleSpecifier !== undefined && ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : undefined;
  const clause = statement.exportClause;
  if (clause === undefined || !ts.isNamedExports(clause)) {
    // `export * from` and `export * as ns from`: everything the target exports.
    if (from !== undefined) facts.reexports.push({ from, names: '*' });
    return;
  }
  const names = new Map(clause.elements.map((element): [string, string] => [element.name.text, (element.propertyName ?? element.name).text]));
  if (from === undefined) for (const [exported, local] of names) facts.exports.set(exported, local);
  else facts.reexports.push({ from, names });
}

/** The top-level functions a statement declares, each with the name it is exported under, if any. */
function declared(statement: ts.Statement): Array<{ name: string; body: ts.Node; exportedAs: string | undefined }> {
  const exportedAs = (name: string): string | undefined => {
    if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) return undefined;
    return hasModifier(statement, ts.SyntaxKind.DefaultKeyword) ? 'default' : name;
  };
  if (ts.isFunctionDeclaration(statement)) {
    const name = statement.name?.text ?? 'default';
    return [{ name, body: statement, exportedAs: exportedAs(name) }];
  }
  if (!ts.isVariableStatement(statement)) return [];
  return statement.declarationList.declarations.flatMap((declaration) =>
    (ts.isIdentifier(declaration.name) && declaration.initializer !== undefined ? [{ name: declaration.name.text, body: declaration.initializer, exportedAs: exportedAs(declaration.name.text) }] : []));
}

/** Whether `node`, an identifier, is read as a value: not the name being called, declared, imported, exported or accessed. */
function isValueUse(node: ts.Identifier): boolean {
  const { parent } = node;
  if (ts.isCallExpression(parent) && parent.expression === node) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isExportSpecifier(parent) || ts.isBindingElement(parent)) return false;
  if (ts.isTypeQueryNode(parent) || ts.isTypeReferenceNode(parent)) return false;
  const declares = ts.isVariableDeclaration(parent) || ts.isFunctionDeclaration(parent) || ts.isParameter(parent) || ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent);
  return !(declares && (parent as { name?: ts.Node }).name === node);
}

function factsOf(file: string, text: string): FileFacts {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const facts: FileFacts = { file, imports: new Map(), wholeModules: [], functions: new Set(), exports: new Map(), reexports: [], calls: [], values: [] };
  const visit = (node: ts.Node, within: string): void => {
    if (ts.isCallExpression(node)) {
      dynamicImport(node, facts);
      if (ts.isIdentifier(node.expression)) facts.calls.push({ callee: node.expression.text, within });
    } else if (ts.isIdentifier(node) && isValueUse(node)) {
      facts.values.push({ name: node.text });
    }
    // A command's `.action(...)` is where a lane STARTS: what runs there is the verb, not a step of the
    // function that registered it, so it does not make that function a reader for its own callers.
    const startsALane = ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'action';
    ts.forEachChild(node, (child) => { visit(child, startsALane ? '' : within); });
  };
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) staticImport(statement, facts);
    else if (ts.isExportDeclaration(statement)) exportDeclaration(statement, facts);
    else if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) facts.exports.set('default', statement.expression.text);
    else if (ts.isClassDeclaration(statement)) visit(statement, `class ${statement.name?.text ?? 'default'}`);
    else {
      const functions = declared(statement);
      for (const each of functions) {
        facts.functions.add(each.name);
        if (each.exportedAs !== undefined) facts.exports.set(each.exportedAs, each.name);
        visit(each.body, each.name);
      }
      if (functions.length === 0) visit(statement, '');
    }
  }
  return facts;
}

/** What the scan found. */
interface ReadSiteScan {
  /** Every `<file> › <reader>`, sorted. */
  readonly sites: readonly string[];
  /** Every shape the scan met and cannot follow, as `<file>: <what>` — the coverage test requires none. */
  readonly unfollowed: readonly string[];
}

const SCOPE = '@vibe-agent-toolkit/';

/** The source set, and what a name in one file IS in another. */
class Sources {
  readonly all: readonly FileFacts[];
  readonly #byFile: ReadonlyMap<string, FileFacts>;

  constructor(sources: ReadonlyMap<string, string>) {
    this.#byFile = new Map([...sources].map(([file, text]): [string, FileFacts] => [toForwardSlash(file), factsOf(toForwardSlash(file), text)]));
    this.all = [...this.#byFile.values()];
  }

  factsOf(module: string): FileFacts | undefined {
    return this.#byFile.get(module);
  }

  /** The file a specifier names, when it is one of the sources — or the archive module's specifier itself. */
  moduleOf(file: string, from: string): string | undefined {
    if (from === ARCHIVE_SPECIFIER) return ARCHIVE_SPECIFIER;
    let base: string | undefined;
    if (from.startsWith('.')) {
      base = safePath.join(file, '..', from).replace(/\.js$/, '');
    } else if (from.startsWith(SCOPE)) {
      const rest = from.slice(SCOPE.length);
      const cut = rest.indexOf('/');
      base = cut === -1 ? `packages/${rest}/src/index` : `packages/${rest.slice(0, cut)}/src/${rest.slice(cut + 1)}`;
    }
    return base === undefined ? undefined : [`${base}.ts`, `${base}/index.ts`].find((candidate) => this.#byFile.has(candidate));
  }

  /** Where the export `name` of `module` is defined, following re-exports. */
  origin(module: string, name: string, seen: ReadonlySet<string> = new Set()): Defined | undefined {
    if (module === ARCHIVE_SPECIFIER) return BASE_READERS.has(name) ? { file: module, name } : undefined;
    const facts = this.#byFile.get(module);
    if (facts === undefined || seen.has(`${module}#${name}`)) return undefined;
    const deeper = new Set([...seen, `${module}#${name}`]);
    const local = facts.exports.get(name);
    if (local === undefined) return this.#reexported(facts, name, deeper);
    if (facts.functions.has(local)) return { file: module, name: local };
    // An imported binding exported again.
    return this.importedAs(facts, local, deeper);
  }

  #reexported(facts: FileFacts, name: string, seen: ReadonlySet<string>): Defined | undefined {
    for (const reexport of facts.reexports) {
      const original = reexport.names === '*' ? name : reexport.names.get(name);
      const target = original === undefined ? undefined : this.moduleOf(facts.file, reexport.from);
      const found = original === undefined || target === undefined ? undefined : this.origin(target, original, seen);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  /** The function a local name of `facts` is, when it was imported. */
  importedAs(facts: FileFacts, local: string, seen: ReadonlySet<string> = new Set()): Defined | undefined {
    const imported = facts.imports.get(local);
    const target = imported === undefined ? undefined : this.moduleOf(facts.file, imported.from);
    return imported === undefined || target === undefined ? undefined : this.origin(target, imported.name, seen);
  }
}

/** The readers of a source set: the archive module's three, and every wrapper of one. */
class Readers {
  readonly #sources: Sources;
  readonly #keys = new Set([...BASE_READERS].map((name) => key({ file: ARCHIVE_SPECIFIER, name })));

  /**
   * Grow the set to its fixpoint: an exported function that reaches a reader and is called from
   * another file is a reader for whoever calls it.
   */
  constructor(sources: Sources) {
    this.#sources = sources;
    const calledElsewhere = new Set(sources.all.flatMap((facts) => facts.calls
      .map((call) => sources.importedAs(facts, call.callee))
      .filter((defined): defined is Defined => defined !== undefined && defined.file !== facts.file)
      .map(key)));
    for (let grew = true; grew;) {
      grew = false;
      for (const facts of sources.all) {
        for (const name of this.reaching(facts)) {
          const wrapper = key({ file: facts.file, name });
          if (facts.functions.has(name) && calledElsewhere.has(wrapper) && !this.#keys.has(wrapper)) {
            this.#keys.add(wrapper);
            grew = true;
          }
        }
      }
    }
  }

  /** The reader a local name of `facts` is, when it was imported as one. */
  called(facts: FileFacts, local: string): Defined | undefined {
    const defined = this.#sources.importedAs(facts, local);
    return defined !== undefined && this.#keys.has(key(defined)) ? defined : undefined;
  }

  /** The top-level scopes of `facts` that reach a reader: by calling one, or by calling a function of the same file that does. */
  reaching(facts: FileFacts): Set<string> {
    const reach = new Set(facts.calls.filter((call) => this.called(facts, call.callee) !== undefined).map((call) => call.within));
    for (let grew = true; grew;) {
      grew = false;
      for (const call of facts.calls) {
        if (facts.functions.has(call.callee) && reach.has(call.callee) && !reach.has(call.within)) {
          reach.add(call.within);
          grew = true;
        }
      }
    }
    return reach;
  }

  /** Whether importing `module` whole could hand over a reader: it defines one, exports one it imported, or re-exports a module that does. */
  exposedBy(module: string, seen: ReadonlySet<string> = new Set()): boolean {
    if (module === ARCHIVE_SPECIFIER) return true;
    const facts = this.#sources.factsOf(module);
    if (facts === undefined || seen.has(module)) return false;
    if ([...facts.functions].some((name) => this.#keys.has(key({ file: module, name })))) return true;
    if ([...facts.exports.values()].some((local) => this.called(facts, local) !== undefined)) return true;
    const deeper = new Set([...seen, module]);
    return facts.reexports.some((reexport) => {
      const target = this.#sources.moduleOf(module, reexport.from);
      return target !== undefined && this.exposedBy(target, deeper);
    });
  }
}

/** Every shape in `facts` that could reach a reader past the scan, each as `<file>: <what>`. */
function unfollowedIn(facts: FileFacts, sources: Sources, readers: Readers): string[] {
  const classes = [...readers.reaching(facts)]
    .filter((scope) => scope.startsWith('class '))
    .map((scope) => `a member of ${scope} reaches an archive reader — its callers cannot be followed; reach it from a function`);
  const wholes = facts.wholeModules
    .filter((whole) => {
      const target = sources.moduleOf(facts.file, whole.from);
      return target !== undefined && readers.exposedBy(target);
    })
    .map((whole) => `${whole.how} of ${whole.from}, which exposes an archive reader — import the reader by name`);
  const values = facts.values
    .map((value) => readers.called(facts, value.name))
    .filter((reader) => reader !== undefined)
    .map((reader) => `${reader.name} is used as a value (stored, passed or aliased), not called — call it by name`);
  return [...classes, ...wholes, ...values].map((what) => `${facts.file}: ${what}`);
}

/**
 * Scan `sources` for archive read sites.
 *
 * @param sources - Repo-relative path (`packages/<pkg>/src/…`) → the file's text; the archive module's own files left out
 * @returns The sites, and every shape that could reach a reader which the scan cannot follow
 */
export function scanReadSites(sources: ReadonlyMap<string, string>): ReadSiteScan {
  const read = new Sources(sources);
  const readers = new Readers(read);
  const sites = read.all.flatMap((facts) => facts.calls
    .map((call) => readers.called(facts, call.callee))
    .filter((reader) => reader !== undefined)
    .map((reader) => `${facts.file} › ${reader.name}`));
  const sorted = (values: readonly string[]): string[] => [...new Set(values)].sort((a, b) => a.localeCompare(b));
  return { sites: sorted(sites), unfollowed: sorted(read.all.flatMap((facts) => unfollowedIn(facts, read, readers))) };
}

/** A lane registration a suite makes: the id handed to `archiveLane(...)`, and how the call stands. */
interface LaneRegistration {
  readonly id: string;
  /** `runs`: unconditionally; `skipped`: inside a skipped or placeholder block; `conditional`: inside `.skipIf` / `.runIf` or an `if` — it may not run. */
  readonly standing: 'runs' | 'skipped' | 'conditional';
}


const SKIPPED = /\.(skip|todo)\b/;
const CONDITIONAL = /\.(skipIf|runIf)\b/;

function standingOf(node: ts.Node): LaneRegistration['standing'] {
  let standing: LaneRegistration['standing'] = 'runs';
  ts.findAncestor(node.parent, (at) => {
    const called = ts.isCallExpression(at) ? at.expression.getText() : '';
    if (SKIPPED.test(called)) standing = 'skipped';
    else if (standing === 'runs' && (CONDITIONAL.test(called) || ts.isIfStatement(at) || ts.isConditionalExpression(at))) standing = 'conditional';
    return standing === 'skipped';
  });
  return standing;
}

/**
 * Every `archiveLane('<id>')` call in a test file's text, with how it stands.
 *
 * @param file - The file's path, for the parser
 * @param text - Its text
 */
export function laneRegistrations(file: string, text: string): LaneRegistration[] {
  const found: LaneRegistration[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'archiveLane') {
      const [id] = node.arguments;
      if (id !== undefined && ts.isStringLiteralLike(id)) found.push({ id: id.text, standing: standingOf(node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true));
  return found;
}
