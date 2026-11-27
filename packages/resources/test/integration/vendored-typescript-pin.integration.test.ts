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
 * Not here yet, each deferred to the PR that owns what it checks:
 *
 * - the `dts` rule's agreement with TypeScript (no `dts` rule exists until the `ts` extraction
 *   lands; it brings that check);
 * - the fixtures proving `configFile.fileName` reaches the resolver, and `configFilePath` reaches
 *   `getOutputFileNames` and `getCommonSourceDirectoryOfConfig`. Those are claims about the options
 *   VAT passes, and no VAT code passes options until the type-resolution PR, which owns option
 *   passing and brings them. Until then this file pins only that the functions exist and behave.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

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
] as const;

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
