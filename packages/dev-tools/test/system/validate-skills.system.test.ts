/**
 * System tests for validate-skills script
 * Tests the script as it would be executed in real usage
 * These tests primarily exist to improve coverage of the main execution wrapper
 */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('validate-skills script (system test)', () => {
  // Use relative path to avoid PATH security issues
  const projectRoot = process.cwd();
  const scriptPath = join(projectRoot, 'packages/dev-tools/src/validate-skills.ts');

  it('should execute successfully on the project', () => {
    // Execute the script on the current project
    // This exercises the main execution wrapper that isn't covered by unit tests
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- Using bun from PATH in test environment is safe
    const result = spawnSync('bun', ['run', scriptPath, projectRoot], {
      encoding: 'utf-8',
      cwd: projectRoot,
    });

    // Script should execute (exit code 0 = success, 1 = validation errors)
    expect([0, 1]).toContain(result.status);

    // Should produce output
    expect(result.stdout.length).toBeGreaterThan(0);

    // Should show validation progress
    expect(result.stdout).toContain('Validating');
  });
});
