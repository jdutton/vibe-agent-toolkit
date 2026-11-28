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
import { gateJsonDepth } from '../src/projection/data-extractor.js';
import {
  loadTsconfigParse,
  parseTsconfigs,
  type ParsedTsconfig,
  type TsconfigJobAnswer,
  type TsconfigJobInput,
} from '../src/projection/tsconfig-parse.js';
import { NO_WORKSPACE_LINKS, workspaceLinks, type WorkspaceLinkTable } from '../src/projection/workspace-links.js';
import type { WorkspaceDependencyRow, WorkspacePackageRow } from '../src/schemas/projection-workspace.js';
import type ts from '../src/vendor/typescript.cjs';
import { loadVendoredTypeScript } from '../src/vendored-typescript.js';

/** An absolute root no disk holds. */
const ROOT = safePath.join(normalizedTmpdir(), 'vat-tsconfig-parse-fixture-root-never-created');

let typescript: typeof ts;

beforeAll(async () => {
  typescript = await loadVendoredTypeScript();
});

/** The job's input for `texts` (path to JSON value, serialized) over `listing`, demanding `configs`. */
function inputOf(configs: readonly string[], texts: Readonly<Record<string, unknown>>, listing: readonly string[], links: WorkspaceLinkTable = NO_WORKSPACE_LINKS): TsconfigJobInput {
  const held = Object.fromEntries(Object.entries(texts).map(([path, value]) => [path, JSON.stringify(value)]));
  return { root: ROOT, configs, texts: held, listing, links, useCaseSensitiveFileNames: true };
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

  it('holds git content under a node_modules that is no link as absent, as the resolution host does', () => {
    const tracked = { 'tsconfig.json': { extends: '@scope/config/tsconfig.json', files: ['a.ts', 'node_modules/x/b.ts'] }, 'node_modules/@scope/config/tsconfig.json': { compilerOptions: { strict: true } } };
    const config = only(inputOf(['tsconfig.json'], tracked, ['tsconfig.json', 'a.ts', 'node_modules/@scope/config/tsconfig.json', 'node_modules/x/b.ts']));
    expect(codes(config)).toContain(6053);
    expect(config.fileNames).toEqual(['a.ts']);
    expect(config.reachesOutsideGit).toEqual([{ kind: 'files-entry', entry: 'node_modules/x/b.ts', path: 'node_modules/x/b.ts' }]);
  });

  it('names a root file by its listed spelling on a case-insensitive host, and drops it on a case-sensitive one', () => {
    const texts = { 'tsconfig.json': { files: ['SRC/a.ts', 'src/b.ts'] } };
    const listing = ['tsconfig.json', 'src/a.ts', 'src/b.ts'];
    expect(only({ ...inputOf(['tsconfig.json'], texts, listing), useCaseSensitiveFileNames: false }).fileNames).toEqual(['src/a.ts', 'src/b.ts']);
    expect(only(inputOf(['tsconfig.json'], texts, listing)).fileNames).toEqual(['src/b.ts']);
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

  it('accepts a text nested exactly to outputDepth at the gate, and refuses one level more', () => {
    // The gate is a scan over an explicit stack, so this recurses on no platform. That TypeScript's
    // recursive reader then PARSES this depth is held in a worker at the default stack by
    // `parse-pool-tsconfig.test.ts`: in-process it would run on whatever stack the test runner's
    // thread has (a Windows fork's is under 1 MiB, a worker's 4 MiB), which is not the shipped one.
    const limits = DEFAULT_PARSE_LIMITS;
    const textNestedTo = (depth: number): string => `${'['.repeat(depth - 1)}"x"${']'.repeat(depth - 1)}`;
    expect(gateJsonDepth(`{"deep":${textNestedTo(limits.outputDepth)}}`, limits).outcome).toBe('depth');
    expect(gateJsonDepth(`{"deep":${textNestedTo(limits.outputDepth + 1)}}`, limits)).toMatchObject({ outcome: 'breach', limit: 'outputDepth' });
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

// ── Workspace links: a declared member is present at `<D>/node_modules/<name>` ──────

/** A `workspace_packages` row for the manifest in `dir`. */
function memberRow(dir: string, name: string | null): WorkspacePackageRow {
  return { root: 'r', path: dir === '.' ? 'package.json' : `${dir}/package.json`, dir, name, version: null, private: null, workspaceRoot: dir === '.' };
}

/** A `workspace_dependencies` row: the manifest in `from` declares `name`, naming the member in `target`. */
function declares(from: string, name: string, target: string, field = 'dependencies'): WorkspaceDependencyRow {
  return { root: 'r', path: from === '.' ? 'package.json' : `${from}/package.json`, field, name, range: 'workspace:*', targetPath: `${target}/package.json`, protocol: 'workspace' };
}

const BASE_MEMBER = 'packages/base';
const MEMBERS = [memberRow('.', 'root'), memberRow('packages/app', 'app'), memberRow('packages/other', 'other'), memberRow(BASE_MEMBER, '@acme/base')];
const APP_CONFIG = 'packages/app/tsconfig.json';
const OTHER_CONFIG = 'packages/other/tsconfig.json';
const BASE_CONFIG = 'packages/base/tsconfig.json';
const EXTENDS_BASE = { extends: '@acme/base/tsconfig.json', include: ['src'] };

/** The workspace's listing: the root, `app` and `other` (each with a source file), and `base` with its config and sources. */
const MEMBER_LISTING = [
  'package.json',
  'packages/app/package.json', APP_CONFIG, 'packages/app/src/a.ts',
  'packages/other/package.json', OTHER_CONFIG, 'packages/other/src/o.ts',
  'packages/base/package.json', BASE_CONFIG, 'packages/base/src/x.ts', 'packages/base/configs/strict.json',
];

/** Every manifest's text and both member configs extending `@acme/base`; `base` names its config by `exports` when `exports` is given. */
function memberTexts(exports?: Record<string, string>): Record<string, unknown> {
  return {
    'package.json': { name: 'root' },
    'packages/app/package.json': { name: 'app' },
    'packages/other/package.json': { name: 'other' },
    'packages/base/package.json': { name: '@acme/base', ...(exports === undefined ? {} : { exports }) },
    [BASE_CONFIG]: { compilerOptions: { outDir: './dist', strict: true } },
    'packages/base/configs/strict.json': { compilerOptions: { noUncheckedIndexedAccess: true } },
    [APP_CONFIG]: EXTENDS_BASE,
    [OTHER_CONFIG]: EXTENDS_BASE,
  };
}

describe('the tsconfig parse job through workspace links', () => {
  const appDeclares = workspaceLinks(MEMBERS, [declares('packages/app', '@acme/base', BASE_MEMBER)], false);

  it('resolves a package-name extends of a member its manifest declares, answering the member\'s own path', () => {
    const config = only(inputOf([APP_CONFIG], memberTexts(), MEMBER_LISTING, appDeclares));
    expect(config.errors).toEqual([]);
    expect(config.extends).toEqual([BASE_CONFIG]);
    // The base's own path option resolves against the member's directory, never the link's.
    expect(config.options).toMatchObject({ outDir: 'packages/base/dist', strict: true });
    expect(config.fileNames).toEqual(['packages/app/src/a.ts']);
    // Every asked path through the link is recorded canonical: the link directories themselves are the only node_modules spellings.
    expect(config.asked.map((asked) => asked.path).filter((path) => path.includes('node_modules/@acme/base'))).toEqual([]);
    expect(config.asked).toContainEqual({ path: 'packages/base/package.json', call: 'readFile', phase: 'chain' });
  });

  it('gives TS6053 from a member that does not declare it, and for a name no member has', () => {
    expect(codes(only(inputOf([OTHER_CONFIG], memberTexts(), MEMBER_LISTING, appDeclares)))).toEqual([6053]);
    const texts = { ...memberTexts(), [APP_CONFIG]: { extends: '@acme/nope/tsconfig.json', include: ['src'] } };
    expect(codes(only(inputOf([APP_CONFIG], texts, MEMBER_LISTING, appDeclares)))).toEqual([6053]);
  });

  it('resolves from every member when the root manifest declares it (a file walks its ancestors\' links)', () => {
    const rootDeclares = workspaceLinks(MEMBERS, [declares('.', '@acme/base', BASE_MEMBER, 'devDependencies')], false);
    const configs = parsed(inputOf([APP_CONFIG, OTHER_CONFIG], memberTexts(), MEMBER_LISTING, rootDeclares));
    for (const config of [APP_CONFIG, OTHER_CONFIG]) expect(configs.get(config)).toMatchObject({ extends: [BASE_CONFIG], errors: [] });
  });

  it('lists a literal include through a link under the member\'s own paths, reaching nothing outside git', () => {
    const rootDeclares = workspaceLinks(MEMBERS, [declares('.', '@acme/base', BASE_MEMBER, 'devDependencies')], false);
    const config = only(inputOf(['tsconfig.json'], { 'tsconfig.json': { include: ['node_modules/@acme/base/src'] } }, ['tsconfig.json', ...MEMBER_LISTING], rootDeclares));
    expect(config.errors).toEqual([]);
    expect(config.fileNames).toEqual(['packages/base/src/x.ts']);
    expect(config.reachesOutsideGit).toEqual([]);
  });

  it('serves a linked package.json#exports naming the config from the held texts, with no request', () => {
    const texts = { ...memberTexts({ './tsconfig': './configs/strict.json' }), [APP_CONFIG]: { extends: '@acme/base/tsconfig', include: ['src'] } };
    const answer = run(inputOf([APP_CONFIG], texts, MEMBER_LISTING, appDeclares));
    expect(answer.outcome).toBe('parsed');
    expect(answer).toMatchObject({ configs: [{ extends: ['packages/base/configs/strict.json'], errors: [] }] });
  });

  it('requests a linked package.json it was not handed under the member\'s path', () => {
    const texts = Object.fromEntries(Object.entries(memberTexts()).filter(([path]) => path !== 'packages/base/package.json'));
    expect(run(inputOf([APP_CONFIG], texts, MEMBER_LISTING, appDeclares))).toEqual({ outcome: 'requests', typescript: typescript.version, requests: ['packages/base/package.json'] });
  });

  it('a path below a link that names node_modules is not a link: TS6053', () => {
    const texts = { ...memberTexts(), [APP_CONFIG]: { extends: '@acme/base/node_modules/@acme/base/tsconfig.json', include: ['src'] } };
    expect(codes(only(inputOf([APP_CONFIG], texts, MEMBER_LISTING, appDeclares)))).toEqual([6053]);
  });
});
