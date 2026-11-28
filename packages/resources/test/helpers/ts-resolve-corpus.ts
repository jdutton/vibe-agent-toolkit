/**
 * The resolved import graph's I0 corpus workspace, shared: one clean
 * workspace that refuses nothing and holds every fixture, the census every arm answers alike,
 * and the expected rows of `ts_import_targets`, `ts_program_files` and `ts_import_conditions` over it.
 *
 * The workspace is a yarn workspace over `packages/*`; every demanded config is invoked by a member's
 * `build` script. No committed path names `dist/` or `node_modules/` (the fixture rule): those are
 * strings in manifests and configs, and the links an isolated install would present are the step's
 * own (a test that needs them on disk, the compiler differential, makes them itself from
 * {@link TS_RESOLVE_LINKS}).
 *
 * - **`@acme/lib`** (`type: module`): `exports` with conditions (`types` first, then `import` only, at
 *   `.`; `browser` before `types` at `./feature`), `imports` (`#internal`), a `noEmit`
 *   `tsconfig.json` no script invokes beside the script-invoked `tsconfig.build.json` that emits
 *   to `dist` (`rootDir: src`). Its index: relative `.js` to `.ts`, `#internal` and a
 *   self-reference (TypeScript's own input mapping: `file`, never redirected), and a directory
 *   import under NodeNext (`unresolved`, as tsc).
 * - **`@acme/app`** (CommonJS format, declares `@acme/lib`): `paths` under an `extends` chain with no
 *   `baseUrl` (so `pathsBasePath` decides), a failing alias (`unresolved`, never `external`), an
 *   alias into `node_modules/@acme/lib` (the link's `paths` half: `member`); the member through
 *   `exports` naming `dist` (`member`, `redirected`) under `require` mode although the root export is
 *   `{ types, import }` only; a dynamic `import()` (import mode in a CommonJS-format file); a
 *   `resolution-mode` attribute on an `import type`; a third-party name (`external`); `node:fs` and
 *   `fs` (`builtin`).
 * - **`@acme/other`** (declares nothing): the sibling-link pair. `@acme/lib`, declared by its sibling only, is
 *   `memberUndeclared`; `@acme/shared`, declared by the root manifest above it, is `member`.
 * - **`@acme/bundled`**: `module: commonjs` under `moduleResolution: bundler` (require mode).
 * - **`@acme/refs`**: the three triple-slash forms, `types` through `typeRoots`.
 * - **`@acme/layout`**: one config per output layout, each reached through its own `exports`
 *   subpath from `@acme/consumer`: `rootDir` unset without and with `composite`, `declarationDir`
 *   beside `outDir`, `emitDeclarationOnly`, `jsx: preserve` (`.tsx` to `.jsx`), a `.json` input,
 *   an `outFile` bundle (`outputUnmapped`), `x.ts` and `x.tsx` in one config and one output claimed
 *   by two configs (each `TS_OUTPUT_REDIRECT_AMBIGUOUS`).
 * - **`@acme/consumer`**: an augmentation in a module file, and an ambient module declaration in a
 *   script file whose body imports a bare name.
 * - **demand narrowing:** `fixtures/broken/tsconfig.json` is TS18003 and no script invokes it, so it
 *   refuses nothing ({@link INVOKE_BROKEN_SCRIPT} invokes it).
 * - **the version skew:** the root declares `typescript@^5.9.3` (one `TS_VERSION_SKEW` row).
 *
 * Pure data with no imports, so every package whose tests build this tree reads one copy: the
 * resources thread-hook proof, the cli census and system tests (`packages/cli/test/helpers/ts-resolve-rows.ts`
 * adds the files only the CLI arms read, and the expected rows) and the dev-tools compiler differential.
 */

/** `value` as a manifest's or config's text. */
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** NodeNext options every config but the two below it shares. */
const NODENEXT = { module: 'nodenext', moduleResolution: 'nodenext' } as const;

/** A member manifest with a `build` script compiling `projects` in order. */
function member(name: string, projects: readonly string[], fields: Readonly<Record<string, unknown>> = {}): string {
  return json({ name, private: true, ...fields, scripts: { build: projects.map((project) => `tsc -p ${project}`).join(' && ') } });
}

