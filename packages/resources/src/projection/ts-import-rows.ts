/**
 * `ts__imports` rows, collected node by node on the `ts` extractor's one walk: imported by
 * `ts-extractor.ts` and its sibling `ts-export-rows.ts` alone, and reaching TypeScript only as a type and through the module and
 * internals the extractor hands it.
 *
 * ## Kinds
 *
 * One row per module reference of SPEC's closed kind list. `require` is a call whose callee is the
 * identifier `require`, by spelling. `createRequire` is recognised exactly as
 * `local/projection-sqlite-import-boundary` (`utils/eslint/rules/projection-sqlite-import-boundary.cjs`)
 * recognises it, so the rule's port to these rows is not narrower. That rule reads ESTree, so the
 * tree is read here as ESTree shapes it: parentheses vanish, and an optional chain is wrapped in a
 * `ChainExpression` where it ends (a parenthesized chain, or a chain that is a declarator's whole
 * initializer), which is then neither a call nor a member. Its names come from the whole file
 * before any call is judged (a call above its binding counts), so a call that may be one is held
 * until {@link TsImportCollector.finish}. Like the rule, a name bound to a `createRequire(...)`
 * result counts by spelling wherever it is declared; the rule reads only a variable's first
 * declarator, so a redeclared `var` whose first declarator is something else is the one shape the
 * two can answer differently.
 *
 * ## Order and positions
 *
 * Rows are numbered in source order: by the start of the node that carries each, ties in walk
 * (pre-order) order. Triple-slash directives are not nodes; each is placed at its value
 * (`FileReference.pos`). Line and column come from the shared line index, never TypeScript's.
 */

import type { TsImportRow } from '../schemas/projection-ts.js';
import type ts from '../vendor/typescript.cjs';

import { positionOf } from './line-index.js';

/** `ts__imports` minus `blob` and `variant`. */
type ImportRow = Omit<TsImportRow, 'blob' | 'variant'>;

/** Where a module reference stands. */
export type ImportScope = TsImportRow['scope'];

/** The TypeScript internals the import rows read, outside the public typings. */
export interface TsImportInternals {
  getResolutionModeOverride(attributes: ts.ImportAttributes | undefined): ts.ResolutionMode | undefined;
  isExclusivelyTypeOnlyImportOrExport(declaration: ts.ImportDeclaration | ts.ExportDeclaration): boolean;
}

/** The module `createRequire` is imported from. */
const MODULE_MODULES: ReadonlySet<string> = new Set(['module', 'node:module']);

/** The columns every row states, before the kind's own. */
const DEFAULTS = {
  argumentCount: null,
  typeOnly: false,
  hasClause: false,
  hasDefault: false,
  hasNamespace: false,
  namedBindings: null,
  typeOnlyNamed: null,
  resolutionMode: null,
  attributeType: null,
} as const;

/** The columns a kind states: its kind and placement, and any of the rest it sets. */
type KindColumns = Partial<ImportRow> & Pick<ImportRow, 'kind' | 'specifier' | 'specifierForm' | 'line' | 'column' | 'nodeLine' | 'nodeColumn'>;

/** A row before it is numbered, with what orders it. */
interface Candidate {
  readonly row: Omit<ImportRow, 'ordinal'>;
  /** The offset of the carrying node's start (a directive's value): the order key. */
  readonly key: number;
  /** The node the row is for, or undefined for a triple-slash directive. */
  readonly host: ts.Node | undefined;
}

/** A call that is a `createRequire` row only if the whole file's names say so. */
interface PendingCall {
  readonly call: ts.CallExpression;
  readonly scope: ImportScope;
  readonly seq: number;
}

/** What the collected rows answer. */
export interface CollectedImports {
  readonly rows: readonly ImportRow[];
  /** The ordinal of each node a row is for: how `ts__import_names` and `ts__exports` point at a row. */
  readonly ordinals: ReadonlyMap<ts.Node, number>;
}

/**
 * The scope of a child node, from its parent's: a top-level statement is `module`; a statement in
 * a `declare module 'm'` body (and the body itself) is `ambientModule`; entering a function with a body, a class, a block, a nested
 * statement or any other module body makes it `nested`, and nothing undoes that.
 *
 * @param typescript - The loaded TypeScript
 * @param parent - The parent node
 * @param parentScope - The parent's scope
 * @param child - The child node
 * @returns The child's scope
 */
