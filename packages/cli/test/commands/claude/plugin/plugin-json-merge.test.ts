/* eslint-disable sonarjs/no-duplicate-string */
import { describe, expect, it } from 'vitest';

import {
  mergePluginJson,
  resolveVersion,
} from '../../../../src/commands/claude/plugin/plugin-json-merge.js';

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

  it('VAT wins on name/author/version (caller pre-resolves version)', () => {
    // Per the multi-plugin marketplace versioning design, version precedence
    // (config > plugin.json > root) is resolved by the caller via
    // resolveVersion BEFORE invoking mergePluginJson. By the time we get here,
    // vat.version IS the resolved answer — author-supplied versions are
    // discarded. Name and author follow the same VAT-wins pattern.
    const { merged, warnings } = mergePluginJson({
      vat: vatFields,
      configDescription: undefined,
      authorJson: {
        name: 'author-picked-name',
        author: 'author-picked-author-string',
      },
    });
    expect(merged['name']).toBe('my-plugin');
    expect(merged['version']).toBe('1.2.3');
    expect(merged['author']).toEqual({ name: 'Org', email: 'ops@org.example' });
    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('name'),
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

  // Author-subfield ownership. Config owns exactly the subfields the marketplace
  // `owner` can express (name, email). Everything else — notably `url`, which VAT's
  // config has NO field for — passes through from the author's plugin.json instead
  // of being destroyed: dropping it is data loss, not a precedence policy.
  const mergeAuthor = (author: unknown, vat = vatFields) =>
    mergePluginJson({ vat, configDescription: undefined, authorJson: { author } });

  it('keeps the config author when plugin.json declares no author', () => {
    const { merged, warnings } = mergePluginJson({
      vat: vatFields,
      configDescription: undefined,
      authorJson: { license: 'MIT' },
    });
    expect(merged['author']).toEqual({ name: 'Org', email: 'ops@org.example' });
    expect(warnings).toEqual([]);
  });

  it('passes author.url through — VAT config cannot express it, so config cannot own it', () => {
    const { merged, warnings } = mergeAuthor({
      name: 'Org',
      email: 'ops@org.example',
      url: 'https://org.example/about',
    });
    expect(merged['author']).toEqual({
      name: 'Org',
      email: 'ops@org.example',
      url: 'https://org.example/about',
    });
    expect(warnings).toEqual([]);
  });

  it('overrides name/email from config while preserving every unowned subfield', () => {
    const { merged, warnings } = mergeAuthor({
      name: 'Someone Else',
      email: 'someone@else.example',
      url: 'https://org.example/about',
      twitter: '@org',
    });
    expect(merged['author']).toEqual({
      name: 'Org',
      email: 'ops@org.example',
      url: 'https://org.example/about',
      twitter: '@org',
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('author');
  });

  it('preserves an author object that supplies ONLY url', () => {
    const { merged, warnings } = mergeAuthor({ url: 'https://org.example/about' });
    expect(merged['author']).toEqual({
      name: 'Org',
      email: 'ops@org.example',
      url: 'https://org.example/about',
    });
    expect(warnings).toEqual([]);
  });

  it('does not manufacture a disagreement warning from plugin.json key order', () => {
    const { warnings } = mergeAuthor({
      url: 'https://org.example/',
      email: 'ops@org.example',
      name: 'Org',
    });
    expect(warnings).toEqual([]);
  });

  it('replaces a non-object author wholesale (an npm-style string cannot be merged)', () => {
    const { merged, warnings } = mergeAuthor('Org <ops@org.example> (https://org.example)');
    expect(merged['author']).toEqual({ name: 'Org', email: 'ops@org.example' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('author');
  });

  it('owns email even when config omits it — owner.email IS config-expressible', () => {
    const { merged, warnings } = mergeAuthor(
      { name: 'Org', email: 'dropped@org.example', url: 'https://org.example/' },
      { name: 'my-plugin', version: '1.2.3', author: { name: 'Org' } },
    );
    expect(merged['author']).toEqual({ name: 'Org', url: 'https://org.example/' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('email');
  });

  it('omits version when caller-resolved vat.version is undefined (even if authorJson has one)', () => {
    // Under Option A semantics, the caller pre-resolves version via resolveVersion.
    // If vat.version is undefined here, all three sources (config, plugin.json,
    // root) were absent — the author-supplied value would already have been
    // picked up upstream. Reaching this with vat.version=undefined plus an
    // authorJson.version means the upstream resolution explicitly chose
    // undefined; mergePluginJson must respect that.
    const vatNoVersion = { name: 'my-plugin', version: undefined, author: { name: 'Org' } };
    const { merged, warnings } = mergePluginJson({
      vat: vatNoVersion,
      configDescription: undefined,
      authorJson: { version: '7.8.9' },
    });
    expect('version' in merged).toBe(false);
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

function makeSink(): { warnings: string[]; warn: (m: string) => void } {
  const warnings: string[] = [];
  return {
    warnings,
    warn(m: string) {
      warnings.push(m);
    },
  };
}

describe('resolveVersion', () => {
  it('config wins over plugin.json over root', () => {
    const sink = makeSink();
    const result = resolveVersion(
      { version: '3.0.0' },
      { version: '2.0.0' },
      '1.0.0',
      sink,
    );
    expect(result).toBe('3.0.0');
  });

  it('plugin.json wins over root when no config', () => {
    const sink = makeSink();
    const result = resolveVersion(undefined, { version: '2.0.0' }, '1.0.0', sink);
    expect(result).toBe('2.0.0');
    expect(sink.warnings).toEqual([]);
  });

  it('root is fallback when neither config nor plugin.json supplied', () => {
    const sink = makeSink();
    const result = resolveVersion(undefined, undefined, '1.0.0', sink);
    expect(result).toBe('1.0.0');
    expect(sink.warnings).toEqual([]);
  });

  it('returns undefined when all three are undefined', () => {
    const sink = makeSink();
    const result = resolveVersion(undefined, undefined, undefined, sink);
    expect(result).toBeUndefined();
    expect(sink.warnings).toEqual([]);
  });

  it('warns when config and plugin.json disagree (config still wins)', () => {
    const sink = makeSink();
    const result = resolveVersion(
      { version: '3.0.0' },
      { version: '2.0.0' },
      '1.0.0',
      sink,
    );
    expect(result).toBe('3.0.0');
    expect(sink.warnings).toHaveLength(1);
    expect(sink.warnings[0]).toContain('3.0.0');
    expect(sink.warnings[0]).toContain('2.0.0');
    expect(sink.warnings[0]).toMatch(/mismatch/i);
  });

  it('does NOT warn when config and plugin.json agree', () => {
    const sink = makeSink();
    const result = resolveVersion(
      { version: '2.0.0' },
      { version: '2.0.0' },
      '1.0.0',
      sink,
    );
    expect(result).toBe('2.0.0');
    expect(sink.warnings).toEqual([]);
  });

  it('handles empty configEntry object (no version field)', () => {
    const sink = makeSink();
    const result = resolveVersion({}, { version: '2.0.0' }, '1.0.0', sink);
    expect(result).toBe('2.0.0');
    expect(sink.warnings).toEqual([]);
  });

  it('defaults logger to console when not provided', () => {
    // Just ensure no throw with default logger; agreement case so no warn fires.
    const result = resolveVersion({ version: '2.0.0' }, { version: '2.0.0' }, '1.0.0');
    expect(result).toBe('2.0.0');
  });
});
