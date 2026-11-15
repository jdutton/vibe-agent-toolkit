/**
 * The pure helpers behind `eslint.config.js`'s lint guard and ignore translation. They live at the
 * repo root beside the config, which every package's lint loads.
 */
import { describe, expect, it } from 'vitest';

import { declaredTypesFiles, gitignorePatterns, lintTaskRefusal } from '../../../eslint-config-support.js';

describe('gitignorePatterns', () => {
  it('matches an unanchored pattern at any depth, below the ignore file\'s directory', () => {
    expect(gitignorePatterns('build\n', '.gitignore')).toEqual(['**/build', '**/build/**']);
    expect(gitignorePatterns('*.log\n', 'pkg/sub/.gitignore')).toEqual(['pkg/sub/**/*.log', 'pkg/sub/**/*.log/**']);
  });

  it('anchors a pattern with a slash before its end to the ignore file\'s directory', () => {
    expect(gitignorePatterns('/coverage\nout/tmp\n', 'pkg/.gitignore')).toEqual(['pkg/coverage', 'pkg/coverage/**', 'pkg/out/tmp', 'pkg/out/tmp/**']);
  });

  it('reads a trailing slash as the directory\'s contents only', () => {
    expect(gitignorePatterns('dist/\n/run/\n', '.gitignore')).toEqual(['**/dist/**', 'run/**']);
  });

  it('keeps a negation as a re-include', () => {
    expect(gitignorePatterns('*\n!keep.ts\n', 'run/.gitignore')).toEqual(['run/**/*', 'run/**/*/**', '!run/**/keep.ts', '!run/**/keep.ts/**']);
  });

  it('skips blank lines and comments, and reads a mid-line # as part of the pattern', () => {
    expect(gitignorePatterns('# comment\n\n  \nweird#name\n', '.gitignore')).toEqual(['**/weird#name', '**/weird#name/**']);
  });
});

describe('declaredTypesFiles', () => {
  it('collects the top-level types and every types under exports, once each', () => {
    const manifest = {
      types: './dist/index.d.ts',
      exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' }, './path': { types: './dist/path.d.ts' }, './eslint': { types: './eslint/index.d.cts' } },
    };
    expect(declaredTypesFiles(manifest, 'p/package.json')).toEqual(['./dist/index.d.ts', './dist/path.d.ts', './eslint/index.d.cts']);
  });

  it('refuses a wildcard types path, naming the manifest', () => {
    expect(() => declaredTypesFiles({ exports: { './*': { types: './dist/*.d.ts' } } }, 'packages/x/package.json'))
      .toThrow(/packages\/x\/package\.json declares a wildcard types path \(\.\/dist\/\*\.d\.ts\)/);
  });
});

describe('lintTaskRefusal', () => {
  const none = (): string[] => [];

  it('lets a run without VAT_LINT_TASK through without looking for types (an editor, a test)', () => {
    expect(lintTaskRefusal({}, () => {
      throw new Error('must not be called');
    })).toBeUndefined();
  });

  it('refuses a package lint the root script did not build for', () => {
    expect(lintTaskRefusal({ VAT_LINT_TASK: '1' }, none)).toMatch(/runs only after a build: run `bun run lint`/);
  });

  it('refuses a built run while a declared types file is missing, naming it', () => {
    expect(lintTaskRefusal({ VAT_LINT_TASK: '1', VAT_LINT_BUILT: '1' }, () => ['packages/u/dist/path.d.ts']))
      .toMatch(/these are not built: packages\/u\/dist\/path\.d\.ts/);
  });

  it('lets a built run with every types file present through', () => {
    expect(lintTaskRefusal({ VAT_LINT_TASK: '1', VAT_LINT_BUILT: '1' }, none)).toBeUndefined();
  });
});
