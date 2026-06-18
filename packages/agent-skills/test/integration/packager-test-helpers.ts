/**
 * Shared helpers for packager integration tests.
 *
 * Extracted to eliminate duplicated setup across packager-*.integration.test.ts files.
 */

import { safePath } from '@vibe-agent-toolkit/utils';
import { expect } from 'vitest';

import { packageSkill } from '../../src/skill-packager.js';

/**
 * Package the canonical `skills/example/SKILL.md` skill inside `projectRoot`
 * into `dist/example` and assert that packaging succeeded without errors.
 *
 * Both HTML-rewrite and frontmatter-rewrite tests use the same skill path
 * layout; this helper centralises the three-line setup that was duplicated
 * across those test files.
 *
 * @param projectRoot - Root directory of the temporary test project
 * @returns `outputPath` (`<projectRoot>/dist/example`) for further assertions
 */
export async function buildExampleSkill(projectRoot: string): Promise<{ outputPath: string }> {
  const skillPath = safePath.join(projectRoot, 'skills', 'example', 'SKILL.md');
  const outputPath = safePath.join(projectRoot, 'dist', 'example');
  const result = await packageSkill(skillPath, { outputPath, formats: ['directory'] });
  expect(result.hasErrors).toBe(false);
  return { outputPath };
}
