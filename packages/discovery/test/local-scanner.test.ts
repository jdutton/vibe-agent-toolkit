/* eslint-disable security/detect-non-literal-fs-filename -- test file uses controlled temp directory */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';

import { setupSyncTempDirSuite, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';


import { scan } from '../src/scanners/local-scanner.js';

describe('scan', () => {
  const suite = setupSyncTempDirSuite('discovery');
  let tempDir: string;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);

  beforeEach(() => {
    suite.beforeEach();
    tempDir = suite.getTempDir();
  });

  it('should scan single SKILL.md file', async () => {
    const skillPath = safePath.join(tempDir, 'SKILL.md');
    fs.writeFileSync(skillPath, '# Test Skill');

    const result = await scan({ path: skillPath });

    expect(result.totalScanned).toBe(1);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.format).toBe('agent-skill');
    expect(result.results[0]?.path).toBe(skillPath);
  });

  it('should scan directory non-recursively', async () => {
    fs.writeFileSync(safePath.join(tempDir, 'SKILL.md'), '# Skill');
    fs.writeFileSync(safePath.join(tempDir, 'README.md'), '# Readme');
    fs.mkdirSync(safePath.join(tempDir, 'sub'));
    fs.writeFileSync(safePath.join(tempDir, 'sub', 'agent.yaml'), 'name: test');

    const result = await scan({ path: tempDir, recursive: false });

    expect(result.totalScanned).toBe(2);
    expect(result.byFormat['agent-skill']).toBe(1);
    expect(result.byFormat['markdown']).toBe(1);
  });

  it('should scan directory recursively', async () => {
    fs.writeFileSync(safePath.join(tempDir, 'SKILL.md'), '# Skill');
    fs.mkdirSync(safePath.join(tempDir, 'sub'));
    fs.writeFileSync(safePath.join(tempDir, 'sub', 'agent.yaml'), 'name: test');

    const result = await scan({ path: tempDir, recursive: true });

    expect(result.totalScanned).toBe(2);
    expect(result.byFormat['agent-skill']).toBe(1);
    expect(result.byFormat['vat-agent']).toBe(1);
  });

  it('should respect include patterns', async () => {
    fs.writeFileSync(safePath.join(tempDir, 'test.md'), '# Test');
    fs.writeFileSync(safePath.join(tempDir, 'test.ts'), 'code');

    const result = await scan({
      path: tempDir,
      include: ['*.md']
    });

    expect(result.totalScanned).toBe(1);
    expect(result.results[0]?.format).toBe('markdown');
  });

  it('should respect exclude patterns', async () => {
    fs.mkdirSync(safePath.join(tempDir, 'node_modules'));
    fs.writeFileSync(safePath.join(tempDir, 'README.md'), '# Readme');
    fs.writeFileSync(safePath.join(tempDir, 'node_modules', 'pkg.md'), '# Pkg');

    const result = await scan({
      path: tempDir,
      recursive: true,
      exclude: ['**/node_modules/**']
    });

    expect(result.totalScanned).toBe(1);
    expect(result.results[0]?.relativePath).toBe('README.md');
  });

  it('should detect gitignored files', async () => {
    // Initialize git repo for git check-ignore to work
    const gitPath = 'git';
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- test setup uses git from PATH
    spawnSync(gitPath, ['init'], { cwd: tempDir, stdio: 'pipe' });
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- test setup uses git from PATH
    spawnSync(gitPath, ['config', 'user.email', 'test@example.com'], { cwd: tempDir, stdio: 'pipe' });
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- test setup uses git from PATH
    spawnSync(gitPath, ['config', 'user.name', 'Test User'], { cwd: tempDir, stdio: 'pipe' });

    fs.writeFileSync(safePath.join(tempDir, '.gitignore'), 'dist/\n');
    fs.mkdirSync(safePath.join(tempDir, 'dist'));
    fs.writeFileSync(safePath.join(tempDir, 'dist', 'SKILL.md'), '# Built');
    fs.writeFileSync(safePath.join(tempDir, 'SKILL.md'), '# Source');

    const result = await scan({ path: tempDir, recursive: true });

    // `.gitignore` is scanned too: the crawler no longer refuses to see paths
    // whose segments begin with a dot. That is the point — it is what lets
    // discovery reach `.claude/skills/` (asserted below) — and callers narrow
    // the result with `include` patterns anyway.
    expect(result.totalScanned).toBe(3);
    expect(result.sourceFiles).toHaveLength(2);
    expect(result.buildOutputs).toHaveLength(1);
    expect(result.sourceFiles.map((f) => f.relativePath).sort((a, b) => a.localeCompare(b))).toEqual(
      ['.gitignore', 'SKILL.md']
    );
  });

  it('discovers a skill inside a dot-directory', async () => {
    fs.mkdirSync(safePath.join(tempDir, '.claude', 'skills', 'house'), { recursive: true });
    fs.writeFileSync(safePath.join(tempDir, '.claude', 'skills', 'house', 'SKILL.md'), '# House');

    const result = await scan({ path: tempDir, recursive: true, include: ['**/SKILL.md'] });

    expect(result.results.map((r) => toForwardSlash(r.relativePath))).toEqual([
      '.claude/skills/house/SKILL.md',
    ]);
    expect(result.results[0]?.format).toBe('agent-skill');
  });
});
