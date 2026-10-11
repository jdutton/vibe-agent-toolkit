/**
 * Fixture-based system tests for skills validate command
 * Uses committed test fixture instead of scanning entire project directory
 * Fast and deterministic on all platforms including Windows
 */

import { describe, expect, it } from 'vitest';
import * as yaml from 'yaml';

import { SKILLS_VALIDATE_REPORT_SCHEMA } from '../../src/commands/skills/validate-schema.js';

import { getBinPath, getFixturePath } from './test-common.js';
import { executeSkillsCommandAndExpectYaml } from './test-helpers/index.js';

describe('skills validate command - fixture tests (system test)', () => {
  const binPath = getBinPath(import.meta.url);
  // Use committed fixture instead of creating files at runtime (faster on Windows).
  // Resolved relative to this test file (not process.cwd()) so it works whether
  // vitest is invoked from the monorepo root or from packages/cli directly.
  const fixtureDir = getFixturePath(import.meta.url, 'skills-minimal');

  it('validates both fixture skills clean, each with its own row', () => {
    const { result } = executeSkillsCommandAndExpectYaml(binPath, 'validate', fixtureDir);
    const document = SKILLS_VALIDATE_REPORT_SCHEMA.parse(yaml.parse(result.stdout));

    expect(result.status).toBe(0);
    expect(document.status).toBe('ok');
    expect(document.examined).toBe(2);
    expect(document.findings).toEqual([]);
    // Every validated skill has a row — clean ones included — so the rows and
    // `examined` agree without `--verbose`.
    expect(document.data.skills).toHaveLength(2);
    for (const skill of document.data.skills) {
      expect(skill).toEqual({ name: skill.name, status: 'ok', summary: { errors: 0, warnings: 0, info: 0 }, allowed: 0 });
    }
  });
});
