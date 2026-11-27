/**
 * The tsconfig parse job (`projection/tsconfig-parse.ts`), run in-process over a fixture listing
 * and held texts: TypeScript's own config parse through a host that answers from the git-content
 * listing alone and reads only the texts it was handed.
 *
 * The root is an absolute path nothing on disk holds, so a host that fell through to the file
 * system would find nothing: every answer below comes from the listing. That the host answers as
 * TypeScript on disk does is held by `integration/tsconfig-parse-on-disk.integration.test.ts`.
 */

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { beforeAll, describe, expect, it } from 'vitest';

import { isParserUnavailable } from '../src/parse-cache.js';
import { DEFAULT_PARSE_LIMITS } from '../src/parse-limits.js';
import {
  loadTsconfigParse,
  parseTsconfigs,
  type ParsedTsconfig,
  type TsconfigJobAnswer,
  type TsconfigJobInput,
  tsconfigOutputBound,
  tsconfigOutputRows,
} from '../src/projection/tsconfig-parse.js';
import type ts from '../src/vendor/typescript.cjs';
import { loadVendoredTypeScript } from '../src/vendored-typescript.js';

/** An absolute root no disk holds. */
const ROOT = safePath.join(normalizedTmpdir(), 'vat-tsconfig-parse-fixture-root-never-created');

let typescript: typeof ts;

beforeAll(async () => {
  typescript = await loadVendoredTypeScript();
});

/** The job's input for `texts` (path to JSON value, serialized) over `listing`, demanding `configs`. */
function inputOf(configs: readonly string[], texts: Readonly<Record<string, unknown>>, listing: readonly string[]): TsconfigJobInput {
  const held = Object.fromEntries(Object.entries(texts).map(([path, value]) => [path, JSON.stringify(value)]));
  return { root: ROOT, configs, texts: held, listing, useCaseSensitiveFileNames: true };
}

/** A root-relative path whose first segment is `..`: outside the root. */
const OUTSIDE_ROOT = /^\.\.(?:\/|$)/;

/** Run the job in-process under the default limits. */
function run(input: TsconfigJobInput): TsconfigJobAnswer {
  return parseTsconfigs(typescript, input, DEFAULT_PARSE_LIMITS);
}

/** Every config of a parsed answer, by path; throws when the answer is not `parsed`. */
function parsed(input: TsconfigJobInput): ReadonlyMap<string, ParsedTsconfig> {
  const answer = run(input);
  if (answer.outcome !== 'parsed') throw new Error(`expected a parsed answer, got ${JSON.stringify(answer)}`);
  return new Map(answer.configs.map((config) => [config.path, config]));
}

/** The one config of a one-config parse. */
function only(input: TsconfigJobInput): ParsedTsconfig {
  const [config] = parsed(input).values();
  if (config === undefined) throw new Error('no config parsed');
  return config;
}

/** The error codes a config's parse gave. */
function codes(config: ParsedTsconfig): number[] {
  return config.errors.map((error) => error.code);
}

