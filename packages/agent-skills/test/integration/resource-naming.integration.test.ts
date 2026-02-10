/**
 * Unit tests for resource naming strategies
 * Tests stripPrefix behavior with all three strategies
 */

import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { mkdirSyncReal, normalizedTmpdir } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { packageSkill } from '../../src/skill-packager.js';

const KB_PATH = 'knowledge-base';
const GUIDES_PATH = 'guides';

const TOPICS_QUICKSTART_PATH = join('topics', 'quickstart');
const OVERVIEW_MD = 'overview.md';
const BASENAME_STRATEGY = 'basename';
const RESOURCE_ID_STRATEGY = 'resource-id';
const PRESERVE_PATH_STRATEGY = 'preserve-path';
const SKILL_MD = 'SKILL.md';

describe('Resource Naming Strategies', () => {
  let tempDir: string;
  let testProjectDir: string;

  beforeEach(() => {
    // Create temp directory structure mimicking knowledge-base
    tempDir = mkdtempSync(join(normalizedTmpdir(), 'vat-naming-test-'));
    testProjectDir = join(tempDir, 'test-project');
    mkdirSyncReal(testProjectDir, { recursive: true });

    // Create nested directory structure
    const kbDir = join(testProjectDir, KB_PATH, GUIDES_PATH, TOPICS_QUICKSTART_PATH);
    mkdirSyncReal(kbDir, { recursive: true });

    // Create test files
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Test fixture creation
    writeFileSync(
      join(kbDir, OVERVIEW_MD),
      '# Quickstart Overview\n\nContent here.'
    );
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Test fixture creation
    writeFileSync(
      join(testProjectDir, KB_PATH, GUIDES_PATH, OVERVIEW_MD),
      '# Guides Overview\n\nContent here.'
    );

    // Create SKILL.md that links to both
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Test fixture creation
    writeFileSync(
      join(testProjectDir, SKILL_MD),
      `---
name: test-skill
description: Test skill for naming strategies with proper length to meet validation
---

# Test Skill

See [Guides Overview](${KB_PATH}/${GUIDES_PATH}/overview.md)
See [Quickstart Overview](${KB_PATH}/${GUIDES_PATH}/topics/quickstart/overview.md)
`
    );
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('basename strategy (default)', () => {
    it('should detect filename collisions and throw error', async () => {
      const skillPath = join(testProjectDir, SKILL_MD);
      const outputPath = join(tempDir, 'output-basename');

      // Should throw error due to overview.md collision
      await expect(
        packageSkill(skillPath, {
          outputPath,
          resourceNaming: BASENAME_STRATEGY,
        })
      ).rejects.toThrow(/Filename collision detected/);
    });
  });

  describe('resource-id strategy', () => {
    it('should flatten path to kebab-case filename', async () => {
      const skillPath = join(testProjectDir, SKILL_MD);
      const outputPath = join(tempDir, 'output-resource-id');

      await packageSkill(skillPath, {
        outputPath,
        resourceNaming: RESOURCE_ID_STRATEGY,
      });

      // Files should be flattened with kebab-case names
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Test output validation
      const files = readdirSync(outputPath);
      expect(files).toContain('knowledge-base-guides-overview.md');
      expect(files).toContain('knowledge-base-guides-topics-quickstart-overview.md');
    });

    it('should strip prefix and trim leading dash', async () => {
      const skillPath = join(testProjectDir, SKILL_MD);
      const outputPath = join(tempDir, 'output-resource-id-stripped');

      await packageSkill(skillPath, {
        outputPath,
        resourceNaming: RESOURCE_ID_STRATEGY,
        stripPrefix: KB_PATH,
      });

      // Prefix should be stripped, no leading dash
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Test output validation
      const files = readdirSync(outputPath);
      expect(files).toContain('guides-overview.md');
      expect(files).toContain('guides-topics-quickstart-overview.md');
      
      // Should NOT have knowledge-base- prefix
      expect(files.some(f => f.startsWith('knowledge-base-'))).toBe(false);
      
      // Should NOT have leading dash
      expect(files.some(f => /^-/.exec(f))).toBe(false);
    });

    it('should work with stripPrefix with or without trailing slash', async () => {
      const skillPath = join(testProjectDir, SKILL_MD);
      
      // Test with trailing slash
      const output1 = join(tempDir, 'output-with-slash');
      await packageSkill(skillPath, {
        outputPath: output1,
        resourceNaming: RESOURCE_ID_STRATEGY,
        stripPrefix: 'knowledge-base/',
      });
      
      // Test without trailing slash
      const output2 = join(tempDir, 'output-without-slash');
      await packageSkill(skillPath, {
        outputPath: output2,
        resourceNaming: RESOURCE_ID_STRATEGY,
        stripPrefix: KB_PATH,
      });

      // Both should produce same result
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Test output validation
      const files1 = readdirSync(output1).sort((a, b) => a.localeCompare(b));
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Test output validation
      const files2 = readdirSync(output2).sort((a, b) => a.localeCompare(b));
      expect(files1).toEqual(files2);
      expect(files1).toContain('guides-overview.md');
    });
  });

  describe('preserve-path strategy', () => {
    it('should preserve directory structure', async () => {
      const skillPath = join(testProjectDir, SKILL_MD);
      const outputPath = join(tempDir, 'output-preserve-path');

      await packageSkill(skillPath, {
        outputPath,
        resourceNaming: PRESERVE_PATH_STRATEGY,
      });

      // Directory structure should be preserved
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Test output validation
      expect(existsSync(join(outputPath, KB_PATH, GUIDES_PATH, OVERVIEW_MD))).toBe(true);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Test output validation
      expect(existsSync(join(outputPath, KB_PATH, GUIDES_PATH, 'topics', 'quickstart', OVERVIEW_MD))).toBe(true);
    });

    it('should strip path prefix and trim leading slash', async () => {
      const skillPath = join(testProjectDir, SKILL_MD);
      const outputPath = join(tempDir, 'output-preserve-stripped');

      await packageSkill(skillPath, {
        outputPath,
        resourceNaming: PRESERVE_PATH_STRATEGY,
        stripPrefix: KB_PATH,
      });

      // Prefix should be stripped from paths
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Test output validation
      expect(existsSync(join(outputPath, GUIDES_PATH, OVERVIEW_MD))).toBe(true);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Test output validation
      expect(existsSync(join(outputPath, GUIDES_PATH, 'topics', 'quickstart', OVERVIEW_MD))).toBe(true);

      // Should NOT have knowledge-base directory
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Test output validation
      expect(existsSync(join(outputPath, KB_PATH))).toBe(false);
    });

    it('should work with stripPrefix with or without trailing slash', async () => {
      const skillPath = join(testProjectDir, SKILL_MD);
      
      // Test with trailing slash
      const output1 = join(tempDir, 'output-path-slash');
      await packageSkill(skillPath, {
        outputPath: output1,
        resourceNaming: PRESERVE_PATH_STRATEGY,
        stripPrefix: `${KB_PATH}/`,
      });

      // Test without trailing slash
      const output2 = join(tempDir, 'output-path-no-slash');
      await packageSkill(skillPath, {
        outputPath: output2,
        resourceNaming: PRESERVE_PATH_STRATEGY,
        stripPrefix: KB_PATH,
      });

      // Both should produce same structure
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Test output validation
      expect(existsSync(join(output1, GUIDES_PATH, OVERVIEW_MD))).toBe(true);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Test output validation
      expect(existsSync(join(output2, GUIDES_PATH, OVERVIEW_MD))).toBe(true);
    });
  });

  describe('stripPrefix edge cases', () => {
    it('should handle nested prefix correctly', async () => {
      const skillPath = join(testProjectDir, SKILL_MD);
      const outputPath = join(tempDir, 'output-nested-prefix');

      await packageSkill(skillPath, {
        outputPath,
        resourceNaming: RESOURCE_ID_STRATEGY,
        stripPrefix: `${KB_PATH}/${GUIDES_PATH}`,
      });

      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Test output validation
      const files = readdirSync(outputPath);
      // Should strip both knowledge-base and guides
      expect(files).toContain(OVERVIEW_MD);
      expect(files).toContain('topics-quickstart-overview.md');
    });

    it('should not strip if prefix does not match', async () => {
      const skillPath = join(testProjectDir, SKILL_MD);
      const outputPath = join(tempDir, 'output-no-match');

      await packageSkill(skillPath, {
        outputPath,
        resourceNaming: RESOURCE_ID_STRATEGY,
        stripPrefix: 'does-not-exist',
      });

      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Test output validation
      const files = readdirSync(outputPath);
      // Prefix didn't match, so full path should remain
      expect(files).toContain('knowledge-base-guides-overview.md');
    });
  });
});
