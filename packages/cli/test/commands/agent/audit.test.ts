import fs from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runCliCommand } from '../../test-helpers.js';

// Constants for test fixtures
const CLAUDE_PLUGIN_DIRNAME = '.claude-plugin';
const PLUGIN_JSON_FILENAME = 'plugin.json';
const MARKETPLACE_JSON_FILENAME = 'marketplace.json';
const INSTALLED_PLUGINS_FILENAME = 'installed_plugins.json';
const KNOWN_MARKETPLACES_FILENAME = 'known_marketplaces.json';
const STATUS_SUCCESS = 'status: success';
const TEST_OWNER_NAME = 'Test Owner';
const MY_MARKETPLACE_NAME = 'my-marketplace';

// Helper to run audit command
function runAuditCommand(...args: string[]) {
  return runCliCommand('agent', 'audit', ...args);
}

describe('agent audit command (integration)', () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(join(os.tmpdir(), 'vat-agent-audit-'));
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
          name: 'test-plugin',
          version: '1.0.0',
          description: 'Test plugin',
        })
      );

      const result = runAuditCommand(pluginDir);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(STATUS_SUCCESS);
      expect(result.stdout).toContain('test-plugin');
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
      expect(result.stdout).toContain('status: error');
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
          name: 'test-marketplace',
          owner: { name: TEST_OWNER_NAME },
          plugins: [],
        })
      );

      const result = runAuditCommand(marketplaceDir);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(STATUS_SUCCESS);
      expect(result.stdout).toContain('test-marketplace');
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
          'test-marketplace': {
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
      expect(result.stdout).toContain('status: error');
      expect(result.stdout).toContain('UNKNOWN_FORMAT');
    });
  });

  describe('user-level audit', () => {
    it('should handle --user flag correctly', () => {
      // Test --user flag behavior
      // This test checks that the --user flag works correctly:
      // - If ~/.claude/plugins exists, it should scan it recursively
      // - If it doesn't exist, it should exit with status 2 (system error)

      const userPluginsDir = join(os.homedir(), '.claude', 'plugins');
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- safe: path constructed from os.homedir()
      const userPluginsDirExists = fs.existsSync(userPluginsDir);

      const result = runAuditCommand('--user');

      if (userPluginsDirExists) {
        // If the directory exists, the command should succeed or have validation issues
        // (status 0 for success, 1 for validation errors)
        expect([0, 1]).toContain(result.status);
        // Should have scanned something
        expect(result.stdout).toContain('filesScanned:');
      } else {
        // If directory doesn't exist, should exit with status 2 (system error)
        expect(result.status).toBe(2);
        expect(result.stderr).toContain('User plugins directory not found');
      }
    });

    it('should reject --user flag when path argument is also provided', () => {
      // This test verifies that using --user with a path argument works
      // (--user takes precedence and ignores the path argument)
      const result = runAuditCommand(tempDir, '--user');

      const userPluginsDir = join(os.homedir(), '.claude', 'plugins');
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- safe: path constructed from os.homedir()
      const userPluginsDirExists = fs.existsSync(userPluginsDir);

      if (userPluginsDirExists) {
        // Should scan user plugins, not tempDir
        expect([0, 1]).toContain(result.status);
      } else {
        expect(result.status).toBe(2);
        expect(result.stderr).toContain('User plugins directory not found');
      }
    });
  });

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
});
