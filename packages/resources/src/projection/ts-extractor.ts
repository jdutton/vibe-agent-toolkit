/**
 * The `ts` instance's extractor: one TypeScript or JavaScript file's decoded text and its variant
 * in, its row set out (`ts__files`, `ts__imports`, `ts__import_names`, `ts__exports`), minus the
 * `blob` and `variant` columns the row-set stage adds.
 *
 * It runs in the parse worker only: TypeScript's parser recurses on nesting, so it never runs on the
 * main thread over document bytes. `parser-loader.ts` is its one importer, and it reaches the
 * vendored TypeScript through `vendored-typescript.ts` alone (`parser-import-boundary.test.ts`).
 * The core, {@link extractTsRows}, takes the TypeScript module as a parameter, so a unit test runs it
 * in-process and can wrap the module it is handed.
 *
 * ## The parse
 *
 * `createSourceFile` under a fixed synthetic name per variant ({@link SYNTHETIC_NAMES}), never the
 * real path: the parser reads the name only to decide the script kind (passed explicitly here) and
 * whether the file is a declaration file (the `dts` variant), so the rows are a function of the
 * bytes and the variant alone. JSDoc is parsed as tsc parses it (`ParseForTypeErrors`: in
 * JavaScript files only). No program, binder or checker runs.
 *
 * ## Structure before the parse
 *
 * Before the parse, an iterative pass over TypeScript's own scanner ({@link nestingDepth}) counts the
 * deepest nesting of `(`, `[`, `{` and template substitutions. Past `outputDepth` the file is the
 * depth breach, refused before anything recurses. A `/` that starts an expression is rescanned as a
 * regular-expression literal (so a bracket or backtick inside one is not counted); what the scan
 * still cannot tell from code is JSX text, and a `/` after `)`, `]`, `}`, `>` or a non-null `!`
 * (`a! / (`), which it reads as division. A miscount there moves the count either way: too high refuses a file the parser would
 * read (the depth breach), too low leaves the parse to the stack guard (a stack breach). Neither
 * answers rows from a wrong tree.
 *
 * ## Parse errors are defects
 *
 * `createSourceFile` always returns a tree, recovering from errors, and a recovered tree can invent
 * or drop an import. So any entry in the source file's `parseDiagnostics` is `TS_PARSE_ERROR`, whose
 * message names the first diagnostic's code and its line and column (by the shared line index), never
 * source text. TypeScript-only syntax in a `js` file is reported by a program-level check, not by
 * the parser, so such a file yields rows describing the syntax as written.
 *
 * JSDoc errors are not parse errors. TypeScript records them apart, in `jsDocDiagnostics`, and a
 * comment typo must not refuse a real file, so a JSDoc comment whose span holds any such error
 * contributes no rows (`@import * from 'm'` would otherwise bind a local called `from`) and the
 * file is still extracted. A comment TypeScript attaches to more than one host is read once, by its span.
 *
 * ## Rows
 *
 * `ts__files`: `moduleSyntax` (TypeScript's `isFileProbablyExternalModule`) and `hasJsx` (a JSX
 * element, self-closing element or fragment anywhere in the tree; TypeScript's own
 * `walkTreeForJSXTags` is not exported, so VAT walks the tree itself). The walk is one iterative
 * pass with an explicit stack, in source order, that the other tables' rows are collected on:
 * `ts__imports` by `ts-import-rows.ts`, `ts__import_names` and `ts__exports` by `ts-export-rows.ts`,
 * which point at an import by the ordinal the first assigns. The
 * whole row set is held to the output caps by `settleRows`, the one rule every row-set answer is
 * held to.
 */

import { type OutputLimitName, type ParseLimits, factsOutputBreach } from '../parse-limits.js';
import type {
  TsExportRow,
  TsFileRow,
  TsImportNameRow,
  TsImportRow,
  TsVariant,
} from '../schemas/projection-ts.js';
import type ts from '../vendor/typescript.cjs';
import { loadVendoredTypeScript, vendoredTypeScriptLacks } from '../vendored-typescript.js';