/** The layout member's configs, each compiling the named files to its own output layout. */
export const LAYOUT_CONFIGS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  'tsconfig.json': { extends: './tsconfig.base.json', compilerOptions: { outDir: 'out', declaration: true }, files: ['src/plain.ts'] },
  'tsconfig.composite.json': { extends: './tsconfig.base.json', compilerOptions: { outDir: 'out-composite', composite: true }, files: ['src/comp.ts'] },
  'tsconfig.decl.json': { extends: './tsconfig.base.json', compilerOptions: { outDir: 'out-js', declarationDir: 'out-types', declaration: true }, files: ['src/decl.ts'] },
  'tsconfig.declonly.json': { extends: './tsconfig.base.json', compilerOptions: { outDir: 'out-do', declaration: true, emitDeclarationOnly: true }, files: ['src/declonly.ts'] },
  'tsconfig.jsx.json': { extends: './tsconfig.base.json', compilerOptions: { outDir: 'out-jsx', jsx: 'preserve' }, files: ['src/view.tsx'] },
  'tsconfig.data.json': { extends: './tsconfig.base.json', compilerOptions: { outDir: 'out-json', resolveJsonModule: true }, files: ['src/data.json'] },
  'tsconfig.bundle.json': { compilerOptions: { module: 'system', outFile: 'bundle/out.js', declaration: true }, files: ['src/bundled.ts'] },
  'tsconfig.amb.json': { extends: './tsconfig.base.json', compilerOptions: { outDir: 'out-amb', declaration: true, jsx: 'react-jsx' }, files: ['src/x.ts', 'src/x.tsx'] },
  'tsconfig.two-a.json': { extends: './tsconfig.base.json', compilerOptions: { outDir: 'out-two', rootDir: 'src/two-a', declaration: true }, files: ['src/two-a/two.ts'] },
  'tsconfig.two-b.json': { extends: './tsconfig.base.json', compilerOptions: { outDir: 'out-two', rootDir: 'src/two-b', declaration: true }, files: ['src/two-b/two.ts'] },
};

/** The layout member's `exports`: one subpath per layout, each naming an output path. */
const LAYOUT_EXPORTS: Readonly<Record<string, unknown>> = {
  './plain': { types: './out/src/plain.d.ts' },
  './composite': { types: './out-composite/src/comp.d.ts' },
  './decl': { types: './out-types/src/decl.d.ts' },
  './declonly': { types: './out-do/src/declonly.d.ts' },
  './jsx': './out-jsx/src/view.jsx',
  './data': './out-json/src/data.json',
  './bundle': { types: './bundle/out.d.ts' },
  './amb': { types: './out-amb/src/x.d.ts' },
  './two': { types: './out-two/two.d.ts' },
};

/**
 * The workspace's files, by root-relative path: every corpus file but the three only the CLI arms
 * read (the VAT config and the markdown the census reads), which `TS_RESOLVE_FILES` adds.
 */