export function childScope(typescript: typeof ts, parent: ts.Node, parentScope: ImportScope, child: ts.Node): ImportScope {
  const kinds = typescript.SyntaxKind;
  if (parent.kind === kinds.SourceFile) return 'module';
  // The parse sets no parent links, so the body of a `declare module 'm'` carries the scope down.
  if (typescript.isModuleDeclaration(parent) && typescript.isStringLiteral(parent.name) && child.kind === kinds.ModuleBlock) return 'ambientModule';
  if (parent.kind === kinds.ModuleBlock && parentScope === 'ambientModule') return 'ambientModule';
  if (parentScope === 'nested' || opensRuntimeBody(typescript, parent) || typescript.isClassLike(parent) || isNestingStatement(typescript, child)) return 'nested';
  return parentScope;
}

/**
 * @param typescript - The loaded TypeScript
 * @param node - A node
 * @returns Whether it opens a runtime function body: a function declaration or expression, an arrow, a method, an
 *   accessor or a constructor that HAS a body. A function type, a constructor type, a call, construct, method or
 *   index signature, a JSDoc signature or `@callback`, and a body-less (ambient or overload) declaration are
 *   types, and a reference in one runs at the scope it is written in
 */
function opensRuntimeBody(typescript: typeof ts, node: ts.Node): boolean {
  return (
    (typescript.isFunctionDeclaration(node) || typescript.isFunctionExpression(node) || typescript.isArrowFunction(node) ||
      typescript.isMethodDeclaration(node) || typescript.isGetAccessorDeclaration(node) || typescript.isSetAccessorDeclaration(node) ||
      typescript.isConstructorDeclaration(node)) && node.body !== undefined
  );
}

/**
 * @param typescript - The loaded TypeScript
 * @param node - A node
 * @returns Whether it is a statement or a body that holds statements
 */
function isNestingStatement(typescript: typeof ts, node: ts.Node): boolean {
  const kinds = typescript.SyntaxKind;
  if (node.kind >= kinds.FirstStatement && node.kind <= kinds.LastStatement) return true;
  return node.kind === kinds.Block || node.kind === kinds.ModuleBlock || node.kind === kinds.CaseBlock || node.kind === kinds.ClassStaticBlockDeclaration;
}

/** The ESTree view of an expression: parentheses dropped, and undefined where ESTree has a `ChainExpression`. */
export function estree(typescript: typeof ts, expression: ts.Expression, chainEnds: boolean): ts.Expression | undefined {
  let inner = expression;
  let parenthesized = false;
  while (typescript.isParenthesizedExpression(inner)) {
    inner = inner.expression;
    parenthesized = true;
  }
  return (parenthesized || chainEnds) && typescript.isOptionalChain(inner) ? undefined : inner;
}

/** The text and form of a string literal or substitution-free template, else nulls. */
function specifierOf(typescript: typeof ts, node: ts.Node | undefined): Pick<ImportRow, 'specifier' | 'specifierForm'> {
  if (node !== undefined && typescript.isStringLiteral(node)) return { specifier: node.text, specifierForm: 'string' };
  if (node !== undefined && typescript.isNoSubstitutionTemplateLiteral(node)) return { specifier: node.text, specifierForm: 'template' };
  return { specifier: null, specifierForm: null };
}

/** The clause columns of an import clause (absent: none). */
function importClauseColumns(typescript: typeof ts, clause: ts.ImportClause | undefined): Partial<ImportRow> {
  if (clause === undefined) return {};
  const bindings = clause.namedBindings;
  const named = bindings !== undefined && typescript.isNamedImports(bindings) ? bindings.elements : undefined;
  return {
    hasClause: true,
    hasDefault: clause.name !== undefined,
    hasNamespace: bindings !== undefined && typescript.isNamespaceImport(bindings),
    ...namedColumns(named),
  };
}

/** `namedBindings` and `typeOnlyNamed` of a named clause's elements. */
function namedColumns(elements: readonly (ts.ImportSpecifier | ts.ExportSpecifier)[] | undefined): Partial<ImportRow> {
  if (elements === undefined) return {};
  return { namedBindings: elements.length, typeOnlyNamed: elements.filter((element) => element.isTypeOnly).length };
}

