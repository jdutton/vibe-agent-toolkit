/**
 * Dogfooding System Tests
 *
 * Tests that audit command can successfully audit the vibe-agent-toolkit project itself,
 * including transitive link traversal on skills with linked markdown files.
 */

import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  cleanupTestTempDir,
  createTestTempDir,
  executeCli,
  executeCliAndParseYaml,
  getBinPath,
} from './test-common.js';

/**
 * Helper to validate audit result expectations
 */
function expectSuccessfulAudit(result: ReturnType<typeof executeCli>): void {
  // Should succeed (exit 0) or fail gracefully
  expect([0, 1]).toContain(result.status);

  // Should produce structured output
  expect(result.stdout).toBeTruthy();

  // Should not crash with unhandled errors
  if (result.status === 2) {
    throw new Error(`Unexpected error: ${result.stderr}`);
  }
}

/**
 * Create a test skill directory with linked markdown files
 */
function createLinkedSkill(baseDir: string): string {
  const skillDir = safePath.join(baseDir, 'test-skill');
  const resourcesDir = safePath.join(skillDir, 'resources');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test directory
  fs.mkdirSync(resourcesDir, { recursive: true });

  // SKILL.md with links to resources
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test file
  fs.writeFileSync(safePath.join(skillDir, 'SKILL.md'), `---
name: test-linked-skill
description: A test skill with linked markdown resources
---

# Test Linked Skill

- [Guide A](resources/guide-a.md)
- [Guide B](resources/guide-b.md)
`);

  // guide-a.md links to guide-c.md (transitive)
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test file
  fs.writeFileSync(safePath.join(resourcesDir, 'guide-a.md'), `# Guide A

See also [Guide C](guide-c.md) for more details.
`);

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test file
  fs.writeFileSync(safePath.join(resourcesDir, 'guide-b.md'), `# Guide B

Standalone reference document.
`);

  // guide-c.md (transitively linked from guide-a)
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test file
  fs.writeFileSync(safePath.join(resourcesDir, 'guide-c.md'), `# Guide C

Deep reference document.
`);

  return skillDir;
}

