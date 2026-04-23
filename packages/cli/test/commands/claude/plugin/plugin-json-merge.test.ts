/* eslint-disable sonarjs/no-duplicate-string */
import { describe, expect, it } from 'vitest';

import { mergePluginJson } from '../../../../src/commands/claude/plugin/plugin-json-merge.js';

describe('mergePluginJson', () => {
  const vatFields = {
    name: 'my-plugin',
    version: '1.2.3',
    author: { name: 'Org', email: 'ops@org.example' },
  };

  it('generates defaults when no author plugin.json present', () => {
    const { merged, warnings } = mergePluginJson({
      vat: vatFields,
      configDescription: undefined,
      authorJson: undefined,
    });
    expect(merged).toEqual({
      name: 'my-plugin',
      description: 'my-plugin plugin',
      version: '1.2.3',
      author: { name: 'Org', email: 'ops@org.example' },
    });
    expect(warnings).toEqual([]);
  });

  it('description chain: config wins over author over default', () => {
    const r1 = mergePluginJson({
      vat: vatFields,
      configDescription: 'from-config',
      authorJson: { description: 'from-author' },
    });
    expect(r1.merged['description']).toBe('from-config');

    const r2 = mergePluginJson({
      vat: vatFields,
      configDescription: undefined,
      authorJson: { description: 'from-author' },
    });
    expect(r2.merged['description']).toBe('from-author');

    const r3 = mergePluginJson({ vat: vatFields, configDescription: undefined, authorJson: {} });
    expect(r3.merged['description']).toBe('my-plugin plugin');
  });

  it('author wins on non-VAT keys (keywords, repository, homepage, license)', () => {
    const { merged } = mergePluginJson({
      vat: vatFields,
      configDescription: undefined,
      authorJson: {
        keywords: ['x', 'y'],
        repository: 'git+https://example/repo.git',
        homepage: 'https://example/',
        license: 'Apache-2.0',
      },
    });
    expect(merged['keywords']).toEqual(['x', 'y']);
    expect(merged['repository']).toBe('git+https://example/repo.git');
    expect(merged['homepage']).toBe('https://example/');
    expect(merged['license']).toBe('Apache-2.0');
  });

  it('VAT wins on name/version/author (shallow wholesale replace)', () => {
    const { merged, warnings } = mergePluginJson({
      vat: vatFields,
      configDescription: undefined,
      authorJson: {
        name: 'author-picked-name',
        version: '9.9.9',
        author: 'author-picked-author-string',
      },
    });
    expect(merged['name']).toBe('my-plugin');
    expect(merged['version']).toBe('1.2.3');
    expect(merged['author']).toEqual({ name: 'Org', email: 'ops@org.example' });
    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('name'),
        expect.stringContaining('version'),
        expect.stringContaining('author'),
      ]),
    );
  });

  it('does not warn when author-supplied VAT-winning fields equal VAT values', () => {
    const { warnings } = mergePluginJson({
      vat: vatFields,
      configDescription: undefined,
      authorJson: {
        name: 'my-plugin',
        version: '1.2.3',
        author: { name: 'Org', email: 'ops@org.example' },
      },
    });
    expect(warnings).toEqual([]);
  });

  it('discards any author.author shape entirely when it differs (no deep merge)', () => {
    const { merged } = mergePluginJson({
      vat: vatFields,
      configDescription: undefined,
      authorJson: { author: { name: 'Other', twitter: '@other', extra: true } },
    });
    expect(merged['author']).toEqual({ name: 'Org', email: 'ops@org.example' });
  });

  it('preserves author version when VAT has no version (no package.json)', () => {
    const vatNoVersion = { name: 'my-plugin', version: undefined, author: { name: 'Org' } };
    const { merged, warnings } = mergePluginJson({
      vat: vatNoVersion,
      configDescription: undefined,
      authorJson: { version: '7.8.9' },
    });
    expect(merged['version']).toBe('7.8.9');
    expect(warnings.filter((w) => w.includes('version'))).toEqual([]);
  });

  it('omits version entirely when neither VAT nor author supply one', () => {
    const vatNoVersion = { name: 'my-plugin', version: undefined, author: { name: 'Org' } };
    const { merged } = mergePluginJson({
      vat: vatNoVersion,
      configDescription: undefined,
      authorJson: {},
    });
    expect('version' in merged).toBe(false);
  });
});
