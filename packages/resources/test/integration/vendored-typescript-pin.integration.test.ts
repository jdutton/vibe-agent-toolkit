/**
 * The pin test: the vendored TypeScript the loader returns holds everything VAT's steps call.
 *
 * A function missing from the pinned version is a build-time fact, so it is asserted here, on the
 * module {@link loadVendoredTypeScript} returns (the copy `build` writes). Each check is a helper run twice: on the
 * vendored module (green) and on a stub built to lack the one thing it checks (red), so a helper
 * that could never fail is itself a failure here.
 *
 * Integration tier, not unit: the first load of the 9 MB vendored module takes over a second, past
 * the unit tier's per-file budget, and the copy checks read real build output.
 * The integration tier runs in `validate` and in CI on every build, so a TypeScript bump still
 * cannot reach a release without this file seeing it.
 *
 * It also pins the router's `dts` rule ({@link isDeclarationName}, which routing applies without
 * loading TypeScript) to the vendored `isDeclarationFileName`, both ways, over every extension
 * TypeScript knows and the near misses around them.
 *
 * Not here yet, deferred to the PR that owns what it checks: the fixtures proving
 * `configFile.fileName` reaches the resolver, and `configFilePath` reaches `getOutputFileNames` and
 * `getCommonSourceDirectoryOfConfig`. Those are claims about the options VAT passes, and no VAT code
 * passes options until the type-resolution PR, which owns option passing and brings them. Until then
 * this file pins only that the functions exist and behave.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

import { isDeclarationName } from '../../src/projection/router.js';
import type ts from '../../src/vendor/typescript.cjs';
import { loadVendoredTypeScript } from '../../src/vendored-typescript.js';
import { declaredTypeScriptVersion } from '../helpers/declared-typescript-version.js';

/** Public functions the resolve step, the stand-ins and the worker's tsconfig job call. */
const PUBLIC_FUNCTIONS = [
  'resolveModuleName',
  'resolveTypeReferenceDirective',
  'resolveTripleslashReference',
  'createModuleResolutionCache',
  'createTypeReferenceDirectiveResolutionCache',
  'getModeForUsageLocation',
  'getOutputFileNames',
  'createSourceFile',
  'parseJsonText',
  'parseJsonSourceFileConfigFileContent',
  'parseJsonConfigFileContent',
  'createScanner',
] as const;

/** Functions exported on the `ts` object but absent from its public typings. */
const INTERNAL_FUNCTIONS = [
  'getSupportedExtensions',
  'getImpliedNodeFormatForFileWorker',
  'getDefaultResolutionModeForFileWorker',
  'getSetExternalModuleIndicator',
  'getCommonSourceDirectoryOfConfig',
  'tryParsePatterns',
  'matchPatternOrExact',
  'matchFiles',
  'isFileProbablyExternalModule',
  'getResolutionModeOverride',
  'isExclusivelyTypeOnlyImportOrExport',
  'isDeclarationFileName',
] as const;

/** Extension lists exported on the `ts` object but absent from its public typings: the `dts` agreement ranges over them. */
const INTERNAL_LISTS = ['supportedDeclarationExtensions', 'supportedTSExtensionsFlat', 'supportedJSExtensionsFlat'] as const;

/** @returns The names among the pinned lists that `module` does not hold as an array of strings */
function missingPinnedLists(module: object): string[] {
  const members = module as Record<string, unknown>;
  return INTERNAL_LISTS.filter((name) => {
    const list = members[name];
    return !Array.isArray(list) || list.some((entry) => typeof entry !== 'string');
  });
}

/** The internal members the `dts` agreement reads, absent from the public typings. */
interface DeclarationInternals {
  isDeclarationFileName(fileName: string): boolean;
  supportedDeclarationExtensions: readonly string[];
  supportedTSExtensionsFlat: readonly string[];
  supportedJSExtensionsFlat: readonly string[];
}

/** Base names the arbitrary `.d.<ext>.ts` form is tried with. */
const ARBITRARY_DECLARATION_EXTENSIONS = ['json', 'css', 'html', 'helper', 'ts', 'mts', 'd'] as const;

/**
 * Every name the `dts` agreement asks about: each extension TypeScript knows, and `.d.<ext>.ts`, as
 * the extension alone, a bare name, under a directory and behind a `.d.`-bearing directory, plus its
 * near misses (upper case, a capital `D`, the leading dot missing, a trailing `.map`).
 *
 * @param typescript - The module whose extension lists seed the names
 * @returns The names, deduplicated
 */
