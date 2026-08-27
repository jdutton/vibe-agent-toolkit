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
import { conventionalSuiteProbe, resolveTestInputDirs } from '../../src/test-input.js';

let tempDir: string;

/** Build a skill dir; optionally give it the conventional suite and/or decoy dirs. */
function makeSkillDir(
  opts: { suite?: boolean; rootEvalsNoSuite?: boolean; nestedEvals?: boolean },
  name = 'demo',
): string {
  const skillDir = safePath.join(tempDir, 'skills', name);
  mkdirSyncReal(skillDir, { recursive: true });
  writeTestFile(safePath.join(skillDir, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n\n# ${name}\n`);

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
    expect(resolveTestInputDirs({}, skillDir, [], conventionalSuiteProbe())).toEqual([safePath.join(skillDir, 'evals')]);
  });

  it('never infers from a directory NAME — a root evals/ with no suite file is ordinary content', () => {
    tempDir = createTestTempDir('vat-implicit-suite-nosuite-');
    const skillDir = makeSkillDir({ rootEvalsNoSuite: true });

    // Keying on the name would silently drop this author's docs from their bundle.
    expect(resolveTestInputDirs({}, skillDir, [], conventionalSuiteProbe())).toEqual([]);
  });

  it('names exactly <skill-root>/evals — a nested docs/evals/ is untouched', () => {
    tempDir = createTestTempDir('vat-implicit-suite-nested-');
    const skillDir = makeSkillDir({ suite: true, nestedEvals: true });

    // Only the root suite dir is test input; the nested one is never mentioned.
    expect(resolveTestInputDirs({}, skillDir, [], conventionalSuiteProbe())).toEqual([safePath.join(skillDir, 'evals')]);
  });

  it('is pure auto-detect: no test: block and no suite is a clean no-op, not an error', () => {
    tempDir = createTestTempDir('vat-implicit-suite-none-');
    const skillDir = makeSkillDir({});

    // The convention must never make evals REQUIRED. The overwhelming majority of
    // skills have no suite at all; they must package exactly as before, with no
    // error, no warning, and nothing excluded.
    expect(() => resolveTestInputDirs({}, skillDir, [], conventionalSuiteProbe())).not.toThrow();
    expect(resolveTestInputDirs({}, skillDir, [], conventionalSuiteProbe())).toEqual([]);
  });

  it('lets an explicit test: block win over the convention', () => {
    tempDir = createTestTempDir('vat-implicit-suite-explicit-');
    const skillDir = makeSkillDir({ suite: true });

    // An explicit declaration is still the instruction, suite file present or not.
    expect(resolveTestInputDirs({ test: { evals: 'suites/demo/evals.json' } }, skillDir, [], conventionalSuiteProbe()))
      .toEqual([safePath.join(skillDir, 'suites', 'demo')]);
  });
});

/** The conventional suite's content — the file whose EXISTENCE is the whole signal. */
const SUITE_JSON = '{"skill_name":"demo","evals":[]}';

/** Give an existing skill dir the conventional suite, after the fact. */
function addConventionalSuite(skillDir: string): void {
  mkdirSyncReal(safePath.join(skillDir, 'evals'), { recursive: true });
  writeTestFile(safePath.join(skillDir, 'evals', 'evals.json'), SUITE_JSON);
}

/**
 * The conventional-suite probe is the module's ONE filesystem touch, and
 * `resolveTestInputDirs` reaches it once for the subject and once per entry in
 * `projectSkills`. Every skill in a package that keeps its skills in one
 * directory therefore names the SAME directory, so a single call asked the
 * filesystem the identical question N+1 times (measured on `vat audit .`: 14
 * probes over 2 distinct paths).
 *
 * These cases pin "at most one probe per directory per call" — and, just as
 * load-bearing, "the answer does not outlive the call".
 *
 * HOW THE COUNT IS OBSERVED: it cannot be counted directly. test-input.ts
 * imports `existsSync` as a live ESM binding, so patching `node:fs` from a test
 * is invisible (measured here: 0 calls traced through both the default export
 * and the CJS module object). The count is made observable instead by changing
 * the ANSWER while the call is in flight — reading element 1 of the
 * `projectSkills` array creates the suite file. A second probe of the same
 * directory would see the new file and return a dir; a deduplicated one keeps
 * the answer it already has.
 */
describe('conventional-suite probing (integration)', () => {
  afterEach(() => {
    cleanupTestTempDir(tempDir);
  });

  it('asks the filesystem about one skill dir at most ONCE per call', () => {
    tempDir = createTestTempDir('vat-implicit-suite-dedupe-');
    const skillDir = makeSkillDir({});

    const projectSkills = [
      { skillDir, config: {} },
      { skillDir, config: {} },
    ];
    // Reading index 1 — which only happens if the loop probes a SECOND time for a
    // directory it has already asked about — creates the suite the first probe
    // did not find.
    Object.defineProperty(projectSkills, 1, {
      configurable: true,
      enumerable: true,
      get: () => {
        addConventionalSuite(skillDir);
        return { skillDir, config: {} };
      },
    });

    // The suite did not exist when the call began, so the call must not report it.
    expect(resolveTestInputDirs({}, skillDir, projectSkills, conventionalSuiteProbe())).toEqual([]);
  });

  it('still answers per DIRECTORY — a different skill dir gets its own probe', () => {
    tempDir = createTestTempDir('vat-implicit-suite-perdir-');
    const bare = makeSkillDir({}, 'bare');
    const withSuite = makeSkillDir({ suite: true }, 'with-suite');

    // The fixture can tell the two answers apart: one dir has the suite, one does
    // not. A memo keyed on anything coarser than the directory would hand the
    // second skill the first skill's `false` and ship its answer key.
    expect(resolveTestInputDirs({}, bare, [
      { skillDir: bare, config: {} },
      { skillDir: withSuite, config: {} },
    ], conventionalSuiteProbe())).toEqual([safePath.join(withSuite, 'evals')]);
  });

  it('re-probes for a LATER RUN — the answer dies with the probe', () => {
    tempDir = createTestTempDir('vat-implicit-suite-scope-');
    const skillDir = makeSkillDir({});

    expect(resolveTestInputDirs({}, skillDir, [], conventionalSuiteProbe())).toEqual([]);

    // A module-level cache would still be answering `false` here — in a
    // long-lived process, and across every later test in the same worker.
    addConventionalSuite(skillDir);
    expect(resolveTestInputDirs({}, skillDir, [], conventionalSuiteProbe())).toEqual([safePath.join(skillDir, 'evals')]);
  });

  it('holds its answer for the WHOLE run — that is the scope, and its known cost', () => {
    tempDir = createTestTempDir('vat-implicit-suite-runscope-');
    const skillDir = makeSkillDir({});

    // ONE probe, as a lane looping over its discovered skills creates it.
    const suiteProbe = conventionalSuiteProbe();
    expect(resolveTestInputDirs({}, skillDir, [], suiteProbe)).toEqual([]);

    // The tree changes UNDER the run. The probe keeps the answer it took, and that
    // is deliberate: a run already reads the project's skills and configs once and
    // answers every skill from that one snapshot, so widening the memo from the call
    // to the run adds no window the lanes did not already have — while removing the
    // S² re-probing that made a 103-skill `vat resources validate` spend half its
    // filesystem calls re-asking 103 questions it had already answered.
    addConventionalSuite(skillDir);
    expect(resolveTestInputDirs({}, skillDir, [], suiteProbe)).toEqual([]);
  });
});
