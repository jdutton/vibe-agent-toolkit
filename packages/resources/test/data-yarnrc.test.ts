/**
 * The `data` instance's extractor, variant `yarnrc`: a `.yarnrc.yml` read as YAML and kept only
 * through its key allowlist, so no auth key (top-level or nested under a scope or registry) and
 * nothing outside the list becomes a row, a condition or a message.
 */

import { describe, expect, it } from 'vitest';

import type { ExtractedDataRows } from '../src/projection/data-extractor.js';

import { extractUnder, nodeAt, rowsOf } from './helpers/data-rows.js';

const TOKEN = 'secret-token-bytes';

const YARNRC = [
  'nodeLinker: node-modules',
  `npmAuthToken: ${TOKEN}`,
  `npmAuthIdent: ${TOKEN}`,
  `httpProxy: http://me:${TOKEN}@proxy.example`,
  'npmScopes:',
  '  acme:',
  '    npmRegistryServer: https://npm.acme.example',
  `    npmAuthToken: ${TOKEN}`,
  `    npmAuthToken: ${TOKEN}`,
  'npmRegistries:',
  '  "//npm.acme.example":',
  `    npmAuthIdent: ${TOKEN}`,
  '    npmAlwaysAuth: true',
  'packageExtensions:',
  '  "left-pad@*":',
  '    dependencies:',
  '      lodash: ^4',
  '',
].join('\n');

const yarnrcRows = (text: string): ExtractedDataRows => rowsOf(text, 'yarnrc');

describe('extractDataRows yarnrc: the allowlist', () => {
  const rows = yarnrcRows(YARNRC);

  it('keeps every allowlisted key and its subtree, minus the auth keys', () => {
    expect(rows.nodes.map(({ pointer }) => pointer)).toEqual([
      '',
      '/nodeLinker',
      '/npmScopes',
      '/npmScopes/acme',
      '/npmScopes/acme/npmRegistryServer',
      '/npmRegistries',
      '/npmRegistries/~1~1npm.acme.example',
      '/npmRegistries/~1~1npm.acme.example/npmAlwaysAuth',
      '/packageExtensions',
      '/packageExtensions/left-pad@*',
      '/packageExtensions/left-pad@*/dependencies',
      '/packageExtensions/left-pad@*/dependencies/lodash',
    ]);
  });

  it('holds the token in no row, condition or message', () => {
    expect(JSON.stringify(rows)).not.toContain(TOKEN);
  });

  it('renumbers ordinals, parents and child counts over the kept rows', () => {
    expect(rows.nodes.map(({ ordinal }) => ordinal)).toEqual(rows.nodes.map((_node, index) => index));
    expect(nodeAt(rows, '').childCount).toBe(4);
    expect(nodeAt(rows, '/npmScopes/acme').childCount).toBe(1);
    expect(nodeAt(rows, '/npmScopes/acme/npmRegistryServer').parent).toBe(nodeAt(rows, '/npmScopes/acme').ordinal);
    expect(rows.files[0].nodeCount).toBe(rows.nodes.length);
    expect(rows.documents[0]?.nodeCount).toBe(rows.nodes.length);
    expect(rows.files[0].maxDepth).toBe(4);
  });

  it('keeps a kept node\'s position from the source', () => {
    expect(nodeAt(rows, '/nodeLinker')).toMatchObject({ line: 1, column: 1, value: 'node-modules' });
    expect(nodeAt(rows, '/npmScopes/acme/npmRegistryServer')).toMatchObject({ line: 7, column: 5 });
  });

  it('drops the conditions a dropped node raised (a repeated auth key)', () => {
    expect(rows.conditions).toEqual([]);
  });

  it('keeps a kept node\'s condition, renumbered', () => {
    const repeated = yarnrcRows(`npmAuthToken: ${TOKEN}\nnpmAuthToken: ${TOKEN}\nnodeLinker: pnp\nnodeLinker: node-modules\n`);
    expect(repeated.conditions.map(({ code, seq, node }) => ({ code, seq, node }))).toEqual([
      { code: 'DATA_DUPLICATE_KEY', seq: 0, node: 2 },
    ]);
  });

  it('keeps only the root of a document whose root is not a map', () => {
    expect(yarnrcRows(`- ${TOKEN}\n`).nodes.map(({ pointer, childCount }) => [pointer, childCount])).toEqual([['', 0]]);
  });

  it('answers a defect without quoting the text', () => {
    const answer = extractUnder(`npmAuthToken: "${TOKEN}\n`, {}, 'yarnrc');
    expect(answer.outcome).toBe('defect');
    expect(JSON.stringify(answer)).not.toContain(TOKEN);
  });

  it('drops an allowlisted key whose value aliases a dropped row, so the alias cannot copy a secret', () => {
    const aliased = yarnrcRows(`npmAuthToken: &t ${TOKEN}\nnodeLinker: *t\nnpmScopes: {a: &s {x: 1}}\nnpmRegistries: *s\n`);
    expect(aliased.nodes.map(({ pointer }) => pointer)).toEqual(['', '/npmScopes', '/npmScopes/a', '/npmScopes/a/x', '/npmRegistries', '/npmRegistries/x']);
    expect(nodeAt(aliased, '/npmRegistries').aliasOf).toBe(nodeAt(aliased, '/npmScopes/a').ordinal);
    expect(nodeAt(aliased, '/npmRegistries/x').aliasOf).toBe(nodeAt(aliased, '/npmScopes/a/x').ordinal);
    expect(JSON.stringify(aliased)).not.toContain(TOKEN);
  });

  it.each([
    ['a %YAML directive naming a version', `%YAML ${TOKEN}\n---\nnodeLinker: pnp\n`],
    ['an alias naming no anchor', `nodeLinker: *${TOKEN}\n`],
    ['a malformed stream', `nodeLinker: [${TOKEN}\n`],
  ])('never quotes file text in a defect: %s', (_case, text) => {
    const answer = extractUnder(text, {}, 'yarnrc');
    expect(answer.outcome).toBe('defect');
    expect(JSON.stringify(answer)).not.toContain(TOKEN);
  });
});

