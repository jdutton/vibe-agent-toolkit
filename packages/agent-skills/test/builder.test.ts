
/* eslint-disable security/detect-non-literal-fs-filename -- Test code with temp directories */
import fs from 'node:fs/promises';
import path from 'node:path';

import { setupAsyncTempDirSuite } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildAgentSkill } from '../src/builder.js';

const AGENT_YAML = 'agent.yaml';
const PACKAGE_JSON_NAME = 'package.json';
const PROMPTS_DIR = 'prompts';
const SYSTEM_MD = 'system.md';
const TEST_AGENT_NAME = 'test-agent';
const TEST_AGENT_TOOLS_NAME = 'test-agent-tools';
const TEST_AGENT_SCRIPTS_NAME = 'test-agent-scripts';
const TEST_AGENT_LICENSE_NAME = 'test-agent-license';
const TEST_AGENT_NO_PROMPT_NAME = 'test-agent-no-prompt';

describe('buildAgentSkill', () => {
  const suite = setupAsyncTempDirSuite('agent-skill');
  let tempDir: string;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);

  beforeEach(async () => {
    await suite.beforeEach();
    tempDir = suite.getTempDir();
  });

  it('should build a basic Agent Skill', async () => {
    // Create a minimal agent directory structure
    const agentDir = path.join(tempDir, TEST_AGENT_NAME);
    await fs.mkdir(agentDir, { recursive: true });

    // Create package.json (required for findAgentPackageRoot)
    await fs.writeFile(
      path.join(agentDir, PACKAGE_JSON_NAME),
      JSON.stringify({ name: TEST_AGENT_NAME })
    );

    // Create prompts directory
    const promptsDir = path.join(agentDir, PROMPTS_DIR);
    await fs.mkdir(promptsDir);
    await fs.writeFile(
      path.join(promptsDir, SYSTEM_MD),
      '# Test Agent\n\nYou are a helpful test agent.'
    );

    // Create agent.yaml
    const manifestContent = `metadata:
  name: ${TEST_AGENT_NAME}
  description: A test agent
  license: MIT

spec:
  llm:
    provider: anthropic
    model: claude-sonnet-4-20250514
  prompts:
    system:
      $ref: ./prompts/system.md
`;
    const manifestPath = path.join(agentDir, AGENT_YAML);
    await fs.writeFile(manifestPath, manifestContent);

    // Build the skill
    const result = await buildAgentSkill({
      agentPath: manifestPath,
    });

    // Verify result
    expect(result.agent.name).toBe(TEST_AGENT_NAME);
    expect(result.files).toHaveLength(2);

    // Verify SKILL.md exists and has correct structure
    const skillPath = path.join(result.outputPath, 'SKILL.md');
    const skillContent = await fs.readFile(skillPath, 'utf-8');
    expect(skillContent).toContain(`---\nname: ${TEST_AGENT_NAME}`);
    expect(skillContent).toContain('description: A test agent');
    expect(skillContent).toContain('license: MIT');
    expect(skillContent).toContain('## Agent Manifest Format');
    expect(skillContent).toContain('Read `agent-manifest-guide.md`');

    // Verify agent-manifest-guide.md exists (builder writes directly, not via packager)
    const guidePath = path.join(result.outputPath, 'agent-manifest-guide.md');
    const guideContent = await fs.readFile(guidePath, 'utf-8');
    expect(guideContent).toContain('# VAT Agent Manifest Guide');
    expect(guideContent).toContain('## Manifest Structure');
    expect(guideContent).toContain('## Minimal Example');
    expect(guideContent).toContain('## Complex Example');
    expect(guideContent).toContain('## Common Patterns');
    expect(guideContent).toContain('## Anti-Patterns');
  });

  it('should include tools section when tools are defined', async () => {
    // Create agent with tools
    const agentDir = path.join(tempDir, TEST_AGENT_TOOLS_NAME);
    await fs.mkdir(agentDir, { recursive: true });

    await fs.writeFile(
      path.join(agentDir, PACKAGE_JSON_NAME),
      JSON.stringify({ name: TEST_AGENT_TOOLS_NAME })
    );

    const promptsDir = path.join(agentDir, PROMPTS_DIR);
    await fs.mkdir(promptsDir);
    await fs.writeFile(
      path.join(promptsDir, SYSTEM_MD),
      'Test agent with tools'
    );

    const manifestContent = `metadata:
  name: ${TEST_AGENT_TOOLS_NAME}
  description: Test agent with tools

spec:
  llm:
    provider: anthropic
    model: claude-sonnet-4-20250514
  prompts:
    system:
      $ref: ./prompts/system.md
  tools:
    - name: test-tool
      type: library
      description: A test tool
`;
    const manifestPath = path.join(agentDir, AGENT_YAML);
    await fs.writeFile(manifestPath, manifestContent);

    const result = await buildAgentSkill({ agentPath: manifestPath });

    const skillPath = path.join(result.outputPath, 'SKILL.md');
    const skillContent = await fs.readFile(skillPath, 'utf-8');
    expect(skillContent).toContain('## Available Tools');
    expect(skillContent).toContain('`test-tool`: A test tool');
  });

  it('should copy scripts directory if present', async () => {
    const agentDir = path.join(tempDir, TEST_AGENT_SCRIPTS_NAME);
    await fs.mkdir(agentDir, { recursive: true });

    await fs.writeFile(
      path.join(agentDir, PACKAGE_JSON_NAME),
      JSON.stringify({ name: TEST_AGENT_SCRIPTS_NAME })
    );

    const promptsDir = path.join(agentDir, PROMPTS_DIR);
    await fs.mkdir(promptsDir);
    await fs.writeFile(
      path.join(promptsDir, SYSTEM_MD),
      'Test agent'
    );

    // Create scripts directory
    const scriptsDir = path.join(agentDir, 'scripts');
    await fs.mkdir(scriptsDir);
    await fs.writeFile(
      path.join(scriptsDir, 'test-script.js'),
      'console.log("test");'
    );

    const manifestContent = `metadata:
  name: ${TEST_AGENT_SCRIPTS_NAME}
  description: Test agent with scripts

spec:
  llm:
    provider: anthropic
    model: claude-sonnet-4-20250514
  prompts:
    system:
      $ref: ./prompts/system.md
`;
    const manifestPath = path.join(agentDir, AGENT_YAML);
    await fs.writeFile(manifestPath, manifestContent);

    const result = await buildAgentSkill({ agentPath: manifestPath });

    // Verify scripts directory was copied (builder writes directly, not via packager)
    const outputScriptsPath = path.join(result.outputPath, 'scripts');
    const scriptsExist = await fs.access(outputScriptsPath).then(() => true).catch(() => false);
    expect(scriptsExist).toBe(true);

    const scriptContent = await fs.readFile(
      path.join(outputScriptsPath, 'test-script.js'),
      'utf-8'
    );
    expect(scriptContent).toBe('console.log("test");');
  });

  it('should copy LICENSE.txt if present', async () => {
    const agentDir = path.join(tempDir, TEST_AGENT_LICENSE_NAME);
    await fs.mkdir(agentDir, { recursive: true });

    await fs.writeFile(
      path.join(agentDir, PACKAGE_JSON_NAME),
      JSON.stringify({ name: TEST_AGENT_LICENSE_NAME })
    );

    const promptsDir = path.join(agentDir, PROMPTS_DIR);
    await fs.mkdir(promptsDir);
    await fs.writeFile(
      path.join(promptsDir, SYSTEM_MD),
      'Test agent'
    );

    // Create LICENSE.txt
    await fs.writeFile(
      path.join(agentDir, 'LICENSE.txt'),
      'MIT License...'
    );

    const manifestContent = `metadata:
  name: ${TEST_AGENT_LICENSE_NAME}
  description: Test agent with license

spec:
  llm:
    provider: anthropic
    model: claude-sonnet-4-20250514
  prompts:
    system:
      $ref: ./prompts/system.md
`;
    const manifestPath = path.join(agentDir, AGENT_YAML);
    await fs.writeFile(manifestPath, manifestContent);

    const result = await buildAgentSkill({ agentPath: manifestPath });

    // Verify LICENSE.txt was copied (builder writes directly, not via packager)
    const outputLicensePath = path.join(result.outputPath, 'LICENSE.txt');
    const licenseExists = await fs.access(outputLicensePath).then(() => true).catch(() => false);
    expect(licenseExists).toBe(true);

    const licenseContent = await fs.readFile(outputLicensePath, 'utf-8');
    expect(licenseContent).toBe('MIT License...');
  });

  it('should throw error if system prompt is missing', async () => {
    const agentDir = path.join(tempDir, TEST_AGENT_NO_PROMPT_NAME);
    await fs.mkdir(agentDir, { recursive: true });

    await fs.writeFile(
      path.join(agentDir, PACKAGE_JSON_NAME),
      JSON.stringify({ name: TEST_AGENT_NO_PROMPT_NAME })
    );

    const manifestContent = `metadata:
  name: ${TEST_AGENT_NO_PROMPT_NAME}
  description: Test agent

spec:
  llm:
    provider: anthropic
    model: claude-sonnet-4-20250514
`;
    const manifestPath = path.join(agentDir, AGENT_YAML);
    await fs.writeFile(manifestPath, manifestContent);

    await expect(buildAgentSkill({ agentPath: manifestPath }))
      .rejects
      .toThrow('Agent must have a system prompt');
  });
});
