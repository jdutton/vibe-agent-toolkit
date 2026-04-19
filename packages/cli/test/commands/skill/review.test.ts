/**
 * Unit tests for resolveSkillPath in `vat skill review`.
 *
 * Covers the path-resolution contract:
 * - SKILL.md files are accepted (classic single-file entry point)
 * - Any .md file is accepted (single-file skill layout)
 * - Non-.md files are rejected with a useful error
 * - Directories containing SKILL.md are accepted
 * - Missing paths error
 */

import * as fs from 'node:fs';

import { setupSyncTempDirSuite, safePath } from '@vibe-agent-toolkit/utils';
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';

import { resolveSkillPath } from '../../../src/commands/skill/review.js';

describe('resolveSkillPath', () => {
  const suite = setupSyncTempDirSuite('vat-review-path');
  let tempDir: string;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);

  beforeEach(() => {
    suite.beforeEach();
    tempDir = suite.getTempDir();
  });

  // ── Existing behavior that must be preserved ──────────────────────────────

  it('accepts a SKILL.md file and returns its absolute path', () => {
    const skillPath = safePath.join(tempDir, 'SKILL.md');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test temp directory
    fs.writeFileSync(skillPath, '# skill');

    const result = resolveSkillPath(skillPath);
    expect(result).toBe(skillPath);
  });

  it('accepts a directory containing SKILL.md and returns the SKILL.md path', () => {
    const skillDir = safePath.join(tempDir, 'my-skill');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test temp directory
    fs.mkdirSync(skillDir);
    const skillMd = safePath.join(skillDir, 'SKILL.md');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test temp directory
    fs.writeFileSync(skillMd, '# skill');

    const result = resolveSkillPath(skillDir);
    expect(result).toBe(skillMd);
  });

  it('throws when path does not exist', () => {
    const missing = safePath.join(tempDir, 'does-not-exist.md');
    expect(() => resolveSkillPath(missing)).toThrow(/Path does not exist/);
  });

  it('throws when directory has no SKILL.md', () => {
    const emptyDir = safePath.join(tempDir, 'empty-dir');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test temp directory
    fs.mkdirSync(emptyDir);

    expect(() => resolveSkillPath(emptyDir)).toThrow(/No SKILL.md found in directory/);
  });

  // ── New behavior: any .md file is accepted ────────────────────────────────

  it('accepts a single-file skill (.md not named SKILL.md) and returns its absolute path', () => {
    const singleFile = safePath.join(tempDir, 'vat-audit.md');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test temp directory
    fs.writeFileSync(singleFile, '# vat-audit skill');

    const result = resolveSkillPath(singleFile);
    expect(result).toBe(singleFile);
  });

  it('accepts a hyphenated-name .md skill file', () => {
    const singleFile = safePath.join(tempDir, 'skill-quality-checklist.md');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test temp directory
    fs.writeFileSync(singleFile, '# checklist skill');

    const result = resolveSkillPath(singleFile);
    expect(result).toBe(singleFile);
  });

  // ── New error message for non-.md files ──────────────────────────────────

  it('throws with the new error message for a .txt file', () => {
    const txtFile = safePath.join(tempDir, 'notes.txt');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test temp directory
    fs.writeFileSync(txtFile, 'not a skill');

    expect(() => resolveSkillPath(txtFile)).toThrow(
      /Expected a markdown file \(\.md\) or a skill directory/,
    );
  });

  it('throws with the new error message for a .json file', () => {
    const jsonFile = safePath.join(tempDir, 'config.json');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test temp directory
    fs.writeFileSync(jsonFile, '{}');

    expect(() => resolveSkillPath(jsonFile)).toThrow(
      /Expected a markdown file \(\.md\) or a skill directory/,
    );
  });

  it('includes the original path argument in the error for non-.md files', () => {
    const txtFile = safePath.join(tempDir, 'notes.txt');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test temp directory
    fs.writeFileSync(txtFile, 'not a skill');

    expect(() => resolveSkillPath(txtFile)).toThrow(txtFile);
  });
});