/** Collects `ts__imports` rows as the extractor's walk visits each node. */
export class TsImportCollector {
  readonly #typescript: typeof ts;
  readonly #internals: TsImportInternals;
  readonly #sourceFile: ts.SourceFile;
  readonly #starts: readonly number[];
  readonly #candidates: { candidate: Candidate; seq: number }[] = [];
  readonly #pending: PendingCall[] = [];
  /** Local names a top-level import binds `createRequire` from `module` or `node:module` to. */
  readonly #creators = new Set(['createRequire']);
  /** Every variable declarator binding a plain name to a call: a `createRequire` binding if the call is one. */
  readonly #bindings: { readonly name: string; readonly call: ts.CallExpression }[] = [];
  #seq = 0;

  constructor(typescript: typeof ts, internals: TsImportInternals, sourceFile: ts.SourceFile, starts: readonly number[]) {
    this.#typescript = typescript;
    this.#internals = internals;
    this.#sourceFile = sourceFile;
    this.#starts = starts;
  }

  /**
   * @param node - The next node, in walk order
   * @param scope - Its scope
   * @param inJsDoc - Whether it lies in a JSDoc comment
   */
  visit(node: ts.Node, scope: ImportScope, inJsDoc: boolean): void {
    const typescript = this.#typescript;
    if (typescript.isImportDeclaration(node)) this.#importDeclaration(node, scope);
    else if (typescript.isExportDeclaration(node)) this.#exportDeclaration(node, scope);
    else if (typescript.isImportEqualsDeclaration(node)) this.#importEquals(node, scope);
    else if (typescript.isCallExpression(node)) this.#call(node, scope);
    else if (typescript.isVariableDeclaration(node)) this.#declarator(node);
    else if (typescript.isImportTypeNode(node)) this.#importType(node, scope, inJsDoc);
    else if (typescript.isJSDocImportTag(node)) this.#jsdocImport(node, scope);
    else if (typescript.isModuleDeclaration(node) && typescript.isStringLiteral(node.name)) {
      this.#add(node, scope, { kind: 'ambient', ...this.#placed(node.name, node) });
    }
  }

  /**
   * Resolve the held calls against the whole file's names, add the triple-slash directives, and
   * number every row in source order.
   *
   * @returns The rows and the ordinal of each node a row is for
   */
  finish(): CollectedImports {
    const requireNames = new Set(this.#bindings.filter(({ call }) => this.#isCreatorCall(call)).map(({ name }) => name));
    for (const { call, scope, seq } of this.#pending) {
      const callee = estree(this.#typescript, call.expression, false);
      const recognised = callee !== undefined
        && ((this.#typescript.isIdentifier(callee) && requireNames.has(callee.text))
          || (this.#typescript.isCallExpression(callee) && this.#isCreatorCall(callee)));
      if (recognised) this.#candidates.push({ candidate: this.#callCandidate(call, scope, 'createRequire'), seq });
    }
    this.#directives();
    const ordered = this.#candidates.toSorted((left, right) => left.candidate.key - right.candidate.key || left.seq - right.seq);
    const ordinals = new Map<ts.Node, number>();
    const rows = ordered.map(({ candidate }, ordinal) => {
      if (candidate.host !== undefined) ordinals.set(candidate.host, ordinal);
      return { ordinal, ...candidate.row };
    });
    return { rows, ordinals };
  }

  #importDeclaration(node: ts.ImportDeclaration, scope: ImportScope): void {
    // An import declaration is a statement: `module` scope is exactly the top level.
    if (scope === 'module') this.#collectCreators(node);
    this.#add(node, scope, {
      kind: 'import',
      ...this.#placed(node.moduleSpecifier, node),
      typeOnly: this.#internals.isExclusivelyTypeOnlyImportOrExport(node),
      ...importClauseColumns(this.#typescript, node.importClause),
      ...this.#attributeColumns(node.attributes),
    });
  }

  #exportDeclaration(node: ts.ExportDeclaration, scope: ImportScope): void {
    if (node.moduleSpecifier === undefined) return;
    const clause = node.exportClause;
    const named = clause !== undefined && this.#typescript.isNamedExports(clause) ? clause.elements : undefined;
    this.#add(node, scope, {
      kind: 'export',
      ...this.#placed(node.moduleSpecifier, node),
      typeOnly: this.#internals.isExclusivelyTypeOnlyImportOrExport(node),
      hasClause: clause !== undefined,
      hasNamespace: clause !== undefined && this.#typescript.isNamespaceExport(clause),
      ...namedColumns(named),
      ...this.#attributeColumns(node.attributes),
    });
  }

