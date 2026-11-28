/**
 * The tsconfig parse job answers as TypeScript on disk does: over a real tree, `ts.sys` and the
 * job's listing-only host give the same files (less the literal entries the job reports as outside
 * git content) and the same error codes. Every file of a fixture is git content here, and every
 * JSON file is held, a config or the `package.json` TypeScript reads for a package-name `extends`.
 */

import { rmSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_PARSE_LIMITS } from '../../src/parse-limits.js';
import { parseTsconfigs } from '../../src/projection/tsconfig-parse.js';
import type ts from '../../src/vendor/typescript.cjs';
import { loadVendoredTypeScript } from '../../src/vendored-typescript.js';

let typescript: typeof ts;

beforeAll(async () => {
  typescript = await loadVendoredTypeScript();
});

/** Fixtures the job and TypeScript on disk must answer alike: path to file text, and the config parsed. */
const DISK_FIXTURES: ReadonlyArray<{ readonly files: Readonly<Record<string, string>>; readonly config: string }> = [
  {
    config: 'pkg/tsconfig.json',
    files: {
      'pkg/tsconfig.json': '{"extends":["../base1.json","../base2"],"compilerOptions":{"allowJs":true}}',
      'base1.json': '{"extends":"./base0.json","include":["${configDir}/src","${configDir}/.config/**/*"]}',
      'base0.json': '{"compilerOptions":{"outDir":"${configDir}/dist"}}',
      'base2.json': '{"compilerOptions":{"strict":true}}',
      'pkg/src/a.ts': '', 'pkg/src/a.js': '', 'pkg/src/b.d.ts': '', 'pkg/src/c.js': '', 'pkg/.config/d.ts': '',
      'pkg/src/.hidden/e.ts': '', 'pkg/dist/f.ts': '',
    },
  },
  {
    config: 'tsconfig.json',
    files: {
      'tsconfig.json': '{"compilerOptions":{"declarationDir":"types"},"exclude":["skip"],"files":["x.ts","gone.ts"]}',
      'x.ts': '', 'skip/y.ts': '', 'types/z.d.ts': '', 'lib/w.tsx': '', 'package.json': '{"name":"p"}',
    },
  },
  {
    config: 'tsconfig.json',
    files: { 'tsconfig.json': '{"extends":"@scope/base/tsconfig.json","include":["nothing"]}', 'package.json': '{"name":"p"}', 'a.ts': '' },
  },
];

describe('the tsconfig parse job against TypeScript on disk', () => {
  const base = safePath.join(normalizedTmpdir(), `vat-tsconfig-oracle-${String(process.pid)}`);
  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it.each(DISK_FIXTURES.map((fixture, index) => [index, fixture] as const))('fixture %i: the same files and error codes as ts.sys over the same tree', (_index, fixture) => {
    const root = safePath.join(base, `fixture-${String(_index)}`);
    for (const [path, text] of Object.entries(fixture.files)) {
      mkdirSyncReal(safePath.resolve(root, path, '..'), { recursive: true });
      writeFileSync(safePath.join(root, path), text);
    }
    const fileName = safePath.join(root, fixture.config);
    const sourceFile = typescript.readJsonConfigFile(fileName, typescript.sys.readFile);
    const onDisk = typescript.parseJsonSourceFileConfigFileContent(sourceFile, typescript.sys, safePath.resolve(fileName, '..'), undefined, fileName);

    const configTexts = Object.fromEntries(Object.entries(fixture.files).filter(([path]) => path.endsWith('.json')));
    const answer = parseTsconfigs(
      typescript,
      { root, configs: [fixture.config], texts: configTexts, listing: Object.keys(fixture.files), useCaseSensitiveFileNames: typescript.sys.useCaseSensitiveFileNames },
      DEFAULT_PARSE_LIMITS,
    );
    expect(answer.outcome).toBe('parsed');
    if (answer.outcome !== 'parsed') return;
    const [config] = answer.configs;
    const outsideGit = new Set(config?.reachesOutsideGit.map((entry) => entry.path));
    expect(config?.fileNames).toEqual(onDisk.fileNames.map((name) => safePath.relative(root, name)).filter((name) => !outsideGit.has(name)));
    expect(config?.errors.map((error) => error.code)).toEqual(onDisk.errors.map((error) => error.code));
  });
});
