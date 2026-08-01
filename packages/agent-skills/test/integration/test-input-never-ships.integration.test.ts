/* eslint-disable security/detect-non-literal-fs-filename -- test paths are our own controlled temp dirs */
/**
 * Integration test: declared test input never reaches a built skill.
 *
 * Drives the REAL `packageSkill` against a temp project, so this covers the actual
 * link-graph walk, the exclusion, and the post-build guarantee together — the unit
 * tests in test-input.test.ts cover the path logic in isolation.
 *
 * Both entry routes into a bundle are exercised, and both leave a receipt:
 *   - a SKILL.md link into the eval suite (the target is not packaged and the link is
 *     rewritten away, so the author is told — a link that silently vanished from the
 *     shipped skill is indistinguishable from one that worked);
 *   - a `files:` entry mapping the suite in (the copy does not happen, and the entry
 *     that did nothing is named).
 *
 * Both receipts are `PACKAGED_TEST_INPUT` warnings, not failures: the declaration
 * under `test.evals` IS the instruction, so the build already produced the right
 * artifact and there is nothing for the adopter to fix.
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { packageSkill, packagingConfigToPackageOptions } from '../../src/skill-packager.js';
import type { DeclaredEvalSuite } from '../../src/test-input.js';
import { activeErrorsOf, activeWarningsOf, validateSkillForPackaging } from '../../src/validators/packaging-validator.js';

const ANSWER_KEY = 'the model must output exactly forty-two';
/** Basename of the declared eval suite, used as both a source leaf and a dest. */
const EVALS_FILE = 'evals.json';
/** The declared suite subpath, exactly as a skill's `test.evals` spells it. */
const EVALS_SUBPATH = 'evals/evals.json';
/** A `dest` whose source sits in declared test input, so it is never written. */
const DROPPED_DEST = 'evals-copy.json';
/** The code a missing link target raises at SOURCE phase in both agent-skills lanes. */
const BROKEN_LINK_CODE = 'LINK_MISSING_TARGET';
let projectRoot: string;

/** Codes of a set of issues, for order-independent membership assertions. */
function codesOf(issues: ReadonlyArray<{ code: unknown }> | undefined): string[] {
  return (issues ?? []).map((i) => String(i.code));
}

/** A project with one skill whose SKILL.md links to BOTH a normal doc and its eval suite. */
function writeProject(opts: { alsoLink?: string } = {}): {
  skillPath: string;
  outputPath: string;
  evalsDir: string;
} {
  const skillDir = safePath.join(projectRoot, 'skills', 'demo');
  const evalsDir = safePath.join(skillDir, 'evals');
  mkdirSyncReal(safePath.join(skillDir, 'references'), { recursive: true });
  mkdirSyncReal(evalsDir, { recursive: true });
  // Anchor the project root so `files:` sources resolve repo-relative (as they do in
  // a real adopter) rather than collapsing onto the skill dir.
  writeFileSync(safePath.join(projectRoot, 'vibe-agent-toolkit.config.yaml'), 'version: 1\n', 'utf8');

  writeFileSync(
    safePath.join(skillDir, 'SKILL.md'),
    '---\nname: demo\ndescription: A fixture skill for the test-input packaging rule.\n---\n\n' +
      '# Demo\n\nSee [the guide](references/guide.md).\n\nEvals live in [the suite](evals/evals.json).\n' +
      (opts.alsoLink === undefined ? '' : `\nAnd [the copy](${opts.alsoLink}).\n`),
    'utf8',
  );
  writeFileSync(safePath.join(skillDir, 'references', 'guide.md'), '# Guide\n\nReal content.\n', 'utf8');
  writeFileSync(
    safePath.join(evalsDir, EVALS_FILE),
    JSON.stringify({
      skill_name: 'demo',
      evals: [{ id: 'one', prompt: 'do it', expected_output: ANSWER_KEY, expectations: ['it works'] }],
    }) + '\n',
    'utf8',
  );
  writeFileSync(safePath.join(evalsDir, 'notes.md'), `# Notes\n\n${ANSWER_KEY}\n`, 'utf8');

  return {
    skillPath: safePath.join(skillDir, 'SKILL.md'),
    outputPath: safePath.join(projectRoot, 'dist', 'demo'),
    evalsDir,
  };
}

