/* eslint-disable security/detect-non-literal-fs-filename -- Test code with temp directories */

/**
 * What `vat claude org skills install <dir>` actually publishes.
 *
 * The command documents "a built skill directory" as its input, but nothing
 * stops an operator handing it the *source* tree — where the eval suite (the
 * answer key) lives. Publishing to an organization is the widest blast radius
 * in the lifecycle, so the exclusion is enforced here rather than assumed.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { collectSkillUploadFiles } from '../src/commands/claude/org/skills.js';

let tempDir: string;

/** Write a file, creating parent directories as needed. */
function writeAt(root: string, relPath: string, content: string): void {
  const abs = safePath.join(root, relPath);
  mkdirSyncReal(safePath.join(abs, '..'), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

/** A skill source tree: real content plus the things that must never publish. */
function createSourceTree(name: string): string {
  const root = safePath.join(tempDir, name);
  mkdirSyncReal(root, { recursive: true });
  writeAt(root, 'SKILL.md', '---\nname: sample\ndescription: Sample.\n---\n\n# sample\n');
  writeAt(root, 'resources/guide.md', '# Guide\n');
  writeAt(root, 'evals/evals.json', '{"evals":[{"expected_output":"the answer"}]}');
  writeAt(root, 'evals/fixtures/input.txt', 'fixture');
  writeAt(root, 'node_modules/dep/index.js', 'module.exports = {};');
  writeAt(root, '.git/config', '[core]\n');
  return root;
}

describe('collectSkillUploadFiles', () => {
  beforeAll(() => {
    tempDir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-org-upload-'));
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('never uploads an eval suite, node_modules, or .git', () => {
    const collected = collectSkillUploadFiles(createSourceTree('source-tree'));

    const paths = collected.files.map((f) => f.relativePath);
    expect(paths).toContain('SKILL.md');
    expect(paths).toContain(safePath.join('resources', 'guide.md'));
    expect(paths.some((p) => p.includes('evals'))).toBe(false);
    expect(paths.some((p) => p.includes('node_modules'))).toBe(false);
    expect(paths.some((p) => p.includes('.git'))).toBe(false);
  });

  it('reports what it excluded, so the skip is never silent', () => {
    const collected = collectSkillUploadFiles(createSourceTree('reported'));

    expect(collected.excludedDirs).toContain('evals');
    expect(collected.excludedDirs).toContain('node_modules');
    expect(collected.excludedDirs).toContain('.git');
  });

  it('excludes an eval suite nested below the skill root too', () => {
    const root = safePath.join(tempDir, 'nested');
    mkdirSyncReal(root, { recursive: true });
    writeAt(root, 'SKILL.md', '---\nname: nested\ndescription: Nested.\n---\n\n# nested\n');
    writeAt(root, 'resources/evals/evals.json', '{"evals":[]}');

    const collected = collectSkillUploadFiles(root);

    expect(collected.files.map((f) => f.relativePath)).toEqual(['SKILL.md']);
    expect(collected.excludedDirs).toContain(safePath.join('resources', 'evals'));
  });

  it('leaves a correctly built skill directory untouched', () => {
    const root = safePath.join(tempDir, 'built');
    mkdirSyncReal(root, { recursive: true });
    writeAt(root, 'SKILL.md', '---\nname: built\ndescription: Built.\n---\n\n# built\n');
    writeAt(root, 'resources/ref.md', '# Ref\n');

    const collected = collectSkillUploadFiles(root);

    expect(collected.files).toHaveLength(2);
    expect(collected.excludedDirs).toEqual([]);
  });
});
