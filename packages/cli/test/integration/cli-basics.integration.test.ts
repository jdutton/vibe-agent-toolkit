import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const binPath = resolve(__dirname, '../../dist/bin.js');

describe('CLI basics (integration)', () => {
  it('should show version', () => {
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- node is required for CLI integration tests
    const result = spawnSync('node', [binPath, '--version'], {
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('should show help', () => {
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- node is required for CLI integration tests
    const result = spawnSync('node', [binPath, '--help'], {
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('vat');
    expect(result.stdout).toContain('Usage:');
  });

  it('should handle unknown commands', () => {
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- node is required for CLI integration tests
    const result = spawnSync('node', [binPath, 'unknown'], {
      encoding: 'utf-8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('unknown command');
  });
});
