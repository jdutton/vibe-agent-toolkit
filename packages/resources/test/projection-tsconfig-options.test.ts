/**
 * The tsconfig options helper (`projection/tsconfig-options.ts`): path options root-relative and
 * back, over the vendored TypeScript's own `optionDeclarations`, read here at test time so a
 * TypeScript that adds a path option moves the test with it.
 */

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { beforeAll, describe, expect, it } from 'vitest';

import { absoluteOptions, pathOptionNames, rootRelativeOptions } from '../src/projection/tsconfig-options.js';
import type ts from '../src/vendor/typescript.cjs';
import { loadVendoredTypeScript } from '../src/vendored-typescript.js';

/** An absolute root no disk holds. */
const ROOT = safePath.join(normalizedTmpdir(), 'vat-tsconfig-options-fixture-root-never-created');

type Declaration = { readonly name: string; readonly isFilePath?: boolean; readonly element?: { readonly isFilePath?: boolean } };

let typescript: typeof ts;
let declarations: readonly Declaration[];

beforeAll(async () => {
  typescript = await loadVendoredTypeScript();
  declarations = (typescript as unknown as { optionDeclarations: readonly Declaration[] }).optionDeclarations;
});

/** @returns Root-relative form of an absolute path (no links) */
const relativeTo = (path: string): string => safePath.relative(ROOT, path);

/** @returns An absolute options bag holding every declared file-path option (a string, or a list) */
function everyPathOption(): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  for (const declaration of declarations) {
    if (declaration.isFilePath === true) options[declaration.name] = safePath.join(ROOT, 'under', declaration.name);
    else if (declaration.element?.isFilePath === true) options[declaration.name] = [safePath.join(ROOT, 'a', declaration.name), safePath.join(ROOT, 'b', declaration.name)];
  }
  return { ...options, configFilePath: safePath.join(ROOT, 'tsconfig.json'), pathsBasePath: safePath.join(ROOT, 'packages', 'x'), strict: true };
}

describe('pathOptionNames', () => {
  it('lists every declared file-path option and the two undeclared ones', () => {
    const names = pathOptionNames(typescript);
    const declared = declarations.filter((declaration) => declaration.isFilePath === true || declaration.element?.isFilePath === true).map((declaration) => declaration.name);
    expect(declared.length).toBeGreaterThan(5);
    for (const name of [...declared, 'configFilePath', 'pathsBasePath']) expect(names).toContain(name);
    expect(names).not.toContain('strict');
  });
});

describe('rootRelativeOptions and absoluteOptions', () => {
  it('round-trips every file-path option, lists included, and leaves the rest alone', () => {
    const absolute = everyPathOption();
    const relative = rootRelativeOptions(typescript, relativeTo, absolute as unknown as ts.CompilerOptions);
    expect(relative['outDir']).toBe('under/outDir');
    expect(relative['pathsBasePath']).toBe('packages/x');
    expect(relative['strict']).toBe(true);
    expect(absoluteOptions(typescript, relative, ROOT)).toEqual(absolute);
  });

  it('round-trips configFile as { fileName }, and drops everything else of the source file', () => {
    const absolute = { configFile: { fileName: safePath.join(ROOT, 'a', 'tsconfig.json'), text: 'x' }, strict: true };
    const relative = rootRelativeOptions(typescript, relativeTo, absolute as unknown as ts.CompilerOptions);
    expect(relative.configFile).toEqual({ fileName: 'a/tsconfig.json' });
    expect(absoluteOptions(typescript, relative, ROOT).configFile).toEqual({ fileName: safePath.join(ROOT, 'a', 'tsconfig.json') });
  });

  it('keeps the .. of an option outside the root through the round trip', () => {
    const outside = safePath.resolve(ROOT, '..', 'elsewhere', 'out');
    const relative = rootRelativeOptions(typescript, relativeTo, { outDir: outside });
    expect(relative['outDir']).toBe('../elsewhere/out');
    expect(absoluteOptions(typescript, relative, ROOT)['outDir']).toBe(outside);
  });

  it('absolutizes under the root as given, a drive-letter root on any host, never against the working directory', () => {
    for (const root of ['C:/repo', '/repo']) {
      expect(absoluteOptions(typescript, { outDir: 'packages/a/dist', rootDir: '../up' }, root)).toEqual({ outDir: `${root}/packages/a/dist`, rootDir: root.replace('/repo', '/up') });
    }
  });

  it('absolutizes the root itself (an empty relative path) to the root', () => {
    expect(absoluteOptions(typescript, { rootDir: '' }, ROOT)['rootDir']).toBe(ROOT);
  });

  it('leaves a non-path value of a path option alone', () => {
    expect(absoluteOptions(typescript, { typeRoots: [1 as unknown as string] }, ROOT)['typeRoots']).toEqual([1]);
  });
});
