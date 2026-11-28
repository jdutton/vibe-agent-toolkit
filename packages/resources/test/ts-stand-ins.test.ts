/**
 * The resolve step's main-thread rules (`ts-stand-ins.ts`), each held to a real `Program` of the
 * vendored TypeScript over an in-memory tree: a stand-in's mode and module-ness equal the real file's
 * for every template across module kinds, package scopes and extensions; the collection predicate
 * equals what the program collects, row by row; the triple-slash rule includes what the
 * program includes; the `paths` matcher is TypeScript's.
 */

import { readWorkCounters, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { __resetWorkCountersForTest } from '@vibe-agent-toolkit/utils/testing';
import { describe, expect, it } from 'vitest';

import type { ExtractedTsImport } from '../src/projection/ts-extractor.js';
import {
  collected,
  hasReferenceOutput,
  joinsProgram,
  missingResolveInternal,
  MODE_STAND_IN_TEMPLATES,
  MODULE_STAND_IN_TEMPLATES,
  pathsMatch,
  STAND_IN_SPECIFIER,
  standInTexts,
  tripleSlashPathTarget,
  TsStandIns,
  type ResolutionModeName,
  type StandInFile,
} from '../src/projection/ts-stand-ins.js';
import { TsImportKindSchema, type TsVariant } from '../src/schemas/projection-ts.js';
import type ts from '../src/vendor/typescript.cjs';

import { loadTypeScriptBeforeAll, tsRowsOf, vendoredTypeScript } from './helpers/ts-rows.js';

loadTypeScriptBeforeAll();

const DIR = '/p';
const MANIFEST = `${DIR}/package.json`;

/** An in-memory tree: absolute path to text. */
type Tree = Readonly<Record<string, string>>;

/** The program-internal file members the oracle reads. */
interface CollectedFile {
  readonly imports: readonly ts.StringLiteralLike[];
  readonly moduleAugmentations: readonly (ts.StringLiteral | ts.Identifier)[];
}

/** The program-internal member the type-reference oracle reads. */
interface WithDefaultMode {
  readonly getDefaultResolutionModeForFile: (file: ts.SourceFile) => ts.ResolutionMode;
}

/** A resolution host over an in-memory tree. */
function hostOf(tree: Tree): ts.ModuleResolutionHost {
  return {
    fileExists: (path) => tree[path] !== undefined,
    readFile: (path) => tree[path],
    directoryExists: (dir) => Object.keys(tree).some((path) => toForwardSlash(path).startsWith(`${toForwardSlash(dir)}/`)),
  };
}

/** A real `Program` of `rootNames` over the tree, as `tsc` builds one (no parent links). */
function programOf(tree: Tree, rootNames: readonly string[], options: ts.CompilerOptions): ts.Program {
  const typescript = vendoredTypeScript();
  const host: ts.CompilerHost = {
    ...hostOf(tree),
    getSourceFile: (name, languageVersionOrOptions) => {
      const text = tree[name];
      return text === undefined ? undefined : typescript.createSourceFile(name, text, languageVersionOrOptions);
    },
    getDefaultLibFileName: () => '/lib.d.ts',
    writeFile: () => undefined,
    getCurrentDirectory: () => '/',
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
  };
  return typescript.createProgram({ rootNames, options: { ...options, noLib: true, types: [] }, host });
}

/** The stand-in context for `fileName` in the tree, as the step builds it. */
function standInFileOf(tree: Tree, fileName: string, options: ts.CompilerOptions, config = 'tsconfig.json'): StandInFile {
  const cache = vendoredTypeScript().createModuleResolutionCache('/', (name) => name, options);
  return { config, options, fileName, host: hostOf(tree), packageJsonInfoCache: cache.getPackageJsonInfoCache() };
}

/** The variant a file name parses under. */
function variantOf(fileName: string): TsVariant {
  if (/\.d\.[mc]?ts$/.test(fileName)) return 'dts';
  if (fileName.endsWith('.tsx')) return 'tsx';
  return /\.[mc]?ts$/.test(fileName) ? 'ts' : 'js';
}

/** The 0-based offset of a 1-based line and column in `text`. */
function offsetOf(text: string, line: number, column: number): number {
  const lines = text.split('\n');
  return lines.slice(0, line - 1).reduce((sum, current) => sum + current.length + 1, 0) + column - 1;
}

/** The option sets the matrix runs under: every module kind whose mode selection differs. */
function optionSets(): Readonly<Record<string, ts.CompilerOptions>> {
  const { ModuleKind: module, ModuleResolutionKind: resolution } = vendoredTypeScript();
  const base = { allowJs: true };
  return {
    nodenext: { ...base, module: module.NodeNext, moduleResolution: resolution.NodeNext },
    node16: { ...base, module: module.Node16, moduleResolution: resolution.Node16 },
    bundlerCommonjs: { ...base, module: module.CommonJS, moduleResolution: resolution.Bundler },
    bundlerEsnext: { ...base, module: module.ESNext, moduleResolution: resolution.Bundler },
    preserve: { ...base, module: module.Preserve, moduleResolution: resolution.Bundler },
    // Import syntax does not affect resolution here, so only an override gives a mode.
    bundlerNoExports: { ...base, module: module.CommonJS, moduleResolution: resolution.Bundler, resolvePackageJsonExports: false, resolvePackageJsonImports: false },
  };
}

/** The package scopes the matrix runs under: the manifest text, or none. */
const SCOPES: Readonly<Record<string, string | undefined>> = {
  module: '{"type":"module"}',
  commonjs: '{"type":"commonjs"}',
  untyped: '{}',
  none: undefined,
};

const EXTENSIONS = ['.ts', '.mts', '.cts', '.tsx', '.d.ts', '.d.mts', '.js', '.mjs', '.cjs', '.jsx'] as const;

/** The real file of every mode template valid in a variant: each shape with its own specifier, among other statements. */
function realModeText(variant: TsVariant): string {
  const shapes = MODE_STAND_IN_TEMPLATES.filter((template) => template.variants.includes(variant));
  const statements = shapes.map((template, index) =>
    template.text.replaceAll(STAND_IN_SPECIFIER, `dep${index}`).replaceAll(/\bT\b/g, `T${index}`).replaceAll(/\bt\b/g, `t${index}`),
  );
  // The directives must lead the file; every other statement follows, between unrelated ones.
  const directives = statements.filter((text) => text.startsWith('///'));
  const rest = statements.filter((text) => !text.startsWith('///'));
  return [...directives, 'const before = 1;\n', ...rest, 'function after() { return before; }\n'].join('');
}

/** The program's mode for every collected reference of `fileName`, keyed by offset. */
function oracleModes(program: ts.Program, fileName: string): Map<number, ResolutionModeName | null> {
  const typescript = vendoredTypeScript();
  const file = program.getSourceFile(fileName);
  if (file === undefined) throw new Error(`no ${fileName} in the program`);
  const name = (mode: ts.ResolutionMode): ResolutionModeName | null => {
    if (mode === typescript.ModuleKind.ESNext) return 'import';
    return mode === typescript.ModuleKind.CommonJS ? 'require' : null;
  };
  const modes = new Map<number, ResolutionModeName | null>();
  const own = file as unknown as CollectedFile;
  for (const usage of [...own.imports, ...own.moduleAugmentations]) {
    if (typescript.isStringLiteralLike(usage)) modes.set(usage.getStart(file), name(program.getModeForUsageLocation(file, usage)));
  }
  const fileDefault = (program as unknown as WithDefaultMode).getDefaultResolutionModeForFile(file);
  for (const directive of file.typeReferenceDirectives) modes.set(directive.pos, name(directive.resolutionMode ?? fileDefault));
  return modes;
}

/** One cell of the mode matrix: an option set, a package scope and an extension. */
interface ModeCase {
  readonly setName: string;
  readonly options: ts.CompilerOptions;
  readonly scopeName: string;
  readonly manifest: string | undefined;
  readonly extension: string;
}

/** @returns Every cell of the mode matrix */
function modeCases(): ModeCase[] {
  return Object.entries(optionSets()).flatMap(([setName, options]) =>
    Object.entries(SCOPES).flatMap(([scopeName, manifest]) => EXTENSIONS.map((extension) => ({ setName, options, scopeName, manifest, extension }))),
  );
}

/** A tree of one file and, when given, the package manifest above it. */
function treeOf(fileName: string, text: string, manifest: string | undefined): Tree {
  return { [fileName]: text, ...(manifest === undefined ? {} : { [MANIFEST]: manifest }) };
}

/** Compare every mode-kind row of the cell's real file with the program's mode; @returns How many were compared */
function compareModeCase({ setName, options, scopeName, manifest, extension }: ModeCase): number {
  const fileName = `${DIR}/src/file${extension}`;
  const variant = variantOf(fileName);
  const text = realModeText(variant);
  const tree = treeOf(fileName, text, manifest);
  const oracle = oracleModes(programOf(tree, [fileName], options), fileName);
  const context = standInFileOf(tree, fileName, options, setName);
  const standIns = new TsStandIns(vendoredTypeScript());
  // `require` outside JavaScript is never collected, so no mode is asked of it.
  const rows = tsRowsOf(text, variant).imports.filter((row) => row.kind !== 'require' || variant === 'js');
  for (const row of rows) {
    const offset = offsetOf(text, row.line, row.column);
    const where = `${setName}/${scopeName}/${extension} ${row.kind} typeOnly=${String(row.typeOnly)} rm=${String(row.resolutionMode)}`;
    expect(oracle.has(offset), `${where}: the program collected it`).toBe(true);
    expect(standIns.modeOf(context, row), where).toBe(oracle.get(offset));
  }
  return rows.length;
}

/** A real file text with the two syntax facts, among other statements. */
function realModuleText(moduleSyntax: boolean, hasJsx: boolean): string {
  return `const a = 1;\n${moduleSyntax ? 'export const b = a;\n' : ''}${hasJsx ? 'const c = <div>{a}</div>;\n' : ''}function d() { return a; }\n`;
}

/** One cell of the module-detection matrix. */
interface ModuleCase {
  readonly options: ts.CompilerOptions;
  readonly manifest: string | undefined;
  readonly extension: string;
}

/** @returns The option sets module detection runs under: every `(jsx, moduleDetection, module kind)` */
function moduleOptionSets(): ts.CompilerOptions[] {
  const { JsxEmit: jsx, ModuleDetectionKind: detection, ModuleKind: module, ModuleResolutionKind: resolution } = vendoredTypeScript();
  const bases = [{ module: module.NodeNext, moduleResolution: resolution.NodeNext }, { module: module.ESNext, moduleResolution: resolution.Bundler }];
  const jsxOptions = [undefined, jsx.Preserve, jsx.ReactJSX, jsx.ReactJSXDev].map((value) => (value === undefined ? {} : { jsx: value }));
  const detections = [undefined, detection.Auto, detection.Force, detection.Legacy].map((value) => (value === undefined ? {} : { moduleDetection: value }));
  return jsxOptions.flatMap((jsxOption) => detections.flatMap((moduleDetection) => bases.map((base) => ({ ...base, allowJs: true, ...jsxOption, ...moduleDetection }))));
}

/** @returns Every `(option set, package scope, extension)` cell */
function moduleCases(): ModuleCase[] {
  const cells = moduleOptionSets().flatMap((options) => [SCOPES['module'], undefined].map((manifest) => ({ options, manifest })));
  return cells.flatMap((cell) => EXTENSIONS.map((extension) => ({ ...cell, extension })));
}

/** Compare module detection for every template of the cell's variant with the program's; @returns How many were compared */
function compareModuleCase({ options, manifest, extension }: ModuleCase): number {
  const typescript = vendoredTypeScript();
  const fileName = `${DIR}/src/file${extension}`;
  const variant = variantOf(fileName);
  const templates = MODULE_STAND_IN_TEMPLATES.filter((candidate) => candidate.variant === variant);
  const standIns = new TsStandIns(typescript);
  for (const template of templates) {
    const text = realModuleText(template.moduleSyntax, template.hasJsx);
    const tree = treeOf(fileName, text, manifest);
    const real = programOf(tree, [fileName], options).getSourceFile(fileName) as ts.SourceFile;
    const facts = tsRowsOf(text, variant).files[0];
    expect(facts).toMatchObject({ moduleSyntax: template.moduleSyntax, hasJsx: template.hasJsx });
    const where = `${JSON.stringify(options)} scope=${String(manifest)} ${extension} ${JSON.stringify(facts)}`;
    expect(standIns.isModuleFile(standInFileOf(tree, fileName, options), { variant, ...facts }), where).toBe(typescript.isExternalModule(real));
  }
  return templates.length;
}

/** Every row of `text` under `fileName`, with the predicate's answer and the program's. */
function judged(fileName: string, text: string): { row: ExtractedTsImport; predicate: boolean; program: boolean }[] {
  const typescript = vendoredTypeScript();
  const variant = variantOf(fileName);
  const program = programOf({ [fileName]: text }, [fileName], { allowJs: true });
  const file = program.getSourceFile(fileName) as ts.SourceFile;
  const own = file as unknown as CollectedFile;
  const offsets = new Set([
    ...[...own.imports, ...own.moduleAugmentations].map((node) => node.getStart(file)),
    ...[...file.referencedFiles, ...file.typeReferenceDirectives, ...file.libReferenceDirectives].map((reference) => reference.pos),
  ]);
  const isModule = typescript.isExternalModule(file);
  return tsRowsOf(text, variant).imports.map((row) => ({
    row,
    predicate: collected(typescript, row, { variant, isModule }),
    program: offsets.has(offsetOf(text, row.line, row.column)),
  }));
}

/** Assert the predicate equals the program on every row, and that each row's verdict is the expected one. */
function expectVerdicts(fileName: string, text: string, expected: readonly boolean[]): void {
  const rows = judged(fileName, text);
  expect(rows.map(({ row, predicate, program }) => ({ kind: row.kind, specifier: row.specifier, predicate, program }))).toEqual(
    rows.map(({ row, program }) => ({ kind: row.kind, specifier: row.specifier, predicate: program, program })),
  );
  expect(rows.map(({ program }) => program)).toEqual(expected);
}

/** What the program includes from `/// <reference path="<specifier>" />` in `/p/a.ts`, and the rule's answer. */
function both(specifier: string, files: readonly string[], options: ts.CompilerOptions = {}): { program: string | undefined; rule: string | undefined } {
  const typescript = vendoredTypeScript();
  const root = '/p/a.ts';
  const tree: Tree = { [root]: `/// <reference path="${specifier}" />\nexport {};\n`, ...Object.fromEntries(files.map((file) => [file, file.endsWith('.json') ? '{}' : 'export {};\n'])) };
  const included = programOf(tree, [root], options).getSourceFiles().map((file) => file.fileName).find((name) => name !== root);
  return { program: included, rule: tripleSlashPathTarget(typescript, specifier, root, options, (path) => tree[path] !== undefined) };
}

/** A value `import` with no attribute: the row shape most mode cases ask about. */
const VALUE_IMPORT = { kind: 'import', typeOnly: false, resolutionMode: null } as const;

/** @returns `module` and `moduleResolution` NodeNext */
function nodeNext(): ts.CompilerOptions {
  const { ModuleKind: module, ModuleResolutionKind: resolution } = vendoredTypeScript();
  return { module: module.NodeNext, moduleResolution: resolution.NodeNext };
}

/** @returns The mode a fresh stand-in cache answers for `row` in `fileName` of the tree */
function modeIn(tree: Tree, fileName: string, options: ts.CompilerOptions, row: Parameters<TsStandIns['modeOf']>[1]): ResolutionModeName | null {
  return new TsStandIns(vendoredTypeScript()).modeOf(standInFileOf(tree, fileName, options), row);
}

describe('mode stand-ins', () => {
  it('answers every template as a real file of the same shape does, under every module kind, package scope and extension', () => {
    const compared = modeCases().map(compareModeCase).reduce((sum, count) => sum + count, 0);
    // Every template, in every variant it is valid in, under every option set and scope.
    expect(compared).toBeGreaterThanOrEqual(MODE_STAND_IN_TEMPLATES.length * Object.keys(optionSets()).length * Object.keys(SCOPES).length);
  });

  it('gives a dynamic import() in a CommonJS-format file import mode, and require() there require mode', () => {
    const cts = { [`${DIR}/a.cts`]: '' };
    expect(modeIn(cts, `${DIR}/a.cts`, nodeNext(), { kind: 'dynamic', typeOnly: false, resolutionMode: null })).toBe('import');
    expect(modeIn(cts, `${DIR}/a.cts`, nodeNext(), VALUE_IMPORT)).toBe('require');
  });

  it('lets a resolution-mode attribute on an import type override the file format', () => {
    const cts = { [`${DIR}/a.cts`]: '' };
    expect(modeIn(cts, `${DIR}/a.cts`, nodeNext(), { kind: 'import', typeOnly: true, resolutionMode: 'import' })).toBe('import');
    // On a value import the attribute is not an override, as in TypeScript.
    expect(modeIn(cts, `${DIR}/a.cts`, nodeNext(), { kind: 'import', typeOnly: false, resolutionMode: 'import' })).toBe('require');
  });

  it('gives every file require mode under bundler with module commonjs, whatever its package scope', () => {
    const { ModuleKind: module, ModuleResolutionKind: resolution } = vendoredTypeScript();
    const options = { module: module.CommonJS, moduleResolution: resolution.Bundler };
    expect(modeIn({ [`${DIR}/a.ts`]: '', [MANIFEST]: '{"type":"module"}' }, `${DIR}/a.ts`, options, VALUE_IMPORT)).toBe('require');
  });

  it('reads the package scope under NodeNext: type module gives import mode, none gives require', () => {
    expect(modeIn({ [`${DIR}/a.ts`]: '', [MANIFEST]: '{"type":"module"}' }, `${DIR}/a.ts`, nodeNext(), VALUE_IMPORT)).toBe('import');
    expect(modeIn({ [`${DIR}/a.ts`]: '' }, `${DIR}/a.ts`, nodeNext(), VALUE_IMPORT)).toBe('require');
  });

  it('reads packageJsonScope as a Program sets it: a file under node_modules in a commonjs scope takes require mode under bundler', () => {
    // Outside Node16-NodeNext only a node_modules path looks its scope up, and only the scope's `type`
    // then decides the emit format, so this is the case where the stand-in's packageJsonScope matters.
    const { ModuleKind: module, ModuleResolutionKind: resolution } = vendoredTypeScript();
    const options = { module: module.ESNext, moduleResolution: resolution.Bundler };
    const fileName = `${DIR}/node_modules/dep/a.ts`;
    const text = "import 'x';\n";
    const tree: Tree = { [fileName]: text, [`${DIR}/node_modules/dep/package.json`]: '{"type":"commonjs"}' };
    const oracle = oracleModes(programOf(tree, [fileName], options), fileName);
    const row = tsRowsOf(text, 'ts').imports[0] as ExtractedTsImport;
    expect(oracle.get(offsetOf(text, row.line, row.column))).toBe('require');
    expect(new TsStandIns(vendoredTypeScript()).modeOf(standInFileOf(tree, fileName, options), row)).toBe('require');
  });

  it('keeps two package scopes apart in one cache', () => {
    const options = optionSets()['nodenext'] as ts.CompilerOptions;
    const tree: Tree = { [`${DIR}/a.ts`]: '', [MANIFEST]: '{"type":"module"}', [`${DIR}/cjs/b.ts`]: '', [`${DIR}/cjs/package.json`]: '{"type":"commonjs"}' };
    const standIns = new TsStandIns(vendoredTypeScript());
    const row = { kind: 'import', typeOnly: false, resolutionMode: null } as const;
    expect(standIns.modeOf(standInFileOf(tree, `${DIR}/a.ts`, options), row)).toBe('import');
    expect(standIns.modeOf(standInFileOf(tree, `${DIR}/cjs/b.ts`, options), row)).toBe('require');
  });

  it('answers null for a kind resolved without a mode', () => {
    const fileName = `${DIR}/a.ts`;
    const standIns = new TsStandIns(vendoredTypeScript());
    const context = standInFileOf({ [fileName]: '' }, fileName, optionSets()['nodenext'] as ts.CompilerOptions);
    for (const kind of ['referencePath', 'referenceLib', 'createRequire'] as const) {
      expect(standIns.modeOf(context, { kind, typeOnly: false, resolutionMode: null })).toBeNull();
    }
  });

  it('refuses a shape no template holds rather than guess', () => {
    const fileName = `${DIR}/a.ts`;
    const standIns = new TsStandIns(vendoredTypeScript());
    const context = standInFileOf({ [fileName]: '' }, fileName, {});
    expect(() => standIns.modeOf(context, { kind: 'dynamic', typeOnly: true, resolutionMode: null })).toThrow(RangeError);
  });

  it('caches per (config, package scope, extension, text): one creation per key, counted', () => {
    const options = optionSets()['nodenext'] as ts.CompilerOptions;
    const tree: Tree = { [`${DIR}/a.ts`]: '', [`${DIR}/b.ts`]: '', [`${DIR}/c.mts`]: '', [MANIFEST]: '{"type":"module"}' };
    const standIns = new TsStandIns(vendoredTypeScript());
    const row = { kind: 'import', typeOnly: false, resolutionMode: null } as const;
    __resetWorkCountersForTest();
    const created = (): number => readWorkCounters()['resolve.ts.modeStandIns'];
    standIns.modeOf(standInFileOf(tree, `${DIR}/a.ts`, options), row);
    standIns.modeOf(standInFileOf(tree, `${DIR}/b.ts`, options), row);
    expect(created()).toBe(1);
    standIns.modeOf(standInFileOf(tree, `${DIR}/c.mts`, options), row);
    standIns.modeOf(standInFileOf(tree, `${DIR}/a.ts`, options, 'other/tsconfig.json'), row);
    expect(created()).toBe(3);
  });
});

describe('the stand-in templates', () => {
  it('parse with no diagnostic in every variant they are used in', () => {
    const typescript = vendoredTypeScript();
    const names: Readonly<Record<TsVariant, string>> = { ts: 'vat.ts', dts: 'vat.d.ts', tsx: 'vat.tsx', js: 'vat.js' };
    const templates = [
      ...MODE_STAND_IN_TEMPLATES.flatMap((template) => template.variants.map((variant) => ({ variant, text: template.text }))),
      ...MODULE_STAND_IN_TEMPLATES,
    ];
    for (const { variant, text } of templates) {
      const parsed = typescript.createSourceFile(names[variant], text, typescript.ScriptTarget.Latest, true);
      const diagnostics = (parsed as unknown as { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
      expect(diagnostics.map((diagnostic) => diagnostic.code), `${variant}: ${text}`).toEqual([]);
    }
  });

  it('are a closed set of fixed texts, each mode text carrying the placeholder', () => {
    for (const template of MODE_STAND_IN_TEMPLATES) expect(template.text).toContain(JSON.stringify(STAND_IN_SPECIFIER));
    const texts = standInTexts();
    expect(texts.size).toBe(new Set([...MODE_STAND_IN_TEMPLATES, ...MODULE_STAND_IN_TEMPLATES].map((template) => template.text)).size);
  });

  it('cover every (kind, typeOnly, resolutionMode) the extractor gives a mode kind', () => {
    const keys = new Set(MODE_STAND_IN_TEMPLATES.map((template) => `${template.kind}/${String(template.typeOnly)}/${String(template.resolutionMode)}`));
    expect(keys.size).toBe(MODE_STAND_IN_TEMPLATES.length);
    // The mode kinds are the `ts__imports` kind list but the three TypeScript resolves with no
    // mode: a path directive, a lib directive, and `createRequire`, which no Program collects.
    const modeless = new Set(['referencePath', 'referenceLib', 'createRequire']);
    const expected = TsImportKindSchema.options.filter((kind) => !modeless.has(kind));
    const byText = (left: string, right: string): number => left.localeCompare(right);
    expect([...new Set(MODE_STAND_IN_TEMPLATES.map((template) => template.kind))].toSorted(byText)).toEqual(expected.toSorted(byText));
    for (const kind of expected) expect(keys).toContain(`${kind}/false/null`);
    expect(keys).toContain('importEquals/true/null');
    for (const mode of ['null', 'import', 'require']) {
      for (const kind of ['import', 'export']) for (const typeOnly of [false, true]) expect(keys).toContain(`${kind}/${typeOnly}/${mode}`);
      for (const kind of ['importType', 'jsdocImportType', 'jsdocImport', 'referenceTypes']) expect(keys).toContain(`${kind}/false/${mode}`);
    }
  });
});

describe('module detection', () => {
  it('equals the real file for every (moduleSyntax, hasJsx, jsx, moduleDetection, extension, scope)', () => {
    const compared = moduleCases().map(compareModuleCase).reduce((sum, count) => sum + count, 0);
    expect(compared).toBeGreaterThanOrEqual(moduleCases().length * 2);
  });

  it('refuses hasJsx in a variant that cannot parse JSX', () => {
    const fileName = `${DIR}/a.ts`;
    const standIns = new TsStandIns(vendoredTypeScript());
    expect(() => standIns.isModuleFile(standInFileOf({ [fileName]: '' }, fileName, {}), { variant: 'ts', moduleSyntax: false, hasJsx: true })).toThrow(RangeError);
  });
});

describe('the collection predicate, against what a Program collects', () => {
  it('resolves an augmentation in a module file and not an ambient declaration in a script file', () => {
    expectVerdicts('/p/mod.ts', "import 'a';\ndeclare module 'b' { import 'c'; }\n", [true, true, false]);
    expectVerdicts('/p/script.d.ts', "declare module 'b' { import 'c'; import './rel'; }\n", [false, true, false]);
    expectVerdicts('/p/script.ts', "declare module 'b' { import x = require('c'); export * from 'd'; }\n", [false, true, true]);
  });

  it('collects require in JavaScript only, with one string-like argument', () => {
    expectVerdicts('/p/a.js', "require('a');\nrequire(`b`);\nrequire('c', 1);\nrequire(name);\n", [true, true, false, false]);
    expectVerdicts('/p/a.ts', "require('a');\n", [false]);
  });

  it('never collects createRequire, nor a static import in a nested scope or with a template specifier', () => {
    expectVerdicts('/p/a.js', "import { createRequire } from 'module';\nconst r = createRequire(import.meta.url);\nr('x');\n", [true, false]);
    expectVerdicts('/p/a.ts', "namespace N { import x = require('a'); }\nimport y = require(`b`);\nexport * from `c`;\n", [false, false, false]);
  });

  it('collects dynamic imports anywhere with a string-like first argument, and import types', () => {
    expectVerdicts('/p/a.ts', "function f() { return import('a'); }\nimport(`b`);\nimport(name);\ntype T = import('c');\nlet u: typeof import('');\n", [true, true, false, true, true]);
  });

  it('collects JSDoc imports and import types in JavaScript, and every triple-slash directive', () => {
    const text = "/// <reference path=\"./g.d.ts\" />\n/// <reference types=\"node\" />\n/// <reference lib=\"es2020\" />\n/** @import { A } from 'a' */\n/** @type {import('b')} */\nlet x;\n";
    expectVerdicts('/p/a.js', text, [true, true, true, true, true]);
  });
});

describe('triple-slash reference paths', () => {
  it.each([
    ['an explicit .ts', './b.ts', ['/p/b.ts'], {}, '/p/b.ts'],
    ['an extensionless path, first of .ts, .tsx, .d.ts', './b', ['/p/b.d.ts', '/p/b.tsx'], {}, '/p/b.tsx'],
    ['a missing file', './missing.ts', [], {}, undefined],
    ['a .js file without allowJs', './b.js', ['/p/b.js'], {}, undefined],
    ['a .js file with allowJs', './b.js', ['/p/b.js'], { allowJs: true }, '/p/b.js'],
    ['an extensionless .js under allowJs', './b', ['/p/b.js'], { allowJs: true }, '/p/b.js'],
    ['a .json file with resolveJsonModule off', './b.json', ['/p/b.json'], { resolveJsonModule: false }, undefined],
    ['a .json file under the computed resolveJsonModule default', './b.json', ['/p/b.json'], {}, '/p/b.json'],
    ['a .json file under resolveJsonModule', './b.json', ['/p/b.json'], { resolveJsonModule: true, module: 199 }, '/p/b.json'],
    ['an unsupported extension', './b.css', ['/p/b.css', '/p/b.css.ts'], {}, undefined],
    ['a parent-relative path', '../q/c.ts', ['/q/c.ts'], {}, '/q/c.ts'],
  ] as const)('%s', (_name, specifier, files, options, expected) => {
    const { program, rule } = both(specifier, files, options);
    expect(rule).toBe(expected);
    expect(program).toBe(expected);
  });
});

describe('paths matching', () => {
  it("is TypeScript's matcher: exact keys, the best star pattern, nothing without paths", () => {
    const typescript = vendoredTypeScript();
    const options = { paths: { exact: ['./e'], '@app/*': ['./src/*'], 'two/*/stars/*': ['./x'] } };
    expect(pathsMatch(typescript, options, 'exact')).toBe(true);
    expect(pathsMatch(typescript, options, '@app/util')).toBe(true);
    expect(pathsMatch(typescript, options, 'other')).toBe(false);
    expect(pathsMatch(typescript, options, 'two/a/stars/b')).toBe(false);
    expect(pathsMatch(typescript, {}, 'exact')).toBe(false);
  });
});

describe('project-reference outputs', () => {
  it("has a declaration output for every root file but a declaration file or a .json file, by TypeScript's rules", () => {
    const typescript = vendoredTypeScript();
    const verdicts = ['a.ts', 'a.tsx', 'a.mts', 'a.js', 'a.d.ts', 'a.d.cts', 'a.d.css.ts', 'a.json'].map((name) => [name, hasReferenceOutput(typescript, name)]);
    expect(verdicts).toStrictEqual([
      ['a.ts', true], ['a.tsx', true], ['a.mts', true], ['a.js', true],
      ['a.d.ts', false], ['a.d.cts', false], ['a.d.css.ts', false], ['a.json', false],
    ]);
  });
});

describe('program membership of a resolved module', () => {
  it('follows shouldAddFile: the resolution diagnostic, allowJs for JavaScript, never an augmentation, a JSDoc reference only in JavaScript', () => {
    const typescript = vendoredTypeScript();
    const joins = (options: ts.CompilerOptions, kind: (typeof TsImportKindSchema.options)[number], extension: string, containing: TsVariant = 'ts'): boolean =>
      joinsProgram(typescript, options, { kind, extension, containing });
    expect([
      joins({}, 'import', '.ts'), joins({}, 'import', '.d.ts'), joins({}, 'import', '.tsx'), joins({ jsx: typescript.JsxEmit.Preserve }, 'import', '.tsx'),
      joins({}, 'import', '.js'), joins({ allowJs: true }, 'import', '.js'), joins({ resolveJsonModule: false }, 'import', '.json'), joins({ resolveJsonModule: true }, 'import', '.json'),
      joins({}, 'import', '.d.css.ts'), joins({}, 'import', '.d.css.ts', 'dts'), joins({}, 'ambient', '.ts'),
      joins({ allowJs: true }, 'jsdocImportType', '.ts', 'ts'), joins({ allowJs: true }, 'jsdocImportType', '.ts', 'js'),
    ]).toStrictEqual([
      true, true, false, true,
      false, true, false, true,
      false, true, false,
      false, true,
    ]);
  });
});

describe('the internals', () => {
  it('are all present on the vendored TypeScript, and a missing one is named', () => {
    const typescript = vendoredTypeScript();
    expect(missingResolveInternal(typescript)).toBeUndefined();
    const lacking = { ...typescript, tryParsePatterns: undefined } as unknown as typeof ts;
    expect(missingResolveInternal(lacking)).toBe('tryParsePatterns');
    expect(() => new TsStandIns(lacking)).toThrow(/tryParsePatterns/);
  });
});
