
/* eslint-disable security/detect-non-literal-fs-filename */
// Test file requires dynamic paths for fixtures and temporary files
import * as fs from 'node:fs';
import * as path from 'node:path';

import { mkdirSyncReal } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import type { ImportResult } from '../../src/import.js';
import { importSkillToAgent } from '../../src/import.js';
import { createSkillContent, createSkillFile, setupTempDir } from '../test-helpers.js';

// Test constants
const AGENT_YAML_FILENAME = 'agent.yaml';
const EXISTING_AGENT_CONTENT = 'existing: content\n';
const TEST_SKILL_NAME = 'test-skill';
const TEST_SKILL_DESC = 'Test skill';
const TEST_CONTENT = '\nContent.\n';

// Test helper: Create SKILL.md and attempt import
async function createSkillAndImport(
  tempDir: string,
  skillContent: string,
  importOptions?: { outputPath?: string; force?: boolean },
): Promise<{ result: ImportResult; skillPath: string; agentPath: string }> {
  const skillPath = createSkillFile(tempDir, skillContent);

  const result = await importSkillToAgent({
    skillPath,
    ...importOptions,
  });

  const agentPath = importOptions?.outputPath ?? path.join(tempDir, AGENT_YAML_FILENAME);

  return { result, skillPath, agentPath };
}

// Test helper: Create minimal test skill content
function createTestSkill(): string {
  return createSkillContent(
    {
      name: TEST_SKILL_NAME,
      description: TEST_SKILL_DESC,
    },
    TEST_CONTENT,
  );
}

// Test helper: Import skill and return parsed agent.yaml
async function importAndParseAgentYaml(
  tempDir: string,
  skillFields: Record<string, unknown>,
): Promise<{ success: boolean; agentData: unknown; agentPath: string }> {
  const skillContent = createSkillContent(skillFields, TEST_CONTENT);
  const skillPath = createSkillFile(tempDir, skillContent);
  const result = await importSkillToAgent({ skillPath });

  if (!result.success) {
    return { success: false, agentData: null, agentPath: '' };
  }

  const agentContent = fs.readFileSync(result.agentPath, 'utf-8');
  const agentData = parseYaml(agentContent);

  return { success: true, agentData, agentPath: result.agentPath };
}

