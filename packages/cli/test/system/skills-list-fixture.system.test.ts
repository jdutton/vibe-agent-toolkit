/**
 * Fixture-based system tests for skills list command
 * Uses committed test fixture instead of scanning entire project directory
 * Fast and deterministic on all platforms including Windows
 */

import { chmodSync, cpSync } from 'node:fs';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { CANNOT_DENY_READS } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as yaml from 'yaml';

import { SKILLS_LIST_REPORT_SCHEMA } from '../../src/commands/skills/list-schema.js';

import { cleanupTestTempDir, createTestTempDir, getBinPath, getFixturePath } from './test-common.js';
import { executeCli } from './test-helpers/index.js';

describe('skills list command - fixture tests (system test)', () => {
  const binPath = getBinPath(import.meta.url);
  // Use committed fixture instead of creating files at runtime (faster on Windows).
  // Resolved relative to this test file (not process.cwd()) so it works whether
  // vitest is invoked from the monorepo root or from packages/cli directly.
  const fixtureDir = getFixturePath(import.meta.url, 'skills-minimal');
  let tempDir: string;

  beforeAll(() => {
    tempDir = createTestTempDir('vat-skills-list-fixture-');
  });

  afterAll(() => {
    cleanupTestTempDir(tempDir);
  });

  it('publishes the fixture listing as a report the registry schema accepts', () => {
    const result = executeCli(binPath, ['skills', 'list', fixtureDir]);

    expect(result.status, result.stderr).toBe(0);
    const report = SKILLS_LIST_REPORT_SCHEMA.parse(yaml.parse(result.stdout));

    expect(report.status).toBe('ok');
    // One search root: the project directory.
    expect(report.examined).toBe(1);
    expect(report.data?.context).toBe('project');
    expect(report.data?.skills).toHaveLength(2);
    expect(report.data?.skills.every((skill) => skill.valid)).toBe(true);
    // Root-relative: `root` is the only absolute path in the document.
    expect(report.data?.skills.map((skill) => skill.path).toSorted()).toStrictEqual([
      'packages/test-skill-2/resources/skills/SKILL.md',
      'resources/skills/SKILL.md',
    ]);
  });

  it.skipIf(CANNOT_DENY_READS)('an unreadable skills directory is a warning finding, exit 0, not a status word', () => {
    const project = safePath.join(tempDir, 'locked-project');
    cpSync(fixtureDir, project, { recursive: true });
    const locked = safePath.join(project, 'resources', 'locked');
    mkdirSyncReal(locked, { recursive: true });
    chmodSync(locked, 0o000);
    try {
      const result = executeCli(binPath, ['skills', 'list', project]);

      expect(result.status, result.stderr).toBe(0);
      const report = SKILLS_LIST_REPORT_SCHEMA.parse(yaml.parse(result.stdout));
      expect(report.status).toBe('findings');
      expect(report.findings.map((finding) => [finding.code, finding.severity, finding.location])).toStrictEqual([
        ['SCAN_PATH_UNREADABLE', 'warning', 'resources/locked'],
      ]);
      // The skills that WERE listed are still published.
      expect(report.data?.skills).toHaveLength(2);
    } finally {
      chmodSync(locked, 0o755);
    }
  });
});