describe('the tsconfig parse job', () => {
  it('answers the TypeScript version that parsed', () => {
    const answer = run(inputOf(['tsconfig.json'], { 'tsconfig.json': { files: ['a.ts'] } }, ['tsconfig.json', 'a.ts']));
    expect(answer.typescript).toBe(typescript.version);
  });

  it('follows an array extends in TypeScript\'s order, later bases winning, the chain root-relative', () => {
    const config = only(inputOf(
      ['pkg/tsconfig.json'],
      {
        'pkg/tsconfig.json': { extends: ['../base1.json', '../base2.json'], include: ['src'] },
        'base1.json': { extends: './base0.json', compilerOptions: { strict: false, target: 'es2020' } },
        'base0.json': { compilerOptions: { allowJs: true, target: 'es2015' } },
        'base2.json': { compilerOptions: { strict: true } },
      },
      ['pkg/tsconfig.json', 'pkg/src/a.ts', 'base0.json', 'base1.json', 'base2.json'],
    ));
    expect(config.extends).toEqual(['base1.json', 'base0.json', 'base2.json']);
    expect(config.options).toMatchObject({ strict: true, allowJs: true, target: typescript.ScriptTarget.ES2020 });
    expect(config.options.configFile).toEqual({ fileName: 'pkg/tsconfig.json' });
    expect(config.fileNames).toEqual(['pkg/src/a.ts']);
    expect(config.errors).toEqual([]);
  });

  it('substitutes ${configDir} from a shared base with the extending config\'s directory, every path root-relative', () => {
    const base = { compilerOptions: { outDir: '${configDir}/dist', rootDir: '${configDir}/src' }, include: ['${configDir}/src'] };
    const configs = parsed(inputOf(
      ['a/tsconfig.json', 'b/tsconfig.json'],
      { 'tsconfig.base.json': base, 'a/tsconfig.json': { extends: '../tsconfig.base.json' }, 'b/tsconfig.json': { extends: '../tsconfig.base.json' } },
      ['tsconfig.base.json', 'a/tsconfig.json', 'a/src/x.ts', 'b/tsconfig.json', 'b/src/y.ts', 'b/dist/y.js'],
    ));
    expect(configs.get('a/tsconfig.json')).toMatchObject({ fileNames: ['a/src/x.ts'], options: { outDir: 'a/dist', rootDir: 'a/src' } });
    expect(configs.get('b/tsconfig.json')).toMatchObject({ fileNames: ['b/src/y.ts'], options: { outDir: 'b/dist', rootDir: 'b/src' } });
  });

  it('applies the default include and the implicit outDir exclude', () => {
    const config = only(inputOf(
      ['tsconfig.json'],
      { 'tsconfig.json': { compilerOptions: { outDir: 'dist', declarationDir: 'types' } } },
      ['tsconfig.json', 'src/a.ts', 'dist/a.d.ts', 'types/a.d.ts', 'lib/b.tsx'],
    ));
    expect(config.fileNames).toEqual(['lib/b.tsx', 'src/a.ts']);
  });

  it('keeps the higher-priority extension of two siblings', () => {
    const config = only(inputOf(
      ['tsconfig.json'],
      { 'tsconfig.json': { compilerOptions: { allowJs: true }, include: ['src'] } },
      ['tsconfig.json', 'src/a.ts', 'src/a.js', 'src/b.d.ts', 'src/b.ts', 'src/c.js'],
    ));
    expect(config.fileNames).toEqual(['src/a.ts', 'src/b.ts', 'src/c.js']);
  });

  it('reads a bare include directory as everything beneath it, and does not skip a dot directory the host lists', () => {
    // As TypeScript on disk answers (checked against `ts.sys` over a real tree): a bare `.storybook`
    // include is TypeScript's own `**/*` under a dot directory, which it skips; a spelled-out pattern
    // reaches it, because the host lists the dot directory like any other.
    const config = only(inputOf(
      ['tsconfig.json'],
      { 'tsconfig.json': { include: ['src', '.storybook', '.config/**/*'] } },
      ['tsconfig.json', 'src/deep/er/a.ts', '.storybook/main.ts', '.config/c.ts', 'other/b.ts'],
    ));
    expect(config.fileNames).toEqual(['src/deep/er/a.ts', '.config/c.ts']);
  });

  it('leaves a dot directory to TypeScript\'s own ** rule, which skips it', () => {
    const config = only(inputOf(['tsconfig.json'], { 'tsconfig.json': {} }, ['tsconfig.json', 'a.ts', '.hidden/b.ts']));
    expect(config.fileNames).toEqual(['a.ts']);
  });

  it('gives TS6053 for an extends target that is not git content, TS5083 when it is spelled with .json, and requests neither', () => {
    // TypeScript's own split, the same on disk: a `.json` target is taken without a lookup and then
    // cannot be read (5083); an extension-less one is looked up, with `.json` appended, and not found (6053).
    for (const [target, code] of [['./ignored-base', 6053], ['./ignored-base.json', 5083]] as const) {
      const answer = run(inputOf(['tsconfig.json'], { 'tsconfig.json': { extends: target, files: ['a.ts'] } }, ['tsconfig.json', 'a.ts']));
      expect(answer.outcome).toBe('parsed');
      if (answer.outcome !== 'parsed') return;
      expect(answer.configs[0]?.errors).toEqual([{ code, category: typescript.DiagnosticCategory.Error }]);
    }
  });

  it('gives TS6053 for an extends into node_modules, which is never git content', () => {
    const config = only(inputOf(['tsconfig.json'], { 'tsconfig.json': { extends: '@scope/config/tsconfig.json', files: ['a.ts'] } }, ['tsconfig.json', 'a.ts']));
    expect(codes(config)).toContain(6053);
  });

  it('requests the scope\'s package.json when a package-name extends makes TypeScript read it', () => {
    const answer = run(inputOf(['tsconfig.json'], { 'tsconfig.json': { extends: '@scope/base/tsconfig.json', files: ['a.ts'] } }, ['tsconfig.json', 'package.json', 'a.ts']));
    expect(answer).toEqual({ outcome: 'requests', typescript: typescript.version, requests: ['package.json'] });
  });

  it('requests a held-text miss instead of answering: a demanded config, and an extends target in git content', () => {
    expect(run(inputOf(['tsconfig.json'], {}, ['tsconfig.json', 'a.ts']))).toEqual({
      outcome: 'requests',
      typescript: typescript.version,
      requests: ['tsconfig.json'],
    });
    expect(run(inputOf(
      ['a/tsconfig.json', 'b/tsconfig.json'],
      { 'a/tsconfig.json': { extends: '../base.json' }, 'b/tsconfig.json': { extends: '../other.json' } },
      ['a/tsconfig.json', 'b/tsconfig.json', 'base.json', 'other.json', 'a/x.ts'],
    ))).toEqual({ outcome: 'requests', typescript: typescript.version, requests: ['base.json', 'other.json'] });
  });

  it('filters a literal files entry outside git content from the members, and reports it and a literal include entry', () => {
    const config = only(inputOf(
      ['tsconfig.json'],
      { 'tsconfig.json': { files: ['src/a.ts', 'src/built.ts'], include: ['lib', 'gone', 'src/*.ts'] } },
      ['tsconfig.json', 'src/a.ts', 'lib/b.ts'],
    ));
    expect(config.fileNames).toEqual(['src/a.ts', 'lib/b.ts']);
    expect(config.reachesOutsideGit).toEqual([
      { kind: 'files-entry', entry: 'src/built.ts', path: 'src/built.ts' },
      { kind: 'include-entry', entry: 'gone', path: 'gone' },
    ]);
  });

  it('gives TS18003 when no input is git content', () => {
    const config = only(inputOf(['tsconfig.json'], { 'tsconfig.json': { include: ['nothing/**/*'] } }, ['tsconfig.json', 'src/a.ts']));
    expect(codes(config)).toEqual([18003]);
  });

  it('records outside-root paths with the call and the phase, from the chain and from the inputs', () => {
    const config = only(inputOf(
      ['tsconfig.json'],
      { 'tsconfig.json': { extends: '../outside/base.json', include: ['src', '../shared/**/*'], files: ['../loose.ts'] } },
      ['tsconfig.json', 'src/a.ts'],
    ));
    const outside = config.asked.filter((asked) => OUTSIDE_ROOT.test(asked.path));
    expect(outside).toEqual(expect.arrayContaining([
      { path: '../outside/base.json', call: 'fileExists', phase: 'chain' },
      { path: '../loose.ts', call: 'files', phase: 'inputs' },
      { path: '../shared', call: 'getFileSystemEntries', phase: 'inputs' },
    ]));
    expect(outside.filter((asked) => asked.phase === 'chain').map((asked) => asked.path)).not.toContain('../shared');
    expect(config.asked).toContainEqual({ path: 'src', call: 'getFileSystemEntries', phase: 'inputs' });
  });

  it('answers project references root-relative, outside ones included', () => {
    const config = only(inputOf(
      ['tsconfig.json'],
      { 'tsconfig.json': { files: [], references: [{ path: './pkg' }, { path: '../sibling', circular: true }] } },
      ['tsconfig.json', 'pkg/tsconfig.json'],
    ));
    expect(config.projectReferences).toEqual([
      { path: 'pkg', originalPath: './pkg', circular: false },
      { path: '../sibling', originalPath: '../sibling', circular: true },
    ]);
    expect(config.errors).toEqual([]);
  });

  it('carries a code and a category per error, and no message text', () => {
    const config = only(inputOf(['tsconfig.json'], { 'tsconfig.json': { compilerOptions: { notAnOption: true }, files: ['a.ts'] } }, ['tsconfig.json', 'a.ts']));
    expect(config.errors.length).toBeGreaterThan(0);
    for (const error of config.errors) expect(Object.keys(error).sort((left, right) => left.localeCompare(right))).toEqual(['category', 'code']);
  });

  it('answers a text past outputDepth as defective with the data instance\'s code, before TypeScript reads it', () => {
    const limits = { ...DEFAULT_PARSE_LIMITS, outputDepth: 3 };
    const deep = { compilerOptions: { paths: { a: ['b'] } } };
    const answer = parseTsconfigs(typescript, inputOf(['tsconfig.json'], { 'tsconfig.json': deep }, ['tsconfig.json']), limits);
    expect(answer).toEqual({
      outcome: 'defective',
      typescript: typescript.version,
      defects: [{ path: 'tsconfig.json', code: 'PARSE_LIMIT_EXCEEDED', limit: 'outputDepth', found: 4 }],
    });
  });

  it('answers a text past inputBytes as defective, an extends target included', () => {
    const limits = { ...DEFAULT_PARSE_LIMITS, inputBytes: 40 };
    const big = { compilerOptions: { outDir: 'x'.repeat(64) } };
    const answer = parseTsconfigs(
      typescript,
      inputOf(['tsconfig.json'], { 'tsconfig.json': { extends: './base.json' }, 'base.json': big }, ['tsconfig.json', 'base.json']),
      limits,
    );
    expect(answer).toMatchObject({ outcome: 'defective', defects: [{ path: 'base.json', code: 'PARSE_LIMIT_EXCEEDED', limit: 'inputBytes' }] });
  });

  it('accepts a text nested exactly to outputDepth', () => {
    const limits = DEFAULT_PARSE_LIMITS;
    // The root object is one level; the rest is `paths`' arrays nested to the limit.
    let nested: unknown = 'x';
    for (let level = 0; level < limits.outputDepth - 1; level += 1) nested = [nested];
    const config = only(inputOf(['tsconfig.json'], { 'tsconfig.json': { files: ['a.ts'], deep: nested } }, ['tsconfig.json', 'a.ts']));
    expect(config.fileNames).toEqual(['a.ts']);
  });

  it('bounds its output by the listing times the configs, and counts what it returned against it', () => {
    const input = inputOf(['a.json', 'b.json'], { 'a.json': { files: ['x.ts'] }, 'b.json': { include: ['*.ts'] } }, ['a.json', 'b.json', 'x.ts', 'y.ts']);
    const answer = run(input);
    expect(tsconfigOutputBound(input)).toBe(8);
    expect(tsconfigOutputRows(answer)).toBe(3);
    expect(tsconfigOutputRows({ outcome: 'requests', typescript: 'v', requests: ['a.json'] })).toBe(0);
  });

  it('refuses as parser-unavailable, rather than guessing, when TypeScript lacks an internal the parse calls', () => {
    const input = inputOf(['tsconfig.json'], { 'tsconfig.json': {} }, ['tsconfig.json']);
    for (const missing of ['matchFiles', 'optionDeclarations']) {
      const lacking = { ...typescript, [missing]: undefined } as typeof ts;
      let thrown: unknown;
      try {
        parseTsconfigs(lacking, input, DEFAULT_PARSE_LIMITS);
      } catch (error) {
        thrown = error;
      }
      expect(isParserUnavailable(thrown)).toBe(true);
      expect((thrown as Error).message).toContain(`has no ${missing}`);
    }
  });

  it('loads TypeScript through the vendored loader and answers as the in-process function does', async () => {
    const parse = await loadTsconfigParse();
    const input = inputOf(['tsconfig.json'], { 'tsconfig.json': { include: ['src'] } }, ['tsconfig.json', 'src/a.ts']);
    expect(parse(input, DEFAULT_PARSE_LIMITS)).toEqual(run(input));
  });
});
