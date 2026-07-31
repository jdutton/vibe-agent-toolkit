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
      plugins: [{ name: 'b', author: { name: 'Org' } }],
    });

    expect(json['owner']).toEqual({ name: 'Org' });
    expect(json['plugins']).toEqual([
      { name: 'b', source: './plugins/b', author: { name: 'Org' } },
    ]);
  });
});
