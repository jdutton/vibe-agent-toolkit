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

function sourcesConstructingEslint(): string[] {
  return readdirSync(TEST_ROOT, { recursive: true, encoding: 'utf8' })
    .map((entry) => safePath.join('', entry))
    .filter((file) => file.endsWith('.ts') && file !== HELPER)
    .filter((file) => /\bnew ESLint\(/.test(readFileSync(safePath.join(TEST_ROOT, file), 'utf8')))
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
