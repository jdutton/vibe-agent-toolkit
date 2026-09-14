/**
 * System tests for `vat audit --help` text.
 *
 * Asserts help output names CLAUDE_CONFIG_DIR and the capability / compat
 * codes the registry emits (`CAPABILITY_*`, `COMPAT_TARGET_*`) — not the
 * retired SKILL_CONSOLE_INCOMPATIBLE, nor a COMPAT_REQUIRES_* spelling the
 * registry never carried.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { safePath } from '@vibe-agent-toolkit/utils';
import { NODE_EXECUTABLE } from '@vibe-agent-toolkit/utils/testing';
import { describe, expect, it } from 'vitest';

import { getBinPath } from './test-common.js';

const binPath = getBinPath(import.meta.url);

function runAuditHelp(): string {
  const result = spawnSync(NODE_EXECUTABLE, [binPath, 'audit', '--help'], { encoding: 'utf-8' });
  expect(result.status).toBe(0);
  return result.stdout;
}

describe('vat audit --help', () => {
  it('mentions CLAUDE_CONFIG_DIR as the override for --user scope', () => {
    const help = runAuditHelp();
    expect(help).toMatch(/CLAUDE_CONFIG_DIR/);
    expect(help).toMatch(/default:\s*(\$CLAUDE_CONFIG_DIR or )?~\/\.claude/i);
  });

  it('names the capability observations and the --compat verdict codes', () => {
    const help = runAuditHelp();
    expect(help).toMatch(/CAPABILITY_LOCAL_SHELL/);
    expect(help).toMatch(/COMPAT_TARGET_NEEDS_REVIEW/);
  });

  it('no longer mentions the retired SKILL_CONSOLE_INCOMPATIBLE', () => {
    expect(runAuditHelp()).not.toMatch(/SKILL_CONSOLE_INCOMPATIBLE/);
  });
});

const docsDir = safePath.resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs');

describe('packages/cli/docs/audit.md', () => {
  const docPath = safePath.resolve(docsDir, 'audit.md');

  it('documents the CLAUDE_CONFIG_DIR multi-dir pattern', () => {
    const doc = readFileSync(docPath, 'utf-8');
    expect(doc).toMatch(/Multi-dir Workflows/);
    expect(doc).toMatch(/CLAUDE_CONFIG_DIR/);
    expect(doc).toMatch(/for dir in/);
  });

  it('references the capability and compat codes the registry actually emits', () => {
    const doc = readFileSync(docPath, 'utf-8');
    expect(doc).toMatch(/CAPABILITY_BROWSER_AUTH/);
    expect(doc).toMatch(/CAPABILITY_LOCAL_SHELL/);
    expect(doc).toMatch(/CAPABILITY_EXTERNAL_CLI/);
    expect(doc).toMatch(/COMPAT_TARGET_INCOMPATIBLE/);
    expect(doc).toMatch(/COMPAT_TARGET_NEEDS_REVIEW/);
    // Retired spellings: the registry never carried them.
    expect(doc).not.toMatch(/COMPAT_REQUIRES_/);
    expect(doc).not.toMatch(/SKILL_CONSOLE_INCOMPATIBLE/);
  });

  it('--help names the same capability and compat codes as the doc', () => {
    const help = runAuditHelp();
    expect(help).toMatch(/CAPABILITY_BROWSER_AUTH/);
    expect(help).toMatch(/COMPAT_TARGET_INCOMPATIBLE/);
    expect(help).not.toMatch(/COMPAT_REQUIRES_/);
  });
});
