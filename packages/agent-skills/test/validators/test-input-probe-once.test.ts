/**
 * Unit test: the packaging validator resolves a skill's declared test-input dirs
 * ONCE per skill, not once per consumer of that answer.
 *
 * `resolveTestInputDirs` probes the filesystem for `<skill-root>/evals/evals.json`
 * for the SUBJECT and for every entry in `projectSkills`, so its cost is O(S) per
 * skill validated and O(S²) per run. Computing it twice per skill — once inside
 * `packagedFileEntries`, once directly for the walker's exclude rules — doubled
 * that whole quadratic term. Projected on a 58-skill adopter declaring no `test:`
 * block at all: 6,844 probes where 3,422 answer the same question.
 *
 * OBSERVABILITY. The count is read from a `node:fs` MODULE mock (passthrough +
 * collector), the only seam that sees this call: `test-input.ts` imports
 * `existsSync` as an ESM named binding, which a counter installed on the `fs`
 * default export or on the CJS module object does not intercept (measured: 0 of
 * the calls), and which a `--require` preload sees only partially. `vi.spyOn` on a
 * module namespace throws outright.
 *
 * FIXTURE. Three DISTINCT skill directories, none of which carries a suite. The
 * distinctness is load-bearing: `resolveTestInputDirs` memoizes per call, so a
 * fixture whose skills share one directory collapses to a single probe and cannot
 * tell "resolved once" from "resolved twice".
 */

/* eslint-disable security/detect-non-literal-fs-filename -- Test code with temp directories */
import type * as NodeFs from 'node:fs';
import * as fs from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_EVALS_SUBPATH } from '../../src/skill-test/eval-suite-isolation.js';
import type { DeclaredEvalSuite } from '../../src/test-input.js';
import { validateSkillForPackaging } from '../../src/validators/packaging-validator.js';
import { createSkillContent, setupTempDir } from '../test-helpers.js';

const { suiteProbes } = vi.hoisted(() => ({ suiteProbes: [] as string[] }));

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof NodeFs>();
  const collect = (target: Parameters<NodeFs['existsSync']>[0]): boolean => {
    const probed = String(target);
    if (probed.replaceAll('\\', '/').endsWith(DEFAULT_EVALS_SUBPATH)) suiteProbes.push(probed);
    return real.existsSync(target);
  };
  return { ...real, default: real, existsSync: collect };
});

const { getTempDir } = setupTempDir('test-input-probe-once-');

const SIBLING_DIRS = ['sibling-a', 'sibling-b'];

/** The conventional suite path `resolveTestInputDirs` probes for a skill root. */
function suitePathFor(skillDir: string): string {
  return safePath.resolve(skillDir, DEFAULT_EVALS_SUBPATH);
}

describe('validateSkillForPackaging - declared test-input resolution', () => {
  beforeEach(() => {
    suiteProbes.length = 0;
  });

  it('probes each declared skill root once per validated skill, not twice', async () => {
    const tempDir = getTempDir();
    const skillPath = safePath.join(tempDir, 'SKILL.md');
    fs.writeFileSync(
      skillPath,
      createSkillContent({
        name: 'probe-once-skill',
        description: 'A skill used to count how often declared test input is resolved per run',
      }),
    );
    const projectSkills: DeclaredEvalSuite[] = SIBLING_DIRS.map((name) => ({
      skillDir: safePath.join(tempDir, name),
      config: {},
    }));

    await validateSkillForPackaging(skillPath, {}, 'source', { projectSkills });

    const expected = [tempDir, ...SIBLING_DIRS.map((n) => safePath.join(tempDir, n))].map(suitePathFor);
    // Every skill root IS reached — without this the count assertion below passes vacuously.
    const byPath = (a: string, b: string): number => a.localeCompare(b);
    expect([...new Set(suiteProbes)].sort(byPath)).toEqual([...expected].sort(byPath));
    // ...and each is reached exactly once. Two resolutions make this 2x.
    expect(suiteProbes).toHaveLength(expected.length);
  });
});
