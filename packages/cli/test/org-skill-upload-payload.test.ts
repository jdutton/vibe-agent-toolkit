/* eslint-disable security/detect-non-literal-fs-filename -- Test code with temp directories */

/**
 * What `vat claude org skills install <dir>` actually publishes.
 *
 * The command documents "a built skill directory" as its input, but nothing
 * stops an operator handing it the *source* tree — where the eval suite (the
 * answer key) lives. Publishing to an organization is the widest blast radius
 * in the lifecycle, so the exclusion is enforced here rather than assumed.
 *
 * Every assertion here is on the COLLECTED FILE SET — "is the answer key in the
 * payload?" — never on a directory name. An earlier version of this suite
 * asserted `excludedDirs).toContain('evals')`, which is satisfied by a hardcoded
 * name match and therefore could not see the leak this suite now covers: an
 * adopter whose config declares its suite somewhere other than `evals/`.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { collectSkillUploadFiles } from '../src/commands/claude/org/skills.js';

let tempDir: string;

/** An eval suite's `expected_output` — the thing that must never be published. */
const ANSWER_KEY = '{"evals":[{"prompt":"2+2?","expected_output":"FAKE-ANSWER-KEY-4"}]}';

/** Write a file, creating parent directories as needed. */
function writeAt(root: string, relPath: string, content: string): void {
  const abs = safePath.join(root, relPath);
  mkdirSyncReal(safePath.join(abs, '..'), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

/** The publishable content every fixture skill shares. */
function writeSkillContent(skillDir: string, name: string): void {
  mkdirSyncReal(skillDir, { recursive: true });
  writeAt(skillDir, 'SKILL.md', `---\nname: ${name}\ndescription: Sample.\n---\n\n# ${name}\n`);
  writeAt(skillDir, 'resources/guide.md', '# Guide\n');
}

/** A skill source tree with no VAT config: real content plus the conventional suite. */
function createSourceTree(name: string): string {
  const root = safePath.join(tempDir, name);
  writeSkillContent(root, 'sample');
  writeAt(root, 'evals/evals.json', ANSWER_KEY);
  writeAt(root, 'evals/fixtures/input.txt', 'fixture');
  writeAt(root, 'node_modules/dep/index.js', 'module.exports = {};');
  writeAt(root, '.git/config', '[core]\n');
  return root;
}

/**
 * An adopter project whose `vibe-agent-toolkit.config.yaml` declares its eval
 * suite at `evalsSubpath` (relative to the skill dir), with the answer key
 * actually written there. Returns the skill directory an operator would point
 * the uploader at.
 */
function createAdopterProject(dirName: string, evalsSubpath: string): string {
  const projectRoot = safePath.join(tempDir, dirName);
  mkdirSyncReal(projectRoot, { recursive: true });
  writeAt(projectRoot, 'vibe-agent-toolkit.config.yaml', [
    'version: 1',
    'skills:',
    '  include: ["skills/**/SKILL.md"]',
    '  config:',
    '    sample:',
    '      test:',
    `        evals: ${evalsSubpath}`,
    '',
  ].join('\n'));

  const skillDir = safePath.join(projectRoot, 'skills', 'sample');
  writeSkillContent(skillDir, 'sample');
  writeAt(skillDir, evalsSubpath, ANSWER_KEY);
  return skillDir;
}

/** Relative paths in the upload payload. */
async function uploadedPaths(skillDir: string): Promise<string[]> {
  const collected = await collectSkillUploadFiles(skillDir);
  return collected.files.map((f) => f.relativePath);
}

describe('collectSkillUploadFiles', () => {
  beforeAll(() => {
    tempDir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-org-upload-'));
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('never uploads a declared eval suite that lives outside evals/', async () => {
    const skillDir = createAdopterProject('declared-elsewhere', 'fixtures/qa/evals.json');

    const paths = await uploadedPaths(skillDir);

    expect(paths).toContain('SKILL.md');
    expect(paths.some((p) => p.endsWith('evals.json'))).toBe(false);
    expect(paths.some((p) => p.includes('qa'))).toBe(false);
  });

  it('never uploads a suite declared as a bare file at the skill root', async () => {
    const skillDir = createAdopterProject('declared-at-root', 'answers.json');

    const paths = await uploadedPaths(skillDir);

    expect(paths).toContain('SKILL.md');
    expect(paths).not.toContain('answers.json');
  });

  it('never uploads the conventional eval suite, node_modules, or .git', async () => {
    const paths = await uploadedPaths(createSourceTree('source-tree'));

    expect(paths).toContain('SKILL.md');
    expect(paths).toContain(safePath.join('resources', 'guide.md'));
    expect(paths.some((p) => p.includes('evals'))).toBe(false);
    expect(paths.some((p) => p.includes('node_modules'))).toBe(false);
    expect(paths.some((p) => p.includes('.git'))).toBe(false);
  });

  it('still withholds the conventional evals/ when no config is discoverable', async () => {
    // No vibe-agent-toolkit.config.yaml anywhere up the tree: the backstop must
    // fail SAFE rather than fall back to uploading everything.
    const collected = await collectSkillUploadFiles(createSourceTree('no-config'));

    expect(collected.files.some((f) => f.relativePath.includes('evals'))).toBe(false);
    expect(collected.excluded).toContain('evals');
  });

  it('reports every exclusion, so the skip is never silent', async () => {
    const conventional = await collectSkillUploadFiles(createSourceTree('reported'));
    expect(conventional.excluded).toContain('evals');
    expect(conventional.excluded).toContain('node_modules');
    expect(conventional.excluded).toContain('.git');

    const declared = await collectSkillUploadFiles(
      createAdopterProject('reported-declared', 'fixtures/qa/evals.json'),
    );
    expect(declared.excluded).toContain(safePath.join('fixtures', 'qa'));
  });

  it('excludes an eval suite nested below the skill root too', async () => {
    const root = safePath.join(tempDir, 'nested');
    mkdirSyncReal(root, { recursive: true });
    writeAt(root, 'SKILL.md', '---\nname: nested\ndescription: Nested.\n---\n\n# nested\n');
    writeAt(root, 'resources/evals/evals.json', ANSWER_KEY);

    const collected = await collectSkillUploadFiles(root);

    expect(collected.files.map((f) => f.relativePath)).toEqual(['SKILL.md']);
    expect(collected.excluded).toContain(safePath.join('resources', 'evals'));
  });

  it('leaves a correctly built skill directory untouched', async () => {
    const root = safePath.join(tempDir, 'built');
    writeSkillContent(root, 'built');

    const collected = await collectSkillUploadFiles(root);

    expect(collected.files).toHaveLength(2);
    expect(collected.excluded).toEqual([]);
  });
});
