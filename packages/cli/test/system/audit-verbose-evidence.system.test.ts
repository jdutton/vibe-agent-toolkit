/**
 * System tests for `vat audit --verbose` evidence rendering.
 *
 * Verifies that:
 * 1. Without --verbose, no evidence is rendered and no file row carries any.
 * 2. With --verbose, stderr renders the evidence behind each capability
 *    finding, with the expected pattern IDs for the test skill. The report's
 *    file rows never carry evidence — their findings are the envelope's.
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
  fs.mkdirSync(skillDir, { recursive: true });
  const skillPath = safePath.join(skillDir, 'SKILL.md');
  writeTestFile(skillPath, SKILL_CONTENT);
  return skillPath;
}

interface FileEntry {
  path: string;
  evidence?: unknown;
}

function getFiles(parsed: Record<string, unknown>): FileEntry[] {
  return ((parsed['data'] as { files?: FileEntry[] } | undefined)?.files ?? []);
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

  it('renders no evidence when --verbose is not set, and no file row carries any', async () => {
    const skillPath = createTestSkill(tempDir, 'no-verbose-skill');
    const { result, parsed } = await executeCliAndParseYaml(binPath, ['audit', skillPath]);

    expect(result.status).toBe(0);
    const files = getFiles(parsed);
    expect(files.length).toBeGreaterThan(0);
    expect(files[0]?.evidence).toBeUndefined();
    expect(result.stderr).not.toContain('supporting evidence');
  });

  it('renders the expected evidence pattern IDs on stderr when --verbose is set', async () => {
    const skillPath = createTestSkill(tempDir, 'verbose-skill');
    const { result, parsed } = await executeCliAndParseYaml(binPath, ['audit', skillPath, '--verbose']);

    expect(result.status).toBe(0);
    // The report's file rows carry no evidence at any verbosity: the evidence is
    // the human channel's, beneath the finding it supports.
    expect(getFiles(parsed)[0]?.evidence).toBeUndefined();
    expect(result.stderr).toContain('supporting evidence');
    expect(result.stderr).toContain('[FENCED_SHELL_BLOCK]');
    expect(result.stderr).toContain('[EXTERNAL_CLI_AZ]');
    expect(result.stderr).toContain('[BROWSER_AUTH_AZ_LOGIN]');
  });
});