const SUBJECT_NAME = 'csv-summarizer';
/** The root file of a skill, and the one we read back out of the bundle. */
const SKILL_MD = 'SKILL.md';
/** The other skill's answer key — the string that must never reach this bundle. */
const OTHER_ANSWER_KEY = 'the model must output exactly forty-two';
/** The subject's own suite subpath, as its `test.evals` spells it. */
const SUBJECT_EVALS = 'evals/csvsum-evals.json';
/** The other skill's suite subpath. Distinct basename — see the file header. */
const OTHER_EVALS = 'evals/example-evals.json';
/** The other skill's suite as an href from the subject's SKILL.md. */
const OTHER_EVALS_HREF = '../example-skill/evals/example-evals.json';

let subjectDir: string;
let otherDir: string;

/**
 * A two-skill project. The subject (`csv-summarizer`) cites the OTHER skill's eval
 * suite from its SKILL.md — a perfectly reasonable "worked example" citation, and
 * exactly the shape that leaked.
 */
function writeCrossSkillProject(): void {
  subjectDir = safePath.join(projectRoot, 'skills', SUBJECT_NAME);
  otherDir = safePath.join(projectRoot, 'skills', 'example-skill');
  mkdirSyncReal(safePath.join(subjectDir, 'evals'), { recursive: true });
  mkdirSyncReal(safePath.join(otherDir, 'evals'), { recursive: true });
  writeFileSync(safePath.join(projectRoot, 'vibe-agent-toolkit.config.yaml'), 'version: 1\n', 'utf8');

  writeFileSync(
    safePath.join(subjectDir, SKILL_MD),
    `---\nname: ${SUBJECT_NAME}\ndescription: A fixture skill that summarizes CSV files.\n---\n\n` +
      '# CSV Summarizer\n\nSee [the guide](guide.md).\n\n' +
      `A worked example of a suite: [the example skill's suite](${OTHER_EVALS_HREF}).\n`,
    'utf8',
  );
  writeFileSync(safePath.join(subjectDir, 'guide.md'), '# Guide\n\nOrdinary content.\n', 'utf8');
  writeFileSync(
    safePath.join(subjectDir, SUBJECT_EVALS),
    JSON.stringify({ skill_name: SUBJECT_NAME, evals: [{ id: 'a', expected_output: 'own key' }] }) + '\n',
    'utf8',
  );

  writeFileSync(
    safePath.join(otherDir, SKILL_MD),
    '---\nname: example-skill\ndescription: A second fixture skill with a suite of its own.\n---\n\n# Example\n',
    'utf8',
  );
  writeFileSync(
    safePath.join(otherDir, OTHER_EVALS),
    JSON.stringify({
      skill_name: 'example-skill',
      evals: [{ id: 'one', prompt: 'do it', expected_output: OTHER_ANSWER_KEY }],
    }) + '\n',
    'utf8',
  );
}

/** The project's declared suites, exactly as a CLI lane assembles them once per run. */
function projectSkills(): DeclaredEvalSuite[] {
  return [
    { skillDir: subjectDir, config: { test: { evals: SUBJECT_EVALS } } },
    { skillDir: otherDir, config: { test: { evals: OTHER_EVALS } } },
  ];
}

/** Every file under `dir`, as output-relative forward-slash paths. */
function outputFiles(dir: string): string[] {
  const out: string[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const abs = safePath.join(current, entry.name);
      if (entry.isDirectory()) visit(abs);
      else out.push(safePath.relative(dir, abs));
    }
  };
  visit(dir);
  return out;
}

