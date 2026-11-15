import { NODE_EXECUTABLE } from '@vibe-agent-toolkit/utils/testing';
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
    const result = spawnSync(NODE_EXECUTABLE, [wrapperPath, '--version'], {
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

    const result = spawnSync(NODE_EXECUTABLE, [wrapperPath, '--version'], {
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

    const result = spawnSync(NODE_EXECUTABLE, [wrapperPath, '--version'], {
      encoding: 'utf-8',
      cwd: projectDir,
    });

    // Should still work (falls back to global)
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/\d{1,9}\.\d{1,9}\.\d{1,9}/);
  });

  it('should fall back to global context', () => {
    const result = spawnSync(NODE_EXECUTABLE, [wrapperPath, '--version'], {
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
    const result = spawnSync(NODE_EXECUTABLE, [wrapperPath, '--help'], {
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage:');
    expect(result.stdout).toContain('vat');
  });

  it('should handle unknown commands through wrapper', () => {
    const result = spawnSync(NODE_EXECUTABLE, [wrapperPath, 'unknown-command'], {
      encoding: 'utf-8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('unknown');
  });
});

/** Write a stub `bin.js` under `dir` that prints `marker` and exits 0. */
function writeStubBin(dir: string, name: string, marker: string): string {
  const binPath = safePath.join(dir, name);
  fs.writeFileSync(binPath, `process.stdout.write(${JSON.stringify(marker)} + '\\n');\n`);
  return binPath;
}

/** Run the wrapper with `VAT_BIN` pinned to `binPath` and `VAT_ROOT_DIR` cleared. */
function runWrapperWithBin(binPath: string): ReturnType<typeof spawnSync> {
  return spawnSync(NODE_EXECUTABLE, [wrapperPath], {
    encoding: 'utf-8',
    env: { ...process.env, VAT_BIN: binPath, VAT_ROOT_DIR: undefined },
  });
}

/**
 * `VAT_BIN` / `VAT_ROOT_DIR` are explicit overrides: a named target that cannot
 * be run is a hard error (exit 2), never a silent fall-through to whatever
 * resolution would otherwise have picked. `writeStubBin` produces a script that
 * proves WHICH override actually ran (a wrapper spawning the wrong target, or
 * falling through past a bad one, still exits 0 — only the marker tells them
 * apart).
 */
describe('VAT_BIN / VAT_ROOT_DIR overrides (system test)', () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = createTestTempDir('vat-override-test-');
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('runs the bin.js VAT_BIN names', () => {
    const binPath = writeStubBin(tempDir, 'vat-bin-stub.js', 'VAT_BIN_MARKER');

    const result = runWrapperWithBin(binPath);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('VAT_BIN_MARKER');
  });

  it('refuses a VAT_BIN that does not exist', () => {
    const missingPath = safePath.join(tempDir, 'does-not-exist.js');

    const result = spawnSync(NODE_EXECUTABLE, [wrapperPath], {
      encoding: 'utf-8',
      env: { ...process.env, VAT_BIN: missingPath, VAT_ROOT_DIR: undefined },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('VAT_BIN');
    expect(result.stderr).toContain(missingPath);
    expect(result.stdout).toBe('');
  });

  it('refuses VAT_BIN naming the wrapper', () => {
    const repoRoot = safePath.resolve(__dirname, '../../../..');
    const wrapperTarget = safePath.join(repoRoot, 'packages/cli/dist/bin/vat.js');

    const result = spawnSync(NODE_EXECUTABLE, [wrapperPath], {
      encoding: 'utf-8',
      env: { ...process.env, VAT_BIN: wrapperTarget, VAT_ROOT_DIR: undefined },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('VAT_BIN');
    expect(result.stderr).toContain('wrapper');
  });

  it('refuses a VAT_ROOT_DIR with no built CLI', () => {
    const result = spawnSync(NODE_EXECUTABLE, [wrapperPath], {
      encoding: 'utf-8',
      env: { ...process.env, VAT_ROOT_DIR: tempDir, VAT_BIN: undefined },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('VAT_ROOT_DIR');
    expect(result.stderr).toContain(safePath.join(tempDir, 'packages/cli/dist/bin.js'));
    expect(result.stdout).toBe('');
  });

  it('prefers VAT_BIN over VAT_ROOT_DIR', () => {
    const binPath = writeStubBin(tempDir, 'vat-bin-precedence-stub.js', 'VAT_BIN_WINS_MARKER');
    const repoRoot = safePath.resolve(__dirname, '../../../..');

    const result = spawnSync(NODE_EXECUTABLE, [wrapperPath], {
      encoding: 'utf-8',
      env: { ...process.env, VAT_BIN: binPath, VAT_ROOT_DIR: repoRoot },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('VAT_BIN_WINS_MARKER');
  });

  it('passes the repo root, not packages/, as VAT_CONTEXT_PATH', () => {
    const fakeRoot = safePath.join(tempDir, 'fake-root');
    const fakeDistDir = safePath.join(fakeRoot, 'packages/cli/dist');
    fs.mkdirSync(fakeDistDir, { recursive: true });
    const binPath = safePath.join(fakeDistDir, 'bin.js');
    fs.writeFileSync(binPath, `process.stdout.write((process.env.VAT_CONTEXT_PATH ?? '') + '\\n');\n`);

    const result = runWrapperWithBin(binPath);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(fakeRoot);
  });
});
