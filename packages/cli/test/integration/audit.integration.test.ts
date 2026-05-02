/* eslint-disable security/detect-non-literal-fs-filename -- Test code with temp directories */

import fs from 'node:fs';
import { dirname } from 'node:path';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AuditCommandOptions } from '../../src/commands/audit.js';
import { getValidationResults, resetAuditCaches } from '../../src/commands/audit.js';

// Constants for test fixtures
const CLAUDE_PLUGIN_DIRNAME = '.claude-plugin';
const PLUGIN_JSON_FILENAME = 'plugin.json';
const MARKETPLACE_JSON_FILENAME = 'marketplace.json';
const INSTALLED_PLUGINS_FILENAME = 'installed_plugins.json';
const KNOWN_MARKETPLACES_FILENAME = 'known_marketplaces.json';
const TEST_OWNER_NAME = 'Test Owner';
const MY_MARKETPLACE_NAME = 'my-marketplace';
const TEST_MARKETPLACE_NAME = 'test-marketplace';
const TEST_PLUGIN_NAME = 'test-plugin';
const TEST_PLUGIN_DESCRIPTION = 'Test plugin';

// Silent logger for tests (no stderr output)
const silentLogger = {
  info: (_msg: string) => {},
  error: (_msg: string) => {},
  debug: (_msg: string) => {},
};

// Helper to run audit validation directly (no CLI subprocess)
// options.recursive defaults to true (recursive by default), set to false to disable
async function runAudit(targetPath: string, options: AuditCommandOptions = {}) {
  resetAuditCaches();
  return getValidationResults(targetPath, options.recursive !== false, options, silentLogger);
}