import type { RowSetExtraction } from './data-extractor.js';
import { placedMessage, settleRows } from './data-row-rules.js';
import { lineStarts } from './line-index.js';
import { TsExportCollector } from './ts-export-rows.js';
import { childScope, type ImportScope, TsImportCollector, type TsImportInternals } from './ts-import-rows.js';

/** A row of the instance's tables minus the pair the row-set stage adds: the extractor never sees the content key. */
type WithoutPair<Row> = Omit<Row, 'blob' | 'variant'>;

/** `ts__files` minus `blob` and `variant`. */
type ExtractedTsFile = WithoutPair<TsFileRow>;

/** `ts__imports` minus `blob` and `variant`. */
export type ExtractedTsImport = WithoutPair<TsImportRow>;

/** `ts__import_names` minus `blob` and `variant`. */
export type ExtractedTsImportName = WithoutPair<TsImportNameRow>;

/** `ts__exports` minus `blob` and `variant`. */
export type ExtractedTsExport = WithoutPair<TsExportRow>;

/** One file's row set, minus the `blob` and `variant` columns. */
export interface ExtractedTsRows {
  readonly files: readonly [ExtractedTsFile];
  readonly imports: readonly ExtractedTsImport[];
  readonly importNames: readonly ExtractedTsImportName[];
  readonly exports: readonly ExtractedTsExport[];
}

/** The document defects the bytes alone decide: each is a `defective` pair. */
export const TS_DEFECT_CODES = ['TS_PARSE_ERROR'] as const;

/** One {@link TS_DEFECT_CODES} member. */
export type TsDefectCode = (typeof TS_DEFECT_CODES)[number];

/** What one `ts` extraction answers: the rows, a `TS_PARSE_ERROR`, or the output cap breached. */
export type TsExtraction = RowSetExtraction<ExtractedTsRows, TsDefectCode>;

/** What a `ts` job settles to on the pool: a breach never resolves, the pool rejects it. */
export type TsRowsAnswer = Exclude<TsExtraction, { readonly outcome: 'breach' }>;

/** One file to extract. */
export interface TsExtractInput {
  /** The decoded text, BOM stripped. */
  readonly text: string;
  readonly variant: TsVariant;
}

/** The extraction bound to a loaded TypeScript: what the parse worker calls. */
export type TsExtract = (input: TsExtractInput, limits: Pick<ParseLimits, OutputLimitName>) => TsExtraction;

/** The fixed file name each variant parses under: never the real path, so rows never depend on it. */
export const SYNTHETIC_NAMES: Readonly<Record<TsVariant, string>> = Object.freeze({
  ts: 'vat.ts',
  dts: 'vat.d.ts',
  tsx: 'vat.tsx',
  js: 'vat.js',
});

/**
 * The internals the extractor reads, outside TypeScript's public typings: the one typed view of
 * them, checked by {@link internalsOf} before any is called.
 */
interface TypeScriptParseInternals extends TsImportInternals {
  isFileProbablyExternalModule(sourceFile: ts.SourceFile): ts.Node | undefined;
}

/** The internals {@link internalsOf} checks, by name. */
const INTERNAL_NAMES = ['isFileProbablyExternalModule', 'getResolutionModeOverride', 'isExclusivelyTypeOnlyImportOrExport'] as const;

/** A parsed source file's own diagnostics, a property outside the public typings. */
interface WithParseDiagnostics {
  readonly parseDiagnostics?: unknown;
}

/** A parsed source file's JSDoc parse errors, a property outside the public typings, absent when there are none. */
interface WithJsDocDiagnostics {
  readonly jsDocDiagnostics?: unknown;
}

/** Who calls the internals, as a missing-internal refusal names it. */
const CALLER = 'the ts extractor';

/**
 * Load the vendored TypeScript and return the extraction bound to it. Refuses rather than guesses
 * when an internal the extraction calls is missing.
 *
 * @returns The extraction
 * @throws {ParserUnavailableError} If TypeScript cannot be loaded, or lacks an internal the extraction reads
 */
