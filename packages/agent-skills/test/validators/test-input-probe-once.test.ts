/**
 * Unit test: a run resolves each declared skill root's conventional suite ONCE —
 * not once per consumer of that answer, and not once per skill in the run.
 *
 * TWO distinct multipliers on the same probe, closed in that order:
 *
 *   1. PER SKILL (closed earlier). `resolveTestInputDirs` was computed twice for
 *      one skill — once inside `packagedFileEntries`, once directly for the
 *      walker's exclude rules — from identical arguments.
 *   2. PER RUN (closed here). `resolveTestInputDirs` probes `<skill-root>/evals/
 *      evals.json` for the SUBJECT and for every entry in `projectSkills`, so a
 *      lane that loops over S skills asks S² questions about S paths. Measured
 *      with the lab on a 103-skill adopter, `vat resources validate`: 10,815
 *      probes over 103 distinct paths — exactly 50% of the command's 21,648 user
 *      filesystem calls. The probe is now created once per RUN and threaded, so
 *      the same tree costs ~103.
 *
 * Both tests below count probes rather than inspecting the returned dirs: the dirs
 * are identical before and after either fix, so an output assertion passes on the
 * quadratic and proves nothing.
 *
 * OBSERVABILITY. The count is read from a `node:fs` MODULE mock (passthrough +
 * collector), the only seam that sees this call: `test-input.ts` imports
 * `existsSync` as an ESM named binding, which a counter installed on the `fs`
 * default export or on the CJS module object does not intercept (measured: 0 of
 * the calls), and which a `--require` preload sees only partially. `vi.spyOn` on a
 * module namespace throws outright.
 *
 * FIXTURE. DISTINCT skill directories, none of which carries a suite. The
 * distinctness is load-bearing: the probe memoizes by path, so a fixture whose
 * skills share one directory collapses to a single probe and cannot tell
 * "resolved once" from "resolved S times". It is also why this quadratic survived
 * on VAT's own repo, where the whole project is 2 distinct skill roots: 2² = 4.
 */

/* eslint-disable security/detect-non-literal-fs-filename -- Test code with temp directories */
import type * as NodeFs from 'node:fs';
import * as fs from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_EVALS_SUBPATH } from '../../src/skill-test/eval-suite-isolation.js';
import { conventionalSuiteProbe, packagedFileEntries, type DeclaredEvalSuite } from '../../src/test-input.js';
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

/** Skill roots for a run that loops over the whole project, as the adopter lanes do. */
const RUN_SKILL_DIRS = ['run-a', 'run-b', 'run-c', 'run-d'];

describe('a run-scoped conventional-suite probe', () => {
  beforeEach(() => {
    suiteProbes.length = 0;
  });

  it('costs S probes for S skills, not S squared', () => {
    const tempDir = getTempDir();
    const skillDirs = RUN_SKILL_DIRS.map((name) => safePath.join(tempDir, name));
    const projectSkills: DeclaredEvalSuite[] = skillDirs.map((skillDir) => ({ skillDir, config: {} }));

    // ONE probe for the whole run, exactly as a lane looping over its discovered
    // skills creates it — then the loop every adopter lane runs.
    const suiteProbe = conventionalSuiteProbe();
    for (const skillDir of skillDirs) {
      packagedFileEntries({}, skillDir, tempDir, projectSkills, suiteProbe);
    }

    const byPath = (a: string, b: string): number => a.localeCompare(b);
    const expected = skillDirs.map(suitePathFor).sort(byPath);
    // Every skill root IS reached — without this the count assertion is vacuous.
    expect([...new Set(suiteProbes)].sort(byPath)).toEqual(expected);
    // ...and the RUN pays for each exactly once. A per-call probe makes this S x S.
    expect(suiteProbes).toHaveLength(skillDirs.length);
  });

  it('is threaded through the batching validator via its shared context', async () => {
    const tempDir = getTempDir();
    const names = ['batched-a', 'batched-b'];
    const skillDirs = names.map((name) => safePath.join(tempDir, name));
    for (const [index, skillDir] of skillDirs.entries()) {
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        safePath.join(skillDir, 'SKILL.md'),
        createSkillContent({
          name: names[index] as string,
          description: 'A skill in a batched run that shares one conventional-suite probe',
        }),
      );
    }
    const projectSkills: DeclaredEvalSuite[] = skillDirs.map((skillDir) => ({ skillDir, config: {} }));
    const suiteProbe = conventionalSuiteProbe();

    for (const skillDir of skillDirs) {
      await validateSkillForPackaging(safePath.join(skillDir, 'SKILL.md'), {}, 'source', {
        projectSkills,
        suiteProbe,
      });
    }

    expect(suiteProbes).toHaveLength(skillDirs.length);
  });
});
