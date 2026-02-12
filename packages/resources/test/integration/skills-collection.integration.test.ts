import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { setupResourceTestSuite } from '../test-helpers.js';

/**
 * Helper to create a SKILL.md file in the skills directory
 */
async function createSkillFile(tempDir: string, content: string): Promise<string> {
  const skillsDir = join(tempDir, 'resources', 'skills');
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await fs.mkdir(skillsDir, { recursive: true });

  const skillPath = join(skillsDir, 'SKILL.md');
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await fs.writeFile(skillPath, content, 'utf-8');

  return skillPath;
}

describe('Skills Collection Integration', () => {
  const suite = setupResourceTestSuite('skills-integration-');

  beforeEach(suite.beforeEach);
  afterEach(suite.afterEach);

  describe('Resource Validation of SKILL.md', () => {
    it('should validate SKILL.md files as markdown resources', async () => {
      // Create SKILL.md in skills directory
      await createSkillFile(
        suite.tempDir,
        `---
name: test-skill
description: A test skill for validation
---

# Test Skill

This is a test skill file.

## Usage

See [documentation](../../docs/README.md) for details.
`,
      );

      // Create referenced doc
      const docsDir = join(suite.tempDir, 'docs');
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      await fs.mkdir(docsDir, { recursive: true });
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      await fs.writeFile(join(docsDir, 'README.md'), '# Documentation\n\nMain docs.', 'utf-8');

      // Crawl and validate
      await suite.registry.crawl({
        baseDir: suite.tempDir,
        include: ['**/*.md'],
      });

      // Verify SKILL.md was scanned
      const resources = suite.registry.getAllResources();
      const skillResource = resources.find((r) => r.filePath.endsWith('SKILL.md'));
      expect(skillResource).toBeDefined();

      // Validate all resources (including links)
      const result = await suite.registry.validate();

      // Should have no broken links
      expect(result.errorCount).toBe(0);
      expect(result.issues).toHaveLength(0);
    });

    it('should detect broken links in SKILL.md', async () => {
      // Create SKILL.md with broken link
      await createSkillFile(
        suite.tempDir,
        `---
name: test-skill
description: A test skill with broken link
---

# Test Skill

See [missing file](../../docs/MISSING.md) for more.
`,
      );

      // Crawl and validate
      await suite.registry.crawl({
        baseDir: suite.tempDir,
        include: ['**/*.md'],
      });

      // Validate all resources (including links)
      const result = await suite.registry.validate();

      // Should detect broken link (type is 'broken_file', not 'broken-file-link')
      expect(result.errorCount).toBeGreaterThan(0);
      const brokenLinkIssue = result.issues.find((i) => i.type === 'broken_file');
      expect(brokenLinkIssue).toBeDefined();
      expect(brokenLinkIssue?.message).toContain('MISSING.md');
    });

    it('should validate SKILL.md frontmatter against JSON schema', async () => {
      // Create skill frontmatter schema (simplified version)
      const schema = {
        type: 'object',
        required: ['name', 'description'],
        properties: {
          name: {
            type: 'string',
            minLength: 1,
            maxLength: 64,
          },
          description: {
            type: 'string',
            minLength: 1,
            maxLength: 1024,
          },
        },
        additionalProperties: false,
      };

      // Create SKILL.md with invalid frontmatter (missing required field)
      await createSkillFile(
        suite.tempDir,
        `---
name: test-skill
# Missing description field
---

# Test Skill

This should fail validation.
`,
      );

      // Crawl all markdown files
      await suite.registry.crawl({
        baseDir: suite.tempDir,
        include: ['**/*.md'],
      });

      // Validate with frontmatter schema
      const result = await suite.registry.validate({ frontmatterSchema: schema });

      // Should have frontmatter validation error (missing description)
      expect(result.errorCount).toBeGreaterThan(0);
      const frontmatterError = result.issues.find((i) =>
        i.type === 'frontmatter_schema_error' || i.type === 'frontmatter_missing'
      );
      expect(frontmatterError).toBeDefined();
      expect(frontmatterError?.message).toMatch(/description/i);
    });

    it('should validate SKILL.md frontmatter with pattern constraints', async () => {
      // Create skill frontmatter schema with pattern for reserved words
      const schema = {
        type: 'object',
        required: ['name', 'description'],
        properties: {
          name: {
            type: 'string',
            minLength: 1,
            maxLength: 64,
            // Pattern that disallows "claude" or "anthropic" (case-insensitive)
            pattern: '^(?!.*(claude|anthropic)).*$',
          },
          description: {
            type: 'string',
            minLength: 1,
          },
        },
        additionalProperties: false,
      };

      // Create SKILL.md with reserved word in name
      await createSkillFile(
        suite.tempDir,
        `---
name: anthropic-skill
description: A skill with reserved word in name
---

# Anthropic Skill

This should fail pattern validation.
`,
      );

      // Crawl all markdown files
      await suite.registry.crawl({
        baseDir: suite.tempDir,
        include: ['**/*.md'],
      });

      // Validate with frontmatter schema
      const result = await suite.registry.validate({ frontmatterSchema: schema });

      // Should have frontmatter validation error for pattern mismatch
      expect(result.errorCount).toBeGreaterThan(0);
      const patternError = result.issues.find((i) =>
        i.type === 'frontmatter_schema_error' &&
        (i.message.toLowerCase().includes('pattern') || i.message.toLowerCase().includes('name'))
      );
      expect(patternError).toBeDefined();
      expect(patternError?.message).toMatch(/name|pattern/i);
    });
  });

  describe('End-to-End Skills Validation', () => {
    it('should catch both resource errors and frontmatter errors', async () => {
      // Create skill frontmatter schema
      const schema = {
        type: 'object',
        required: ['name', 'description'],
        properties: {
          name: {
            type: 'string',
            minLength: 1,
            pattern: '^(?!.*(claude|anthropic)).*$', // No reserved words
          },
          description: {
            type: 'string',
            minLength: 1,
          },
        },
        additionalProperties: false,
      };

      // Create SKILL.md with BOTH errors:
      // 1. Broken link (resource error)
      // 2. Reserved word in frontmatter (schema error)
      await createSkillFile(
        suite.tempDir,
        `---
name: anthropic-skill
description: Test skill with multiple errors
---

# Anthropic Skill

See [missing file](../../docs/MISSING.md) for more.
`,
      );

      // Crawl all markdown files
      await suite.registry.crawl({
        baseDir: suite.tempDir,
        include: ['**/*.md'],
      });

      // Validate with frontmatter schema (catches both link and frontmatter errors)
      const result = await suite.registry.validate({ frontmatterSchema: schema });

      // Should have errors for BOTH issues
      expect(result.errorCount).toBeGreaterThan(1); // At least 2 errors

      // Should detect broken link (type is 'broken_file')
      const brokenLinkIssue = result.issues.find((i) => i.type === 'broken_file');
      expect(brokenLinkIssue).toBeDefined();
      expect(brokenLinkIssue?.message).toContain('MISSING.md');

      // Should have frontmatter error (reserved word in name)
      const frontmatterError = result.issues.find((i) =>
        i.type === 'frontmatter_schema_error' &&
        (i.message.toLowerCase().includes('pattern') || i.message.toLowerCase().includes('name'))
      );
      expect(frontmatterError).toBeDefined();

      // Both errors reported in single validation result
      // This verifies integration between link and frontmatter validation systems
    });
  });
});
