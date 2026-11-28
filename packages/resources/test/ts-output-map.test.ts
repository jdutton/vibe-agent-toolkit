/**
 * The output map (output path to source): built by TypeScript's own `getOutputFileNames`
 * per input on a shadow command line (`rootDir` fixed to the config's common source directory,
 * `fileNames: [input]`), so the build is linear in the inputs.
 *
 * The proof that the linear build is TypeScript's answer is equality: over every fixture, the
 * map equals the one the plain call `getOutputFileNames(parsed, input)` gives per input.
 */

import { compareCodeUnits, readWorkCounters } from '@vibe-agent-toolkit/utils';
import { beforeAll, describe, expect, it } from 'vitest';

import { combineOutputMaps, isEmittingConfig, OutputMaps, outputMapOf, type OutputMapConfig } from '../src/projection/ts-output-map.js';
import type ts from '../src/vendor/typescript.cjs';
import { loadVendoredTypeScript } from '../src/vendored-typescript.js';

import { parseInMemoryTsconfig } from './helpers/in-memory-tsconfig.js';

let typescript: typeof ts;

beforeAll(async () => {
  typescript = await loadVendoredTypeScript();
});

const lacks = (name: string): Error => new Error(`lacks ${name}`);

/** A one-config tree at `/p`: the config's compiler options and include, plus the files. */
function tree(compilerOptions: Record<string, unknown>, files: readonly string[], include: readonly string[] = ['src']): Record<string, string> {
  const tsconfig = JSON.stringify({ compilerOptions, include });
  return { '/p/tsconfig.json': tsconfig, ...Object.fromEntries(files.map((file) => [`/p/${file}`, file.endsWith('.json') ? '{}' : 'export {};\n'])) };
}

/** Every fixture, named. */
const FIXTURES: Record<string, Record<string, string>> = {
  'rootDir unset': tree({ outDir: 'dist', declaration: true }, ['src/a.ts', 'src/sub/b.ts']),
  'rootDir unset, composite': tree({ outDir: 'dist', composite: true }, ['src/a.ts', 'src/sub/b.ts']),
  'rootDir set': tree({ outDir: 'dist', rootDir: 'src', declaration: true }, ['src/a.ts', 'src/sub/b.ts']),
  'declarationDir beside outDir': tree({ outDir: 'dist', declarationDir: 'types', declaration: true }, ['src/a.ts']),
  'emitDeclarationOnly': tree({ outDir: 'dist', declaration: true, emitDeclarationOnly: true }, ['src/a.ts']),
  'declaration off': tree({ outDir: 'dist' }, ['src/a.ts']),
  'no outDir': tree({ declaration: true }, ['src/a.ts']),
  'jsx preserve': tree({ outDir: 'dist', jsx: 'preserve', declaration: true }, ['src/view.tsx', 'src/a.ts']),
  'json under resolveJsonModule': tree({ outDir: 'dist', resolveJsonModule: true, module: 'nodenext' }, ['src/a.ts', 'src/data.json'], ['src', 'src/data.json']),
  '.mts and .cts': tree({ outDir: 'dist', declaration: true, module: 'nodenext' }, ['src/e.mts', 'src/c.cts']),
  'source and declaration maps': tree({ outDir: 'dist', declaration: true, sourceMap: true, declarationMap: true }, ['src/a.ts']),
  'a declaration input': tree({ outDir: 'dist', declaration: true }, ['src/a.ts', 'src/types.d.ts']),
};

function parsedFixture(name: string): ts.ParsedCommandLine {
  const files = FIXTURES[name];
  if (files === undefined) throw new Error(`no fixture ${name}`);
  return parseInMemoryTsconfig(typescript, files, '/p/tsconfig.json');
}

/** The map the plain (quadratic) call gives: output to its inputs, one call per input on `parsed` itself. */
function plainMap(module: typeof ts, parsed: ts.ParsedCommandLine): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const input of parsed.fileNames) {
    for (const output of module.getOutputFileNames(parsed, input, false)) map.set(output, [...(map.get(output) ?? []), input]);
  }
  return map;
}

/** @returns The map's entries as a plain object, for readable equality */
function entriesOf(map: ReadonlyMap<string, readonly string[]> | undefined): Record<string, readonly string[]> {
  return Object.fromEntries(map ?? []);
}

/** A module whose `getCommonSourceDirectoryOfConfig` answers the seeded rule instead of TypeScript's. */
function withCommonSourceDirectory(module: typeof ts, rule: (parsed: OutputMapConfig) => string): typeof ts {
  return { ...module, getCommonSourceDirectoryOfConfig: rule } as typeof ts;
}

