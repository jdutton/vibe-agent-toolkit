/**
 * `ts__import_names` and `ts__exports` rows, collected node by node on the `ts` extractor's one
 * walk beside the `ts__imports` rows: imported by `ts-extractor.ts` alone, and reaching TypeScript
 * only as a type and through the module the extractor hands it.
 *
 * ## Import names
 *
 * One row per local binding a module reference creates, pointing at that reference's `ts__imports`
 * ordinal: an import clause's default (`default`), namespace (`*`) and named bindings (an
 * `import` declaration anywhere, a JSDoc `@import` tag); `import x = require()` (`*`); and, at
 * module scope, a variable declarator (`const`, `let` or `var`) whose initializer is a call that is
 * a `require` or `createRequire` row: a plain name binds the whole module (`*`), an object pattern
 * binds each property it names directly (`{ a: b }` is `imported = 'a'`, `local = 'b'`). A rest
 * element, a nested pattern, a computed key and an array pattern bind nothing nameable, so they are
 * no row. `typeOnly` is the statement's `type` or the element's inline `type`.
 *
 * ## Exports
 *
 * Top-level statements only (`module` scope): an `export` inside a namespace or a `declare module`
 * body is that body's, not the file's. One row per exported name or form, in source order, of the
 * ten kinds SPEC names. A default export is placed at its `default` keyword (the exported name's
 * token); `export *` at its specifier; `export =` and `module.exports =` at the assigned expression,
 * and they name no export (`name` is null: the whole module is replaced). CommonJS forms are
 * assignment expression statements (`=` only, each target of a chain) whose target is
 * `module.exports`, or a member of `exports` or `module.exports`, by spelling; `local` is the
 * assigned value when it is a bare identifier. Names and positions are always the name node's own
 * start (`getStart`), never the statement's.
 */

import type { TsExportRow, TsImportNameRow } from '../schemas/projection-ts.js';
import type ts from '../vendor/typescript.cjs';

import { positionOf } from './line-index.js';
import { type CollectedImports, estree, type ImportScope } from './ts-import-rows.js';

/** `ts__import_names` minus `blob` and `variant`. */
type NameRow = Omit<TsImportNameRow, 'blob' | 'variant'>;

/** `ts__exports` minus `blob` and `variant`. */
type ExportRow = Omit<TsExportRow, 'blob' | 'variant'>;

/** One binding before its reference is numbered. */
type Binding = Omit<NameRow, 'import' | 'seq'>;

/** The bindings of one module reference, before the reference is numbered. */
interface PendingBindings {
  /** The node the reference's `ts__imports` row is for. */
  readonly host: ts.Node;
  /** Whether the bindings stand only if that row is a `require` or `createRequire` (a declarator's call). */
  readonly requireOnly: boolean;
  readonly bindings: readonly Binding[];
}

/** One export before it is numbered: `host` is the declaration a module reference row is for, if any. */
interface PendingExport {
  readonly row: Omit<ExportRow, 'seq' | 'import'>;
  readonly host: ts.Node | undefined;
}

/** A member access read by name: `o.x`, `o['x']` or ``o[`x`]``. */
interface Member {
  readonly object: ts.Expression;
  readonly name: string;
  readonly at: ts.Node;
}

/** The call kinds whose result a declarator binds as a module. */
const REQUIRE_KINDS: ReadonlySet<string> = new Set(['require', 'createRequire']);

/** What the collected names and exports answer. */
interface CollectedNamesAndExports {
  readonly importNames: readonly NameRow[];
  readonly exports: readonly ExportRow[];
}

/** Collects `ts__import_names` and `ts__exports` rows as the extractor's walk visits each node. */
export class TsExportCollector {
  readonly #typescript: typeof ts;
  readonly #sourceFile: ts.SourceFile;
  readonly #starts: readonly number[];
  readonly #names: PendingBindings[] = [];
  readonly #exports: PendingExport[] = [];
  #scanner: ts.Scanner | undefined;

  constructor(typescript: typeof ts, sourceFile: ts.SourceFile, starts: readonly number[]) {
    this.#typescript = typescript;
    this.#sourceFile = sourceFile;
    this.#starts = starts;
  }