function declarationCandidates(typescript: DeclarationInternals): string[] {
  const extensions = [
    ...typescript.supportedDeclarationExtensions,
    ...typescript.supportedTSExtensionsFlat,
    ...typescript.supportedJSExtensionsFlat,
    ...ARBITRARY_DECLARATION_EXTENSIONS.map((ext) => `.d.${ext}.ts`),
  ];
  const spellings = extensions.flatMap((ext) => [ext, ext.toUpperCase(), ext.replace('.d.', '.D.'), ext.slice(1), `${ext}.map`]);
  const names = spellings.flatMap((spelling) => [spelling, `a${spelling}`, `src/lib/a${spelling}`, `x.d.dir/a${spelling}`]);
  return [...new Set(names)];
}

/** @returns The candidates on which `rule` and the module's `isDeclarationFileName` answer differently */
function declarationDisagreements(rule: (path: string) => boolean, typescript: DeclarationInternals): string[] {
  return declarationCandidates(typescript).filter((name) => rule(name) !== typescript.isDeclarationFileName(name));
}

/** @returns The module's internal members the `dts` agreement reads */
async function declarationInternals(): Promise<DeclarationInternals> {
  return (await loadVendoredTypeScript()) as unknown as DeclarationInternals;
}

/** @returns The names among the pinned functions that `module` does not hold as a function */
function missingPinnedFunctions(module: object): string[] {
  const members = module as Record<string, unknown>;
  return [...PUBLIC_FUNCTIONS, ...INTERNAL_FUNCTIONS].filter((name) => typeof members[name] !== 'function');
}

/** The internal property `createProgram` sets on a source file, and the stand-in sets as it does. */
interface WithPackageScope {
  packageJsonScope?: { contents: { packageJsonContent: { type?: string } } } | undefined;
}

/**
 * The mode `getModeForUsageLocation` gives an `import()` in a CommonJS-implied stand-in under
 * `module: esnext`, with the package scope saying `commonjs` and with no scope at all. TypeScript
 * reads the scope to decide the file's emit format, so the two answers differ.
 *
 * @param typescript - The module under test
 * @returns The two modes, with the scope and without
 */
function importCallModes(typescript: typeof ts): { withScope: unknown; withoutScope: unknown } {
  const options: ts.CompilerOptions = {
    module: typescript.ModuleKind.ESNext,
    moduleResolution: typescript.ModuleResolutionKind.Bundler,
  };
  const modeOf = (scope: WithPackageScope['packageJsonScope']): unknown => {
    const standIn = typescript.createSourceFile(
      '/project/src/stand-in.ts',
      "import('./target');",
      { languageVersion: typescript.ScriptTarget.Latest, impliedNodeFormat: typescript.ModuleKind.CommonJS },
      true,
    );
    (standIn as WithPackageScope).packageJsonScope = scope;
    const [statement] = standIn.statements;
    if (statement === undefined || !typescript.isExpressionStatement(statement) || !typescript.isCallExpression(statement.expression)) {
      throw new Error('stand-in did not parse as one import() call');
    }
    const [usage] = statement.expression.arguments;
    if (usage === undefined || !typescript.isStringLiteralLike(usage)) throw new Error('stand-in has no specifier');
    return typescript.getModeForUsageLocation(standIn, usage, options);
  };
  return {
    withScope: modeOf({ contents: { packageJsonContent: { type: 'commonjs' } } }),
    withoutScope: modeOf(undefined),
  };
}

/** A stub whose `getModeForUsageLocation` never sees the stand-in's package scope. */
function scopeBlindStub(typescript: typeof ts): typeof ts {
  return {
    ...typescript,
    getModeForUsageLocation: (file, usage, options) => {
      const scoped = file as WithPackageScope;
      const saved = scoped.packageJsonScope;
      delete scoped.packageJsonScope;
      try {
        return typescript.getModeForUsageLocation(file, usage, options);
      } finally {
        scoped.packageJsonScope = saved;
      }
    },
  };
}

/** @returns `source`'s parse diagnostics (an internal member, absent from the typings) */
function parseDiagnosticsOf(source: ts.SourceFile): readonly unknown[] {
  return (source as unknown as { parseDiagnostics: readonly unknown[] }).parseDiagnostics;
}

/**
 * Whether `copy` is `original` minus its trailing `//# sourceMappingURL=` line, byte for byte.
 *
 * @param copy - The vendored file's bytes
 * @param original - The devDependency's `lib/typescript.js` bytes
 * @returns Whether the copy is the original's prefix and the rest is that one line
 */
function isOriginalMinusSourceMapLine(copy: Buffer, original: Buffer): boolean {
  const prefixEqual = original.subarray(0, copy.length).equals(copy);
  const rest = original.subarray(copy.length).toString('utf8');
  return prefixEqual && /^\/\/# sourceMappingURL=[^\n]*\n?$/.test(rest);
}