describe('outputMapOf: the shadow build equals TypeScript\'s plain per-input answer', () => {
  it.each(Object.keys(FIXTURES))('%s', (name) => {
    const parsed = parsedFixture(name);
    const built = outputMapOf(typescript, parsed, false, lacks);
    expect(entriesOf(built?.entries)).toEqual(entriesOf(plainMap(typescript, parsed)));
  });

  it('is not vacuous: every fixture but the declaration-only one maps something, and its inputs agree', () => {
    for (const name of Object.keys(FIXTURES)) {
      expect(outputMapOf(typescript, parsedFixture(name), false, lacks)?.entries.size ?? 0, name).toBeGreaterThan(0);
    }
  });

  it('holds the pinned 6.0 layout: outDir with no rootDir and include [src] gives dist/src/a.js', () => {
    expect(entriesOf(outputMapOf(typescript, parsedFixture('rootDir unset'), false, lacks)?.entries)).toEqual({
      '/p/dist/src/a.js': ['/p/src/a.ts'],
      '/p/dist/src/a.d.ts': ['/p/src/a.ts'],
      '/p/dist/src/sub/b.js': ['/p/src/sub/b.ts'],
      '/p/dist/src/sub/b.d.ts': ['/p/src/sub/b.ts'],
    });
    expect([...(outputMapOf(typescript, parsedFixture('rootDir unset, composite'), false, lacks)?.entries.keys() ?? [])]).toContain('/p/dist/src/a.js');
  });

  it('applies each option TypeScript applies', () => {
    const keys = (name: string): string[] => [...(outputMapOf(typescript, parsedFixture(name), false, lacks)?.entries.keys() ?? [])].sort(compareCodeUnits);
    expect(keys('declarationDir beside outDir')).toEqual(['/p/dist/src/a.js', '/p/types/src/a.d.ts']);
    expect(keys('emitDeclarationOnly')).toEqual(['/p/dist/src/a.d.ts']);
    expect(keys('declaration off')).toEqual(['/p/dist/src/a.js']);
    expect(keys('jsx preserve')).toContain('/p/dist/src/view.jsx');
    expect(keys('json under resolveJsonModule')).toContain('/p/dist/src/data.json');
    expect(keys('.mts and .cts')).toEqual(['/p/dist/src/c.cjs', '/p/dist/src/c.d.cts', '/p/dist/src/e.d.mts', '/p/dist/src/e.mjs']);
    expect(keys('a declaration input')).toEqual(['/p/dist/src/a.d.ts', '/p/dist/src/a.js']);
  });

  it('red seed: a shadow whose rootDir is the one input\'s own directory moves the no-rootDir outputs', () => {
    const parsed = parsedFixture('rootDir unset');
    const seeded = withCommonSourceDirectory(typescript, (config) => {
      const [first] = config.fileNames;
      return first === undefined ? '/' : first.slice(0, first.lastIndexOf('/') + 1);
    });
    expect(entriesOf(outputMapOf(seeded, parsed, false, lacks)?.entries)).not.toEqual(entriesOf(plainMap(typescript, parsed)));
  });

  it('is linear: getCommonSourceDirectoryOfConfig once, and each getOutputFileNames call sees one file name', () => {
    const parsed = parsedFixture('rootDir unset');
    const fileNameCounts: number[] = [];
    let commonCalls = 0;
    const internals = typescript as unknown as { getCommonSourceDirectoryOfConfig: (config: OutputMapConfig, ignoreCase: boolean) => string };
    const watched = {
      ...typescript,
      getOutputFileNames: (commandLine: ts.ParsedCommandLine, input: string, ignoreCase: boolean) => {
        fileNameCounts.push(commandLine.fileNames.length);
        return typescript.getOutputFileNames(commandLine, input, ignoreCase);
      },
      getCommonSourceDirectoryOfConfig: (config: OutputMapConfig, ignoreCase: boolean) => {
        commonCalls += 1;
        return internals.getCommonSourceDirectoryOfConfig(config, ignoreCase);
      },
    } as typeof ts;
    outputMapOf(watched, parsed, false, lacks);
    expect(parsed.fileNames).toHaveLength(2);
    expect(fileNameCounts).toEqual([1, 1]);
    expect(commonCalls).toBe(1);
  });

  it('noEmit and outFile configs are not emitting and build nothing', () => {
    for (const options of [{ outDir: 'dist', noEmit: true }, { outFile: 'bundle.js', module: 'amd' }]) {
      const parsed = parseInMemoryTsconfig(typescript, tree(options, ['src/a.ts']), '/p/tsconfig.json');
      expect(isEmittingConfig(parsed)).toBe(false);
      expect(outputMapOf(typescript, parsed, false, lacks)).toBeUndefined();
    }
    expect(isEmittingConfig(parsedFixture('rootDir unset'))).toBe(true);
  });

  it('refuses through the caller\'s factory when the internal it calls is missing', () => {
    const lacking = { ...typescript, getCommonSourceDirectoryOfConfig: undefined } as unknown as typeof ts;
    expect(() => outputMapOf(lacking, parsedFixture('rootDir unset'), false, lacks)).toThrow('lacks getCommonSourceDirectoryOfConfig');
    expect(() => new OutputMaps(lacking, false, lacks)).toThrow('lacks getCommonSourceDirectoryOfConfig');
  });
});

