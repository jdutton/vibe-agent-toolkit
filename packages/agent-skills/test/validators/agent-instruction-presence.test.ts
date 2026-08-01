/* eslint-disable security/detect-non-literal-fs-filename -- Test code with temp directories */
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { detectPackagedAgentInstructionFiles } from '../../src/validators/agent-instruction-presence.js';
import { setupTempDir } from '../test-helpers.js';

describe('detectPackagedAgentInstructionFiles', () => {
  const { getTempDir } = setupTempDir('vat-agent-instruction-presence-');

  /** Write `files` (relative paths) into a fresh tree and scan it. */
  const scan = (files: string[], locationRoot?: string) => {
    const root = getTempDir();
    for (const rel of files) {
      const full = safePath.join(root, rel);
      mkdirSyncReal(dirname(full), { recursive: true });
      writeFileSync(full, '# content\n');
    }
    return detectPackagedAgentInstructionFiles(root, locationRoot ?? root);
  };

  it('reports every agent-instruction basename found in the tree', () => {
    const issues = scan([
      'CLAUDE.md',
      'nested/AGENTS.md',
      'nested/deep/GEMINI.md',
      'CLAUDE.local.md',
    ]);

    expect(issues).toHaveLength(4);
    for (const issue of issues) {
      expect(issue.code).toBe('PACKAGED_AGENT_INSTRUCTION_FILE');
      expect(issue.severity).toBe('warning');
    }
    expect(issues.map(i => i.location).sort((a, b) => String(a).localeCompare(String(b)))).toEqual([
      'CLAUDE.local.md',
      'CLAUDE.md',
      'nested/AGENTS.md',
      'nested/deep/GEMINI.md',
    ]);
  });

  it('reports nothing for a clean tree', () => {
    expect(scan(['SKILL.md', 'resources/guide.md', 'README.md'])).toEqual([]);
  });

  it('does not match a doc that merely starts with an agent-instruction name', () => {
    // `CLAUDE-setup.md` is ordinary content; only exact basenames are guidance.
    expect(scan(['CLAUDE-setup.md', 'docs/AGENTS-overview.md'])).toEqual([]);
  });

  it('anchors locations to the supplied root, not the scanned directory', () => {
    // The plugin lane scans <marketplace>/plugins/<name> but anchors issues at
    // the run root, so the reported path must be reachable by the reader.
    const root = getTempDir();
    const pluginDir = safePath.join(root, 'plugins', 'demo');
    mkdirSyncReal(pluginDir, { recursive: true });
    writeFileSync(safePath.join(pluginDir, 'CLAUDE.md'), '# guidance\n');

    const issues = detectPackagedAgentInstructionFiles(pluginDir, root);

    expect(issues).toHaveLength(1);
    expect(issues[0]?.location).toBe('plugins/demo/CLAUDE.md');
  });

  it('returns an empty list for a directory that does not exist', () => {
    const missing = safePath.join(getTempDir(), 'not-there');
    expect(detectPackagedAgentInstructionFiles(missing, missing)).toEqual([]);
  });
});
