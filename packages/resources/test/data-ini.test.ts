/**
 * The `data` instance's extractor, variant `ini` (`.npmrc`, spec 6.1): only the
 * allowlisted top-level keys become rows, and nothing else in the file (a
 * credential above all) reaches a row, a condition or a message.
 */

import { describe, expect, it } from 'vitest';

import type { ExtractedDataNode, ExtractedDataRows } from '../src/projection/data-extractor.js';
import { NPMRC_ALLOWED_KEYS } from '../src/projection/data-ini.js';

import { extractUnder, nodeAt, rowsOf } from './helpers/data-rows.js';

/** The rows of an `.npmrc` text. */
const iniRows = (text: string, bom = false): ExtractedDataRows => rowsOf(text, 'ini', bom);

/** A value no row, condition or message may ever hold. */
const SENTINEL = 'SENTINEL-6f1c';

/** An `.npmrc` holding the sentinel as a registry token, as `_auth`, and under a section, around one kept key. */
const SECRETS = [
  `//registry.npmjs.org/:_authToken=${SENTINEL}`,
  `_auth=${SENTINEL}`,
  'link-workspace-packages=true',
  `${SENTINEL}=x`,
  `; ${SENTINEL} in a comment`,
  '[section]',
  `key=${SENTINEL}`,
  `link-workspace-packages=${SENTINEL}`,
].join('\n');

/** The columns a kept member's row carries beyond its value. */
function memberRow(key: string, ordinal: number, line: number, column: number, shadowed = false): Partial<ExtractedDataNode> {
  return {
    doc: 0, ordinal, parent: 0, pointer: `/${key}`, key, idx: null, depth: 2, childCount: 0,
    lexeme: null, tag: null, aliasOf: null, shadowed, line, column,
  };
}

describe('extractDataRows ini: the allowlist', () => {
  it('is exactly link-workspace-packages', () => {
    expect(NPMRC_ALLOWED_KEYS).toStrictEqual(['link-workspace-packages']);
  });

  it('keeps only the allowlisted top-level key, as one document whose root is an object', () => {
    const rows = iniRows(SECRETS);
    expect(rows.files).toStrictEqual([{ documents: 1, bom: false, nodeCount: 2, maxDepth: 1 }]);
    expect(rows.documents).toStrictEqual([{ doc: 0, rootType: 'object', nodeCount: 2, maxDepth: 1 }]);
    expect(rows.nodes).toStrictEqual([
      {
        doc: 0, ordinal: 0, parent: null, pointer: '', key: null, idx: null, depth: 1, type: 'object', value: null,
        lexeme: null, childCount: 1, tag: null, aliasOf: null, shadowed: false, line: 1, column: 1,
      },
      { ...memberRow('link-workspace-packages', 1, 3, 1), type: 'boolean', value: true },
    ]);
    expect(rows.conditions).toStrictEqual([]);
  });

  it('holds the sentinel in no row, condition or message', () => {
    expect(JSON.stringify(extractUnder(SECRETS, {}, 'ini'))).not.toContain(SENTINEL);
  });

  it('holds the sentinel in no message when a cap refuses the file', () => {
    expect(JSON.stringify(extractUnder(SECRETS, { outputRows: 1 }, 'ini'))).not.toContain(SENTINEL);
  });

  it.each([
    ['drops a key inside a section even when it is allowlisted', '[a]\nlink-workspace-packages=true\n', ['']],
    ['a JSON-valued key is not a section header: a later allowlisted key is kept', `foo='{"a":1}'\nlink-workspace-packages=true\n`, ['', '/link-workspace-packages']],
    ['a [__proto__] header ends the top level like any section', '[__proto__]\nlink-workspace-packages=true\n', ['']],
  ])('%s', (_name, text, pointers) => {
    expect(iniRows(text).nodes.map((node) => node.pointer)).toStrictEqual(pointers);
  });

  it('drops the bracketed-array form of an allowlisted key', () => {
    const rows = iniRows('link-workspace-packages[]=true\n');
    expect(rows.nodes.map((node) => node.pointer)).toStrictEqual(['']);
  });
});

describe('extractDataRows ini: values as ini returns them', () => {
  it.each([
    ['link-workspace-packages=true', 'boolean', true],
    ['link-workspace-packages=false', 'boolean', false],
    ['link-workspace-packages=null', 'null', null],
    ['link-workspace-packages', 'boolean', true],
    ['link-workspace-packages=deep', 'string', 'deep'],
    ['link-workspace-packages=', 'string', ''],
    ['link-workspace-packages = "true"', 'boolean', true],
    ['link-workspace-packages = "deep"', 'string', 'deep'],
    ['link-workspace-packages=${LINK}', 'string', '${LINK}'],
  ] as const)('%s is a %s', (text, type, value) => {
    expect(nodeAt(iniRows(text), '/link-workspace-packages')).toMatchObject({ type, value, lexeme: null });
  });

  it('places a member at its key, past leading whitespace, under the shared line rules', () => {
    const rows = iniRows('; c\r\n\r\n  link-workspace-packages=true\r');
    expect(nodeAt(rows, '/link-workspace-packages')).toMatchObject({ line: 3, column: 3 });
  });

  it('reads a quoted key as ini does', () => {
    expect(nodeAt(iniRows('"link-workspace-packages"=true'), '/link-workspace-packages')).toMatchObject({ value: true });
  });

  it('keeps the BOM column', () => {
    expect(iniRows('link-workspace-packages=true', true).files[0].bom).toBe(true);
  });

  it('is an empty root object for an empty file', () => {
    const rows = iniRows('');
    expect(rows.nodes).toHaveLength(1);
    expect(rows.nodes[0]).toMatchObject({ type: 'object', childCount: 0 });
  });
});

describe('extractDataRows ini: a repeated key', () => {
  it('lets the last occurrence win, shadows the earlier, and raises one DATA_DUPLICATE_KEY per repeat', () => {
    const rows = iniRows('link-workspace-packages=true\nlink-workspace-packages=false\nlink-workspace-packages=deep\n');
    expect(rows.nodes.slice(1)).toStrictEqual([
      { ...memberRow('link-workspace-packages', 1, 1, 1, true), type: 'boolean', value: true },
      { ...memberRow('link-workspace-packages', 2, 2, 1, true), type: 'boolean', value: false },
      { ...memberRow('link-workspace-packages', 3, 3, 1), type: 'string', value: 'deep' },
    ]);
    expect(rows.nodes[0]?.childCount).toBe(3);
    expect(rows.conditions.map(({ code, node, line }) => ({ code, node, line }))).toStrictEqual([
      { code: 'DATA_DUPLICATE_KEY', node: 2, line: 2 },
      { code: 'DATA_DUPLICATE_KEY', node: 3, line: 3 },
    ]);
  });

  it('quotes no value in the duplicate condition', () => {
    const rows = iniRows(`link-workspace-packages=${SENTINEL}\nlink-workspace-packages=true\n`);
    expect(JSON.stringify(rows.conditions)).not.toContain(SENTINEL);
  });
});