/** Escape text for a YAML double-quoted scalar so it decodes to exactly the text. */
function yamlQuote(decoded: string): string {
  return decoded.replaceAll('\\', String.raw`\\`).replaceAll('"', String.raw`\"`);
}

describe('extractDataRows yarnrc: a URL under a kept key that can carry a credential is dropped with its subtree', () => {
  const cases: ReadonlyArray<readonly [string, string, readonly string[]]> = [
    ['npmRegistryServer with userinfo', `npmRegistryServer: "https://user:${TOKEN}@reg.example"\nnodeLinker: pnp\n`, ['', '/nodeLinker']],
    ['a scope npmRegistryServer with userinfo', `npmScopes:\n  acme:\n    npmRegistryServer: "https://${TOKEN}@reg.example"\n    npmAlwaysAuth: true\n`, ['', '/npmScopes', '/npmScopes/acme', '/npmScopes/acme/npmAlwaysAuth']],
    ['an npmRegistries key with userinfo', `npmRegistries:\n  "https://u:${TOKEN}@r.example":\n    npmAlwaysAuth: true\n  "//ok.example":\n    npmAlwaysAuth: true\n`, ['', '/npmRegistries', '/npmRegistries/~1~1ok.example', '/npmRegistries/~1~1ok.example/npmAlwaysAuth']],
    ['a plugin spec with a query', `plugins:\n  - path: ./p.js\n    spec: "https://x.example/p.js?token=${TOKEN}"\n`, ['', '/plugins', '/plugins/0', '/plugins/0/path']],
    ['a scheme-less registry URL with userinfo', `npmPublishRegistry: "//${TOKEN}@r.example/"\n`, ['']],
    ['userinfo behind backslashes', `npmScopes:\n  a:\n    npmRegistryServer: "https:\\\\u:${TOKEN}@h"\n`, ['', '/npmScopes', '/npmScopes/a']],
    ['userinfo behind one slash', `npmScopes:\n  a:\n    npmRegistryServer: "https:/u:${TOKEN}@h"\n`, ['', '/npmScopes', '/npmScopes/a']],
    ['userinfo behind no slash', `npmScopes:\n  a:\n    npmRegistryServer: "https:u:${TOKEN}@h"\n`, ['', '/npmScopes', '/npmScopes/a']],
    ['a # inside the userinfo', `npmScopes:\n  a:\n    npmRegistryServer: "https://u:${TOKEN}#frag@h"\n`, ['', '/npmScopes', '/npmScopes/a']],
    ['a rejected value with whitespace in the userinfo', `npmScopes:\n  a:\n    npmRegistryServer: "https://u s:${TOKEN}@h^"\n`, ['', '/npmScopes', '/npmScopes/a']],
    ['a rejected map key with whitespace in the userinfo', `npmRegistries:\n  "https://u s:${TOKEN}@h^":\n    npmAlwaysAuth: true\n  "//ok.example":\n    npmAlwaysAuth: true\n`, ['', '/npmRegistries', '/npmRegistries/~1~1ok.example', '/npmRegistries/~1~1ok.example/npmAlwaysAuth']],
    ['a rejected value with a newline before the userinfo', `npmScopes:\n  a:\n    npmRegistryServer: "/\\n/u:${TOKEN}@h"\n`, ['', '/npmScopes', '/npmScopes/a']],
    ['an ssh URL with a password', `plugins:\n  - spec: "git+ssh://git:${TOKEN}@h/x"\n`, ['', '/plugins', '/plugins/0']],
    ...[
      'https:u s:SEC@h^',
      'https:/u s:SEC@h^',
      'https:///u s:SEC@h^',
      String.raw`https:\\u s:SEC@h^`,
      String.raw`\\SEC@h`,
      String.raw`/\SEC@h`,
      'SEC@h:1/x',
      'h/x?t=SEC',
      'a@b?t=SEC',
      'a@b:SEC',
      'a@b/x',
      String.raw`a@b\SEC`,
      'a@b@c',
      'https://x y/p?token=SEC',
    ].map((decoded): readonly [string, string, readonly string[]] => [
      `a value no URL parser accepts, holding an @ or a ?: ${decoded}`,
      `npmScopes:\n  a:\n    npmRegistryServer: "${yamlQuote(decoded.replace('SEC', TOKEN))}"\n`,
      ['', '/npmScopes', '/npmScopes/a'],
    ]),
    ['an https URL with a username only', `plugins:\n  - spec: "https://${TOKEN}@h/x"\n`, ['', '/plugins', '/plugins/0']],
  ];
  it.each(cases)('%s', (_case, text, pointers) => {
    const rows = yarnrcRows(text);
    expect(rows.nodes.map(({ pointer }) => pointer)).toEqual(pointers);
    expect(JSON.stringify(rows)).not.toContain(TOKEN);
  });

  it('keeps a URL with neither userinfo nor a query', () => {
    const rows = yarnrcRows('npmRegistryServer: https://registry.npmjs.org\nplugins:\n  - spec: "npm:@yarnpkg/plugin-workspace-tools"\n');
    expect(nodeAt(rows, '/npmRegistryServer').value).toBe('https://registry.npmjs.org');
    expect(nodeAt(rows, '/plugins/0/spec').value).toBe('npm:@yarnpkg/plugin-workspace-tools');
  });

  // A wholly npm package descriptor is not a credential, though no URL parser accepts it.
  it.each(['left-pad@*', 'react@^18.0.0', '@scope/name@1.x', '@yarnpkg/plugin-workspace-tools'])('keeps the package descriptor %s as a value and as a packageExtensions key', (descriptor) => {
    const rows = yarnrcRows(`packageExtensions:\n  "${descriptor}":\n    x: 1\nplugins:\n  - spec: "${descriptor}"\n`);
    expect(nodeAt(rows, '/plugins/0/spec').value).toBe(descriptor);
    expect(rows.nodes.map(({ pointer }) => pointer)).toContain(`/packageExtensions/${descriptor.replaceAll('/', '~1')}/x`);
  });

  // A path-shaped value (`yarn plugin import` writes one) and a compound range are kept.
  it.each(['.yarn/plugins/@yarnpkg/plugin-x.cjs', './.yarn/plugins/@yarnpkg/plugin-x.cjs'])('keeps the plugin path %s as `path` and as `spec`', (path) => {
    const rows = yarnrcRows(`plugins:\n  - path: "${path}"\n    spec: "${path}"\n`);
    expect(nodeAt(rows, '/plugins/0/path').value).toBe(path);
    expect(nodeAt(rows, '/plugins/0/spec').value).toBe(path);
  });

  it.each(['@scope/name@^1 || 2', 'react@>=16 <18'])('keeps the compound-range descriptor %s as a packageExtensions key', (descriptor) => {
    const rows = yarnrcRows(`packageExtensions:\n  "${descriptor}":\n    x: 1\n`);
    expect(rows.nodes.map(({ pointer }) => pointer)).toContain(`/packageExtensions/${descriptor.replaceAll('/', '~1')}/x`);
  });

  // The accepted over-drop: an npm: alias range holds a colon, which a credential shape also holds.
  it('drops the npm: alias descriptor left-pad@npm:1', () => {
    const rows = yarnrcRows('packageExtensions:\n  "left-pad@npm:1":\n    x: 1\n');
    expect(rows.nodes.map(({ pointer }) => pointer)).toEqual(['', '/packageExtensions']);
  });

  it.each([
    ['git+ssh', 'git+ssh://git@h/x'],
    ['ssh', 'ssh://git@h/x'],
  ])('keeps %s with a username only', (_case, spec) => {
    const rows = yarnrcRows(`plugins:\n  - spec: "${spec}"\n`);
    expect(nodeAt(rows, '/plugins/0/spec').value).toBe(spec);
  });

  it.each([String.raw`^\a b\c`, 'what is this', 'npm:@scope/pkg@^1.0.0'])('keeps the non-URL text %s', (spec) => {
    const rows = yarnrcRows(`plugins:\n  - spec: "${yamlQuote(spec)}"\n`);
    expect(nodeAt(rows, '/plugins/0/spec').value).toBe(spec);
  });

  // The accepted over-drop: no URL parser accepts these, and each holds an @ or a ?, so the rule cannot
  // tell them from a credential.
  it.each(['what-is-this?', 'git@github.com:a/b.git'])('drops the non-URL text %s, which holds an @ or a ?', (spec) => {
    const rows = yarnrcRows(`plugins:\n  - spec: "${yamlQuote(spec)}"\n`);
    expect(rows.nodes.map(({ pointer }) => pointer)).toEqual(['', '/plugins', '/plugins/0']);
  });

  it('drops an alias used as a map key, since its text is the anchor value', () => {
    const rows = yarnrcRows(`npmAuthToken: &k ${TOKEN}\nnpmScopes:\n  *k : x\n  ok: y\n`);
    expect(rows.nodes.map(({ pointer }) => pointer)).toEqual(['', '/npmScopes', '/npmScopes/ok']);
    expect(JSON.stringify(rows)).not.toContain(TOKEN);
  });

  it('drops a complex key whose source text holds an auth key, or any flow-collection key', () => {
    const rows = yarnrcRows(`npmScopes:\n  ? {npmAuthToken: ${TOKEN}}\n  : x\n  ? [${TOKEN}]\n  : y\n  ok: z\n`);
    expect(rows.nodes.map(({ pointer }) => pointer)).toEqual(['', '/npmScopes', '/npmScopes/ok']);
    expect(JSON.stringify(rows)).not.toContain(TOKEN);
  });
});
