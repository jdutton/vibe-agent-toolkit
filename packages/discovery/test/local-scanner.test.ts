/* eslint-disable security/detect-non-literal-fs-filename -- test file uses controlled temp directory */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { normalizedTmpdir } from '@vibe-agent-toolkit/utils';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';


import { scan } from '../src/scanners/local-scanner.js';

describe('scan', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(normalizedTmpdir(), 'discovery-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should scan single SKILL.md file', async () => {
    const skillPath = path.join(tempDir, 'SKILL.md');
    fs.writeFileSync(skillPath, '# Test Skill');

    const result = await scan({ path: skillPath });

    expect(result.totalScanned).toBe(1);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.format).toBe('claude-skill');
    expect(result.results[0]?.path).toBe(skillPath);
  });

  it('should scan directory non-recursively', async () => {
    fs.writeFileSync(path.join(tempDir, 'SKILL.md'), '# Skill');
    fs.writeFileSync(path.join(tempDir, 'README.md'), '# Readme');
    fs.mkdirSync(path.join(tempDir, 'sub'));
    fs.writeFileSync(path.join(tempDir, 'sub', 'agent.yaml'), 'name: test');

    const result = await scan({ path: tempDir, recursive: false });

    expect(result.totalScanned).toBe(2);
    expect(result.byFormat['claude-skill']).toBe(1);
    expect(result.byFormat['markdown']).toBe(1);
  });

  it('should scan directory recursively', async () => {
    fs.writeFileSync(path.join(tempDir, 'SKILL.md'), '# Skill');
    fs.mkdirSync(path.join(tempDir, 'sub'));
    fs.writeFileSync(path.join(tempDir, 'sub', 'agent.yaml'), 'name: test');

    const result = await scan({ path: tempDir, recursive: true });

    expect(result.totalScanned).toBe(2);
    expect(result.byFormat['claude-skill']).toBe(1);
    expect(result.byFormat['vat-agent']).toBe(1);
  });

  it('should respect include patterns', async () => {
    fs.writeFileSync(path.join(tempDir, 'test.md'), '# Test');
    fs.writeFileSync(path.join(tempDir, 'test.ts'), 'code');

    const result = await scan({
      path: tempDir,
      include: ['*.md']
    });

    expect(result.totalScanned).toBe(1);
    expect(result.results[0]?.format).toBe('markdown');
  });

  it('should respect exclude patterns', async () => {
    fs.mkdirSync(path.join(tempDir, 'node_modules'));
    fs.writeFileSync(path.join(tempDir, 'README.md'), '# Readme');
    fs.writeFileSync(path.join(tempDir, 'node_modules', 'pkg.md'), '# Pkg');

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

    fs.writeFileSync(path.join(tempDir, '.gitignore'), 'dist/\n');
    fs.mkdirSync(path.join(tempDir, 'dist'));
    fs.writeFileSync(path.join(tempDir, 'dist', 'SKILL.md'), '# Built');
    fs.writeFileSync(path.join(tempDir, 'SKILL.md'), '# Source');

    const result = await scan({ path: tempDir, recursive: true });

    expect(result.totalScanned).toBe(2);
    expect(result.sourceFiles).toHaveLength(1);
    expect(result.buildOutputs).toHaveLength(1);
    expect(result.sourceFiles[0]?.relativePath).toBe('SKILL.md');
  });
});
