/**
 * Warm edit seeds, configuration and attributes: a warm run after an edit to what decides how
 * the tree is read extracts only the keys the primed store lacks and serves every other from the
 * stored blob tier (the harness's `editServed` tell).
 *
 * - a config edit that overrides one file's parser kind (a collection's `mimeType` over that one
 *   path): the same bytes key afresh under the other kind, and so does the config itself;
 * - a `.gitignore` added: a member leaves the tree, and only the ignore file's key is new;
 * - a `.gitattributes` added: no bytes on disk change, only the attributes file's key is new;
 * - a filter attribute: a clean filter makes git see a tracked file modified while its bytes on
 *   disk, which the population keys, stay; only the attributes file's key is new.
 *
 * Every change is uncommitted, and git's own config is the repository's: `HEAD` never moves.
 */

import { utimesSync, writeFileSync } from 'node:fs';

import { safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { GATE_FIXTURE } from '../helpers/cache-differential.js';
import { contentKeyAt, editSeed, editSeedCases, primeAndReference } from '../helpers/warm-edit-seeds.js';

const CONFIG = 'vibe-agent-toolkit.config.yaml';

/** The file the config override re-types, and the type it declares. */
const RETYPED = 'docs/two.md';

/** The gate fixture's config with one collection typing one markdown file as HTML. */
function overriddenConfig(): string {
  const config = GATE_FIXTURE[CONFIG];
  if (config === undefined) throw new Error(`the gate fixture has no ${CONFIG}`);
  // `**/`-anchored: a plain path in `include` is read as a directory.
  const collection = ['  collections:', '    as-html:', '      include:', `        - "**/${RETYPED}"`, '      mimeType: text/html'].join('\n');
  expect(config.startsWith('resources:\n'), `${CONFIG} opens with its resources block`).toBe(true);
  return config.replace('resources:\n', `resources:\n${collection}\n`);
}

const configOverride = editSeed({
  name: 'config override of one file\'s parser kind',
  toB: (_arm, _dirs, corpus) => {
    writeFileSync(safePath.join(corpus, CONFIG), overriddenConfig());
    return Promise.resolve();
  },
  uncovered: (_dirs, corpus) => [contentKeyAt(corpus, CONFIG), contentKeyAt(corpus, RETYPED, 'html')],
  consumed: primeAndReference((keysAt) => {
    // Same bytes, another kind: the kind alone separates the rows.
    const [primed] = keysAt('warmSameHistory:prime', RETYPED);
    const [measured] = keysAt('storeOff:measured', RETYPED);
    expect(String(primed).startsWith('markdown.'), `${RETYPED}: primed as markdown`).toBe(true);
    expect(String(measured).startsWith('html.'), `${RETYPED}: measured as HTML`).toBe(true);
  }),
});

/** The fixture's untracked file, which the added `.gitignore` drops from the tree. */
const IGNORED = 'docs/notes.md';

const gitignoreEdit = editSeed({
  name: '.gitignore edit',
  toB: (_arm, _dirs, corpus, git) => {
    writeFileSync(safePath.join(corpus, '.gitignore'), `${IGNORED}\n`);
    expect(git(['check-ignore', '--', IGNORED]).trim(), `${IGNORED} is ignored`).toBe(IGNORED);
    return Promise.resolve();
  },
  uncovered: (_dirs, corpus) => [contentKeyAt(corpus, '.gitignore')],
  consumed: primeAndReference((keysAt) => {
    expect(keysAt('warmSameHistory:prime', IGNORED), `${IGNORED}: a member of the prime`).toHaveLength(1);
    expect(keysAt('storeOff:measured', IGNORED), `${IGNORED}: ignored`).toEqual([]);
  }),
});

/** The tracked file an attribute names. */
const ATTRIBUTED = 'docs/two.md';

/**
 * What an attribute seed shares: only the attributes file's key is new, and the attributed
 * file's key, from its bytes on disk, is the primed one.
 *
 * @param why - Why the attributed file's key stays
 * @returns The seed's `uncovered` and `consumed`
 */
function attributeKeysStay(why: string): Pick<Parameters<typeof editSeed>[0], 'uncovered' | 'consumed'> {
  return {
    uncovered: (_dirs, corpus) => [contentKeyAt(corpus, '.gitattributes')],
    consumed: primeAndReference((keysAt) => {
      expect(keysAt('storeOff:measured', ATTRIBUTED), `${ATTRIBUTED}: ${why}`).toEqual(keysAt('warmSameHistory:prime', ATTRIBUTED));
    }),
  };
}

const gitattributesEdit = editSeed({
  name: '.gitattributes edit',
  toB: (_arm, _dirs, corpus, git) => {
    writeFileSync(safePath.join(corpus, '.gitattributes'), `${ATTRIBUTED} diff=markdown\n`);
    expect(git(['check-attr', 'diff', '--', ATTRIBUTED]).trim(), 'git reads the attribute').toBe(`${ATTRIBUTED}: diff: markdown`);
    return Promise.resolve();
  },
  ...attributeKeysStay('its bytes, and so its key, unchanged'),
});

/** A clean filter that prefixes a line: git's cleaned blob differs from the bytes on disk. */
const PREFIX_FILTER_SCRIPT = String.raw`
const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => process.stdout.write(Buffer.concat([Buffer.from('cleaned by the filter\n'), ...chunks])));
`;

/** The filtered file's mtime after the attribute lands: fixed, so every cell stamps it alike. */
const FILTERED_MTIME = new Date('2026-01-01T00:00:00.000Z');

const filterAttribute = editSeed({
  name: 'filter attribute',
  toB: (_arm, dirs, corpus, git) => {
    const script = safePath.join(dirs.home, 'prefix-filter.cjs');
    writeFileSync(script, PREFIX_FILTER_SCRIPT);
    // A JSON string is a double-quoted shell word, which is how git runs the filter.
    const quoted = [process.execPath, script].map((path) => JSON.stringify(toForwardSlash(path))).join(' ');
    git(['config', 'filter.prefix.clean', quoted]);
    writeFileSync(safePath.join(corpus, '.gitattributes'), `${ATTRIBUTED} filter=prefix\n`);
    // A new mtime, the same bytes: git's index stat no longer vouches for the file, so git cleans it again.
    utimesSync(safePath.join(corpus, ATTRIBUTED), FILTERED_MTIME, FILTERED_MTIME);
    expect(git(['status', '--porcelain', '--', ATTRIBUTED]).trim(), `git sees ${ATTRIBUTED} through the filter`).toBe(`M ${ATTRIBUTED}`);
    return Promise.resolve();
  },
  ...attributeKeysStay('keyed from its bytes on disk, unchanged'),
});

describe('warm edit: configuration and attributes', () => {
  for (const seed of editSeedCases([configOverride, gitignoreEdit, gitattributesEdit, filterAttribute], import.meta.url)) {
    it.skipIf(seed.unplantable)(seed.title, seed.run);
  }
});
