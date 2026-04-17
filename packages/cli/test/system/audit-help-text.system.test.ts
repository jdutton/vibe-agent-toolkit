/* eslint-disable sonarjs/no-os-command-from-path -- node is required for CLI system tests */
/**
 * System tests for `vat audit --help` text.
 *
 * Asserts help output names CLAUDE_CONFIG_DIR and the new COMPAT_* codes
 * after the retirement of SKILL_CONSOLE_INCOMPATIBLE.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { getBinPath } from './test-common.js';

const binPath = getBinPath(import.meta.url);

describe('vat audit --help', () => {
  it('mentions CLAUDE_CONFIG_DIR as the override for --user scope', () => {
    const result = spawnSync('node', [binPath, 'audit', '--help'], { encoding: 'utf-8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/CLAUDE_CONFIG_DIR/);
    expect(result.stdout).toMatch(/default:\s*(\$CLAUDE_CONFIG_DIR or )?~\/\.claude/i);
  });

  it('mentions the new COMPAT_* codes in the warnings section', () => {
    const result = spawnSync('node', [binPath, 'audit', '--help'], { encoding: 'utf-8' });
    expect(result.stdout).toMatch(/COMPAT_REQUIRES_/);
  });

  it('no longer mentions the retired SKILL_CONSOLE_INCOMPATIBLE', () => {
    const result = spawnSync('node', [binPath, 'audit', '--help'], { encoding: 'utf-8' });
    expect(result.stdout).not.toMatch(/SKILL_CONSOLE_INCOMPATIBLE/);
  });
});

const docsDir = safePath.resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs');

describe('packages/cli/docs/audit.md', () => {
  const docPath = safePath.resolve(docsDir, 'audit.md');

  it('documents the CLAUDE_CONFIG_DIR multi-dir pattern', () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test reads a repo-relative docs file
    const doc = readFileSync(docPath, 'utf-8');
    expect(doc).toMatch(/Multi-dir Workflows/);
    expect(doc).toMatch(/CLAUDE_CONFIG_DIR/);
    expect(doc).toMatch(/for dir in/);
  });

  it('references the new COMPAT_* codes in the Skill Warnings table', () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test reads a repo-relative docs file
    const doc = readFileSync(docPath, 'utf-8');
    expect(doc).toMatch(/COMPAT_REQUIRES_BROWSER_AUTH/);
    expect(doc).toMatch(/COMPAT_REQUIRES_LOCAL_SHELL/);
    expect(doc).toMatch(/COMPAT_REQUIRES_EXTERNAL_CLI/);
    expect(doc).not.toMatch(/SKILL_CONSOLE_INCOMPATIBLE/);
  });
});