export async function loadTsExtract(): Promise<TsExtract> {
  const typescript = await loadVendoredTypeScript();
  internalsOf(typescript);
  assertJsDocAttached(typescript);
  return (input, limits) => extractTsRows(typescript, input, limits);
}

/**
 * @param typescript - The loaded TypeScript
 * @returns Its internals the extraction calls
 * @throws {ParserUnavailableError} If one is missing
 */
function internalsOf(typescript: typeof ts): TypeScriptParseInternals {
  const internals = typescript as unknown as Partial<Record<(typeof INTERNAL_NAMES)[number], unknown>>;
  for (const name of INTERNAL_NAMES) {
    if (typeof internals[name] !== 'function') throw vendoredTypeScriptLacks(name, CALLER);
  }
  return internals as unknown as TypeScriptParseInternals;
}

/**
 * @param sourceFile - A parsed file
 * @returns Its parse diagnostics
 * @throws {ParserUnavailableError} If the parsed file carries none: a TypeScript whose recovery
 *   this extraction could no longer see would answer every broken file as rows
 */
function parseDiagnosticsOf(sourceFile: ts.SourceFile): readonly ts.DiagnosticWithLocation[] {
  const diagnostics = (sourceFile as WithParseDiagnostics).parseDiagnostics;
  if (!Array.isArray(diagnostics)) throw vendoredTypeScriptLacks('parseDiagnostics on a parsed source file', CALLER);
  return diagnostics as readonly ts.DiagnosticWithLocation[];
}

/**
 * @param sourceFile - A parsed file
 * @returns Its JSDoc parse errors (none when TypeScript recorded none)
 */
function jsDocErrorsOf(sourceFile: ts.SourceFile): readonly ts.DiagnosticWithLocation[] {
  const errors = (sourceFile as WithJsDocDiagnostics).jsDocDiagnostics;
  return Array.isArray(errors) ? (errors as readonly ts.DiagnosticWithLocation[]) : [];
}

/**
 * @param typescript - The loaded TypeScript
 * @param variant - The variant
 * @returns The `ScriptKind` it parses as: `TSX` for `tsx`, `JS` for `js`, `TS` otherwise
 */
function scriptKindOf(typescript: typeof ts, variant: TsVariant): ts.ScriptKind {
  if (variant === 'tsx') return typescript.ScriptKind.TSX;
  if (variant === 'js') return typescript.ScriptKind.JS;
  return typescript.ScriptKind.TS;
}

/**
 * @param typescript - The loaded TypeScript
 * @param variant - The variant
 * @returns The language variant its scanner reads under: JSX for `tsx` and `js`, as their script kinds do
 */
function languageVariantOf(typescript: typeof ts, variant: TsVariant): ts.LanguageVariant {
  return variant === 'tsx' || variant === 'js' ? typescript.LanguageVariant.JSX : typescript.LanguageVariant.Standard;
}

/**
 * Extract one file's row set: the job, in-process. The worker calls it through
 * {@link loadTsExtract}; a unit test calls it directly with the loaded (or a wrapped) TypeScript.
 *
 * @param typescript - The loaded TypeScript
 * @param input - The decoded text and its variant
 * @param limits - The output caps in force
 * @returns The rows, a `TS_PARSE_ERROR`, or the output cap breached
 * @throws {ParserUnavailableError} If an internal the extraction reads is missing
 */
