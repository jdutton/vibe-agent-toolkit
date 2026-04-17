/* eslint-disable sonarjs/no-os-command-from-path -- node is required for CLI system tests */
/**
 * System test: vat audit --user honors CLAUDE_CONFIG_DIR end-to-end.
 *
 * Creates a synthetic Claude config directory with a marker skill,
 * invokes `vat audit --user` with CLAUDE_CONFIG_DIR overridden to the
 * synthetic dir, and asserts the marker skill appears in the YAML output.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getBinPath } from './test-common.js';

const binPath = getBinPath(import.meta.url);

describe('vat audit --user honors CLAUDE_CONFIG_DIR', () => {
  let overrideDir: string;

  beforeAll(() => {
    overrideDir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-claude-cfg-'));
    const skillDir = safePath.join(overrideDir, 'skills', 'marker-skill');
    mkdirSyncReal(skillDir, { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- tmpdir-derived path
    writeFileSync(
      safePath.join(skillDir, 'SKILL.md'),
      [
        '---',
        'name: marker-skill',
        'description: Marker skill used by the CLAUDE_CONFIG_DIR system test to prove --user scanned the override directory, not the callers real home.',
        '---',
        '',
        'Body.',
        '',
      ].join('\n'),
    );
  });

  afterAll(() => {
    rmSync(overrideDir, { recursive: true, force: true });
  });

  it('scans the override directory and finds the marker skill', () => {
    const result = spawnSync('node', [binPath, 'audit', '--user', '--verbose'], {
      encoding: 'utf-8',
      env: { ...process.env, CLAUDE_CONFIG_DIR: overrideDir },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('marker-skill');
    // Ensure we scanned the override tmpdir, not the runner's real ~/.claude
    expect(result.stdout).toContain(overrideDir);
  });
});
