import { describe, expect, it } from 'vitest';

import { buildMarketplaceJson } from '../../../../src/commands/claude/plugin/marketplace-json.js';

const EMAIL = 'ops@org.example';

describe('buildMarketplaceJson', () => {
  const owner = { name: 'Org', email: EMAIL };

  it("publishes each plugin's merged author, so plugins[].author matches its plugin.json", () => {
    // The merged author carries the passthrough subfields VAT's config cannot
    // express (here: url). marketplace.json must publish the SAME object the
    // plugin's own plugin.json got — regenerating it from `owner` alone dropped
    // the url from the marketplace listing, the surface consumers actually browse.
    const json = buildMarketplaceJson({
      name: 'mp1',
      owner,
      plugins: [
        {
          kind: 'built',
          name: 'a',
          description: 'Plugin A',
          version: '1.2.3',
          author: { name: 'Org', email: EMAIL, url: 'https://org.example/about' },
        },
      ],
    });

    expect(json['owner']).toEqual(owner);
    expect(json['plugins']).toEqual([
      {
        name: 'a',
        description: 'Plugin A',
        source: './plugins/a',
        version: '1.2.3',
        author: { name: 'Org', email: EMAIL, url: 'https://org.example/about' },
      },
    ]);
  });

  it('omits description and version when the plugin supplies neither', () => {
    const json = buildMarketplaceJson({
      name: 'mp1',
      owner: { name: 'Org' },
      plugins: [{ kind: 'built', name: 'b', author: { name: 'Org' } }],
    });

    expect(json['owner']).toEqual({ name: 'Org' });
    expect(json['plugins']).toEqual([
      { name: 'b', source: './plugins/b', author: { name: 'Org' } },
    ]);
  });

  it('emits an external entry\'s source object verbatim and omits author', () => {
    // An external entry has no local plugin.json to merge an author from — see
    // the module doc. Fabricating one would misattribute someone else's plugin.
    const json = buildMarketplaceJson({
      name: 'mp1',
      owner: { name: 'Org' },
      plugins: [
        {
          kind: 'external',
          name: 'vibe-agent-toolkit',
          description: 'Upstream VAT plugin, referenced not vendored',
          source: { source: 'github', repo: 'jdutton/vibe-agent-toolkit', ref: 'claude-marketplace' },
        },
      ],
    });

    expect(json['plugins']).toEqual([
      {
        name: 'vibe-agent-toolkit',
        description: 'Upstream VAT plugin, referenced not vendored',
        source: { source: 'github', repo: 'jdutton/vibe-agent-toolkit', ref: 'claude-marketplace' },
      },
    ]);
  });

  it('mixes built and external plugins in one marketplace, each with its own source shape', () => {
    const json = buildMarketplaceJson({
      name: 'mp1',
      owner: { name: 'Org' },
      plugins: [
        { kind: 'built', name: 'local-plugin', author: { name: 'Org' } },
        {
          kind: 'external',
          name: 'remote-plugin',
          source: { source: 'npm', package: '@example/remote-plugin' },
        },
      ],
    });

    expect(json['plugins']).toEqual([
      { name: 'local-plugin', source: './plugins/local-plugin', author: { name: 'Org' } },
      { name: 'remote-plugin', source: { source: 'npm', package: '@example/remote-plugin' } },
    ]);
  });
});