describe('declared test input never ships (integration)', () => {
  beforeEach(() => {
    projectRoot = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-test-input-'));
  });
  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('excludes a linked eval suite from the bundle while packaging everything else', async () => {
    const { skillPath, outputPath, evalsDir } = writeProject();

    const result = await packageSkill(skillPath, {
      outputPath,
      formats: ['directory'],
      testInputDirs: [evalsDir],
    });

    const files = outputFiles(outputPath);
    // The suite is gone...
    expect(files.filter((f) => f.includes('evals'))).toEqual([]);
    // ...and nothing in the output carries the answer key.
    for (const file of files) {
      expect(readFileSync(safePath.join(outputPath, file), 'utf8')).not.toContain(ANSWER_KEY);
    }
    // ...while the ordinary linked resource still ships, so the exclusion is targeted.
    expect(files.some((f) => f.endsWith('guide.md'))).toBe(true);

    // The link is REWRITTEN AWAY in the shipped SKILL.md — and the author is told.
    // Silent removal was the gap: `[the suite](evals/evals.json)` became bare text in
    // the published skill with no diagnostic from any lane, so an author could not
    // tell a dropped link from one that worked.
    const shippedSkillMd = readFileSync(safePath.join(outputPath, 'SKILL.md'), 'utf8');
    expect(shippedSkillMd).not.toContain(EVALS_SUBPATH);
    const receipt = result.postBuildIssues?.find((i) => i.code === 'PACKAGED_TEST_INPUT');
    expect(receipt?.severity).toBe('warning');
    expect(receipt?.message).toContain(EVALS_SUBPATH);
    // Excluding declared test input is normal, not an error: the build stays green.
    expect(result.hasErrors).toBe(false);
  });

  it('the read-only lane predicts the SAME bundle and emits the SAME receipt for a linked suite', async () => {
    // `vat skills validate` used to skip the test-input exclusion entirely: it walked
    // the link into `evals/` and counted the suite as a bundled file, predicting an
    // artifact the build never produces. Same input, two answers about what ships,
    // from the two commands that exist to agree.
    const { skillPath } = writeProject();

    const validated = await validateSkillForPackaging(skillPath, {
      test: { evals: EVALS_SUBPATH },
    });

    // SKILL.md + guide.md only — the suite is not counted.
    expect(validated.metadata.fileCount).toBe(2);
    expect(codesOf(activeWarningsOf(validated))).toContain('PACKAGED_TEST_INPUT');
    expect(validated.status).not.toBe('error');
  });

  it('DROPS a files: entry that maps the eval suite in — no config edit, no failed build', async () => {
    // Declaring the path under `test.evals` IS the instruction not to package it.
    // The adopter does not have to fix anything to get the correct artifact; they
    // just get told the entry did nothing.
    const { skillPath, outputPath, evalsDir } = writeProject();

    const result = await packageSkill(skillPath, {
      outputPath,
      formats: ['directory'],
      testInputDirs: [evalsDir],
      files: [{ source: 'skills/demo/evals/evals.json', dest: EVALS_FILE }],
    });

    expect(existsSync(safePath.join(outputPath, EVALS_FILE))).toBe(false);
    const issue = result.postBuildIssues?.find((i) => i.code === 'PACKAGED_TEST_INPUT');
    expect(issue?.severity).toBe('warning');
    expect(result.hasErrors).toBe(false);
  });

  it('reports a BROKEN LINK in both agent-skills lanes when SKILL.md links a dest the rule dropped', async () => {
    // The receipt (`PACKAGED_TEST_INPUT`) says "this copy did not happen". Linking the
    // dest it would have produced is therefore a link to a file that will never exist
    // — an author error, not a deferred artifact. The read-only lane must reach the
    // same verdict as the packager, or `vat skills validate` passes a tree the build
    // then refuses (and the plugin build throws on).
    const { skillPath, outputPath, evalsDir } = writeProject({ alsoLink: DROPPED_DEST });
    const files = [{ source: 'skills/demo/evals/evals.json', dest: DROPPED_DEST }];

    // Lane 1 — the packager: what actually ships.
    const built = await packageSkill(skillPath, {
      outputPath,
      formats: ['directory'],
      testInputDirs: [evalsDir],
      files,
    });
    expect(existsSync(safePath.join(outputPath, DROPPED_DEST))).toBe(false);
    expect(codesOf(built.postBuildIssues)).toContain('PACKAGED_TEST_INPUT');
    expect(codesOf(built.postBuildIssues)).toContain(BROKEN_LINK_CODE);
    expect(built.hasErrors).toBe(true);

    // Lane 2 — `vat skills validate` (source-level, no build): same input, and now
    // the same answer. It used to call this link an info-severity
    // LINK_DEFERRED_ARTIFACT because it modeled the RAW files: list.
    const validated = await validateSkillForPackaging(skillPath, {
      files,
      test: { evals: EVALS_SUBPATH },
    });
    expect(codesOf(activeErrorsOf(validated))).toContain(BROKEN_LINK_CODE);
    expect(codesOf(validated.allErrors)).not.toContain('LINK_DEFERRED_ARTIFACT');
    expect(validated.status).toBe('error');
  });

  it('still packages a files: entry that points OUTSIDE test input', async () => {
    const { skillPath, outputPath, evalsDir } = writeProject();
    writeFileSync(safePath.join(projectRoot, 'generated.md'), '# Generated\n', 'utf8');

    await packageSkill(skillPath, {
      outputPath,
      formats: ['directory'],
      testInputDirs: [evalsDir],
      files: [{ source: 'generated.md', dest: 'cli-reference.md' }],
    });

    expect(existsSync(safePath.join(outputPath, 'cli-reference.md'))).toBe(true);
  });

  it('packages the suite normally when the skill declares no test input (no rule, no surprise)', async () => {
    const { skillPath, outputPath } = writeProject();

    await packageSkill(skillPath, { outputPath, formats: ['directory'] });

    // Without a `test:` declaration VAT does not guess that `evals/` is test input —
    // the linked file bundles like any other resource.
    expect(outputFiles(outputPath).some((f) => f.includes('evals'))).toBe(true);
    expect(existsSync(outputPath)).toBe(true);
  });
});

