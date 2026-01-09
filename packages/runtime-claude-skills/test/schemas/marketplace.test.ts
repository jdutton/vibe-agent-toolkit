import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { MarketplaceSchema } from '../../src/schemas/marketplace.js';

function loadMarketplaceFixture(name: string): unknown {
  const fixturePath = resolve(__dirname, '../fixtures/marketplaces', name);
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  return JSON.parse(readFileSync(fixturePath, 'utf-8'));
}

/**
 * Helper to assert that strict validation rejects unknown fields
 */
function assertStrictValidationRejects(data: unknown): void {
  const result = MarketplaceSchema.safeParse(data);
  expect(result.success).toBe(false);
  if (!result.success) {
    const strictError = result.error.issues.find(i => i.code === 'unrecognized_keys');
    expect(strictError).toBeDefined();
  }
}

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
        if (firstPlugin && typeof firstPlugin.source === 'object') {
          expect(firstPlugin.source.source).toBe('url');
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

  describe('validation errors', () => {
    const TEST_MARKETPLACE_NAME = 'test-marketplace';
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

    it('should reject plugin without required description field', () => {
      const invalid = {
        name: TEST_MARKETPLACE_NAME,
        owner: { name: 'Test' },
        plugins: [
          {
            name: TEST_PLUGIN_NAME,
            source: './',
          },
        ],
      };
      const result = MarketplaceSchema.safeParse(invalid);

      expect(result.success).toBe(false);
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

    it('should reject marketplace with unknown fields', () => {
      const invalid = {
        name: TEST_MARKETPLACE_NAME,
        owner: { name: 'Test Owner' },
        metadata: { description: 'Test', version: '1.0.0' },
        plugins: [],
        unknownField: 'should be rejected',
      };

      assertStrictValidationRejects(invalid);
    });

    it('should reject plugin with unknown fields', () => {
      const invalid = {
        name: TEST_MARKETPLACE_NAME,
        owner: { name: 'Test Owner' },
        metadata: { description: 'Test', version: '1.0.0' },
        plugins: [{
          name: TEST_PLUGIN_NAME,
          description: 'A test plugin',
          source: './',
          unknownPluginField: 'should be rejected',
        }],
      };

      assertStrictValidationRejects(invalid);
    });
  });
});