describe('the vendored TypeScript (pin test)', () => {
  it('is the exact version resources declares for its typescript devDependency', async () => {
    // Exactness of the declaration is the vendor step's refusal to enforce (`assertPinnedTypescript`,
    // which accepts any exact semver, prerelease included); this asserts the copy is that version.
    const typescript = await loadVendoredTypeScript();
    expect(typescript.version).toBe(declaredTypeScriptVersion());
  });

  it('holds every public and internal function the steps call', async () => {
    expect(missingPinnedFunctions(await loadVendoredTypeScript())).toEqual([]);
  });

  it('red seed: a module lacking one pinned function is named', async () => {
    const lacking = Object.fromEntries(Object.entries(await loadVendoredTypeScript()).filter(([name]) => name !== 'matchFiles'));
    expect(missingPinnedFunctions(lacking)).toEqual(['matchFiles']);
  });

  it('holds every internal extension list the dts agreement reads', async () => {
    expect(missingPinnedLists(await loadVendoredTypeScript())).toEqual([]);
  });

  it('red seed: a module lacking one pinned list is named', async () => {
    const lacking = Object.fromEntries(Object.entries(await loadVendoredTypeScript()).filter(([name]) => name !== 'supportedTSExtensionsFlat'));
    expect(missingPinnedLists(lacking)).toEqual(['supportedTSExtensionsFlat']);
  });

  it('the router\'s dts rule equals isDeclarationFileName on every candidate, both ways', async () => {
    const typescript = await declarationInternals();
    const candidates = declarationCandidates(typescript);
    // Non-vacuous: the candidates hold declarations and non-declarations alike, by TypeScript's own answer.
    expect(candidates.filter((name) => typescript.isDeclarationFileName(name))).toEqual(expect.arrayContaining(['a.d.ts', 'a.d.json.ts', '.d.mts']));
    expect(candidates.filter((name) => !typescript.isDeclarationFileName(name))).toEqual(expect.arrayContaining(['a.D.ts', 'x.d.dir/a.ts', 'a.d.ts.map', 'ad.ts']));
    expect(declarationDisagreements(isDeclarationName, typescript)).toEqual([]);
  });

  it('red seed: a rule testing only the three standard suffixes disagrees on a.d.json.ts', async () => {
    const suffixOnly = (path: string): boolean => ['.d.ts', '.d.mts', '.d.cts'].some((suffix) => path.endsWith(suffix));
    expect(declarationDisagreements(suffixOnly, await declarationInternals())).toContain('a.d.json.ts');
  });

  it('red seed: a rule searching the whole path for .d. disagrees on x.d.dir/a.ts', async () => {
    const wholePath = (path: string): boolean => isDeclarationName(path) || (path.endsWith('.ts') && path.includes('.d.'));
    expect(declarationDisagreements(wholePath, await declarationInternals())).toContain('x.d.dir/a.ts');
  });

  it('getModeForUsageLocation reads the stand-in\'s packageJsonScope', async () => {
    const typescript = await loadVendoredTypeScript();
    const { withScope, withoutScope } = importCallModes(typescript);
    expect(withScope).toBe(typescript.ModuleKind.CommonJS);
    expect(withoutScope).toBe(typescript.ModuleKind.ESNext);
  });

  it('red seed: a getModeForUsageLocation blind to packageJsonScope answers the same both ways', async () => {
    const { withScope, withoutScope } = importCallModes(scopeBlindStub(await loadVendoredTypeScript()));
    expect(withScope).toBe(withoutScope);
  });

  it('createSourceFile parses a snippet, and parseDiagnostics reports a bad one', async () => {
    const typescript = await loadVendoredTypeScript();
    const good = typescript.createSourceFile('good.ts', "import { a } from './a.js';\nexport const b = a;\n", typescript.ScriptTarget.Latest);
    expect(good.statements).toHaveLength(2);
    expect(parseDiagnosticsOf(good)).toEqual([]);
    const bad = typescript.createSourceFile('bad.ts', 'const = ;', typescript.ScriptTarget.Latest);
    expect(parseDiagnosticsOf(bad).length).toBeGreaterThan(0);
  });

  it('each copy is the devDependency\'s lib/typescript.js minus its trailing sourceMappingURL line', () => {
    const original = readFileSync(createRequire(import.meta.url).resolve('typescript/lib/typescript.js'));
    for (const copy of ['../../src/vendor/typescript.cjs', '../../dist/vendor/typescript.cjs']) {
      expect(isOriginalMinusSourceMapLine(readFileSync(new URL(copy, import.meta.url)), original), copy).toBe(true);
    }
  });

  it('red seed: a copy with one byte changed, or still carrying the map line, is not the original', () => {
    const original = Buffer.from('module.exports = 1;\n//# sourceMappingURL=typescript.js.map\n');
    expect(isOriginalMinusSourceMapLine(Buffer.from('module.exports = 1;\n'), original)).toBe(true);
    expect(isOriginalMinusSourceMapLine(Buffer.from('module.exports = 2;\n'), original)).toBe(false);
    expect(isOriginalMinusSourceMapLine(original, Buffer.concat([original, Buffer.from('x')]))).toBe(false);
  });
});
