/* eslint-disable security/detect-non-literal-fs-filename -- test paths are our own controlled temp dirs */
/**
 * Integration test: declared test input never reaches a built skill.
 *
 * Drives the REAL `packageSkill` against a temp project, so this covers the actual
 * link-graph walk, the exclusion, and the post-build guarantee together — the unit
 * tests in test-input.test.ts cover the path logic in isolation.
 *
 * Both entry routes into a bundle are exercised:
 *   - a SKILL.md link into the eval suite (excluded silently — the author's link is
 *     not a packaging decision they get to make);
 *   - a `files:` entry mapping the suite in (refused loudly — two config declarations
 *     contradict each other, and silently ignoring one would be worse).
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { packageSkill } from '../../src/skill-packager.js';
import { validateSkillForPackaging } from '../../src/validators/packaging-validator.js';

const ANSWER_KEY = 'the model must output exactly forty-two';
/** Basename of the declared eval suite, used as both a source leaf and a dest. */
const EVALS_FILE = 'evals.json';
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
    // Excluding declared test input is normal, not an error: the build stays green.
    expect(result.postBuildIssues?.some((i) => i.code === 'PACKAGED_TEST_INPUT')).not.toBe(true);
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
      test: { evals: 'evals/evals.json' },
    });
    expect(codesOf(validated.activeErrors)).toContain(BROKEN_LINK_CODE);
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