  /**
   * @param node - The next node, in walk order
   * @param scope - Its scope
   */
  visit(node: ts.Node, scope: ImportScope): void {
    const typescript = this.#typescript;
    if (typescript.isImportDeclaration(node) || typescript.isJSDocImportTag(node)) this.#importClause(node, node.importClause);
    else if (typescript.isImportEqualsDeclaration(node)) this.#importEquals(node, scope);
    else if (scope !== 'module') return;
    else if (typescript.isVariableDeclaration(node)) this.#requireBinding(node);
    else this.#exportForm(node);
  }

  /**
   * Number every binding against its reference's ordinal and every export in source order.
   *
   * @param imports - The numbered `ts__imports` rows
   * @returns The rows
   */
  finish(imports: CollectedImports): CollectedNamesAndExports {
    const importNames: NameRow[] = [];
    for (const { host, requireOnly, bindings } of this.#names) {
      const ordinal = imports.ordinals.get(host);
      if (ordinal === undefined) continue;
      if (requireOnly && !REQUIRE_KINDS.has(imports.rows[ordinal]?.kind ?? '')) continue;
      for (const [seq, binding] of bindings.entries()) importNames.push({ import: ordinal, seq, ...binding });
    }
    const exports = this.#exports.map(({ row, host }, seq) => ({ seq, ...row, import: host === undefined ? null : imports.ordinals.get(host) ?? null }));
    // Stable: bindings of one reference stay in source order.
    return { importNames: importNames.toSorted((left, right) => left.import - right.import), exports };
  }

  #importClause(host: ts.ImportDeclaration | ts.JSDocImportTag, clause: ts.ImportClause | undefined): void {
    if (clause === undefined) return;
    const typescript = this.#typescript;
    // `import type`: the clause's phase modifier (`isTypeOnly` is its deprecated spelling).
    const typeOnly = clause.phaseModifier === typescript.SyntaxKind.TypeKeyword;
    const bindings: Binding[] = [];
    if (clause.name !== undefined) bindings.push(this.#binding('default', clause.name, typeOnly));
    const named = clause.namedBindings;
    if (named !== undefined && typescript.isNamespaceImport(named)) bindings.push(this.#binding('*', named.name, typeOnly));
    if (named !== undefined && typescript.isNamedImports(named)) {
      for (const element of named.elements) {
        bindings.push(this.#binding((element.propertyName ?? element.name).text, element.name, typeOnly || element.isTypeOnly));
      }
    }
    this.#names.push({ host, requireOnly: false, bindings });
  }

  #importEquals(node: ts.ImportEqualsDeclaration, scope: ImportScope): void {
    if (this.#typescript.isExternalModuleReference(node.moduleReference)) {
      this.#names.push({ host: node, requireOnly: false, bindings: [this.#binding('*', node.name, node.isTypeOnly)] });
    }
    if (scope === 'module' && this.#exportModifiers(node) !== undefined) {
      this.#export({ name: node.name.text, kind: 'importAlias', local: node.name.text, typeOnly: node.isTypeOnly }, node.name);
    }
  }

  /** A module-scope declarator bound to a call: its bindings stand if the call is a `require` or `createRequire` row. */
  #requireBinding(node: ts.VariableDeclaration): void {
    const typescript = this.#typescript;
    if (node.initializer === undefined) return;
    const call = estree(typescript, node.initializer, true);
    if (call === undefined || !typescript.isCallExpression(call)) return;
    const bindings: Binding[] = [];
    if (typescript.isIdentifier(node.name)) bindings.push(this.#binding('*', node.name, false));
    else if (typescript.isObjectBindingPattern(node.name)) {
      for (const element of node.name.elements) {
        const imported = this.#propertyNameOf(element);
        if (imported !== undefined && typescript.isIdentifier(element.name)) bindings.push(this.#binding(imported, element.name, false));
      }
    }
    if (bindings.length > 0) this.#names.push({ host: call, requireOnly: true, bindings });
  }

  /** The property an object-pattern element reads, when it names one directly (no rest, no computed key). */
  #propertyNameOf(element: ts.BindingElement): string | undefined {
    const typescript = this.#typescript;
    if (element.dotDotDotToken !== undefined) return undefined;
    const property = element.propertyName ?? element.name;
    return typescript.isIdentifier(property) || typescript.isStringLiteral(property) ? property.text : undefined;
  }

  /** A top-level statement that may export. */
  #exportForm(node: ts.Node): void {
    const typescript = this.#typescript;
    if (typescript.isExportDeclaration(node)) this.#exportDeclaration(node);
    else if (typescript.isExportAssignment(node)) this.#exportAssignment(node);
    else if (typescript.isNamespaceExportDeclaration(node)) this.#export({ name: node.name.text, kind: 'globalNamespace' }, node.name);
    else if (typescript.isExpressionStatement(node)) this.#commonJs(node.expression);
    else this.#declaration(node);
  }

