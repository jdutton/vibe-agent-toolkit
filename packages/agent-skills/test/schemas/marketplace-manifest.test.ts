import { describe, expect, it } from 'vitest';

import { MarketplaceManifestSchema } from '../../src/schemas/marketplace-manifest.js';

describe('MarketplaceManifestSchema', () => {
  const PLUGIN_NAME = 'test-plugin';
  const validMarketplace = {
    name: 'test-marketplace',
    owner: { name: 'Test Org' },
    plugins: [
      {
        name: PLUGIN_NAME,
        source: `./${PLUGIN_NAME}`,
      },
    ],
  };

  it('should parse a valid marketplace manifest', () => {
    const result = MarketplaceManifestSchema.safeParse(validMarketplace);
    expect(result.success).toBe(true);
  });

  it('should parse with optional fields', () => {
    const result = MarketplaceManifestSchema.safeParse({
      ...validMarketplace,
      $schema: 'https://anthropic.com/claude-code/marketplace.schema.json',
      description: 'A test marketplace',
      version: '1.0.0',
    });
    expect(result.success).toBe(true);
  });

  it('should parse official format with extra plugin fields (passthrough)', () => {
    const result = MarketplaceManifestSchema.safeParse({
      ...validMarketplace,
      plugins: [
        {
          name: PLUGIN_NAME,
          source: `./${PLUGIN_NAME}`,
          description: 'A test plugin',
          version: '1.0.0',
          author: { name: 'Author', email: 'author@example.com' },
          category: 'productivity',
          tags: ['test'],
          strict: true,
          lspServers: {},
          homepage: 'https://example.com',
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('should accept object source types (github, url, npm)', () => {
    const result = MarketplaceManifestSchema.safeParse({
      ...validMarketplace,
      plugins: [
        { name: 'github-plugin', source: { source: 'github', repo: 'owner/repo', ref: 'v1.0' } },
        { name: 'url-plugin', source: { source: 'url', url: 'https://example.com/repo.git' } },
        { name: 'npm-plugin', source: { source: 'npm', package: '@acme/plugin', version: '1.0.0' } },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('should accept metadata object (alternative to top-level description/version)', () => {
    const result = MarketplaceManifestSchema.safeParse({
      ...validMarketplace,
      metadata: { description: 'A marketplace', version: '1.0.0', pluginRoot: './plugins' },
    });
    expect(result.success).toBe(true);
  });

  it('should allow unknown top-level fields (passthrough)', () => {
    const result = MarketplaceManifestSchema.safeParse({
      ...validMarketplace,
      customField: 'should be allowed',
    });
    expect(result.success).toBe(true);
  });

  it('should fail when name is missing', () => {
    const result = MarketplaceManifestSchema.safeParse({
      owner: validMarketplace.owner,
      plugins: validMarketplace.plugins,
    });
    expect(result.success).toBe(false);
  });

  it('should fail when owner is missing', () => {
    const result = MarketplaceManifestSchema.safeParse({
      name: validMarketplace.name,
      plugins: validMarketplace.plugins,
    });
    expect(result.success).toBe(false);
  });

  it('should fail when plugins is missing', () => {
    const result = MarketplaceManifestSchema.safeParse({
      name: validMarketplace.name,
      owner: validMarketplace.owner,
    });
    expect(result.success).toBe(false);
  });

  it('should allow empty plugins array (schema is liberal per Postel\'s Law)', () => {
    const result = MarketplaceManifestSchema.safeParse({
      ...validMarketplace,
      plugins: [],
    });
    expect(result.success).toBe(true);
  });

  it('should fail when plugin entry is missing name', () => {
    const result = MarketplaceManifestSchema.safeParse({
      ...validMarketplace,
      plugins: [{ source: './test' }],
    });
    expect(result.success).toBe(false);
  });

  it('should fail when plugin entry is missing source', () => {
    const result = MarketplaceManifestSchema.safeParse({
      ...validMarketplace,
      plugins: [{ name: PLUGIN_NAME }],
    });
    expect(result.success).toBe(false);
  });

  it('should fail when owner.name is missing', () => {
    const result = MarketplaceManifestSchema.safeParse({
      ...validMarketplace,
      owner: {},
    });
    expect(result.success).toBe(false);
  });

  it('should reject plugin source with path traversal (../)', () => {
    const result = MarketplaceManifestSchema.safeParse({
      ...validMarketplace,
      plugins: [{ name: PLUGIN_NAME, source: '../plugins/test-plugin' }],
    });
    expect(result.success).toBe(false);
  });

  it('should reject plugin source with embedded path traversal (foo/../bar)', () => {
    const result = MarketplaceManifestSchema.safeParse({
      ...validMarketplace,
      plugins: [{ name: PLUGIN_NAME, source: './foo/../bar' }],
    });
    expect(result.success).toBe(false);
  });

  it('should accept plugin source with relative path (./name)', () => {
    const result = MarketplaceManifestSchema.safeParse({
      ...validMarketplace,
      plugins: [{ name: PLUGIN_NAME, source: './test-plugin' }],
    });
    expect(result.success).toBe(true);
  });
});
