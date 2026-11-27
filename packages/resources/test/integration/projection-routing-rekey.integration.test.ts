/**
 * A routing change re-keys a path whose bytes did not change.
 *
 * The parser kind is an unhashed qualifier in the content key's text: a `sha256` key's hex is the
 * plain SHA-256 of the raw bytes, the same under every kind. What keeps a re-routed path from being
 * served the facts its old parser derived is that the kind is IN the key text. This guard runs one
 * store twice over one unchanged tree: the first run declares a collection that types `notes.ts` as
 * markdown, the second declares none, so the same bytes route to `none`. The second run's key must
 * name `none`, its rows must be `none` rows, and the store must never be asked for the markdown key.
 */

import { removeTempDir } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { type ContentKey, contentKeyParts } from '../../src/content-key.js';
import type { PopulationOutcome } from '../../src/projection/merge.js';
import type { Projection } from '../../src/projection/projection.js';
import type { BlobFactsRead, BlobRequest, BlobScopedTableName } from '../../src/projection/store.js';
import type { CollectionConfig } from '../../src/schemas/project-config.js';
import { FakeFactStore, WIDE_STORE_BUDGETS } from '../fake-fact-store.js';
import { keyedContentKeyOf as keyOf, populateFilesystemExtent } from '../helpers/filesystem-population.js';
import { createCommittedRepo } from '../test-helpers.js';

/** The re-routed file: a heading and a link, so a markdown parse and a `none` read differ in their rows. */
const ROUTED = 'notes.ts';

const TREE: Readonly<Record<string, string>> = {
  [ROUTED]: '# Notes\n\nSee [home](./README.md).\n',
  'README.md': '# Home\n',
};

/** The declaration that types {@link ROUTED} as markdown in the first run. */
const TS_AS_MARKDOWN: Readonly<Record<string, CollectionConfig>> = {
  sources: { include: ['**/*.ts'], mimeType: 'text/markdown' },
};

/** One tree key for both runs: the tree does not move, only the routing does. */
const TREE_HASH = 'tree-routing-rekey';

/** A store double that records every content key its blob tier is asked for. */
class KeyRecordingStore extends FakeFactStore {
  readonly askedKeys: ContentKey[] = [];

  override readBlobFacts<Table extends BlobScopedTableName>(
    contentKeys: readonly ContentKey[],
    request: BlobRequest<Table>,
  ): Promise<BlobFactsRead<Table>> {
    this.askedKeys.push(...contentKeys);
    return super.readBlobFacts(contentKeys, request);
  }
}

let root = '';

beforeAll(() => {
  // The parse cache would serve a run what an earlier run parsed; this suite judges the store alone.
  vi.stubEnv('VAT_CACHE', '0');
});

afterAll(() => {
  vi.unstubAllEnvs();
});

beforeEach(() => {
  root = createCommittedRepo('vat-routing-rekey-', { files: { ...TREE }, gitignore: '' });
});

afterEach(() => {
  removeTempDir(root);
});

/** One population of {@link root} through `store`, with `collections` declared or not. */
function populateWith(
  store: FakeFactStore,
  collections: Readonly<Record<string, CollectionConfig>> | undefined,
): Promise<{ readonly projection: Projection; readonly outcome: PopulationOutcome }> {
  return populateFilesystemExtent(root, { store, treeHash: TREE_HASH, treeUnchanged: () => true }, collections);
}

describe('a routing change between two runs on one store', () => {
  it('re-keys the same bytes under the new parser kind and serves nothing from the old key', async () => {
    const store = new KeyRecordingStore(WIDE_STORE_BUDGETS);

    const first = await populateWith(store, TS_AS_MARKDOWN);
    expect(first.outcome).toEqual({ population: 'derived', stored: 'written' });
    const markdownKey = keyOf(first.projection, ROUTED);
    expect(contentKeyParts(markdownKey).parserKind, 'the premise: the declaration routes it to markdown').toBe('markdown');
    const markdownBlob = first.projection.blobs.find((row) => row.contentKey === markdownKey);
    expect(markdownBlob?.headingCount, 'the premise: the markdown parse saw the heading').toBe(1);

    store.askedKeys.length = 0;
    const second = await populateWith(store, undefined);

    const noneKey = keyOf(second.projection, ROUTED);
    expect(contentKeyParts(noneKey).parserKind, 'the re-routed path names its new parser kind').toBe('none');
    expect(noneKey).not.toBe(markdownKey);
    // Same bytes: the hex, the plain SHA-256, is the one thing the two keys share.
    expect(contentKeyParts(noneKey).hex).toBe(contentKeyParts(markdownKey).hex);

    const noneBlob = second.projection.blobs.find((row) => row.contentKey === noneKey);
    expect(noneBlob?.headingCount, 'the second run\'s rows are a `none` read, not the markdown parse').toBe(0);
    expect(second.projection.blobs.some((row) => row.contentKey === markdownKey), 'a markdown row reached the second run').toBe(false);
    expect(store.askedKeys, 'the second run asked the store for the markdown key').not.toContain(markdownKey);
  });
});
