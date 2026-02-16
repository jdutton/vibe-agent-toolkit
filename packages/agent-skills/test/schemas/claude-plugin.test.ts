import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ClaudePluginSchema } from '../../src/schemas/claude-plugin.js';

const TEST_PLUGIN_NAME = 'test-plugin';

function loadPluginFixture(name: string): unknown {
  const fixturePath = resolve(__dirname, '../fixtures/plugins', name);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Test helper loading fixtures from known directory
  return JSON.parse(readFileSync(fixturePath, 'utf-8'));
}

/**
 * Helper function to test schema validation errors
 * Eliminates duplication in error validation tests
 */
function expectSchemaError(
  data: unknown,
  path: string,
  messageContains: string
): void {
  const result = ClaudePluginSchema.safeParse(data);
  expect(result.success).toBe(false);
  if (!result.success) {
    const error = result.error.issues.find(i => i.path[0] === path);
    expect(error).toBeDefined();
    expect(error?.message).toContain(messageContains);
  }
}

describe('ClaudePluginSchema', () => {
  it('should validate known-good plugin.json from superpowers', () => {
    const knownGood = loadPluginFixture('superpowers-plugin.json');
    const result = ClaudePluginSchema.safeParse(knownGood);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe('superpowers');
      expect(result.data.version).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  /**
   * Component path fields per official spec (code.claude.com/docs/en/plugins-reference):
   *   commands, agents, skills, outputStyles: string | string[]
   *   hooks, mcpServers, lspServers: string | string[] | object (inline config)
   */
  describe('component paths: string format', () => {
    it('accepts commands as a single string path', () => {
      const plugin = { name: TEST_PLUGIN_NAME, commands: './custom/commands/deploy.md' };
      expect(ClaudePluginSchema.safeParse(plugin).success).toBe(true);
    });

    it('accepts agents as a single string path', () => {
      const plugin = { name: TEST_PLUGIN_NAME, agents: './custom/agents/' };
      expect(ClaudePluginSchema.safeParse(plugin).success).toBe(true);
    });

    it('accepts skills as a single string path', () => {
      const plugin = { name: TEST_PLUGIN_NAME, skills: './custom/skills/' };
      expect(ClaudePluginSchema.safeParse(plugin).success).toBe(true);
    });

    it('accepts hooks as a string path to hooks config file', () => {
      const plugin = { name: TEST_PLUGIN_NAME, hooks: './config/hooks.json' };
      expect(ClaudePluginSchema.safeParse(plugin).success).toBe(true);
    });

    it('accepts mcpServers as a string path to MCP config', () => {
      const plugin = { name: TEST_PLUGIN_NAME, mcpServers: './mcp-config.json' };
      expect(ClaudePluginSchema.safeParse(plugin).success).toBe(true);
    });

    it('accepts outputStyles as a single string path', () => {
      const plugin = { name: TEST_PLUGIN_NAME, outputStyles: './styles/' };
      expect(ClaudePluginSchema.safeParse(plugin).success).toBe(true);
    });

    it('accepts lspServers as a string path to LSP config', () => {
      const plugin = { name: TEST_PLUGIN_NAME, lspServers: './.lsp.json' };
      expect(ClaudePluginSchema.safeParse(plugin).success).toBe(true);
    });
  });

  describe('component paths: array of strings format', () => {
    it('accepts commands as array of string paths', () => {
      const plugin = {
        name: TEST_PLUGIN_NAME,
        commands: ['./specialized/deploy.md', './utilities/batch-process.md'],
      };
      expect(ClaudePluginSchema.safeParse(plugin).success).toBe(true);
    });

    it('accepts agents as array of string paths', () => {
      const plugin = {
        name: TEST_PLUGIN_NAME,
        agents: ['./custom-agents/reviewer.md', './custom-agents/tester.md'],
      };
      expect(ClaudePluginSchema.safeParse(plugin).success).toBe(true);
    });

    it('accepts hooks as array of string paths', () => {
      const plugin = {
        name: TEST_PLUGIN_NAME,
        hooks: ['./hooks/hooks.json', './hooks/security-hooks.json'],
      };
      expect(ClaudePluginSchema.safeParse(plugin).success).toBe(true);
    });
  });

  describe('component paths: inline config object format', () => {
    it('accepts hooks as inline config object', () => {
      const plugin = {
        name: TEST_PLUGIN_NAME,
        hooks: {
          PostToolUse: [{
            matcher: 'Write|Edit',
            hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/scripts/format.sh' }],
          }],
        },
      };
      expect(ClaudePluginSchema.safeParse(plugin).success).toBe(true);
    });

    it('accepts mcpServers as inline config object', () => {
      const plugin = {
        name: TEST_PLUGIN_NAME,
        mcpServers: {
          'plugin-database': {
            command: '${CLAUDE_PLUGIN_ROOT}/servers/db-server',
            args: ['--config', '${CLAUDE_PLUGIN_ROOT}/config.json'],
          },
        },
      };
      expect(ClaudePluginSchema.safeParse(plugin).success).toBe(true);
    });

    it('accepts lspServers as inline config object', () => {
      const plugin = {
        name: TEST_PLUGIN_NAME,
        lspServers: {
          go: {
            command: 'gopls',
            args: ['serve'],
            extensionToLanguage: { '.go': 'go' },
          },
        },
      };
      expect(ClaudePluginSchema.safeParse(plugin).success).toBe(true);
    });
  });

  describe('component paths: complete real-world example from official docs', () => {
    it('accepts the full example from plugins-reference', () => {
      const plugin = {
        name: 'plugin-name',
        version: '1.2.0',
        description: 'Brief plugin description',
        author: { name: 'Author Name', email: 'author@example.com' },
        homepage: 'https://docs.example.com/plugin',
        repository: 'https://github.com/author/plugin',
        license: 'MIT',
        keywords: ['keyword1', 'keyword2'],
        commands: ['./custom/commands/special.md'],
        agents: './custom/agents/',
        skills: './custom/skills/',
        hooks: './config/hooks.json',
        mcpServers: './mcp-config.json',
        outputStyles: './styles/',
        lspServers: './.lsp.json',
      };
      expect(ClaudePluginSchema.safeParse(plugin).success).toBe(true);
    });
  });

  describe('author fields', () => {
    it('accepts author with url field', () => {
      const plugin = {
        name: TEST_PLUGIN_NAME,
        author: {
          name: 'Author Name',
          email: 'author@example.com',
          url: 'https://example.com/author',
        },
      };
      const result = ClaudePluginSchema.safeParse(plugin);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.author?.url).toBe('https://example.com/author');
      }
    });
  });

  describe('validation errors', () => {
    it('should reject plugin with missing name', () => {
      const invalid = {
        description: 'A plugin',
        version: '1.0.0',
      };

      expectSchemaError(invalid, 'name', 'Required');
    });

    it('should reject plugin with invalid version format', () => {
      const invalid = {
        name: TEST_PLUGIN_NAME,
        description: 'A plugin',
        version: 'v1.0', // Invalid: must be x.y.z
      };

      expectSchemaError(invalid, 'version', 'semver');
    });

    it('should reject plugin with uppercase in name', () => {
      const invalid = {
        name: 'TestPlugin', // Invalid: must be lowercase
        description: 'A plugin',
        version: '1.0.0',
      };

      expectSchemaError(invalid, 'name', 'lowercase');
    });
  });
});
