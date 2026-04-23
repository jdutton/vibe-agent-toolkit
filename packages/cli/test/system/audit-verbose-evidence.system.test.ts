/**
 * System tests for `vat audit --verbose` evidence rendering.
 *
 * Verifies that:
 * 1. Without --verbose, per-file YAML output omits the `evidence` field.
 * 2. With --verbose, per-file YAML includes an `evidence` array containing
 *    the expected pattern IDs for the test skill.
 */

import * as fs from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  cleanupTestTempDir,
  createTestTempDir,
  executeCliAndParseYaml,
  getBinPath,
  writeTestFile,
} from './test-common.js';

const SKILL_CONTENT = `---
name: s
description: A skill with a fenced shell block for testing compat detection.
---

\`\`\`bash
az login
\`\`\`
`;

function createTestSkill(parentDir: string, skillName: string): string {
  const skillDir = safePath.join(parentDir, skillName);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test, paths controlled
  fs.mkdirSync(skillDir, { recursive: true });
  const skillPath = safePath.join(skillDir, 'SKILL.md');
  writeTestFile(skillPath, SKILL_CONTENT);
  return skillPath;
}

interface FileEntry {
  path: string;
  evidence?: Array<{ patternId: string }>;
}

function getFiles(parsed: Record<string, unknown>): FileEntry[] {
  return (parsed['files'] ?? []) as FileEntry[];
}

describe('Audit --verbose evidence rendering (system test)', () => {
  let binPath: string;
  let tempDir: string;

  beforeAll(() => {
    binPath = getBinPath(import.meta.url);
    tempDir = createTestTempDir('vat-audit-verbose-evidence-');
  });

  afterAll(() => {
    cleanupTestTempDir(tempDir);
  });

  it('omits the evidence field on file entries when --verbose is not set', async () => {
    const skillPath = createTestSkill(tempDir, 'no-verbose-skill');
    const { result, parsed } = await executeCliAndParseYaml(binPath, ['audit', skillPath]);

    expect(result.status).toBe(0);
    const files = getFiles(parsed);
    expect(files.length).toBeGreaterThan(0);
    expect(files[0]?.evidence).toBeUndefined();
  });

  it('includes the expected evidence pattern IDs when --verbose is set', async () => {
    const skillPath = createTestSkill(tempDir, 'verbose-skill');
    const { result, parsed } = await executeCliAndParseYaml(binPath, ['audit', skillPath, '--verbose']);

    expect(result.status).toBe(0);
    const files = getFiles(parsed);
    expect(files.length).toBeGreaterThan(0);

    const evidence = files[0]?.evidence;
    expect(Array.isArray(evidence)).toBe(true);

    const patternIds = (evidence ?? []).map(e => e.patternId);
    expect(patternIds).toContain('FENCED_SHELL_BLOCK');
    expect(patternIds).toContain('EXTERNAL_CLI_AZ');
    expect(patternIds).toContain('BROWSER_AUTH_AZ_LOGIN');
  });
});