export const TS_RESOLVE_WORKSPACE: Readonly<Record<string, string>> = {
  'package.json': json({
    name: 'ts-resolve-root',
    private: true,
    packageManager: 'yarn@4.1.0',
    workspaces: ['packages/*'],
    devDependencies: { '@acme/shared': 'workspace:*', typescript: '^5.9.3' },
  }),
  'configs/tsconfig.paths.json': json({
    compilerOptions: {
      ...NODENEXT,
      // No `baseUrl`: each target resolves against this file's directory (`pathsBasePath`).
      paths: {
        '@shared/*': ['../packages/app/src/shared/*'],
        '@missing/*': ['../packages/app/src/nowhere/*'],
        '@lib-alias': ['../packages/app/node_modules/@acme/lib'],
      },
    },
  }),
  // TS18003 (no inputs), and no script invokes it.
  'fixtures/broken/tsconfig.json': json({ include: ['nothing'] }),

  'packages/lib/package.json': member('@acme/lib', ['tsconfig.build.json'], {
    type: 'module',
    types: './dist/index.d.ts',
    exports: {
      '.': { types: './dist/index.d.ts', import: './dist/index.js' },
      './feature': { browser: './dist/browser.js', types: './dist/feature.d.ts', default: './dist/feature.js' },
    },
    imports: { '#internal': { types: './dist/internal.d.ts', default: './dist/internal.js' } },
  }),
  'packages/lib/tsconfig.json': json({ compilerOptions: { ...NODENEXT, noEmit: true }, include: ['src'] }),
  'packages/lib/tsconfig.build.json': json({ extends: './tsconfig.json', compilerOptions: { noEmit: false, outDir: 'dist', rootDir: 'src', declaration: true } }),
  'packages/lib/src/index.ts': [
    "import { feature } from './feature.js';",
    "import { internal } from '#internal';",
    "import { feature as self } from '@acme/lib/feature';",
    "import './dir';",
    'export const lib = feature + internal + self;',
    'export type Lib = typeof lib;',
    '',
  ].join('\n'),
  'packages/lib/src/feature.ts': 'export const feature = 1;\n',
  'packages/lib/src/internal.ts': 'export const internal = 1;\n',
  'packages/lib/src/dir/index.ts': 'export const dir = 1;\n',

  'packages/app/package.json': member('@acme/app', ['.'], { dependencies: { '@acme/lib': 'workspace:*' } }),
  'packages/app/tsconfig.json': json({ extends: '../../configs/tsconfig.paths.json', compilerOptions: { noEmit: true }, include: ['src'] }),
  'packages/app/src/index.ts': [
    "import { lib } from '@acme/lib';",
    "import { feature } from '@acme/lib/feature';",
    "import type { Lib } from '@acme/lib' with { 'resolution-mode': 'import' };",
    "import { shared } from '@shared/util';",
    "import { gone } from '@missing/thing';",
    "import { lib as alias } from '@lib-alias';",
    "import { chunk } from 'lodash';",
    "import { readFileSync } from 'node:fs';",
    "import { existsSync } from 'fs';",
    "import { util } from './util.js';",
    "export const later = import('@acme/lib');",
    'export const all: Lib[] = [lib, feature, shared, gone, alias, chunk, readFileSync, existsSync, util];',
    '',
  ].join('\n'),
  'packages/app/src/util.ts': 'export const util = 1;\n',
  'packages/app/src/shared/util.ts': 'export const shared = 1;\n',

  'packages/other/package.json': member('@acme/other', ['.']),
  'packages/other/tsconfig.json': json({ compilerOptions: { ...NODENEXT, noEmit: true }, include: ['src'] }),
  'packages/other/src/index.ts': "import { lib } from '@acme/lib';\nimport { shared } from '@acme/shared';\nexport const both = [lib, shared];\n",

  'packages/shared/package.json': json({ name: '@acme/shared', private: true, types: './index.d.ts' }),
  'packages/shared/index.d.ts': 'export declare const shared: number;\n',

  'packages/bundled/package.json': member('@acme/bundled', ['.']),
  'packages/bundled/tsconfig.json': json({ compilerOptions: { module: 'commonjs', moduleResolution: 'bundler', noEmit: true }, include: ['src'] }),
  'packages/bundled/src/main.ts': "import { util } from './util';\nexport const main = util;\n",
  'packages/bundled/src/util.ts': 'export const util = 1;\n',

  'packages/refs/package.json': member('@acme/refs', ['.']),
  'packages/refs/tsconfig.json': json({ compilerOptions: { ...NODENEXT, noEmit: true, typeRoots: ['./types'] }, files: ['src/main.ts'] }),
  'packages/refs/src/main.ts': [
    '/// <reference path="./globals.d.ts" />',
    '/// <reference types="env" />',
    '/// <reference lib="es2020" />',
    'export const main = GLOBAL_FLAG && ENV_NAME;',
    '',
  ].join('\n'),
  'packages/refs/src/globals.d.ts': 'declare const GLOBAL_FLAG: boolean;\n',
  'packages/refs/types/env/index.d.ts': 'declare const ENV_NAME: string;\n',

  'packages/layout/package.json': member('@acme/layout', Object.keys(LAYOUT_CONFIGS), { type: 'module', exports: LAYOUT_EXPORTS }),
  'packages/layout/tsconfig.base.json': json({ compilerOptions: NODENEXT }),
  ...Object.fromEntries(Object.entries(LAYOUT_CONFIGS).map(([name, value]) => [`packages/layout/${name}`, json(value)])),
  'packages/layout/src/plain.ts': 'export interface Plain { name: string }\nexport const plain = 1;\n',
  'packages/layout/src/comp.ts': 'export const comp = 1;\n',
  'packages/layout/src/decl.ts': 'export const decl = 1;\n',
  'packages/layout/src/declonly.ts': 'export const declonly = 1;\n',
  'packages/layout/src/view.tsx': 'export const View = () => <div />;\n',
  'packages/layout/src/data.json': '{"data": 1}\n',
  'packages/layout/src/bundled.ts': 'export const bundled = 1;\n',
  // The bundle's declaration, committed: a bundler's output no output map holds.
  'packages/layout/bundle/out.d.ts': 'export declare const bundled: number;\n',
  'packages/layout/src/x.ts': 'export const x = 1;\n',
  'packages/layout/src/x.tsx': 'export const x = 2;\n',
  'packages/layout/src/two-a/two.ts': 'export const two = 1;\n',
  'packages/layout/src/two-b/two.ts': 'export const two = 2;\n',

  'packages/consumer/package.json': member('@acme/consumer', ['.'], { type: 'module', dependencies: { '@acme/layout': 'workspace:*' } }),
  'packages/consumer/tsconfig.json': json({ compilerOptions: { ...NODENEXT, noEmit: true, allowJs: true, jsx: 'preserve', resolveJsonModule: true }, include: ['src'] }),
  'packages/consumer/src/index.ts': [
    "import { plain } from '@acme/layout/plain';",
    "import { comp } from '@acme/layout/composite';",
    "import { decl } from '@acme/layout/decl';",
    "import { declonly } from '@acme/layout/declonly';",
    "import { View } from '@acme/layout/jsx';",
    "import data from '@acme/layout/data' with { type: 'json' };",
    "import { bundled } from '@acme/layout/bundle';",
    "import { x } from '@acme/layout/amb';",
    "import { two } from '@acme/layout/two';",
    'export const all = [plain, comp, decl, declonly, View, data, bundled, x, two];',
    '',
  ].join('\n'),
  // A module file: the `declare module` is an augmentation, resolved.
  'packages/consumer/src/augment.ts': "export {};\ndeclare module '@acme/layout/plain' {\n  interface Plain { extra: number }\n}\n",
  // A script file: the `declare module` is an ambient module name, not resolved; its body's bare import is.
  'packages/consumer/src/ambient.d.ts': "declare module 'virtual-mod' {\n  import { Shape } from 'shape-lib';\n  export const v: Shape;\n}\n",
};

/**
 * The links an isolated install would present: `<D>/node_modules/<name>` to the member's
 * directory, for each manifest directory `D` declaring `<name>`. For a test that builds the tree on
 * disk with real links; the step derives the same table from the workspace rows.
 */
export const TS_RESOLVE_LINKS: Readonly<Record<string, string>> = {
  'node_modules/@acme/shared': 'packages/shared',
  'packages/app/node_modules/@acme/lib': 'packages/lib',
  'packages/consumer/node_modules/@acme/layout': 'packages/layout',
};

/** The root script a demand-narrowing seed adds: it invokes the TS18003 config, which then refuses. */
export const INVOKE_BROKEN_SCRIPT = 'tsc -p fixtures/broken';

/** The root manifest with {@link INVOKE_BROKEN_SCRIPT} as its `build`. */
export const ROOT_PACKAGE_INVOKING_BROKEN = json({ ...JSON.parse(TS_RESOLVE_WORKSPACE['package.json'] ?? '{}') as Record<string, unknown>, scripts: { build: INVOKE_BROKEN_SCRIPT } });
