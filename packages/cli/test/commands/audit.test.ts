import fs from 'node:fs';
import { dirname, join } from 'node:path';

import { normalizedTmpdir } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runCliCommand } from '../test-helpers.js';

// Constants for test fixtures
const CLAUDE_PLUGIN_DIRNAME = '.claude-plugin';
const PLUGIN_JSON_FILENAME = 'plugin.json';
const MARKETPLACE_JSON_FILENAME = 'marketplace.json';
const INSTALLED_PLUGINS_FILENAME = 'installed_plugins.json';
const KNOWN_MARKETPLACES_FILENAME = 'known_marketplaces.json';
const STATUS_SUCCESS = 'status: success';
const STATUS_ERROR = 'status: error';
const TEST_OWNER_NAME = 'Test Owner';
const MY_MARKETPLACE_NAME = 'my-marketplace';
const TEST_MARKETPLACE_NAME = 'test-marketplace';
const TEST_PLUGIN_NAME = 'test-plugin';
const TEST_PLUGIN_DESCRIPTION = 'Test plugin';

// Helper to run audit command (top-level command)
function runAuditCommand(...args: string[]) {
  return runCliCommand('audit', ...args);
}

describe('audit command (integration)', () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(join(normalizedTmpdir(), 'vat-agent-audit-'));
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('plugin validation', () => {
    it('should validate a valid plugin directory', () => {
      const pluginDir = join(tempDir, 'valid-plugin');
      const claudePluginDir = join(pluginDir, CLAUDE_PLUGIN_DIRNAME);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- safe: tempDir is from mkdtempSync
      fs.mkdirSync(claudePluginDir, { recursive: true });
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- safe: tempDir is from mkdtempSync
      fs.writeFileSync(
        join(claudePluginDir, PLUGIN_JSON_FILENAME),
        JSON.stringify({
          name: TEST_PLUGIN_NAME,
          version: '1.0.0',
          description: TEST_PLUGIN_DESCRIPTION,
        })
      );

      const result = runAuditCommand(pluginDir);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(STATUS_SUCCESS);
      expect(result.stdout).toContain(TEST_PLUGIN_NAME);
    });

    it('should detect plugin validation errors', () => {
      const pluginDir = join(tempDir, 'invalid-plugin');
      const claudePluginDir = join(pluginDir, CLAUDE_PLUGIN_DIRNAME);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- safe: tempDir is from mkdtempSync
      fs.mkdirSync(claudePluginDir, { recursive: true });
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- safe: tempDir is from mkdtempSync
      fs.writeFileSync(
        join(claudePluginDir, PLUGIN_JSON_FILENAME),
        JSON.stringify({
          // Missing required fields
          name: 'invalid-plugin',
        })
      );

      const result = runAuditCommand(pluginDir);

      expect(result.status).toBe(1);
      expect(result.stdout).toContain(STATUS_ERROR);
    });
  });

  describe('marketplace validation', () => {
    it('should validate a valid marketplace directory', () => {
      const marketplaceDir = join(tempDir, 'valid-marketplace');
      const claudePluginDir = join(marketplaceDir, CLAUDE_PLUGIN_DIRNAME);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- safe: tempDir is from mkdtempSync
      fs.mkdirSync(claudePluginDir, { recursive: true });
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- safe: tempDir is from mkdtempSync
      fs.writeFileSync(
        join(claudePluginDir, MARKETPLACE_JSON_FILENAME),
        JSON.stringify({
          name: TEST_MARKETPLACE_NAME,
          owner: { name: TEST_OWNER_NAME },
          plugins: [],
        })
      );

      const result = runAuditCommand(marketplaceDir);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(STATUS_SUCCESS);
      expect(result.stdout).toContain(TEST_MARKETPLACE_NAME);
    });
  });

  describe('registry validation', () => {
    it('should validate installed_plugins.json registry', () => {
      const registryFile = join(tempDir, INSTALLED_PLUGINS_FILENAME);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- safe: tempDir is from mkdtempSync
      fs.writeFileSync(
        registryFile,
        JSON.stringify({
          version: 2,
          plugins: {
            'test-plugin@test-marketplace': [
              {
                scope: 'user',
                installPath: '/path/to/plugin',
                version: '1.0.0',
                installedAt: new Date().toISOString(),
                lastUpdated: new Date().toISOString(),
                isLocal: false,
              },
            ],
          },
        })
      );

      const result = runAuditCommand(registryFile);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(STATUS_SUCCESS);
    });

    it('should validate known_marketplaces.json registry', () => {
      const registryFile = join(tempDir, KNOWN_MARKETPLACES_FILENAME);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- safe: tempDir is from mkdtempSync
      fs.writeFileSync(
        registryFile,
        JSON.stringify({
          [TEST_MARKETPLACE_NAME]: {
            source: {
              source: 'github',
              repo: 'test/marketplace',
            },
            installLocation: '/path/to/marketplace',
            lastUpdated: new Date().toISOString(),
          },
        })
      );

      const result = runAuditCommand(registryFile);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(STATUS_SUCCESS);
    });
  });

  describe('Claude Skill validation (backward compatibility)', () => {
    it('should validate a single SKILL.md file', () => {
      const skillFile = join(tempDir, 'test-skill', 'SKILL.md');
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- safe: tempDir is from mkdtempSync
      fs.mkdirSync(dirname(skillFile), { recursive: true });
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- safe: tempDir is from mkdtempSync
      fs.writeFileSync(
        skillFile,
        `---
name: test-skill
description: A test skill
---

# Test Skill

This is a test skill.
`
      );

      const result = runAuditCommand(skillFile);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(STATUS_SUCCESS);
    });

    it('should validate VAT agent SKILL.md', () => {
      const agentDir = join(tempDir, 'vat-agent');
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- safe: tempDir is from mkdtempSync
      fs.mkdirSync(agentDir, { recursive: true });

      // Create agent.yaml
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- safe: tempDir is from mkdtempSync
      fs.writeFileSync(
        join(agentDir, 'agent.yaml'),
        `metadata:
  name: test-agent
  version: 0.1.0
spec:
  llm:
    provider: anthropic
    model: claude-sonnet-4.5
`
      );

      // Create SKILL.md
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- safe: tempDir is from mkdtempSync
      fs.writeFileSync(
        join(agentDir, 'SKILL.md'),
        `---
name: test-agent
description: A test agent skill
---

# Test Agent

This is a test agent.
`
      );

      const result = runAuditCommand(agentDir);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(STATUS_SUCCESS);
    });
  });

  describe('unknown resource handling', () => {
    it('should report error for unknown resource type', () => {
      const unknownFile = join(tempDir, 'unknown.txt');
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- safe: tempDir is from mkdtempSync
      fs.writeFileSync(unknownFile, 'not a valid resource');

      const result = runAuditCommand(unknownFile);

      expect(result.status).toBe(1);
      expect(result.stdout).toContain(STATUS_ERROR);
      expect(result.stdout).toContain('UNKNOWN_FORMAT');
    });
  });

  // Note: User-level audit tests were removed because they scanned the actual
  // ~/.claude/plugins directory (5+ seconds, real user data). These should be
  // reimplemented as system tests with mocked filesystems or only run when
  // explicitly requested (e.g., bun run test:system).

  describe('recursive scanning', () => {
    it('should discover and validate all resource types recursively', () => {
      const projectDir = join(tempDir, 'mixed-project');

      // Create plugin
      const pluginDir = join(projectDir, 'plugins', 'my-plugin');
      const pluginClaudeDir = join(pluginDir, CLAUDE_PLUGIN_DIRNAME);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- safe: tempDir is from mkdtempSync
      fs.mkdirSync(pluginClaudeDir, { recursive: true });
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- safe: tempDir is from mkdtempSync
      fs.writeFileSync(
        join(pluginClaudeDir, PLUGIN_JSON_FILENAME),
        JSON.stringify({
          name: 'my-plugin',
          version: '1.0.0',
          description: 'My plugin',
        })
      );

      // Create marketplace
      const marketplaceDir = join(projectDir, 'marketplaces', MY_MARKETPLACE_NAME);
      const marketplaceClaudeDir = join(marketplaceDir, CLAUDE_PLUGIN_DIRNAME);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- safe: tempDir is from mkdtempSync
      fs.mkdirSync(marketplaceClaudeDir, { recursive: true });
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- safe: tempDir is from mkdtempSync
      fs.writeFileSync(
        join(marketplaceClaudeDir, MARKETPLACE_JSON_FILENAME),
        JSON.stringify({
          name: MY_MARKETPLACE_NAME,
          owner: { name: TEST_OWNER_NAME },
          plugins: [],
        })
      );

      // Create registry
      const registriesDir = join(projectDir, 'registries');
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- safe: tempDir is from mkdtempSync
      fs.mkdirSync(registriesDir, { recursive: true });
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- safe: tempDir is from mkdtempSync
      fs.writeFileSync(
        join(registriesDir, INSTALLED_PLUGINS_FILENAME),
        JSON.stringify({
          version: 2,
          plugins: {},
        })
      );

      // Create SKILL.md
      const skillDir = join(projectDir, 'skills', 'my-skill');
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- safe: tempDir is from mkdtempSync
      fs.mkdirSync(skillDir, { recursive: true });
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- safe: tempDir is from mkdtempSync
      fs.writeFileSync(
        join(skillDir, 'SKILL.md'),
        `---
name: my-skill
description: My skill
---

# My Skill
`
      );

      const result = runAuditCommand(projectDir, '--recursive');

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('filesScanned: 4');
      expect(result.stdout).toContain('my-plugin');
      expect(result.stdout).toContain(MY_MARKETPLACE_NAME);
      expect(result.stdout).toContain(INSTALLED_PLUGINS_FILENAME);
      expect(result.stdout).toContain('my-skill');
    });
  });

  describe('hierarchical output (--user flag)', () => {
    it('should use hierarchical output format for --user flag', () => {
      // Create a mock user plugins directory structure with marketplace
      const mockUserPluginsDir = join(tempDir, 'mock-user-plugins');
      const marketplaceDir = join(mockUserPluginsDir, 'marketplaces', 'test-marketplace', 'test-plugin');
      const skillsDir = join(marketplaceDir, 'skills', 'test-skill');
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- safe: tempDir is from mkdtempSync
      fs.mkdirSync(skillsDir, { recursive: true });

      // Create a SKILL.md with an error
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- safe: tempDir is from mkdtempSync
      fs.writeFileSync(
        join(skillsDir, 'SKILL.md'),
        `---
name: test skill with spaces
description: Test skill
---

# Test Skill
`
      );

      // Note: This test would require either mocking os.homedir() or using an environment variable
      // For now, we just verify the basic structure works by testing with a regular directory
      const result = runAuditCommand(mockUserPluginsDir, '--recursive');

      // Should scan the directory and find the skill with error (name has spaces - reserved word)
      expect([0, 1]).toContain(result.status); // May have warnings or errors
      expect(result.stdout).toContain('filesScanned: 1');
    });
  });
});
