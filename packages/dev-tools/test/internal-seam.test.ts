/**
 * The `__internal` convention, held by mechanism.
 *
 * A module that exports helpers so its unit tests can reach them collects
 * them under one `export const __internal = { … }` (worked example:
 * `packages/agent-skills/src/skill-test/run-harness.ts`). The convention is
 * only worth having if two things stay true, and neither is visible in a diff:
 *
 * 1. no barrel re-exports `__internal` — the seam must never become API, and a
 *    `export *` in an `index.ts` would publish it without anyone typing its name;
 * 2. nothing under `src/` imports `__internal` — a src consumer means the name
 *    behind it is not test-only and belongs as an ordinary export.
 *
 * Both are answered from the tree, over every package, so a new seam is held
 * to the same two lines the day it appears.
 */

import { describe, expect, it } from 'vitest';

import { packageSources } from './package-sources.js';

const SEAM = '__internal';

/** `export * from './x.js'` in `barrel` republishes every value export of `seam`, the seam included. */
function starExports(barrel: string, barrelSource: string, seam: string): boolean {
  const dir = barrel.slice(0, barrel.lastIndexOf('/'));
  if (!seam.startsWith(`${dir}/`)) return false;
  const specifier = `./${seam.slice(dir.length + 1).replace(/\.ts$/u, '.js')}`;
  return barrelSource.includes(`export * from '${specifier}'`) || barrelSource.includes(`export * from "${specifier}"`);
}

describe('the __internal seam', () => {
  const files = packageSources();
  const seamModules = [...files].filter(([, source]) => source.includes(`export const ${SEAM} =`)).map(([file]) => file);

  it('exists — at least the worked example declares one', () => {
    expect(seamModules).toContain('packages/agent-skills/src/skill-test/run-harness.ts');
  });

  it('is re-exported by no barrel, by name or by star', () => {
    const leaking = [...files]
      .filter(([file]) => file.endsWith('/index.ts'))
      .filter(([barrel, source]) => source.includes(SEAM) || seamModules.some((seam) => starExports(barrel, source, seam)))
      .map(([barrel]) => barrel);
    expect(leaking).toEqual([]);
  });

  it('is imported by nothing under src/ — a src consumer makes the name API, not internal', () => {
    const importing = [...files]
      .filter(([file, source]) => !seamModules.includes(file) && source.includes(SEAM))
      .map(([file]) => file);
    expect(importing).toEqual([]);
  });
});
