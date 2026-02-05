import type { ScanResult } from '@vibe-agent-toolkit/discovery';
import { describe, it, expect } from 'vitest';

import { discoverSkills, validateSkillFilename } from '../../src/utils/skill-discovery.js';

// Test constants to avoid duplication
const SKILL_FORMAT = 'claude-skill';
const MARKDOWN_FORMAT = 'markdown';
const NOT_GIT_IGNORED = false;
const PROJECT_ROOT = '/project';
const README_PATH = '/project/README.md';

describe('discoverSkills', () => {
  it('should filter resources to find SKILL.md files', () => {
    const resources: ScanResult[] = [
      { path: `${PROJECT_ROOT}/SKILL.md`, format: SKILL_FORMAT, isGitIgnored: NOT_GIT_IGNORED, relativePath: 'SKILL.md' },
      { path: README_PATH, format: MARKDOWN_FORMAT, isGitIgnored: NOT_GIT_IGNORED, relativePath: 'README.md' },
      { path: '/project/docs/guide.md', format: MARKDOWN_FORMAT, isGitIgnored: NOT_GIT_IGNORED, relativePath: 'docs/guide.md' },
    ];

    const skills = discoverSkills(resources);

    expect(skills).toHaveLength(1);
    expect(skills[0]?.path).toBe(`${PROJECT_ROOT}/SKILL.md`);
  });

  it('should find SKILL.md in subdirectories (case-insensitive)', () => {
    const resources: ScanResult[] = [
      { path: `${PROJECT_ROOT}/skill1/SKILL.md`, format: SKILL_FORMAT, isGitIgnored: NOT_GIT_IGNORED, relativePath: 'skill1/SKILL.md' },
      { path: `${PROJECT_ROOT}/skill2/SKILL.md`, format: SKILL_FORMAT, isGitIgnored: NOT_GIT_IGNORED, relativePath: 'skill2/SKILL.md' },
      { path: README_PATH, format: MARKDOWN_FORMAT, isGitIgnored: NOT_GIT_IGNORED, relativePath: 'README.md' },
    ];

    const skills = discoverSkills(resources);

    expect(skills).toHaveLength(2);
    expect(skills[0]?.path).toBe(`${PROJECT_ROOT}/skill1/SKILL.md`);
    expect(skills[1]?.path).toBe(`${PROJECT_ROOT}/skill2/SKILL.md`);
  });

  it('should match SKILL.md case-insensitively', () => {
    const resources: ScanResult[] = [
      { path: `${PROJECT_ROOT}/SKILL.md`, format: SKILL_FORMAT, isGitIgnored: NOT_GIT_IGNORED, relativePath: 'SKILL.md' },
      { path: `${PROJECT_ROOT}/skill.md`, format: MARKDOWN_FORMAT, isGitIgnored: NOT_GIT_IGNORED, relativePath: 'skill.md' },
      { path: `${PROJECT_ROOT}/Skill.md`, format: MARKDOWN_FORMAT, isGitIgnored: NOT_GIT_IGNORED, relativePath: 'Skill.md' },
    ];

    const skills = discoverSkills(resources);

    // Should match all case variations
    expect(skills).toHaveLength(3);
  });

  it('should return empty array when no SKILL.md files found', () => {
    const resources: ScanResult[] = [
      { path: README_PATH, format: MARKDOWN_FORMAT, isGitIgnored: NOT_GIT_IGNORED, relativePath: 'README.md' },
      { path: `${PROJECT_ROOT}/docs/guide.md`, format: MARKDOWN_FORMAT, isGitIgnored: NOT_GIT_IGNORED, relativePath: 'docs/guide.md' },
    ];

    const skills = discoverSkills(resources);

    expect(skills).toHaveLength(0);
  });

  it('should handle empty input array', () => {
    const skills = discoverSkills([]);

    expect(skills).toHaveLength(0);
  });

  it('should not match partial filename matches', () => {
    const resources: ScanResult[] = [
      { path: '/project/SKILL.md.bak', format: MARKDOWN_FORMAT, isGitIgnored: NOT_GIT_IGNORED, relativePath: 'SKILL.md.bak' },
      { path: '/project/MY-SKILL.md', format: MARKDOWN_FORMAT, isGitIgnored: NOT_GIT_IGNORED, relativePath: 'MY-SKILL.md' },
      { path: '/project/SKILL.txt', format: 'unknown', isGitIgnored: NOT_GIT_IGNORED, relativePath: 'SKILL.txt' },
    ];

    const skills = discoverSkills(resources);

    expect(skills).toHaveLength(0);
  });
});

describe('validateSkillFilename', () => {
  it('should validate SKILL.md as correct', () => {
    const result = validateSkillFilename('/path/to/SKILL.md');

    expect(result.valid).toBe(true);
    expect(result.basename).toBe('SKILL.md');
    expect(result.message).toBeUndefined();
  });

  it('should reject lowercase skill.md', () => {
    const result = validateSkillFilename('/path/to/skill.md');

    expect(result.valid).toBe(false);
    expect(result.basename).toBe('skill.md');
    expect(result.message).toContain('SKILL.md');
    expect(result.message).toContain('case-sensitive');
  });

  it('should reject mixed case Skill.md', () => {
    const result = validateSkillFilename('/path/to/Skill.md');

    expect(result.valid).toBe(false);
    expect(result.basename).toBe('Skill.md');
    expect(result.message).toContain('SKILL.md');
  });

  it('should reject SkIlL.md', () => {
    const result = validateSkillFilename('/path/to/SkIlL.md');

    expect(result.valid).toBe(false);
    expect(result.basename).toBe('SkIlL.md');
    expect(result.message).toContain('SKILL.md');
  });

  it('should validate deeply nested SKILL.md', () => {
    const result = validateSkillFilename('/very/deep/path/to/my/skill/SKILL.md');

    expect(result.valid).toBe(true);
    expect(result.basename).toBe('SKILL.md');
  });

  it('should extract basename correctly on Windows paths', () => {
    const result = validateSkillFilename(String.raw`C:\Users\name\project\SKILL.md`);

    expect(result.valid).toBe(true);
    expect(result.basename).toBe('SKILL.md');
  });

  it('should provide helpful error message for wrong case', () => {
    const result = validateSkillFilename('/path/skill.md');

    expect(result.message).toMatch(/must be exactly "SKILL\.md"/i);
    expect(result.message).toMatch(/case-sensitive/i);
  });
});
