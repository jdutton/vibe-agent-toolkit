/**
 * `repoEslint` (`eslint-clean-files.ts`) leaves the linted tree's `.eslintcache` alone.
 *
 * With caching off, `ESLint#lintFiles` deletes the file at its cache location, by default
 * `<cwd>/.eslintcache`. Two tests linted the repo root that way and wiped `bun run lint`'s cache
 * on every gate run. Lint bans constructing an ESLint anywhere else (`ESLINT_INSTANCE_BAN`); this
 * proves the one place that may still does not delete it.
 */

import { existsSync, writeFileSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { createTempDir, removeTempDir } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { repoEslint } from './eslint-clean-files.js';

describe('repoEslint', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) removeTempDir(dir);
  });

  it('lints a tree without deleting the cache file in its cwd', async () => {
    dir = createTempDir('repo-eslint-');
    const cache = safePath.join(dir, '.eslintcache');
    writeFileSync(cache, '{}');
    writeFileSync(safePath.join(dir, 'a.js'), 'export const a = 1;\n');

    const results = await repoEslint({ cwd: dir, overrideConfigFile: true }).lintFiles(['a.js']);

    expect(results).toHaveLength(1);
    expect(existsSync(cache)).toBe(true);
  });
});