  #importEquals(node: ts.ImportEqualsDeclaration, scope: ImportScope): void {
    const reference = node.moduleReference;
    if (!this.#typescript.isExternalModuleReference(reference)) return;
    this.#add(node, scope, { kind: 'importEquals', ...this.#placed(reference.expression, reference), typeOnly: node.isTypeOnly });
  }

  #call(node: ts.CallExpression, scope: ImportScope): void {
    const typescript = this.#typescript;
    if (node.expression.kind === typescript.SyntaxKind.ImportKeyword) {
      this.#push(this.#callCandidate(node, scope, 'dynamic'));
      return;
    }
    const callee = estree(typescript, node.expression, false);
    if (callee === undefined) return;
    if (typescript.isIdentifier(callee) && callee.text === 'require') this.#push(this.#callCandidate(node, scope, 'require'));
    else if (typescript.isIdentifier(callee) || typescript.isCallExpression(callee)) this.#pending.push({ call: node, scope, seq: this.#nextSeq() });
  }

  #declarator(node: ts.VariableDeclaration): void {
    if (!this.#typescript.isIdentifier(node.name) || node.initializer === undefined) return;
    const init = estree(this.#typescript, node.initializer, true);
    if (init !== undefined && this.#typescript.isCallExpression(init)) this.#bindings.push({ name: node.name.text, call: init });
  }

  #importType(node: ts.ImportTypeNode, scope: ImportScope, inJsDoc: boolean): void {
    const argument = node.argument;
    const literal = this.#typescript.isLiteralTypeNode(argument) ? argument.literal : argument;
    const placed = this.#placed(literal, this.#importTypeCarrier(node));
    this.#add(node, scope, {
      kind: inJsDoc ? 'jsdocImportType' : 'importType',
      ...placed,
      ...(inJsDoc ? { nodeLine: placed.line, nodeColumn: placed.column } : {}),
      ...this.#attributeColumns(node.attributes),
    });
  }

  /**
   * Where an import type stands as ESTree places it: a `typeof import('m')` is a type query around
   * the import type, which starts at its `import` keyword, not at `typeof` as TypeScript's node does.
   */
  #importTypeCarrier(node: ts.ImportTypeNode): ts.Node {
    if (!node.isTypeOf) return node;
    const keyword = this.#typescript.SyntaxKind.ImportKeyword;
    return node.getChildren(this.#sourceFile).find((child) => child.kind === keyword) ?? node;
  }

  #jsdocImport(node: ts.JSDocImportTag, scope: ImportScope): void {
    const placed = this.#placed(node.moduleSpecifier, node);
    this.#add(node, scope, {
      kind: 'jsdocImport',
      ...placed,
      nodeLine: placed.line,
      nodeColumn: placed.column,
      ...importClauseColumns(this.#typescript, node.importClause),
      ...this.#attributeColumns(node.attributes),
    });
  }

  /** The triple-slash directives, each placed at its value. */
  #directives(): void {
    const file = this.#sourceFile;
    const groups: readonly (readonly [ImportRow['kind'], readonly ts.FileReference[]])[] = [
      ['referencePath', file.referencedFiles],
      ['referenceTypes', file.typeReferenceDirectives],
      ['referenceLib', file.libReferenceDirectives],
    ];
    for (const [kind, references] of groups) {
      for (const reference of references) {
        const { line, column } = positionOf(reference.pos, this.#starts);
        const row = {
          ...DEFAULTS,
          kind,
          specifier: reference.fileName,
          specifierForm: 'string' as const,
          resolutionMode: this.#resolutionModeName(reference.resolutionMode),
          scope: 'module' as const,
          line,
          column,
          nodeLine: line,
          nodeColumn: column,
        };
        this.#push({ row, key: reference.pos, host: undefined });
      }
    }
  }

  /** Record the local names a top-level import from `module` or `node:module` binds `createRequire` to. */
  #collectCreators(node: ts.ImportDeclaration): void {
    const typescript = this.#typescript;
    if (!typescript.isStringLiteral(node.moduleSpecifier) || !MODULE_MODULES.has(node.moduleSpecifier.text)) return;
    const bindings = node.importClause?.namedBindings;
    if (bindings === undefined || !typescript.isNamedImports(bindings)) return;
    for (const element of bindings.elements) {
      if ((element.propertyName ?? element.name).text === 'createRequire') this.#creators.add(element.name.text);
    }
  }

  /** Whether `call` calls `createRequire`: by a creator name, or as a member `X.createRequire`. */
  #isCreatorCall(call: ts.CallExpression): boolean {
    const typescript = this.#typescript;
    const callee = estree(typescript, call.expression, false);
    if (callee === undefined) return false;
    if (typescript.isIdentifier(callee)) return this.#creators.has(callee.text);
    return typescript.isPropertyAccessExpression(callee) && typescript.isIdentifier(callee.name) && callee.name.text === 'createRequire';
  }

  #callCandidate(call: ts.CallExpression, scope: ImportScope, kind: 'dynamic' | 'require' | 'createRequire'): Candidate {
    // ESTree drops the parentheses of an argument, so a rule sees the literal inside `import(('m'))`: so does the row.
    return this.#candidate(call, scope, { kind, ...this.#placed(this.#seeThroughParentheses(call.arguments[0]), call), argumentCount: call.arguments.length });
  }

  /** The argument without its parentheses when a specifier lies inside them, else the argument itself. */
  #seeThroughParentheses(argument: ts.Expression | undefined): ts.Expression | undefined {
    let inner = argument;
    while (inner !== undefined && this.#typescript.isParenthesizedExpression(inner)) inner = inner.expression;
    return inner !== undefined && specifierOf(this.#typescript, inner).specifier !== null ? inner : argument;
  }

  /** `resolutionMode` and `attributeType` of an attributes clause. */
  #attributeColumns(attributes: ts.ImportAttributes | undefined): Partial<ImportRow> {
    if (attributes === undefined) return {};
    const type = attributes.elements.find((element) => element.name.text === 'type')?.value;
    return {
      resolutionMode: this.#resolutionModeName(this.#internals.getResolutionModeOverride(attributes)),
      attributeType: type !== undefined && this.#typescript.isStringLiteral(type) ? type.text : null,
    };
  }

  #resolutionModeName(mode: ts.ResolutionMode | undefined): ImportRow['resolutionMode'] {
    if (mode === this.#typescript.ModuleKind.ESNext) return 'import';
    if (mode === this.#typescript.ModuleKind.CommonJS) return 'require';
    return null;
  }

  /** The specifier columns and positions: the specifier's start (the carrier's when there is none) and the carrier's. */
  #placed(specifier: ts.Node | undefined, carrier: ts.Node): Pick<ImportRow, 'specifier' | 'specifierForm' | 'line' | 'column' | 'nodeLine' | 'nodeColumn'> {
    const nodeStart = carrier.getStart(this.#sourceFile);
    const at = positionOf(specifier === undefined ? nodeStart : specifier.getStart(this.#sourceFile), this.#starts);
    const node = positionOf(nodeStart, this.#starts);
    return { ...specifierOf(this.#typescript, specifier), line: at.line, column: at.column, nodeLine: node.line, nodeColumn: node.column };
  }

  #candidate(host: ts.Node, scope: ImportScope, columns: KindColumns): Candidate {
    return { row: { ...DEFAULTS, scope, ...columns }, key: host.getStart(this.#sourceFile), host };
  }

  #add(host: ts.Node, scope: ImportScope, columns: KindColumns): void {
    this.#push(this.#candidate(host, scope, columns));
  }

  #push(candidate: Candidate): void {
    this.#candidates.push({ candidate, seq: this.#nextSeq() });
  }

  #nextSeq(): number {
    this.#seq += 1;
    return this.#seq;
  }
}
