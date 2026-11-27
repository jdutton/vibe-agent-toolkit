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
});