export function extractTsRows(typescript: typeof ts, input: TsExtractInput, limits: Pick<ParseLimits, OutputLimitName>): TsExtraction {
  const internals = internalsOf(typescript);
  const depth = nestingDepth(typescript, input.text, input.variant);
  // The one cap rule, applied to the depth alone before anything recurses.
  const deep = factsOutputBreach({}, limits, { rows: 0, bytes: 0, depth });
  if (deep !== undefined) return { outcome: 'breach', limit: deep.limit, found: deep.found };

  const sourceFile = typescript.createSourceFile(
    SYNTHETIC_NAMES[input.variant],
    input.text,
    { languageVersion: typescript.ScriptTarget.Latest, jsDocParsingMode: typescript.JSDocParsingMode.ParseForTypeErrors },
    false,
    scriptKindOf(typescript, input.variant),
  );
  const [first] = parseDiagnosticsOf(sourceFile);
  if (first !== undefined) {
    return { outcome: 'defect', code: 'TS_PARSE_ERROR', message: placedMessage(`TS${String(first.code)}`, first.start, lineStarts(input.text)) };
  }

  const starts = lineStarts(input.text);
  const collector = new TsRowCollector(
    typescript,
    new TsImportCollector(typescript, internals, sourceFile, starts),
    new TsExportCollector(typescript, sourceFile, starts),
  );
  walkTree(typescript, sourceFile, input.variant === 'js' ? jsDocErrorsOf(sourceFile) : undefined, (node, scope, inJsDoc) => {
    collector.visit(node, scope, inJsDoc);
  });
  // `ordinals` is what `ts__import_names` and `ts__exports` point at a row by.
  const imports = collector.imports.finish();
  const { importNames, exports } = collector.exports.finish(imports);
  const rows: ExtractedTsRows = {
    files: [{ moduleSyntax: internals.isFileProbablyExternalModule(sourceFile) !== undefined, hasJsx: collector.hasJsx }],
    imports: imports.rows,
    importNames,
    exports,
  };
  return settleRows(rows, limits);
}

/** What a substitution's open level waits for: a `}` the scanner rescans as a template continuation. */
const SUBSTITUTION = 'substitution';

/**
 * @param typescript - The loaded TypeScript
 * @returns A test of whether a `/` after the given token starts an expression (a regular-expression
 *   literal) rather than dividing: false after an operand (an identifier, a literal, `this`, `super`,
 *   `)`, `]`, `}`, `>`, `++`, `--`), true after anything else, a reserved word such as `return` included
 */
function expressionStartTest(typescript: typeof ts): (previous: ts.SyntaxKind) => boolean {
  const kinds = typescript.SyntaxKind;
  const operands = new Set<ts.SyntaxKind>([
    kinds.Identifier, kinds.PrivateIdentifier, kinds.NumericLiteral, kinds.BigIntLiteral, kinds.StringLiteral,
    kinds.RegularExpressionLiteral, kinds.NoSubstitutionTemplateLiteral, kinds.TemplateTail,
    kinds.CloseParenToken, kinds.CloseBracketToken, kinds.CloseBraceToken, kinds.GreaterThanToken,
    kinds.PlusPlusToken, kinds.MinusMinusToken, kinds.ThisKeyword, kinds.SuperKeyword, kinds.NullKeyword,
    kinds.TrueKeyword, kinds.FalseKeyword,
  ]);
  return (previous) => {
    if (operands.has(previous)) return false;
    // A contextual keyword (`type`, `of`, `async`) is usable as a name: an operand.
    return previous <= kinds.LastReservedWord;
  };
}

/**
 * How deep the text's `(`, `[`, `{` and template substitutions nest, by TypeScript's scanner alone
 * (a loop, never a recursion), under the variant's language variant. It keeps a stack of what each
 * open level waits for: an opener pushes its closer, a template head pushes a substitution, and the
 * matching closer pops. A `}` that closes a substitution is rescanned as a template token: a middle
 * continues the same level, a tail closes it. A closer that does not match the innermost level is
 * not counted as closing it, so the count never falls below what the parser's recovery may nest.
 * Comments and string literals are single tokens, so their brackets do not count.
 *
 * @param typescript - The loaded TypeScript
 * @param text - The document
 * @param variant - Its variant
 * @returns The deepest nesting (0 for none)
 */