describe('combineOutputMaps: ambiguity across the run\'s configs', () => {
  it('x.ts and x.tsx in one config give one key with both sources, ambiguous', () => {
    // `include` keeps only x.ts of the pair (TypeScript drops the lower-priority extension), so the
    // pair is listed under `files`, which keeps both.
    const files = {
      '/p/tsconfig.json': JSON.stringify({ compilerOptions: { outDir: 'dist', jsx: 'react-jsx' }, files: ['src/x.ts', 'src/x.tsx', 'src/y.ts'] }),
      '/p/src/x.ts': 'export {};\n',
      '/p/src/x.tsx': 'export {};\n',
      '/p/src/y.ts': 'export {};\n',
    };
    const parsed = parseInMemoryTsconfig(typescript, files, '/p/tsconfig.json');
    const run = new OutputMaps(typescript, false, lacks).combined([parsed]);
    expect(run.lookup('/p/dist/src/x.js')).toEqual({ kind: 'ambiguous', sources: ['/p/src/x.ts', '/p/src/x.tsx'] });
    expect(run.lookup('/p/dist/src/y.js')).toEqual({ kind: 'source', source: '/p/src/y.ts' });
    expect(run.ambiguities).toEqual([{ output: '/p/dist/src/x.js', sources: ['/p/src/x.ts', '/p/src/x.tsx'] }]);
  });

  it('two configs mapping one output from two sources are ambiguous; from one source they are not', () => {
    const files = {
      '/p/tsconfig.a.json': JSON.stringify({ compilerOptions: { outDir: 'dist' }, include: ['src'] }),
      '/p/tsconfig.b.json': JSON.stringify({ compilerOptions: { outDir: 'dist/src', rootDir: 'other' }, include: ['other'] }),
      '/p/tsconfig.c.json': JSON.stringify({ compilerOptions: { outDir: 'dist' }, include: ['src'] }),
      '/p/src/x.ts': 'export {};\n',
      '/p/other/x.ts': 'export {};\n',
    };
    const [a, b, c] = ['a', 'b', 'c'].map((name) => parseInMemoryTsconfig(typescript, files, `/p/tsconfig.${name}.json`));
    if (a === undefined || b === undefined || c === undefined) throw new Error('three configs');
    const maps = new OutputMaps(typescript, false, lacks);
    expect(maps.combined([a, b]).lookup('/p/dist/src/x.js')).toEqual({ kind: 'ambiguous', sources: ['/p/other/x.ts', '/p/src/x.ts'] });
    expect(maps.combined([a, c]).lookup('/p/dist/src/x.js')).toEqual({ kind: 'source', source: '/p/src/x.ts' });
    expect(maps.combined([a, c]).ambiguities).toEqual([]);
  });

  it('under ignoreCase a key matches whatever case the path is asked in; case-sensitive it does not', () => {
    const parsed = parsedFixture('declaration off');
    const insensitive = combineOutputMaps([outputMapOf(typescript, parsed, true, lacks)], true);
    expect(insensitive.has('/P/DIST/src/A.js')).toBe(true);
    expect(insensitive.lookup('/P/DIST/src/A.js')).toEqual({ kind: 'source', source: '/p/src/a.ts' });
    const sensitive = combineOutputMaps([outputMapOf(typescript, parsed, false, lacks)], false);
    expect(sensitive.has('/P/DIST/src/A.js')).toBe(false);
    expect(sensitive.outputs()).toEqual(['/p/dist/src/a.js']);
    expect(sensitive.size).toBe(1);
  });
});

describe('OutputMaps: memo per config, counted', () => {
  it('builds each emitting config once per run and counts its entries', () => {
    const before = readWorkCounters();
    const maps = new OutputMaps(typescript, false, lacks);
    const emitting = parsedFixture('rootDir unset');
    // Another config path: the memo keys by configFilePath, so one at /p/tsconfig.json would answer emitting's map.
    const silentFiles = { '/q/tsconfig.json': JSON.stringify({ compilerOptions: { noEmit: true }, include: ['src'] }), '/q/src/a.ts': 'export {};\n' };
    const silent = parseInMemoryTsconfig(typescript, silentFiles, '/q/tsconfig.json');
    expect(maps.of(emitting)).toBe(maps.of(emitting));
    maps.combined([emitting, emitting]);
    expect(maps.of(silent)).toBeUndefined();
    const after = readWorkCounters();
    expect(after['resolve.ts.outputMapBuilds'] - before['resolve.ts.outputMapBuilds']).toBe(1);
    expect(after['resolve.ts.outputMapEntries'] - before['resolve.ts.outputMapEntries']).toBe(4);
  });
});
