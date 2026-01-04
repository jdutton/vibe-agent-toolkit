/* eslint-disable security/detect-non-literal-fs-filename -- test helpers use controlled temp directories */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach } from 'vitest';

import { validateSkill } from '../src/validators/skill-validator.js';
import type { ValidationResult } from '../src/validators/types.js';

/**
 * Setup temporary directory for tests
 * Automatically creates and cleans up temp dir before/after each test
 */
export function setupTempDir(prefix: string): { getTempDir: () => string } {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  return {
    getTempDir: () => tempDir,
  };
}

/**
 * Create a SKILL.md file with given content and validate it
 */
export async function createSkillAndValidate(
  tempDir: string,
  content: string,
): Promise<ValidationResult> {
  const skillPath = path.join(tempDir, 'SKILL.md');
  fs.writeFileSync(skillPath, content);
  return validateSkill({ skillPath });
}

/**
 * Create a skill with frontmatter only (no body)
 */
export function createFrontmatter(fields: Record<string, unknown>): string {
  const yaml = Object.entries(fields)
    .map(([key, value]) => {
      if (typeof value === 'object' && value !== null) {
        return `${key}:\n${Object.entries(value)
          .map(([k, v]) => `  ${k}: ${v}`)
          .join('\n')}`;
      }
      return `${key}: ${value}`;
    })
    .join('\n');

  return `---\n${yaml}\n---`;
}

/**
 * Create a complete skill file (frontmatter + body)
 */
export function createSkillContent(
  frontmatter: Record<string, unknown>,
  body = '\n# My Skill',
): string {
  return `${createFrontmatter(frontmatter)}\n${body}`;
}

/**
 * Assert that validation result has specific error code
 */
export function expectError(result: ValidationResult, code: string): void {
  const issue = result.issues.find((i) => i.code === code);
  if (!issue) {
    throw new Error(
      `Expected error code '${code}' but found: ${result.issues.map((i) => i.code).join(', ')}`,
    );
  }
}

/**
 * Assert that validation result has specific warning code
 */
export function expectWarning(result: ValidationResult, code: string): void {
  const issue = result.issues.find((i) => i.code === code && i.severity === 'warning');
  if (!issue) {
    throw new Error(
      `Expected warning code '${code}' but found: ${result.issues.filter((i) => i.severity === 'warning').map((i) => i.code).join(', ')}`,
    );
  }
}

/**
 * Create a SKILL.md file with given content (for integration tests)
 */
export function createSkillFile(tempDir: string, content: string): string {
  const skillPath = path.join(tempDir, 'SKILL.md');
  fs.writeFileSync(skillPath, content);
  return skillPath;
}
