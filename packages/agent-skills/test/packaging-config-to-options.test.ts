import { dirname } from 'node:path';

import { safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { packagingConfigToPackageOptions } from '../src/skill-packager.js';
import { conventionalSuiteProbe } from '../src/test-input.js';

describe('packagingConfigToPackageOptions', () => {
  const anchors = { skillPath: '/repo/skills/x/SKILL.md', outputPath: '/repo/dist/skills/x' };

  it('sets the deterministic base options', () => {
    const out = packagingConfigToPackageOptions({}, anchors, [], conventionalSuiteProbe());
    expect(out).toMatchObject({
      outputPath: '/repo/dist/skills/x',
      formats: ['directory'],
      rewriteLinks: true,
      basePath: dirname(anchors.skillPath),
    });
  });

  it('forwards only the present optional packaging fields', () => {
    const out = packagingConfigToPackageOptions(
      { linkFollowDepth: 'full', files: [{ source: 'a', dest: 'b' }] } as never,
      anchors,
      [],
      conventionalSuiteProbe(),
    );
    expect(out.linkFollowDepth).toBe('full');
    expect(out.files).toEqual([{ source: 'a', dest: 'b' }]);
    expect('validation' in out).toBe(false);
  });

  /**
   * `excludeNavigationFiles: false` is the ONLY value that can be dropped without
   * a symptom in the output, because the packager's own default is `true` — so a
   * conversion that forgets the field produces a bundle with the README stripped
   * while `packaging-validator.ts` (which reads the same config directly) predicts
   * it ships. The pre-build gate and the build then disagree about one bundle,
   * inside the conversion whose docstring promises byte-for-byte parity.
   *
   * Asserted with `false`, never `true`: `true` is indistinguishable from the
   * default and would pass against a conversion that forwards nothing.
   */
  it('forwards excludeNavigationFiles: false rather than falling back to the default', () => {
    const out = packagingConfigToPackageOptions({ excludeNavigationFiles: false }, anchors, [], conventionalSuiteProbe());

    expect(out.excludeNavigationFiles).toBe(false);
  });

  it('omits excludeNavigationFiles when the config does not set it', () => {
    const out = packagingConfigToPackageOptions({}, anchors, [], conventionalSuiteProbe());

    expect('excludeNavigationFiles' in out).toBe(false);
  });
});

/**
 * The ONE conversion both `vat skills build` and the plugin build go through, so
 * this is where the project-wide half of the test-input rule either reaches the
 * packager or silently does not. Keyed to the packaged skill alone, `testInputDirs`
 * named only its own suite, and another skill's answer key was ordinary content the
 * link walker was free to bundle.
 */
describe('packagingConfigToPackageOptions — project-wide test input', () => {
  const PROJECT_ROOT = toForwardSlash(safePath.resolve('/repo'));
  const SUBJECT_DIR = `${PROJECT_ROOT}/skills/csv-summarizer`;
  const OTHER_DIR = `${PROJECT_ROOT}/skills/example-skill`;
  const anchors = {
    skillPath: `${SUBJECT_DIR}/SKILL.md`,
    outputPath: `${PROJECT_ROOT}/dist/skills/csv-summarizer`,
  };
  /**
   * DISTINCT basenames on purpose: a filename collision between two suites is
   * REPORTED, not thrown, and the copy still happens — so a colliding fixture
   * cannot tell the cross-skill rule from its absence.
   */
  const SUBJECT_CONFIG = { test: { evals: 'evals/csvsum-evals.json' } };
  const OTHER_CONFIG = { test: { evals: 'evals/example-evals.json' } };
  const PROJECT_SKILLS = [
    { skillDir: SUBJECT_DIR, config: SUBJECT_CONFIG },
    { skillDir: OTHER_DIR, config: OTHER_CONFIG },
  ];

  it('carries EVERY declared suite dir into the packager, not only the subject\'s', () => {
    const out = packagingConfigToPackageOptions(SUBJECT_CONFIG, anchors, PROJECT_SKILLS, conventionalSuiteProbe());

    expect(out.testInputDirs).toEqual([`${SUBJECT_DIR}/evals`, `${OTHER_DIR}/evals`]);
  });

  it('still carries the subject\'s own suite when the project declares nothing else', () => {
    const out = packagingConfigToPackageOptions(SUBJECT_CONFIG, anchors, [], conventionalSuiteProbe());

    expect(out.testInputDirs).toEqual([`${SUBJECT_DIR}/evals`]);
  });

  it('omits testInputDirs entirely when no skill in the project declares a suite', () => {
    const out = packagingConfigToPackageOptions({}, anchors, [
      { skillDir: OTHER_DIR, config: {} },
    ], conventionalSuiteProbe());

    expect('testInputDirs' in out).toBe(false);
  });
});
