import { it, beforeAll, afterAll } from 'vitest';

import {
  describe,
  dirname,
  expect,
  fileURLToPath,
  fs,
  getWrapperPath,
  safePath,
  spawnSync,
} from './test-common.js';
import { createTestTempDir, setupTestProject } from './test-helpers/index.js';

const wrapperPath = getWrapperPath(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * The provenance line `--version` now always prints.
 *
 * Adopter finding B9: the `-dev (<path>)` suffix is CWD-derived, so the same
 * branch build invoked by absolute path from an adopter checkout resolved
 * `Context: global` and printed a bare `0.1.41-rc.8` — byte-identical to the
 * released rc.8. The resolved binary path is the one fact that always differs,
 * so it is printed unconditionally rather than only under `VAT_DEBUG=1`.
 */
const BINARY_LINE = /binary: .*[/\\]dist[/\\]bin\.js/;

describe('Context detection (system test)', () => {
  let tempDir: string;
  let projectDir: string;

  beforeAll(() => {
    tempDir = createTestTempDir('vat-context-test-');
    projectDir = setupTestProject(tempDir, {
      name: 'test-project',
    });
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should detect dev context via VAT_ROOT_DIR', () => {
    const repoRoot = safePath.resolve(__dirname, '../../../..');
    const result = spawnSync('node', [wrapperPath, '--version'], {
      encoding: 'utf-8',
      env: { ...process.env, VAT_ROOT_DIR: repoRoot },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('-dev');
    expect(result.stdout).toContain(repoRoot);
    expect(result.stdout).toMatch(BINARY_LINE);
  });

  it('should detect dev context when running from repo', () => {
    // Skip if not in actual repo
    const repoRoot = safePath.resolve(__dirname, '../../../..');
    const wrapperExists = fs.existsSync(safePath.join(repoRoot, 'vibe-agent-toolkit/bin/vat'));

    if (!wrapperExists) {
      console.log('Skipping dev context test - not in repo structure');
      return;
    }

    const result = spawnSync('node', [wrapperPath, '--version'], {
      encoding: 'utf-8',
      cwd: repoRoot,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/\d{1,9}\.\d{1,9}\.\d{1,9}/);
  });

  it('should detect local context when project has node_modules', () => {
    // This test verifies the wrapper logic for local installs
    // In real usage, npm/bun install would set up the full package structure
    // For testing, we just verify the wrapper handles missing local gracefully

    const result = spawnSync('node', [wrapperPath, '--version'], {
      encoding: 'utf-8',
      cwd: projectDir,
    });

    // Should still work (falls back to global)
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/\d{1,9}\.\d{1,9}\.\d{1,9}/);
  });

  it('should fall back to global context', () => {
    const result = spawnSync('node', [wrapperPath, '--version'], {
      encoding: 'utf-8',
      cwd: tempDir, // No project markers
      env: { ...process.env, VAT_ROOT_DIR: undefined },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^\d+\.\d+\.\d+/);
    // The identity check that adopter delta testing depends on: in the global
    // fallback the version line alone cannot distinguish this build from the
    // published one of the same version, so the binary line must be there.
    expect(result.stdout).toMatch(BINARY_LINE);
  });

  it('should pass arguments through wrapper correctly', () => {
    const result = spawnSync('node', [wrapperPath, '--help'], {
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage:');
    expect(result.stdout).toContain('vat');
  });

  it('should handle unknown commands through wrapper', () => {
    const result = spawnSync('node', [wrapperPath, 'unknown-command'], {
      encoding: 'utf-8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('unknown');
  });
});
