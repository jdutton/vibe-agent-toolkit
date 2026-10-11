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
function expectSuccessfulAudit(result: Awaited<ReturnType<typeof executeCli>>): void {
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
  fs.mkdirSync(resourcesDir, { recursive: true });

  // SKILL.md with links to resources
  fs.writeFileSync(safePath.join(skillDir, 'SKILL.md'), `---
name: test-linked-skill
description: A test skill with linked markdown resources
---

# Test Linked Skill

- [Guide A](resources/guide-a.md)
- [Guide B](resources/guide-b.md)
`);

  // guide-a.md links to guide-c.md (transitive)
  fs.writeFileSync(safePath.join(resourcesDir, 'guide-a.md'), `# Guide A

See also [Guide C](guide-c.md) for more details.
`);

  fs.writeFileSync(safePath.join(resourcesDir, 'guide-b.md'), `# Guide B

Standalone reference document.
`);

  // guide-c.md (transitively linked from guide-a)
  fs.writeFileSync(safePath.join(resourcesDir, 'guide-c.md'), `# Guide C

Deep reference document.
`);

  return skillDir;
}

// Windows: vitest singleFork worker IPC times out when this runs as part of the full system test suite
describe.skipIf(process.platform === 'win32')('Audit Dogfooding (system test)', () => {
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

  // Windows CI wedges on a monorepo-wide audit (exact cause not yet root-caused;
  // the 0.1.33 perf sweep reduced but did not eliminate it). Ubuntu CI covers
  // this same path. Re-enable once Windows-audit perf is profiled.
  it.skipIf(process.platform === 'win32')('should successfully audit vibe-agent-toolkit project root', async () => {
    const result = await executeCli(binPath, ['audit', projectRoot], {
      cwd: tempDir,
    });

    expectSuccessfulAudit(result);
  });

  it('should audit dist skills without errors', async () => {
    const distSkillsDir = safePath.join(projectRoot, 'packages/vat-development-agents/dist/skills');
    if (!fs.existsSync(distSkillsDir)) {
      // dist may not exist if build hasn't run — skip gracefully
      return;
    }

    const { result, parsed } = await executeCliAndParseYaml(
      binPath,
      ['audit', '--verbose', distSkillsDir],
      { cwd: tempDir },
    );

    expectSuccessfulAudit(result);

    // Should scan multiple skills (we have 5+ dist skills)
    expect(parsed['examined']).toBeGreaterThan(1);
  });

  describe('link traversal (end-to-end)', () => {
    it('should follow transitive links, reporting a finding in a file only a link reaches', async () => {
      const skillDir = createLinkedSkill(tempDir);
      const skillPath = safePath.join(skillDir, 'SKILL.md');

      // The clean tree is clean.
      const clean = await executeCliAndParseYaml(binPath, ['audit', '--verbose', skillPath], { cwd: tempDir });
      expect(clean.result.status).toBe(0);
      expect(clean.parsed['status']).toBe('ok');
      expect((clean.parsed['data'] as { files: unknown[] }).files).toHaveLength(1);

      // guide-c is reachable ONLY through guide-a: a broken link there is seen
      // only if the traversal followed the transitive link.
      fs.appendFileSync(safePath.join(skillDir, 'resources', 'guide-c.md'), '\nSee [gone](gone.md).\n');
      const { parsed } = await executeCliAndParseYaml(binPath, ['audit', '--verbose', skillPath], { cwd: tempDir });

      const findings = parsed['findings'] as Array<Record<string, unknown>>;
      expect(findings.some((f) => String(f['location']).endsWith('resources/guide-c.md'))).toBe(true);
    });

    it('should detect broken links via CLI', async () => {
      const brokenDir = safePath.join(tempDir, 'broken-skill');
      fs.mkdirSync(brokenDir, { recursive: true });

      fs.writeFileSync(safePath.join(brokenDir, 'SKILL.md'), `---
name: broken-links-skill
description: Skill with broken links
---

# Broken Skill

- [Missing file](does-not-exist.md)
`);

      const { result, parsed } = await executeCliAndParseYaml(
        binPath,
        ['audit', safePath.join(brokenDir, 'SKILL.md')],
        { cwd: tempDir },
      );

      // Exit 1: this tree has an error-severity finding.
      expect(result.status).toBe(1);
      expect(parsed['status']).toBe('findings');

      const issues = parsed['findings'] as Array<Record<string, unknown>> | undefined;
      expect(issues).toBeDefined();
      expect(issues?.some(i => i['code'] === 'LINK_INTEGRITY_BROKEN')).toBe(true);
    });

    it('should detect unreferenced files with --warn-unreferenced-files', async () => {
      const skillDir = createLinkedSkill(tempDir);
      const resourcesDir = safePath.join(skillDir, 'resources');

      // Add an orphaned file not linked from anywhere
      fs.writeFileSync(safePath.join(resourcesDir, 'orphan.md'), '# Orphan\n\nNot linked from anywhere.\n');

      const { result, parsed } = await executeCliAndParseYaml(
        binPath,
        ['audit', '--warn-unreferenced-files', safePath.join(skillDir, 'SKILL.md')],
        { cwd: tempDir },
      );

      // Should succeed (unreferenced is info, not error)
      expect(result.status).toBe(0);

      const issues = parsed['findings'] as Array<Record<string, unknown>> | undefined;
      expect(issues?.some(i =>
        i['code'] === 'SKILL_UNREFERENCED_FILE' &&
        String(i['message']).includes('orphan.md'),
      )).toBe(true);
    });

    it('should not flag CLAUDE.md or README.md as unreferenced', async () => {
      const skillDir = createLinkedSkill(tempDir);

      // Add CLAUDE.md and README.md — should NOT be flagged
      fs.writeFileSync(safePath.join(skillDir, 'CLAUDE.md'), '# Claude\n');
      fs.writeFileSync(safePath.join(skillDir, 'README.md'), '# Readme\n');

      const { parsed } = await executeCliAndParseYaml(
        binPath,
        ['audit', '--warn-unreferenced-files', '--verbose', safePath.join(skillDir, 'SKILL.md')],
        { cwd: tempDir },
      );

      const issues = parsed['findings'] as Array<Record<string, unknown>> | undefined;
      // Vacuity guard: the orphan-free control above proved the detector fires.
      expect(issues).toBeDefined();
      const unreferencedMessages = issues
        ?.filter(i => i['code'] === 'SKILL_UNREFERENCED_FILE')
        ?.map(i => String(i['message'])) ?? [];

      expect(unreferencedMessages.some(m => m.includes('CLAUDE.md'))).toBe(false);
      expect(unreferencedMessages.some(m => m.includes('README.md'))).toBe(false);
    });
  });
});