describe('audit command (integration)', () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-agent-audit-'));
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('plugin validation', () => {
    it('should validate a valid plugin directory', async () => {
      const pluginDir = safePath.join(tempDir, 'valid-plugin');
      const claudePluginDir = safePath.join(pluginDir, CLAUDE_PLUGIN_DIRNAME);
      fs.mkdirSync(claudePluginDir, { recursive: true });
      fs.writeFileSync(
        safePath.join(claudePluginDir, PLUGIN_JSON_FILENAME),
        JSON.stringify({
          name: TEST_PLUGIN_NAME,
          version: '1.0.0',
          description: TEST_PLUGIN_DESCRIPTION,
          author: { name: 'VAT Test Suite' },
          license: 'MIT',
        })
      );

      const results = await runAudit(pluginDir);

      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('success');
      expect(results[0].metadata?.name).toBe(TEST_PLUGIN_NAME);
    });

    it('should detect plugin validation errors', async () => {
      const pluginDir = safePath.join(tempDir, 'invalid-plugin');
      const claudePluginDir = safePath.join(pluginDir, CLAUDE_PLUGIN_DIRNAME);
      fs.mkdirSync(claudePluginDir, { recursive: true });
      fs.writeFileSync(
        safePath.join(claudePluginDir, PLUGIN_JSON_FILENAME),
        JSON.stringify({
          // Invalid name format (must be lowercase-alphanumeric-with-hyphens)
          name: 'Invalid_Plugin_Name',
        })
      );

      const results = await runAudit(pluginDir);

      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('error');
    });

    it('should warn when plugin.json is missing version field', async () => {
      const pluginDir = safePath.join(tempDir, 'no-version-plugin');
      const claudePluginDir = safePath.join(pluginDir, CLAUDE_PLUGIN_DIRNAME);
      fs.mkdirSync(claudePluginDir, { recursive: true });
      fs.writeFileSync(
        safePath.join(claudePluginDir, PLUGIN_JSON_FILENAME),
        JSON.stringify({
          name: TEST_PLUGIN_NAME,
          description: TEST_PLUGIN_DESCRIPTION,
          // No version field — Claude Code will cache as "unknown/"
        })
      );

      const results = await runAudit(pluginDir);

      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('warning');
      const codes = results[0].issues.map((i) => i.code);
      expect(codes).toContain('PLUGIN_MISSING_VERSION');
      // Plugin-recommended-fields detector also fires (info severity) for
      // missing author/license — detailed coverage in plugin-validator.test.ts.
    });
  });

  describe('marketplace validation', () => {
    it('should validate marketplace directory successfully', async () => {
      const marketplaceDir = safePath.join(tempDir, 'valid-marketplace');
      const claudePluginDir = safePath.join(marketplaceDir, CLAUDE_PLUGIN_DIRNAME);
      fs.mkdirSync(claudePluginDir, { recursive: true });
      fs.writeFileSync(
        safePath.join(claudePluginDir, MARKETPLACE_JSON_FILENAME),
        JSON.stringify({
          name: TEST_MARKETPLACE_NAME,
          owner: { name: TEST_OWNER_NAME },
          plugins: [{ name: TEST_PLUGIN_NAME, source: `./${TEST_PLUGIN_NAME}` }],
        })
      );

      const results = await runAudit(marketplaceDir);

      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('success');
      expect(results[0].type).toBe('marketplace');
      expect(results[0].metadata?.name).toBe(TEST_MARKETPLACE_NAME);
    });
  });

  describe('registry validation', () => {
    it('should validate installed_plugins.json registry', async () => {
      const registryFile = safePath.join(tempDir, INSTALLED_PLUGINS_FILENAME);
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

      const results = await runAudit(registryFile);

      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('success');
    });

    it('should validate known_marketplaces.json registry', async () => {
      const registryFile = safePath.join(tempDir, KNOWN_MARKETPLACES_FILENAME);
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

      const results = await runAudit(registryFile);

      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('success');
    });
  });

  describe('Agent Skill validation', () => {
    it('should validate a single SKILL.md file', async () => {
      const skillFile = safePath.join(tempDir, 'test-skill', 'SKILL.md');
      fs.mkdirSync(dirname(skillFile), { recursive: true });
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

      const results = await runAudit(skillFile);

      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('success');
    });

    it('should validate VAT agent SKILL.md', async () => {
      const agentDir = safePath.join(tempDir, 'vat-agent');
      fs.mkdirSync(agentDir, { recursive: true });

      // Create agent.yaml
      fs.writeFileSync(
        safePath.join(agentDir, 'agent.yaml'),
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
      fs.writeFileSync(
        safePath.join(agentDir, 'SKILL.md'),
        `---
name: test-agent
description: A test agent skill
---

# Test Agent

This is a test agent.
`
      );

      const results = await runAudit(agentDir);

      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('success');
    });
  });

  describe('unknown resource handling', () => {
    it('should report error for unknown resource type', async () => {
      const unknownFile = safePath.join(tempDir, 'unknown.txt');
      fs.writeFileSync(unknownFile, 'not a valid resource');

      const results = await runAudit(unknownFile);

      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('error');
      expect(results[0].issues.some(i => i.code === 'UNKNOWN_FORMAT')).toBe(true);
    });
  });

  // Note: User-level audit tests were removed because they scanned the actual
  // ~/.claude/plugins directory (5+ seconds, real user data). These should be
  // reimplemented as system tests with mocked filesystems or only run when
  // explicitly requested (e.g., bun run test:system).

  describe('recursive scanning', () => {
    it('should discover and validate all resource types recursively', async () => {
      const projectDir = safePath.join(tempDir, 'mixed-project');

      // Create plugin
      const pluginDir = safePath.join(projectDir, 'plugins', 'my-plugin');
      const pluginClaudeDir = safePath.join(pluginDir, CLAUDE_PLUGIN_DIRNAME);
      fs.mkdirSync(pluginClaudeDir, { recursive: true });
      fs.writeFileSync(
        safePath.join(pluginClaudeDir, PLUGIN_JSON_FILENAME),
        JSON.stringify({
          name: 'my-plugin',
          version: '1.0.0',
          description: 'My plugin',
        })
      );

      // Create marketplace
      const marketplaceDir = safePath.join(projectDir, 'marketplaces', MY_MARKETPLACE_NAME);
      const marketplaceClaudeDir = safePath.join(marketplaceDir, CLAUDE_PLUGIN_DIRNAME);
      fs.mkdirSync(marketplaceClaudeDir, { recursive: true });
      fs.writeFileSync(
        safePath.join(marketplaceClaudeDir, MARKETPLACE_JSON_FILENAME),
        JSON.stringify({
          name: MY_MARKETPLACE_NAME,
          owner: { name: TEST_OWNER_NAME },
          plugins: [],
        })
      );

      // Create registry
      const registriesDir = safePath.join(projectDir, 'registries');
      fs.mkdirSync(registriesDir, { recursive: true });
      fs.writeFileSync(
        safePath.join(registriesDir, INSTALLED_PLUGINS_FILENAME),
        JSON.stringify({
          version: 2,
          plugins: {},
        })
      );

      // Create SKILL.md
      const skillDir = safePath.join(projectDir, 'skills', 'my-skill');
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        safePath.join(skillDir, 'SKILL.md'),
        `---
name: my-skill
description: My skill
---

# My Skill
`
      );

      const results = await runAudit(projectDir, { recursive: true });

      expect(results).toHaveLength(4);
      expect(results.some(r => r.path.includes('my-plugin'))).toBe(true);
      expect(results.some(r => r.path.includes(MY_MARKETPLACE_NAME))).toBe(true);
      expect(results.some(r => r.path.includes(INSTALLED_PLUGINS_FILENAME))).toBe(true);
      expect(results.some(r => r.path.includes('my-skill'))).toBe(true);
    });
  });

  describe('hierarchical output (--user flag)', () => {
    it('should find skill with errors when scanning recursively', async () => {
      // Create a mock user plugins directory structure with marketplace
      const mockUserPluginsDir = safePath.join(tempDir, 'mock-user-plugins');
      const marketplaceDir = safePath.join(mockUserPluginsDir, 'marketplaces', 'test-marketplace', 'test-plugin');
      const skillsDir = safePath.join(marketplaceDir, 'skills', 'test-skill');
      fs.mkdirSync(skillsDir, { recursive: true });

      // Create a SKILL.md with an error (name has spaces)
      fs.writeFileSync(
        safePath.join(skillsDir, 'SKILL.md'),
        `---
name: test skill with spaces
description: Test skill
---

# Test Skill
`
      );

      const results = await runAudit(mockUserPluginsDir, { recursive: true });

      expect(results).toHaveLength(1);
      // Should have validation errors (name contains spaces)
      expect(results[0].issues.length).toBeGreaterThan(0);
    });
  });
});
