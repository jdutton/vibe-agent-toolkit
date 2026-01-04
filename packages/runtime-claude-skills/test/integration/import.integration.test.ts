/* eslint-disable security/detect-non-literal-fs-filename */
// Test file requires dynamic paths for fixtures and temporary files
import * as fs from 'node:fs';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import type { ImportResult } from '../../src/import.js';
import { importSkillToAgent } from '../../src/import.js';

// Test constants
const AGENT_YAML_FILENAME = 'agent.yaml';
const EXISTING_AGENT_CONTENT = 'existing: content\n';

// Test helper: Create SKILL.md and attempt import
async function createSkillAndImport(
  tempDir: string,
  skillContent: string,
  importOptions?: { outputPath?: string; force?: boolean }
): Promise<{ result: ImportResult; skillPath: string; agentPath: string }> {
  const skillPath = path.join(tempDir, 'SKILL.md');
  fs.writeFileSync(skillPath, skillContent);

  const result = await importSkillToAgent({
    skillPath,
    ...importOptions,
  });

  const agentPath = importOptions?.outputPath ?? path.join(tempDir, AGENT_YAML_FILENAME);

  return { result, skillPath, agentPath };
}

describe('importSkillToAgent (integration)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(__dirname, 'temp-import-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('basic SKILL.md import', () => {
    it('should convert minimal SKILL.md to agent.yaml', async () => {
      // Arrange: Create minimal SKILL.md
      const skillContent = `---
name: test-skill
description: A test skill for import
---
# Test Skill

This is the skill content.
`;
      const skillPath = path.join(tempDir, 'SKILL.md');
      fs.writeFileSync(skillPath, skillContent);

      // Act: Import to agent.yaml
      const result = await importSkillToAgent({ skillPath });

      // Assert: Check result
      expect(result.success).toBe(true);
      expect(result.agentPath).toBeDefined();

      // Assert: Verify agent.yaml exists and has correct content
      const agentYamlPath = path.join(tempDir, AGENT_YAML_FILENAME);
      expect(fs.existsSync(agentYamlPath)).toBe(true);

      const agentContent = fs.readFileSync(agentYamlPath, 'utf-8');
      const agentData = parseYaml(agentContent);

      expect(agentData).toMatchObject({
        metadata: {
          name: 'test-skill',
          description: 'A test skill for import',
        },
        spec: {
          runtime: 'claude-skills',
        },
      });
    });

    it('should convert SKILL.md with optional fields to agent.yaml', async () => {
      // Arrange: Create SKILL.md with optional fields
      const skillContent = `---
name: advanced-skill
description: An advanced skill with optional fields
license: MIT
compatibility: Requires Node.js 18+
metadata:
  author: Test Author
  version: 1.0.0
---
# Advanced Skill

This skill has more fields.
`;
      const skillPath = path.join(tempDir, 'SKILL.md');
      fs.writeFileSync(skillPath, skillContent);

      // Act: Import to agent.yaml
      const result = await importSkillToAgent({ skillPath });

      // Assert: Check result
      expect(result.success).toBe(true);

      // Assert: Verify agent.yaml includes optional fields
      const agentYamlPath = path.join(tempDir, AGENT_YAML_FILENAME);
      const agentContent = fs.readFileSync(agentYamlPath, 'utf-8');
      const agentData = parseYaml(agentContent);

      expect(agentData.metadata).toMatchObject({
        name: 'advanced-skill',
        description: 'An advanced skill with optional fields',
        license: 'MIT',
        version: '1.0.0',
      });
      expect(agentData.spec.runtime).toBe('claude-skills');
      expect(agentData.spec.compatibility).toBe('Requires Node.js 18+');
    });

    it('should place agent.yaml in same directory as SKILL.md', async () => {
      // Arrange: Create SKILL.md in subdirectory
      const subDir = path.join(tempDir, 'my-skill');
      fs.mkdirSync(subDir, { recursive: true });

      const skillContent = `---
name: my-skill
description: Test skill in subdirectory
---
# My Skill
`;
      const skillPath = path.join(subDir, 'SKILL.md');
      fs.writeFileSync(skillPath, skillContent);

      // Act: Import to agent.yaml
      const result = await importSkillToAgent({ skillPath });

      // Assert: agent.yaml should be in same directory
      expect(result.success).toBe(true);
      const expectedAgentPath = path.join(subDir, 'agent.yaml');
      expect(result.agentPath).toBe(expectedAgentPath);
      expect(fs.existsSync(expectedAgentPath)).toBe(true);
    });
  });

  describe('validation', () => {
    it('should fail when SKILL.md does not exist', async () => {
      // Arrange: Non-existent path
      const skillPath = path.join(tempDir, 'nonexistent.md');

      // Act: Try to import
      const result = await importSkillToAgent({ skillPath });

      // Assert: Should fail with error
      expect(result.success).toBe(false);
      expect(result.error).toContain('does not exist');
    });

    it('should fail when SKILL.md is missing name field', async () => {
      // Arrange & Act: SKILL.md without name
      const { result } = await createSkillAndImport(tempDir, `---
description: Missing name field
---
Content here.
`);

      // Assert: Should fail validation
      expect(result.success).toBe(false);
      expect(result.error).toContain('name');
    });

    it('should fail when SKILL.md is missing description field', async () => {
      // Arrange & Act: SKILL.md without description
      const { result } = await createSkillAndImport(tempDir, `---
name: test-skill
---
Content here.
`);

      // Assert: Should fail validation
      expect(result.success).toBe(false);
      expect(result.error).toContain('description');
    });

    it('should fail when SKILL.md has invalid name format', async () => {
      // Arrange & Act: SKILL.md with invalid name
      const { result } = await createSkillAndImport(tempDir, `---
name: Invalid_Skill_Name
description: Has invalid characters
---
Content here.
`);

      // Assert: Should fail validation
      expect(result.success).toBe(false);
      expect(result.error).toContain('lowercase');
    });
  });

  describe('output customization', () => {
    it('should allow custom output path via outputPath option', async () => {
      // Arrange: Create SKILL.md
      const skillContent = `---
name: custom-output
description: Test custom output path
---
Content.
`;
      const skillPath = path.join(tempDir, 'SKILL.md');
      fs.writeFileSync(skillPath, skillContent);

      const customOutputPath = path.join(tempDir, 'custom-agent.yaml');

      // Act: Import with custom output
      const result = await importSkillToAgent({
        skillPath,
        outputPath: customOutputPath,
      });

      // Assert: Should create at custom path
      expect(result.success).toBe(true);
      expect(result.agentPath).toBe(customOutputPath);
      expect(fs.existsSync(customOutputPath)).toBe(true);
    });

    it('should not overwrite existing agent.yaml without force flag', async () => {
      // Arrange: Create existing agent.yaml
      const agentPath = path.join(tempDir, AGENT_YAML_FILENAME);
      fs.writeFileSync(agentPath, EXISTING_AGENT_CONTENT);

      // Act: Try to import without force
      const { result } = await createSkillAndImport(tempDir, `---
name: test-skill
description: Test skill
---
Content.
`);

      // Assert: Should fail without force
      expect(result.success).toBe(false);
      expect(result.error).toContain('already exists');

      // Assert: Original file unchanged
      const content = fs.readFileSync(agentPath, 'utf-8');
      expect(content).toBe(EXISTING_AGENT_CONTENT);
    });

    it('should overwrite existing agent.yaml with force flag', async () => {
      // Arrange: Create existing agent.yaml
      const agentPath = path.join(tempDir, AGENT_YAML_FILENAME);
      fs.writeFileSync(agentPath, EXISTING_AGENT_CONTENT);

      // Act: Import with force
      const { result } = await createSkillAndImport(tempDir, `---
name: test-skill
description: Test skill
---
Content.
`, { force: true });

      // Assert: Should succeed
      expect(result.success).toBe(true);

      // Assert: File was overwritten
      const content = fs.readFileSync(agentPath, 'utf-8');
      expect(content).toContain('name: test-skill');
    });
  });

  describe('version metadata', () => {
    it('should set default version to 0.1.0 when not specified', async () => {
      // Arrange: Create SKILL.md without version
      const skillContent = `---
name: version-test
description: Test version defaulting
---
Content.
`;
      const skillPath = path.join(tempDir, 'SKILL.md');
      fs.writeFileSync(skillPath, skillContent);

      // Act: Import
      const result = await importSkillToAgent({ skillPath });

      // Assert: Should have default version
      expect(result.success).toBe(true);
      if (!result.success) return; // Type guard
      const agentContent = fs.readFileSync(result.agentPath, 'utf-8');
      const agentData = parseYaml(agentContent);
      expect(agentData.metadata.version).toBe('0.1.0');
    });

    it('should preserve version from metadata.version field', async () => {
      // Arrange: Create SKILL.md with version in metadata
      const skillContent = `---
name: version-test
description: Test version preservation
metadata:
  version: 1.2.3
---
Content.
`;
      const skillPath = path.join(tempDir, 'SKILL.md');
      fs.writeFileSync(skillPath, skillContent);

      // Act: Import
      const result = await importSkillToAgent({ skillPath });

      // Assert: Should preserve version
      expect(result.success).toBe(true);
      if (!result.success) return; // Type guard
      const agentContent = fs.readFileSync(result.agentPath, 'utf-8');
      const agentData = parseYaml(agentContent);
      expect(agentData.metadata.version).toBe('1.2.3');
    });
  });
});
