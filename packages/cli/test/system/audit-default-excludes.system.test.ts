/**
 * System tests for vat audit default artifact excludes.
 *
 * Verifies that vat audit does NOT descend into node_modules/, dist/, or
 * .claude/worktrees/ by default. `--include-artifacts` opts back into the
 * GITIGNORED territory the `crawl` lane can see (`dist/`), and no further:
 * `node_modules/` and `.claude/worktrees/` are on the lane's never-crawl list
 * (`NEVER_CRAWL_GLOBS`), which no flag lifts. The audit used to carry its own
 * walk that honoured no such list, so the flag once meant "walk everything";
 * it now means what it says — include the artifacts git told us to ignore.
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
  fs.mkdirSync(rootDir, { recursive: true });

  // Initialize a git repo so gitignore-aware scanning works
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
    fs.mkdirSync(skillDir, { recursive: true });
    writeTestFile(safePath.join(skillDir, 'SKILL.md'), skillBody);
  }

  return rootDir;
}

/**
 * `path` in audit output is relative to the run root stated once at the top of
 * the report, so a `dist/` entry reads `dist/...` with no leading separator.
 * Match the segment rather than an absolute-path substring.
 */
const DIST_SEGMENT = /(?:^|\/)dist\//;

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
    expect(paths.some(p => DIST_SEGMENT.test(p))).toBe(false);
    expect(paths.some(p => p.includes('.claude/worktrees'))).toBe(false);
  });

  it('--include-artifacts scans dist, and still never node_modules or a worktree', async () => {
    const rootDir = buildProject(tempDir, 'exclude-opt-in');
    const { result, parsed } = await executeCliAndParseYaml(binPath, [
      'audit',
      '--include-artifacts',
      rootDir,
    ]);

    expect(result.status).toBe(0);
    // The source skill and its gitignored dist/ mirror — 2, not 4: the two
    // copies under never-crawl directories stay out whatever the flag says.
    expect(parsed['summary']).toMatchObject({ filesScanned: 2 });

    const files = parsed['files'] as Array<{ path: string }>;
    const paths = files.map(f => f.path);
    expect(paths.some(p => DIST_SEGMENT.test(p))).toBe(true);
    expect(paths.some(p => p.includes('node_modules'))).toBe(false);
    expect(paths.some(p => p.includes('.claude/worktrees'))).toBe(false);
  });

  it('--exclude adds to default excludes (does not replace them)', async () => {
    const rootDir = buildProject(tempDir, 'exclude-additive');
    // Add one extra skill in an unusual location.
    const customDir = safePath.join(rootDir, 'vendor/skill-copy');
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
