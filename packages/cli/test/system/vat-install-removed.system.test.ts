import { spawnSync } from 'node:child_process';

import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

const binPath = safePath.resolve(import.meta.dirname, '../../dist/bin/vat.js');

describe('vat install is removed', () => {
  it('vat install is not recognized as a valid subcommand', () => {
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- node is trusted in tests
    const result = spawnSync('node', [binPath, 'install', './some-path', '--target', 'claude', '--scope', 'user'], {
      encoding: 'utf-8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('install');
  });

  it('vat install ./foo exits with a non-zero status', () => {
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- node is trusted in tests
    const result = spawnSync('node', [binPath, 'install', './foo'], {
      encoding: 'utf-8',
    });
    expect(result.status).not.toBe(0);
  });
});
