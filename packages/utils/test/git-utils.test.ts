import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { isGitIgnored } from '../src/git-utils.js';

const GITIGNORE_FILENAME = '.gitignore';

describe('isGitIgnored', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-utils-test-'));
    // Initialize git repo for git check-ignore to work
    const gitPath = 'git'; // Using command name directly in tests is acceptable
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- test setup uses git from PATH
    spawnSync(gitPath, ['init'], { cwd: tempDir, stdio: 'pipe' });
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- test setup uses git from PATH
    spawnSync(gitPath, ['config', 'user.email', 'test@example.com'], { cwd: tempDir, stdio: 'pipe' });
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- test setup uses git from PATH
    spawnSync(gitPath, ['config', 'user.name', 'Test User'], { cwd: tempDir, stdio: 'pipe' });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should return true for gitignored file', () => {
    // Create .gitignore
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test file uses controlled temp directory
    fs.writeFileSync(path.join(tempDir, GITIGNORE_FILENAME), 'node_modules/\n');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test file uses controlled temp directory
    fs.mkdirSync(path.join(tempDir, 'node_modules'));

    const result = isGitIgnored(path.join(tempDir, 'node_modules', 'test.js'), tempDir);

    expect(result).toBe(true);
  });

  it('should return false for non-gitignored file', () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test file uses controlled temp directory
    fs.writeFileSync(path.join(tempDir, GITIGNORE_FILENAME), 'node_modules/\n');

    const result = isGitIgnored(path.join(tempDir, 'src', 'test.js'), tempDir);

    expect(result).toBe(false);
  });

  it('should handle absolute paths', () => {
    const gitignorePath = path.join(tempDir, GITIGNORE_FILENAME);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test file uses controlled temp directory
    fs.writeFileSync(gitignorePath, '.worktrees/\n');

    const result = isGitIgnored(path.join(tempDir, '.worktrees', 'feat'), tempDir);

    expect(result).toBe(true);
  });
});