  #exportDeclaration(node: ts.ExportDeclaration): void {
    const typescript = this.#typescript;
    const clause = node.exportClause;
    const typeOnly = node.isTypeOnly;
    if (clause === undefined) {
      if (node.moduleSpecifier !== undefined) this.#export({ name: null, kind: 'star', typeOnly }, node.moduleSpecifier, node);
      return;
    }
    if (typescript.isNamespaceExport(clause)) {
      this.#export({ name: clause.name.text, kind: 'namespace', typeOnly }, clause.name, node);
      return;
    }
    const from = node.moduleSpecifier !== undefined;
    for (const element of clause.elements) {
      const source = (element.propertyName ?? element.name).text;
      const columns = from ? { kind: 'reexport' as const, imported: source } : { kind: 'local' as const, local: source };
      this.#export({ name: element.name.text, ...columns, typeOnly: typeOnly || element.isTypeOnly }, element.name, from ? node : undefined);
    }
  }

  #exportAssignment(node: ts.ExportAssignment): void {
    const expression = node.expression;
    const local = this.#typescript.isIdentifier(expression) ? expression.text : null;
    if (node.isExportEquals === true) {
      this.#export({ name: null, kind: 'assignment', local }, expression);
      return;
    }
    this.#exportAt({ name: 'default', kind: local === null ? 'expression' : 'local', local }, this.#defaultKeywordStart(node));
  }

  /** A declaration carrying an `export` modifier: one row per name it declares. */
  #declaration(node: ts.Node): void {
    const typescript = this.#typescript;
    const modifiers = this.#exportModifiers(node);
    if (modifiers === undefined) return;
    if (typescript.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        for (const name of this.#boundNames(declaration.name)) this.#export({ name: name.text, kind: 'declaration', local: name.text }, name);
      }
      return;
    }
    const name = this.#declaredName(node);
    if (name === undefined) return;
    const local = name === null ? null : name.text;
    const defaultKeyword = modifiers.find((modifier) => modifier.kind === typescript.SyntaxKind.DefaultKeyword);
    if (defaultKeyword !== undefined) this.#export({ name: 'default', kind: 'declaration', local }, defaultKeyword);
    else if (name !== null) this.#export({ name: name.text, kind: 'declaration', local }, name);
  }

  /**
   * @returns The declared name of a function, class, interface, type alias, enum or namespace (null
   *   for an anonymous default function or class), or undefined for any other node, a `declare
   *   module 'm'` and a `declare global`
   */
  #declaredName(node: ts.Node): ts.Identifier | null | undefined {
    const typescript = this.#typescript;
    if (typescript.isModuleDeclaration(node)) {
      const global = (node.flags & typescript.NodeFlags.GlobalAugmentation) !== 0;
      return typescript.isIdentifier(node.name) && !global ? node.name : undefined;
    }
    const named = typescript.isFunctionDeclaration(node) || typescript.isClassDeclaration(node) || typescript.isInterfaceDeclaration(node)
      || typescript.isTypeAliasDeclaration(node) || typescript.isEnumDeclaration(node);
    if (!named) return undefined;
    return node.name ?? null;
  }

  /** The identifiers a binding name declares, in source order, by an explicit stack. */
  #boundNames(root: ts.BindingName): ts.Identifier[] {
    const typescript = this.#typescript;
    const names: ts.Identifier[] = [];
    const stack: ts.BindingName[] = [root];
    for (let name = stack.pop(); name !== undefined; name = stack.pop()) {
      if (typescript.isIdentifier(name)) {
        names.push(name);
        continue;
      }
      const elements = name.elements as readonly ts.ArrayBindingElement[];
      for (let index = elements.length - 1; index >= 0; index -= 1) {
        const element = elements[index];
        if (element !== undefined && typescript.isBindingElement(element)) stack.push(element.name);
      }
    }
    return names;
  }

  /** Each target of an `=` chain that is `module.exports` or a member of `exports` or `module.exports`. */
  #commonJs(expression: ts.Expression): void {
    const typescript = this.#typescript;
    let current = expression;
    while (typescript.isBinaryExpression(current) && current.operatorToken.kind === typescript.SyntaxKind.EqualsToken) {
      const value = current.right;
      const local = typescript.isIdentifier(value) ? value.text : null;
      const target = this.#memberOf(current.left);
      if (target !== undefined && this.#isModuleExports(target)) this.#export({ name: null, kind: 'assignment', local }, value);
      else if (target !== undefined && this.#isExportsObject(target.object)) this.#export({ name: target.name, kind: 'cjs', local }, target.at);
      current = value;
    }
  }

  /** Whether `object` is `exports` or `module.exports`. */
  #isExportsObject(object: ts.Expression): boolean {
    if (this.#typescript.isIdentifier(object)) return object.text === 'exports';
    const member = this.#memberOf(object);
    return member !== undefined && this.#isModuleExports(member);
  }

  #isModuleExports(member: Member): boolean {
    return member.name === 'exports' && this.#typescript.isIdentifier(member.object) && member.object.text === 'module';
  }

  #memberOf(node: ts.Expression): Member | undefined {
    const typescript = this.#typescript;
    if (typescript.isPropertyAccessExpression(node) && typescript.isIdentifier(node.name)) {
      return { object: node.expression, name: node.name.text, at: node.name };
    }
    if (typescript.isElementAccessExpression(node)) {
      const key = node.argumentExpression;
      if (typescript.isStringLiteral(key) || typescript.isNoSubstitutionTemplateLiteral(key)) return { object: node.expression, name: key.text, at: key };
    }
    return undefined;
  }

  /** A node's modifiers when one is `export`, else undefined. */
  #exportModifiers(node: ts.Node): readonly ts.Modifier[] | undefined {
    const typescript = this.#typescript;
    if (!typescript.canHaveModifiers(node)) return undefined;
    const modifiers = typescript.getModifiers(node);
    return modifiers?.some((modifier) => modifier.kind === typescript.SyntaxKind.ExportKeyword) === true ? modifiers : undefined;
  }

  /** The start of `export default`'s `default` keyword: the token after `export`, read by the scanner. */
  #defaultKeywordStart(node: ts.ExportAssignment): number {
    const typescript = this.#typescript;
    this.#scanner ??= typescript.createScanner(typescript.ScriptTarget.Latest, true, this.#sourceFile.languageVariant, this.#sourceFile.text);
    this.#scanner.resetTokenState(node.getStart(this.#sourceFile));
    this.#scanner.scan();
    this.#scanner.scan();
    return this.#scanner.getTokenStart();
  }

  #binding(imported: string, local: ts.Identifier, typeOnly: boolean): Binding {
    return { imported, local: local.text, typeOnly, ...positionOf(local.getStart(this.#sourceFile), this.#starts) };
  }

  /** Add an export placed at `at`'s own start. */
  #export(columns: ExportColumns, at: ts.Node, host?: ts.Node): void {
    this.#exportAt(columns, at.getStart(this.#sourceFile), host);
  }

  #exportAt(columns: ExportColumns, offset: number, host?: ts.Node): void {
    const row = { local: null, imported: null, typeOnly: false, ...columns, ...positionOf(offset, this.#starts) };
    this.#exports.push({ row, host });
  }
}

/** The columns an export states: its name and kind, and any of the rest it sets. */
type ExportColumns = Pick<ExportRow, 'name' | 'kind'> & Partial<Pick<ExportRow, 'local' | 'imported' | 'typeOnly'>>;