export function nestingDepth(typescript: typeof ts, text: string, variant: TsVariant): number {
  const kinds = typescript.SyntaxKind;
  const closerOf = new Map<ts.SyntaxKind, ts.SyntaxKind>([
    [kinds.OpenParenToken, kinds.CloseParenToken],
    [kinds.OpenBracketToken, kinds.CloseBracketToken],
    [kinds.OpenBraceToken, kinds.CloseBraceToken],
  ]);
  const scanner = typescript.createScanner(typescript.ScriptTarget.Latest, false, languageVariantOf(typescript, variant), text);
  const startsExpression = expressionStartTest(typescript);
  // The scanner returns trivia as tokens here: they neither open nor close a level, nor are an operand.
  const trivia = new Set<ts.SyntaxKind>([
    kinds.WhitespaceTrivia, kinds.NewLineTrivia, kinds.SingleLineCommentTrivia, kinds.MultiLineCommentTrivia,
    kinds.ShebangTrivia, kinds.ConflictMarkerTrivia,
  ]);
  const open: (ts.SyntaxKind | typeof SUBSTITUTION)[] = [];
  let deepest = 0;
  let previous: ts.SyntaxKind = kinds.Unknown;
  const slashes = new Set<ts.SyntaxKind>([kinds.SlashToken, kinds.SlashEqualsToken]);
  /** A `/` that starts an expression is a regular-expression literal: the scanner reads it as one token. */
  const resolved = (scanned: ts.SyntaxKind): ts.SyntaxKind => (slashes.has(scanned) && startsExpression(previous) ? scanner.reScanSlashToken() : scanned);
  for (let scanned = scanner.scan(); scanned !== kinds.EndOfFileToken; scanned = scanner.scan()) {
    if (trivia.has(scanned)) continue;
    const kind = resolved(scanned);
    previous = kind;
    const closer = kind === kinds.TemplateHead ? SUBSTITUTION : closerOf.get(kind);
    if (closer !== undefined) {
      open.push(closer);
      deepest = Math.max(deepest, open.length);
    } else if (kind === kinds.CloseBraceToken && open.at(-1) === SUBSTITUTION) {
      previous = scanner.reScanTemplateToken(false);
      if (previous === kinds.TemplateTail) open.pop();
    } else if (kind === open.at(-1)) {
      open.pop();
    }
  }
  return deepest;
}

/** One node waiting on the walk's stack, with the context its parent gave it. */
interface WalkEntry {
  readonly node: ts.Node;
  readonly scope: ImportScope;
  readonly inJsDoc: boolean;
}

/**
 * Visit every node of the tree once, in source order (pre-order), by an explicit stack: never a
 * recursion over the tree. `forEachChild` does not enter JSDoc, so with `jsDoc` set a node's own
 * JSDoc comments are visited
 * right after it, before its children.
 *
 * @param typescript - The loaded TypeScript
 * @param root - The parsed source file
 * @param jsDocErrors - The JSDoc parse errors to enter JSDoc comments around, or undefined to enter none (only the `js` variant parses JSDoc)
 * @param visit - Called with each node, the root first, with its scope and whether it lies in JSDoc
 */
function walkTree(
  typescript: typeof ts,
  root: ts.Node,
  jsDocErrors: readonly ts.DiagnosticWithLocation[] | undefined,
  visit: (node: ts.Node, scope: ImportScope, inJsDoc: boolean) => void,
): void {
  const stack: WalkEntry[] = [{ node: root, scope: 'module', inJsDoc: false }];
  const children: WalkEntry[] = [];
  // TypeScript attaches one comment to more than one host (`/** ... */ (a);`): a comment is visited once, by its span.
  const entered = new Set<string>();
  while (stack.length > 0) {
    const { node, scope, inJsDoc } = stack.pop() as WalkEntry;
    visit(node, scope, inJsDoc);
    children.length = 0;
    if (jsDocErrors !== undefined && !inJsDoc) {
      for (const comment of hostedJsDoc(node)) {
        const span = `${String(comment.pos)}:${String(comment.end)}`;
        if (entered.has(span) || hasError(comment, jsDocErrors)) continue;
        entered.add(span);
        children.push({ node: comment, scope, inJsDoc: true });
      }
    }
    // The callback returns nothing: a truthy return would stop `forEachChild` at that child.
    typescript.forEachChild(node, (child) => {
      children.push({ node: child, scope: childScope(typescript, node, scope, child), inJsDoc });
    });
    for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index] as WalkEntry);
  }
}

