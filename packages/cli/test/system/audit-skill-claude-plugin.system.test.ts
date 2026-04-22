/**
 * System test: `vat audit` recognizes skill-claude-plugin packaging shape.
 *
 * Spawns the built CLI against the skill-claude-plugin fixtures in
 * `packages/agent-skills/test/fixtures/packaging-shapes/` and verifies that
 * audit emits independent results for each surface.
 */

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { safePath } from '@vibe-agent-toolkit/utils';
import { beforeAll, describe, expect, it } from 'vitest';

import { executeCli, executeCliAndParseYaml, getWrapperPath } from './test-common.js';

interface FileEntry {
  type?: string;
  path?: string;
}

interface AuditSummary {
  filesScanned?: number;
}

interface ParsedAuditOutput {
  summary?: AuditSummary;
  files?: FileEntry[];
}

const binPath = getWrapperPath(import.meta.url);
const fixturesBase = safePath.join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'agent-skills',
  'test',
  'fixtures',
  'packaging-shapes',
);

describe('vat audit skill-claude-plugin (system)', () => {
  beforeAll(() => {
    const check = executeCli(binPath, ['--help']);
    if (check.status !== 0) {
      throw new Error('CLI not built. Run `bun run build` before these tests.');
    }
  });

  it('emits two entries with expected types for the matching fixture', () => {
    const dir = safePath.join(fixturesBase, 'skill-claude-plugin-matching');
    const { result, parsed } = executeCliAndParseYaml(binPath, ['audit', dir]);
    expect(result.status).toBe(0);

    const audit = parsed as ParsedAuditOutput;
    expect(audit.summary?.filesScanned).toBe(2);
    expect(audit.files).toHaveLength(2);
    const types = (audit.files ?? [])
      .map((f) => f.type)
      .filter((t): t is string => typeof t === 'string')
      .sort((a, b) => a.localeCompare(b));
    expect(types).toEqual(['agent-skill', 'claude-plugin']);
  });

  it('emits SKILL_CLAUDE_PLUGIN_NAME_MISMATCH for the mismatch fixture', () => {
    const dir = safePath.join(fixturesBase, 'skill-claude-plugin-mismatch');
    const result = executeCli(binPath, ['audit', dir]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('SKILL_CLAUDE_PLUGIN_NAME_MISMATCH');
  });
});