describe('a skill\'s bundle never carries another skill\'s eval suite (integration)', () => {
  beforeEach(() => {
    projectRoot = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-cross-skill-'));
    writeCrossSkillProject();
  });
  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('excludes the OTHER skill\'s suite from the build and leaves a receipt', async () => {
    const skillPath = safePath.join(subjectDir, SKILL_MD);
    const outputPath = safePath.join(projectRoot, 'dist', SUBJECT_NAME);

    const result = await packageSkill(
      skillPath,
      packagingConfigToPackageOptions(
        { test: { evals: SUBJECT_EVALS } },
        { skillPath, outputPath },
        projectSkills(),
      ),
    );

    const files = outputFiles(outputPath);
    // The other skill's suite is not in the bundle, by name...
    expect(files.filter((f) => f.includes('example-evals'))).toEqual([]);
    // ...and no file in the bundle carries its answer key.
    for (const file of files) {
      expect(readFileSync(safePath.join(outputPath, file), 'utf8')).not.toContain(OTHER_ANSWER_KEY);
    }
    // The ordinary linked resource still ships, so the exclusion is targeted.
    expect(files.some((f) => f.endsWith('guide.md'))).toBe(true);

    // The citation is rewritten away — and the author is told, because a link that
    // silently vanished is indistinguishable from one that worked.
    const shipped = readFileSync(safePath.join(outputPath, SKILL_MD), 'utf8');
    expect(shipped).not.toContain('example-evals.json');
    const receipt = result.postBuildIssues?.find((i) => i.code === 'PACKAGED_TEST_INPUT');
    expect(receipt?.severity).toBe('warning');
    // Dropping declared test input is normal, not an error: the build stays green.
    expect(result.hasErrors).toBe(false);
  });

  it('bundles the OTHER skill\'s suite when the project\'s declarations are withheld', async () => {
    // The control. Without the project-wide list the packager is structurally blind to
    // the other skill's declaration, so this asserts the fixture really can leak — if
    // it could not, the test above would pass with or without the wiring.
    const skillPath = safePath.join(subjectDir, SKILL_MD);
    const outputPath = safePath.join(projectRoot, 'dist', `${SUBJECT_NAME}-unwired`);

    await packageSkill(
      skillPath,
      packagingConfigToPackageOptions({ test: { evals: SUBJECT_EVALS } }, { skillPath, outputPath }, []),
    );

    const leaked = outputFiles(outputPath).filter((f) => f.includes('example-evals'));
    expect(leaked).not.toEqual([]);
  });

  it('the read-only validator lane reaches the SAME verdict when handed the project\'s suites', async () => {
    // `vat resources validate` / `vat skills validate` must not predict a bundle the
    // build never produces — same input, one answer about what ships.
    const skillPath = safePath.join(subjectDir, SKILL_MD);

    const validated = await validateSkillForPackaging(
      skillPath,
      { test: { evals: SUBJECT_EVALS } },
      'source',
      { projectSkills: projectSkills() },
    );

    expect(activeWarningsOf(validated).map((i) => String(i.code))).toContain('PACKAGED_TEST_INPUT');
    // SKILL.md + guide.md only — the other skill's suite is not counted as bundled.
    expect(validated.metadata.fileCount).toBe(2);
  });
});
