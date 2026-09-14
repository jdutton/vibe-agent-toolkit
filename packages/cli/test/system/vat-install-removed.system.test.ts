import { spawnSync } from 'node:child_process';

import { safePath } from '@vibe-agent-toolkit/utils';
import { NODE_EXECUTABLE } from '@vibe-agent-toolkit/utils/testing';
import { describe, expect, it } from 'vitest';

const binPath = safePath.resolve(import.meta.dirname, '../../dist/bin/vat.js');

describe('vat install is removed', () => {
  it('vat install is not recognized as a valid subcommand', () => {
    const result = spawnSync(NODE_EXECUTABLE, [binPath, 'install', './some-path', '--target', 'claude', '--scope', 'user'], {
      encoding: 'utf-8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('install');
  });

  it('vat install ./foo exits with a non-zero status', () => {
    const result = spawnSync(NODE_EXECUTABLE, [binPath, 'install', './foo'], {
      encoding: 'utf-8',
    });
    expect(result.status).not.toBe(0);
  });
});
