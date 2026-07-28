/**
 * The default eval-suite convention, honored by BOTH lanes.
 *
 * The harness has always defaulted to `<skill-root>/evals/evals.json` — it reads,
 * strips and grades that suite whether or not a `test:` block exists. This lane did
 * not: `resolveTestInputDirs` returned nothing without an explicit declaration, on
 * the reasoning that VAT should not guess a directory named `evals/` is test input.
 * So the two disagreed about the same skill, in the dangerous direction — the
 * harness protected the signal while the packager PUBLISHED the answer key.
 *
 * `resolveTestInputDirs` is the ONE definition of where a skill's test input lives,
 * consumed by `packagingConfigToOptions` (both build lanes) and by the packaging
 * validator. Pinning the convention here pins it everywhere, which is the point of
 * the module having a single definition at all.
 *
 * These cases need a real filesystem — the convention is keyed on the suite FILE
 * existing, which is exactly what makes it safe — so they live here rather than in
 * the pure `test-input.test.ts`.
 */
import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';

import { cleanupTestTempDir, createTestTempDir, writeTestFile } from '../../../cli/test/system/test-common.js';
import { resolveTestInputDirs } from '../../src/test-input.js';

let tempDir: string;

/** Build a skill dir; optionally give it the conventional suite and/or decoy dirs. */
function makeSkillDir(opts: { suite?: boolean; rootEvalsNoSuite?: boolean; nestedEvals?: boolean }): string {
  const skillDir = safePath.join(tempDir, 'skills', 'demo');
  mkdirSyncReal(skillDir, { recursive: true });
  writeTestFile(safePath.join(skillDir, 'SKILL.md'), '---\nname: demo\ndescription: d\n---\n\n# demo\n');

  if (opts.suite === true) {
    mkdirSyncReal(safePath.join(skillDir, 'evals'), { recursive: true });
    writeTestFile(safePath.join(skillDir, 'evals', 'evals.json'), '{"skill_name":"demo","evals":[]}');
  }
  if (opts.rootEvalsNoSuite === true) {
    mkdirSyncReal(safePath.join(skillDir, 'evals'), { recursive: true });
    writeTestFile(safePath.join(skillDir, 'evals', 'methodology.md'), '# how we evaluate\n');
  }
  if (opts.nestedEvals === true) {
    mkdirSyncReal(safePath.join(skillDir, 'docs', 'evals'), { recursive: true });
    writeTestFile(safePath.join(skillDir, 'docs', 'evals', 'approach.md'), '# approach\n');
  }
  return skillDir;
}

describe('implicit eval-suite convention (integration)', () => {
  afterEach(() => {
    cleanupTestTempDir(tempDir);
  });

  it('treats the conventional suite as declared test input with no test: block', () => {
    tempDir = createTestTempDir('vat-implicit-suite-');
    const skillDir = makeSkillDir({ suite: true });

    // The leak this closes: without a `test:` block this returned [], so nothing
    // excluded the suite and its answer key shipped.
    expect(resolveTestInputDirs({}, skillDir)).toEqual([safePath.join(skillDir, 'evals')]);
  });

  it('never infers from a directory NAME — a root evals/ with no suite file is ordinary content', () => {
    tempDir = createTestTempDir('vat-implicit-suite-nosuite-');
    const skillDir = makeSkillDir({ rootEvalsNoSuite: true });

    // Keying on the name would silently drop this author's docs from their bundle.
    expect(resolveTestInputDirs({}, skillDir)).toEqual([]);
  });

  it('names exactly <skill-root>/evals — a nested docs/evals/ is untouched', () => {
    tempDir = createTestTempDir('vat-implicit-suite-nested-');
    const skillDir = makeSkillDir({ suite: true, nestedEvals: true });

    // Only the root suite dir is test input; the nested one is never mentioned.
    expect(resolveTestInputDirs({}, skillDir)).toEqual([safePath.join(skillDir, 'evals')]);
  });

  it('is pure auto-detect: no test: block and no suite is a clean no-op, not an error', () => {
    tempDir = createTestTempDir('vat-implicit-suite-none-');
    const skillDir = makeSkillDir({});

    // The convention must never make evals REQUIRED. The overwhelming majority of
    // skills have no suite at all; they must package exactly as before, with no
    // error, no warning, and nothing excluded.
    expect(() => resolveTestInputDirs({}, skillDir)).not.toThrow();
    expect(resolveTestInputDirs({}, skillDir)).toEqual([]);
  });

  it('lets an explicit test: block win over the convention', () => {
    tempDir = createTestTempDir('vat-implicit-suite-explicit-');
    const skillDir = makeSkillDir({ suite: true });

    // An explicit declaration is still the instruction, suite file present or not.
    expect(resolveTestInputDirs({ test: { evals: 'suites/demo/evals.json' } }, skillDir))
      .toEqual([safePath.join(skillDir, 'suites', 'demo')]);
  });
});
