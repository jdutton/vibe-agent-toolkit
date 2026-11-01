/**
 * `repoEslint` (`eslint-clean-files.ts`) is the only place this package's tests construct an ESLint.
 *
 * With caching off, `ESLint#lintFiles` deletes the file at its `cacheLocation` — by default the
 * repo's own `.eslintcache` when `cwd` is the repo root. Five tests built one there and wiped
 * `bun run lint`'s cache on every gate run. The helper points the location at a temp path; this
 * keeps a sixth test from going around it.
 */

import { readdirSync, readFileSync } from 'node:fs';

import { resolveFromImportMeta, safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

const TEST_ROOT = resolveFromImportMeta(import.meta.url, '.');
const HELPER = 'eslint-clean-files.ts';
/** This file names every shape it bans. */
const SELF = 'repo-eslint-constructor.test.ts';

/**
 * Every way a test can get a linter that owns a cache file: `new ESLint(` with any spacing or
 * line break, through a namespace (`new eslint.ESLint(`), the legacy class, the
 * `ESLint.fromOptionsModule` factory, and `loadESLint()` (which returns the class to construct).
 * An aliased import (`import { ESLint as E }`) is caught by the import shape.
 */
const CONSTRUCTS_ESLINT = [
  /\bnew\s+[\w.]*ESLint\s*\(/,
  /\bESLint\s*\.\s*fromOptionsModule\b/,
  /\bloadESLint\s*\(/,
  /\bESLint\s+as\s+\w+/,
];

function sourcesConstructingEslint(): string[] {
  return readdirSync(TEST_ROOT, { recursive: true, encoding: 'utf8' })
    .map((entry) => safePath.join('', entry))
    .filter((file) => file.endsWith('.ts') && file !== HELPER && file !== SELF)
    .filter((file) => {
      const source = readFileSync(safePath.join(TEST_ROOT, file), 'utf8');
      return CONSTRUCTS_ESLINT.some((shape) => shape.test(source));
    })
    .sort((a, b) => a.localeCompare(b));
}

describe('repoEslint is the only ESLint constructor in dev-tools tests', () => {
  it('no test file outside the helper calls the ESLint constructor', () => {
    expect(sourcesConstructingEslint()).toEqual([]);
  });

  it('the helper itself still constructs one (the scan can see the shape it bans)', () => {
    expect(readFileSync(safePath.join(TEST_ROOT, HELPER), 'utf8')).toMatch(/\bnew ESLint\(/);
  });
});
