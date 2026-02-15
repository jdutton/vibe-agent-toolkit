import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { MarketplaceSchema } from '../../src/schemas/marketplace.js';

function loadMarketplaceFixture(name: string): unknown {
  const fixturePath = resolve(__dirname, '../fixtures/marketplaces', name);
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  return JSON.parse(readFileSync(fixturePath, 'utf-8'));
}


const TEST_MARKETPLACE_NAME = 'test-marketplace';
const PASSTHROUGH_VALUE = 'should be preserved';

describe('MarketplaceSchema', () => {
  describe('bundled skills marketplace', () => {
    it('should validate known-good marketplace.json from anthropic-agent-skills', () => {
      const knownGood = loadMarketplaceFixture('anthropic-agent-skills-marketplace.json');
      const result = MarketplaceSchema.safeParse(knownGood);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBe('anthropic-agent-skills');
        expect(result.data.plugins).toBeInstanceOf(Array);
        expect(result.data.plugins.length).toBeGreaterThan(0);
      }
    });
  });

  describe('external git repo marketplace', () => {
    it('should validate marketplace.json with external git repos', () => {
      const knownGood = loadMarketplaceFixture('superpowers-marketplace.json');
      const result = MarketplaceSchema.safeParse(knownGood);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBe('superpowers-marketplace');
        expect(result.data.plugins).toBeInstanceOf(Array);
        // Check that source can be an object with url
        const firstPlugin = result.data.plugins[0];
        if (firstPlugin && typeof firstPlugin.source === 'object' && firstPlugin.source.source === 'url') {
          expect(firstPlugin.source.url).toBeDefined();
        }
      }
    });
  });

  describe('LSP server marketplace', () => {
    it('should validate marketplace.json with LSP server configurations', () => {
      const knownGood = loadMarketplaceFixture('local-lsp-marketplace.json');
      const result = MarketplaceSchema.safeParse(knownGood);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBe('local-lsp');
        // Check that plugins can have lspServers
        const firstPlugin = result.data.plugins[0];
        expect(firstPlugin?.lspServers).toBeDefined();
      }
    });
  });

  describe('LspServerConfigSchema', () => {
    it('requires extensionToLanguage', () => {
      const marketplace = {
        name: TEST_MARKETPLACE_NAME,
        owner: { name: 'Test' },
        plugins: [{
          name: 'lsp-plugin',
          source: './',
          lspServers: {
            go: { command: 'gopls', args: ['serve'] },  // missing extensionToLanguage
          },
        }],
      };
      expect(MarketplaceSchema.safeParse(marketplace).success).toBe(false);
    });

    it('accepts LSP config with all official fields', () => {
      const marketplace = {
        name: TEST_MARKETPLACE_NAME,
        owner: { name: 'Test' },
        plugins: [{
          name: 'lsp-plugin',
          source: './',
          lspServers: {
            go: {
              command: 'gopls',
              args: ['serve'],
              extensionToLanguage: { '.go': 'go' },
              transport: 'stdio',
              env: { GOPATH: '/usr/local/go' },
              initializationOptions: { gofumpt: true },
              settings: { formatting: { gofumpt: true } },
              workspaceFolder: '.',
              startupTimeout: 5000,
              shutdownTimeout: 3000,
              restartOnCrash: true,
              maxRestarts: 3,
            },
          },
        }],
      };
      expect(MarketplaceSchema.safeParse(marketplace).success).toBe(true);
    });
  });

  describe('plugin source types', () => {
    it('accepts github source with repo', () => {
      const marketplace = {
        name: TEST_MARKETPLACE_NAME,
        owner: { name: 'Test' },
        plugins: [{
          name: 'my-plugin',
          source: { source: 'github', repo: 'owner/repo' },
        }],
      };
      expect(MarketplaceSchema.safeParse(marketplace).success).toBe(true);
    });

    it('accepts github source with ref and sha', () => {
      const marketplace = {
        name: TEST_MARKETPLACE_NAME,
        owner: { name: 'Test' },
        plugins: [{
          name: 'my-plugin',
          source: { source: 'github', repo: 'owner/repo', ref: 'v1.0.0', sha: 'abc123' },
        }],
      };
      expect(MarketplaceSchema.safeParse(marketplace).success).toBe(true);
    });

    it('accepts url source with ref and sha', () => {
      const marketplace = {
        name: TEST_MARKETPLACE_NAME,
        owner: { name: 'Test' },
        plugins: [{
          name: 'my-plugin',
          source: { source: 'url', url: 'https://github.com/owner/repo.git', ref: 'main', sha: 'def456' },
        }],
      };
      expect(MarketplaceSchema.safeParse(marketplace).success).toBe(true);
    });
  });

  describe('plugin entry fields from official spec', () => {
    it('accepts plugin without description (optional)', () => {
      const marketplace = {
        name: TEST_MARKETPLACE_NAME,
        owner: { name: 'Test' },
        plugins: [{
          name: 'my-plugin',
          source: './',
        }],
      };
      expect(MarketplaceSchema.safeParse(marketplace).success).toBe(true);
    });

    it('accepts plugin with component path fields', () => {
      const marketplace = {
        name: TEST_MARKETPLACE_NAME,
        owner: { name: 'Test' },
        plugins: [{
          name: 'my-plugin',
          source: './',
          commands: './commands/',
          agents: './agents/',
          hooks: './hooks/hooks.json',
          mcpServers: './mcp-config.json',
        }],
      };
      expect(MarketplaceSchema.safeParse(marketplace).success).toBe(true);
    });

    it('accepts plugin with repository, license, keywords', () => {
      const marketplace = {
        name: TEST_MARKETPLACE_NAME,
        owner: { name: 'Test' },
        plugins: [{
          name: 'my-plugin',
          source: './',
          repository: 'https://github.com/owner/repo',
          license: 'MIT',
          keywords: ['productivity', 'code-review'],
        }],
      };
      expect(MarketplaceSchema.safeParse(marketplace).success).toBe(true);
    });
  });

  describe('marketplace metadata', () => {
    it('accepts metadata.pluginRoot', () => {
      const marketplace = {
        name: TEST_MARKETPLACE_NAME,
        owner: { name: 'Test' },
        metadata: { description: 'Test', version: '1.0.0', pluginRoot: './plugins' },
        plugins: [],
      };
      expect(MarketplaceSchema.safeParse(marketplace).success).toBe(true);
    });
  });

  describe('validation errors', () => {
    const TEST_PLUGIN_NAME = 'test-plugin';

    it('should reject marketplace without required name field', () => {
      const invalid = {
        owner: { name: 'Test' },
        plugins: [],
      };
      const result = MarketplaceSchema.safeParse(invalid);

      expect(result.success).toBe(false);
    });

    it('should reject marketplace without required owner field', () => {
      const invalid = {
        name: TEST_MARKETPLACE_NAME,
        plugins: [],
      };
      const result = MarketplaceSchema.safeParse(invalid);

      expect(result.success).toBe(false);
    });

    it('should reject marketplace without required plugins array', () => {
      const invalid = {
        name: TEST_MARKETPLACE_NAME,
        owner: { name: 'Test' },
      };
      const result = MarketplaceSchema.safeParse(invalid);

      expect(result.success).toBe(false);
    });

    it('should reject plugin without required name field', () => {
      const invalid = {
        name: TEST_MARKETPLACE_NAME,
        owner: { name: 'Test' },
        plugins: [
          {
            description: 'Test plugin',
            source: './',
          },
        ],
      };
      const result = MarketplaceSchema.safeParse(invalid);

      expect(result.success).toBe(false);
    });

    it('should accept plugin without description (optional field)', () => {
      const valid = {
        name: TEST_MARKETPLACE_NAME,
        owner: { name: 'Test' },
        plugins: [
          {
            name: TEST_PLUGIN_NAME,
            source: './',
          },
        ],
      };
      const result = MarketplaceSchema.safeParse(valid);

      expect(result.success).toBe(true);
    });

    it('should reject plugin without required source field', () => {
      const invalid = {
        name: TEST_MARKETPLACE_NAME,
        owner: { name: 'Test' },
        plugins: [
          {
            name: TEST_PLUGIN_NAME,
            description: 'Test plugin',
          },
        ],
      };
      const result = MarketplaceSchema.safeParse(invalid);

      expect(result.success).toBe(false);
    });

    it('should accept marketplace with unknown fields (passthrough)', () => {
      const data = {
        name: TEST_MARKETPLACE_NAME,
        owner: { name: 'Test Owner' },
        metadata: { description: 'Test', version: '1.0.0' },
        plugins: [],
        unknownField: PASSTHROUGH_VALUE,
      };
      const result = MarketplaceSchema.safeParse(data);

      expect(result.success).toBe(true);
      if (result.success) {
        expect((result.data as Record<string, unknown>)['unknownField']).toBe(PASSTHROUGH_VALUE);
      }
    });

    it('should accept plugin with unknown fields (passthrough)', () => {
      const data = {
        name: TEST_MARKETPLACE_NAME,
        owner: { name: 'Test Owner' },
        metadata: { description: 'Test', version: '1.0.0' },
        plugins: [{
          name: TEST_PLUGIN_NAME,
          description: 'A test plugin',
          source: './',
          unknownPluginField: PASSTHROUGH_VALUE,
        }],
      };
      const result = MarketplaceSchema.safeParse(data);

      expect(result.success).toBe(true);
      if (result.success) {
        expect((result.data.plugins[0] as Record<string, unknown>)['unknownPluginField']).toBe(PASSTHROUGH_VALUE);
      }
    });
  });
});