describe('importSkillToAgent (integration)', () => {
  const { getTempDir } = setupTempDir('import-test-');

  describe('basic SKILL.md import', () => {
    it('should convert minimal SKILL.md to agent.yaml', async () => {
      const skillContent = createSkillContent(
        {
          name: TEST_SKILL_NAME,
          description: 'A test skill for import',
        },
        '\n# Test Skill\n\nThis is the skill content.\n',
      );
      const skillPath = createSkillFile(getTempDir(), skillContent);

      const result = await importSkillToAgent({ skillPath });

      expect(result.success).toBe(true);
      expect(result.agentPath).toBeDefined();

      const agentYamlPath = path.join(getTempDir(), AGENT_YAML_FILENAME);
      expect(fs.existsSync(agentYamlPath)).toBe(true);

      const agentContent = fs.readFileSync(agentYamlPath, 'utf-8');
      const agentData = parseYaml(agentContent);

      expect(agentData).toMatchObject({
        metadata: {
          name: TEST_SKILL_NAME,
          description: 'A test skill for import',
        },
        spec: {
          runtime: 'agent-skills',
        },
      });
    });

    it('should convert SKILL.md with optional fields to agent.yaml', async () => {
      const skillContent = createSkillContent(
        {
          name: 'advanced-skill',
          description: 'An advanced skill with optional fields',
          license: 'MIT',
          compatibility: 'Requires Node.js 18+',
          metadata: {
            author: 'Test Author',
            version: '1.0.0',
          },
        },
        '\n# Advanced Skill\n\nThis skill has more fields.\n',
      );
      const skillPath = createSkillFile(getTempDir(), skillContent);

      const result = await importSkillToAgent({ skillPath });

      expect(result.success).toBe(true);

      const agentYamlPath = path.join(getTempDir(), AGENT_YAML_FILENAME);
      const agentContent = fs.readFileSync(agentYamlPath, 'utf-8');
      const agentData = parseYaml(agentContent);

      expect(agentData.metadata).toMatchObject({
        name: 'advanced-skill',
        description: 'An advanced skill with optional fields',
        license: 'MIT',
        version: '1.0.0',
      });
      expect(agentData.spec.runtime).toBe('agent-skills');
      expect(agentData.spec.compatibility).toBe('Requires Node.js 18+');
    });

    it('should place agent.yaml in same directory as SKILL.md', async () => {
      const subDir = path.join(getTempDir(), 'my-skill');
      mkdirSyncReal(subDir, { recursive: true });

      const skillContent = createSkillContent(
        {
          name: 'my-skill',
          description: 'Test skill in subdirectory',
        },
        '\n# My Skill\n',
      );
      const skillPath = createSkillFile(subDir, skillContent);

      const result = await importSkillToAgent({ skillPath });

      expect(result.success).toBe(true);
      const expectedAgentPath = path.join(subDir, 'agent.yaml');
      expect(result.agentPath).toBe(expectedAgentPath);
      expect(fs.existsSync(expectedAgentPath)).toBe(true);
    });
  });

  describe('validation', () => {
    it('should fail when SKILL.md does not exist', async () => {
      const skillPath = path.join(getTempDir(), 'nonexistent.md');

      const result = await importSkillToAgent({ skillPath });

      expect(result.success).toBe(false);
      expect(result.error).toContain('does not exist');
    });

    it('should succeed when SKILL.md is missing name field (optional per Claude Code spec)', async () => {
      const { result } = await createSkillAndImport(
        getTempDir(),
        createSkillContent({ description: 'Missing name field' }, TEST_CONTENT),
      );

      expect(result.success).toBe(true);
    });

    it('should succeed when SKILL.md is missing description field (optional per Claude Code spec)', async () => {
      const { result } = await createSkillAndImport(
        getTempDir(),
        createSkillContent({ name: TEST_SKILL_NAME }, TEST_CONTENT),
      );

      expect(result.success).toBe(true);
    });

    it('should fail when SKILL.md has invalid name format', async () => {
      const { result } = await createSkillAndImport(
        getTempDir(),
        createSkillContent(
          {
            name: 'Invalid_Skill_Name',
            description: 'Has invalid characters',
          },
          TEST_CONTENT,
        ),
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('lowercase');
    });
  });

  describe('output customization', () => {
    it('should allow custom output path via outputPath option', async () => {
      const skillContent = createSkillContent(
        {
          name: 'custom-output',
          description: 'Test custom output path',
        },
        '\nContent.\n',
      );
      const skillPath = createSkillFile(getTempDir(), skillContent);
      const customOutputPath = path.join(getTempDir(), 'custom-agent.yaml');

      const result = await importSkillToAgent({
        skillPath,
        outputPath: customOutputPath,
      });

      expect(result.success).toBe(true);
      expect(result.agentPath).toBe(customOutputPath);
      expect(fs.existsSync(customOutputPath)).toBe(true);
    });

    it('should not overwrite existing agent.yaml without force flag', async () => {
      const agentPath = path.join(getTempDir(), AGENT_YAML_FILENAME);
      fs.writeFileSync(agentPath, EXISTING_AGENT_CONTENT);

      const { result } = await createSkillAndImport(getTempDir(), createTestSkill());

      expect(result.success).toBe(false);
      expect(result.error).toContain('already exists');

      const content = fs.readFileSync(agentPath, 'utf-8');
      expect(content).toBe(EXISTING_AGENT_CONTENT);
    });

    it('should overwrite existing agent.yaml with force flag', async () => {
      const agentPath = path.join(getTempDir(), AGENT_YAML_FILENAME);
      fs.writeFileSync(agentPath, EXISTING_AGENT_CONTENT);

      const { result } = await createSkillAndImport(getTempDir(), createTestSkill(), {
        force: true,
      });

      expect(result.success).toBe(true);

      const content = fs.readFileSync(agentPath, 'utf-8');
      expect(content).toContain('name: test-skill');
    });
  });

  describe('version metadata', () => {
    it('should set default version to 0.1.0 when not specified', async () => {
      const { success, agentData } = await importAndParseAgentYaml(getTempDir(), {
        name: 'version-test',
        description: 'Test version defaulting',
      });

      expect(success).toBe(true);
      expect((agentData as { metadata: { version: string } }).metadata.version).toBe('0.1.0');
    });

    it('should preserve version from metadata.version field', async () => {
      const { success, agentData } = await importAndParseAgentYaml(getTempDir(), {
        name: 'version-test',
        description: 'Test version preservation',
        metadata: {
          version: '1.2.3',
        },
      });

      expect(success).toBe(true);
      expect((agentData as { metadata: { version: string } }).metadata.version).toBe('1.2.3');
    });
  });
});