describe('Audit Dogfooding (system test)', () => {
  let binPath: string;
  let projectRoot: string;
  let tempDir: string;

  beforeAll(() => {
    binPath = getBinPath(import.meta.url);
    // Get project root (4 levels up from test/system/) - use fileURLToPath for cross-platform compatibility
    projectRoot = fileURLToPath(new URL('../../../../', import.meta.url));
    tempDir = createTestTempDir('vat-audit-dogfood-');
  });

  afterAll(() => {
    cleanupTestTempDir(tempDir);
  });

  it('should successfully audit vibe-agent-toolkit project root', () => {
    const result = executeCli(binPath, ['audit', projectRoot], {
      cwd: tempDir,
    });

    expectSuccessfulAudit(result);
  });

  it('should audit dist skills without errors', () => {
    const distSkillsDir = safePath.join(projectRoot, 'packages/vat-development-agents/dist/skills');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- project path
    if (!fs.existsSync(distSkillsDir)) {
      // dist may not exist if build hasn't run — skip gracefully
      return;
    }

    const { result, parsed } = executeCliAndParseYaml(
      binPath,
      ['audit', '--verbose', distSkillsDir],
      { cwd: tempDir },
    );

    expectSuccessfulAudit(result);

    // Should scan multiple skills (we have 5+ dist skills)
    const summary = parsed['summary'] as Record<string, unknown> | undefined;
    expect(summary).toBeDefined();
    const filesScanned = summary?.['filesScanned'] as number | undefined;
    expect(filesScanned).toBeDefined();
    expect(filesScanned).toBeGreaterThan(1);
  });

  describe('link traversal (end-to-end)', () => {
    it('should follow transitive links and report linkedFiles', () => {
      const skillDir = createLinkedSkill(tempDir);
      const skillPath = safePath.join(skillDir, 'SKILL.md');

      const { result, parsed } = executeCliAndParseYaml(
        binPath,
        ['audit', '--verbose', skillPath],
        { cwd: tempDir },
      );

      expect(result.status).toBe(0);
      expect(parsed['status']).toBe('success');

      // Verify linkedFiles are present in the output
      const files = parsed['files'] as Array<Record<string, unknown>> | undefined;
      expect(files).toBeDefined();
      expect(files).toHaveLength(1);

      const skillResult = files?.[0];
      const linkedFiles = skillResult?.['linkedFiles'] as Array<Record<string, unknown>> | undefined;
      expect(linkedFiles).toBeDefined();
      // guide-a, guide-b, and guide-c (transitive from guide-a)
      expect(linkedFiles).toHaveLength(3);

      // Verify transitive link was followed (guide-c is only reachable via guide-a)
      const linkedPaths = linkedFiles?.map(f => String(f['path'])) ?? [];
      expect(linkedPaths.some(p => p.endsWith('guide-c.md'))).toBe(true);
    });

    it('should detect broken links via CLI', () => {
      const brokenDir = safePath.join(tempDir, 'broken-skill');
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- test directory
      fs.mkdirSync(brokenDir, { recursive: true });

      // eslint-disable-next-line security/detect-non-literal-fs-filename -- test file
      fs.writeFileSync(safePath.join(brokenDir, 'SKILL.md'), `---
name: broken-links-skill
description: Skill with broken links
---

# Broken Skill

- [Missing file](does-not-exist.md)
`);

      const { result, parsed } = executeCliAndParseYaml(
        binPath,
        ['audit', safePath.join(brokenDir, 'SKILL.md')],
        { cwd: tempDir },
      );

      expect(result.status).toBe(1);

      const files = parsed['files'] as Array<Record<string, unknown>> | undefined;
      const issues = files?.[0]?.['issues'] as Array<Record<string, unknown>> | undefined;
      expect(issues).toBeDefined();
      expect(issues?.some(i => i['code'] === 'LINK_INTEGRITY_BROKEN')).toBe(true);
    });

    it('should detect unreferenced files with --warn-unreferenced-files', () => {
      const skillDir = createLinkedSkill(tempDir);
      const resourcesDir = safePath.join(skillDir, 'resources');

      // Add an orphaned file not linked from anywhere
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- test file
      fs.writeFileSync(safePath.join(resourcesDir, 'orphan.md'), '# Orphan\n\nNot linked from anywhere.\n');

      const { result, parsed } = executeCliAndParseYaml(
        binPath,
        ['audit', '--warn-unreferenced-files', safePath.join(skillDir, 'SKILL.md')],
        { cwd: tempDir },
      );

      // Should succeed (unreferenced is info, not error)
      expect(result.status).toBe(0);

      const files = parsed['files'] as Array<Record<string, unknown>> | undefined;
      const issues = files?.[0]?.['issues'] as Array<Record<string, unknown>> | undefined;
      expect(issues?.some(i =>
        i['code'] === 'SKILL_UNREFERENCED_FILE' &&
        String(i['message']).includes('orphan.md'),
      )).toBe(true);
    });

    it('should not flag CLAUDE.md or README.md as unreferenced', () => {
      const skillDir = createLinkedSkill(tempDir);

      // Add CLAUDE.md and README.md — should NOT be flagged
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- test file
      fs.writeFileSync(safePath.join(skillDir, 'CLAUDE.md'), '# Claude\n');
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- test file
      fs.writeFileSync(safePath.join(skillDir, 'README.md'), '# Readme\n');

      const { parsed } = executeCliAndParseYaml(
        binPath,
        ['audit', '--warn-unreferenced-files', '--verbose', safePath.join(skillDir, 'SKILL.md')],
        { cwd: tempDir },
      );

      const files = parsed['files'] as Array<Record<string, unknown>> | undefined;
      const issues = files?.[0]?.['issues'] as Array<Record<string, unknown>> | undefined;
      const unreferencedMessages = issues
        ?.filter(i => i['code'] === 'SKILL_UNREFERENCED_FILE')
        ?.map(i => String(i['message'])) ?? [];

      expect(unreferencedMessages.some(m => m.includes('CLAUDE.md'))).toBe(false);
      expect(unreferencedMessages.some(m => m.includes('README.md'))).toBe(false);
    });
  });
});
