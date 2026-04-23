/**
 * System tests for vat audit default artifact excludes.
 *
 * Verifies that vat audit does NOT descend into node_modules/, dist/, or
 * .claude/worktrees/ by default. The --include-artifacts flag opts back in.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  cleanupTestTempDir,
  createTestTempDir,
  executeCliAndParseYaml,
  getBinPath,
  writeTestFile,
} from './test-common.js';

// Build a project with: one real skill under skills/, a mirror under
// dist/, and a bundled-dep copy under node_modules/. The source skill
// has no issues; the artifact copies would produce duplicate/noisy
// validation output if scanned.
function buildProject(parentDir: string, rootName: string): string {
  const rootDir = safePath.join(parentDir, rootName);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- controlled test path
  fs.mkdirSync(rootDir, { recursive: true });

  // Initialize a git repo so gitignore-aware scanning works
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- git is required for gitignore tests
  spawnSync('git', ['init'], { cwd: rootDir, stdio: 'pipe' });

  // Create .gitignore to mark artifact directories
  writeTestFile(
    safePath.join(rootDir, '.gitignore'),
    'dist/\nnode_modules/\n.claude/worktrees/\n'
  );

  const skillBody = `---
name: hello-skill
description: Says hello from a bash command inside a fenced block to demonstrate artifact exclusion behavior.
---

# Hello

\`\`\`bash
echo hello
\`\`\`
`;

  for (const relSkillDir of [
    'skills/hello',
    'dist/skills/hello',
    'node_modules/fake-pkg/skill',
    '.claude/worktrees/wt-abc/skills/hello',
  ]) {
    const skillDir = safePath.join(rootDir, relSkillDir);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- controlled test path
    fs.mkdirSync(skillDir, { recursive: true });
    writeTestFile(safePath.join(skillDir, 'SKILL.md'), skillBody);
  }

  return rootDir;
}

describe('Audit default artifact excludes (system test)', () => {
  let binPath: string;
  let tempDir: string;

  beforeAll(() => {
    binPath = getBinPath(import.meta.url);
    tempDir = createTestTempDir('vat-audit-defexc-');
  });

  afterAll(() => {
    cleanupTestTempDir(tempDir);
  });

  it('excludes node_modules, dist, and .claude/worktrees by default', async () => {
    const rootDir = buildProject(tempDir, 'exclude-defaults');
    const { result, parsed } = await executeCliAndParseYaml(binPath, ['audit', rootDir]);

    expect(result.status).toBe(0);
    // Only the source skill should be scanned — 1 file, not 4.
    expect(parsed['summary']).toMatchObject({ filesScanned: 1 });

    const files = parsed['files'] as Array<{ path: string }>;
    const paths = files.map(f => f.path);
    expect(paths).toEqual([
      expect.stringContaining('skills/hello/SKILL.md'),
    ]);
    expect(paths.some(p => p.includes('node_modules'))).toBe(false);
    expect(paths.some(p => p.includes('/dist/'))).toBe(false);
    expect(paths.some(p => p.includes('.claude/worktrees'))).toBe(false);
  });

  it('--include-artifacts scans node_modules and dist', async () => {
    const rootDir = buildProject(tempDir, 'exclude-opt-in');
    const { result, parsed } = await executeCliAndParseYaml(binPath, [
      'audit',
      '--include-artifacts',
      rootDir,
    ]);

    expect(result.status).toBe(0);
    // All four skill copies get scanned when the flag is set.
    expect(parsed['summary']).toMatchObject({ filesScanned: 4 });

    const files = parsed['files'] as Array<{ path: string }>;
    const paths = files.map(f => f.path);
    expect(paths.some(p => p.includes('node_modules'))).toBe(true);
    expect(paths.some(p => p.includes('/dist/'))).toBe(true);
    expect(paths.some(p => p.includes('.claude/worktrees'))).toBe(true);
  });

  it('--exclude adds to default excludes (does not replace them)', async () => {
    const rootDir = buildProject(tempDir, 'exclude-additive');
    // Add one extra skill in an unusual location.
    const customDir = safePath.join(rootDir, 'vendor/skill-copy');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- controlled test path
    fs.mkdirSync(customDir, { recursive: true });
    writeTestFile(
      safePath.join(customDir, 'SKILL.md'),
      `---
name: vendor-skill
description: A vendored skill copy that should be excluded when the user adds it to --exclude.
---

# Vendor
`
    );

    const { result, parsed } = await executeCliAndParseYaml(binPath, [
      'audit',
      '--exclude',
      '**/vendor/**',
      rootDir,
    ]);

    expect(result.status).toBe(0);
    // Still only the real source skill — defaults AND user exclude applied.
    expect(parsed['summary']).toMatchObject({ filesScanned: 1 });
  });
});