/**
 * @param comment - A JSDoc comment
 * @param errors - The file's JSDoc parse errors
 * @returns Whether TypeScript recorded an error inside the comment's span
 */
function hasError(comment: ts.Node, errors: readonly ts.DiagnosticWithLocation[]): boolean {
  return errors.some((error) => error.start >= comment.pos && error.start < comment.end);
}

/**
 * @param node - A node
 * @returns The JSDoc comments it hosts: its `jsDoc` property, outside the public typings. The public
 *   `getJSDocCommentsAndTags` reads parent links, which a parse without `setParentNodes` leaves
 *   unset (and setting them is a recursion); {@link loadTsExtract} checks the property is attached
 */
function hostedJsDoc(node: ts.Node): readonly ts.JSDoc[] {
  return (node as WithJsDoc).jsDoc ?? [];
}

/** A node's JSDoc comments, a property outside the public typings. */
interface WithJsDoc {
  readonly jsDoc?: readonly ts.JSDoc[];
}

/**
 * Refuse a TypeScript whose parse no longer attaches JSDoc comments to their hosts as `jsDoc` (the
 * walk would see no JSDoc and answer every `js` file's JSDoc imports as none), or no longer records
 * a malformed JSDoc tag in `jsDocDiagnostics` (the walk would row what its recovery invented).
 *
 * @param typescript - The loaded TypeScript
 * @throws {ParserUnavailableError} If a documented statement carries no `jsDoc` array, or a malformed tag no diagnostic
 */
export function assertJsDocAttached(typescript: typeof ts): void {
  const probe = typescript.createSourceFile(
    SYNTHETIC_NAMES.js,
    '/** @type {number} */\nlet a;\n',
    { languageVersion: typescript.ScriptTarget.Latest, jsDocParsingMode: typescript.JSDocParsingMode.ParseForTypeErrors },
    false,
    typescript.ScriptKind.JS,
  );
  const [statement] = probe.statements;
  if (statement === undefined || !Array.isArray((statement as WithJsDoc).jsDoc)) throw vendoredTypeScriptLacks('jsDoc on a parsed node', CALLER);
  const broken = typescript.createSourceFile(
    SYNTHETIC_NAMES.js,
    "/** @import * from 'm' */\nlet a;\n",
    { languageVersion: typescript.ScriptTarget.Latest, jsDocParsingMode: typescript.JSDocParsingMode.ParseForTypeErrors },
    false,
    typescript.ScriptKind.JS,
  );
  if (jsDocErrorsOf(broken).length === 0) throw vendoredTypeScriptLacks('jsDocDiagnostics on a parsed source file', CALLER);
}

/** The facts one walk over a file's tree collects, node by node. */
class TsRowCollector {
  /** Whether a JSX element, self-closing element or fragment has been visited. */
  hasJsx = false;
  /** The `ts__imports` rows. */
  readonly imports: TsImportCollector;
  /** The `ts__import_names` and `ts__exports` rows. */
  readonly exports: TsExportCollector;
  readonly #jsxKinds: ReadonlySet<ts.SyntaxKind>;

  constructor(typescript: typeof ts, imports: TsImportCollector, exports: TsExportCollector) {
    const kinds = typescript.SyntaxKind;
    this.#jsxKinds = new Set([kinds.JsxElement, kinds.JsxSelfClosingElement, kinds.JsxFragment]);
    this.imports = imports;
    this.exports = exports;
  }

  /**
   * @param node - The next node, in source order
   * @param scope - Its scope
   * @param inJsDoc - Whether it lies in a JSDoc comment
   */
  visit(node: ts.Node, scope: ImportScope, inJsDoc: boolean): void {
    if (this.#jsxKinds.has(node.kind)) this.hasJsx = true;
    this.imports.visit(node, scope, inJsDoc);
    this.exports.visit(node, scope);
  }
}
