/**
 * The store's write guard (`PopulationCache.treeUnchanged`) over a repository whose markdown goes
 * through an LFS filter.
 *
 * Under `filter=lfs` the tree hash carries a POINTER blob, so it describes a file pulled and not
 * pulled alike. The key carries each pointer's pulled bit, and the guard checks what the run read
 * at each pulled path against the pointer's oid: an extent is filed only when both still describe
 * the bytes the run read.
 *
 * The filter is the repository's emulated clean/smudge pair (`packages/utils/test/fixtures/lfs-filter.mjs`)
 * under a fixture home (`createLfsFixtureRepo`); the store backend is the shared fake, since what
 * is under test is the guard, not the engine.
 */

import { mkdtempSync, rmSync } from 'node:fs';

import {
  ContributorRegistry,
  crawlSourceFor,
  DEFAULT_CONTENT_DEMAND,
  FilesystemExtentContributor,
  formatContentKey,
  populate,
  withPopulationRun,
  type PopulationCache,
  type RealizedContent,
  type RealizedContentKeys,
} from '@vibe-agent-toolkit/resources';
import { normalizedTmpdir, resolveFromImportMeta, safePath, VAT_CACHE_DIR_ENV } from '@vibe-agent-toolkit/utils';
import { createLfsFixtureRepo, type LfsFixtureRepo, lfsOidOf, lfsPointerOf } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureStderr, isolateProjectionStoreTests } from '../projection-store-test-doubles.js';

vi.mock('@vibe-agent-toolkit/projection-sqlite', async () =>
  (await import('../projection-store-test-doubles.js')).backend.moduleExports());

const { CACHE_ENV, openPopulationCache, PROJECTION_STORE_ENV, PROJECTION_STORE_SQLITE, withPopulationCache } =
  await import('../../src/utils/projection-store.js');
const { resetUnscopedNoticeLedger } = await import('../../src/utils/operator-notices.js');

const FILTER_SCRIPT = resolveFromImportMeta(import.meta.url, '../../../utils/test/fixtures/lfs-filter.mjs');

/** The LFS markdown file, its root-relative path. */
const LFS_DOC = 'docs/big.md';
/** 3,000-odd bytes: a pointer is 129, so the sizes tell pulled from not pulled. */
const CONTENT = `# Big\n\n${'lfs content '.repeat(250)}\n`;
/** A hex no content here hashes to. */
const OTHER_HEX = 'ab'.repeat(32);

let dir: string;
let fixture: LfsFixtureRepo;

isolateProjectionStoreTests({ envNames: [PROJECTION_STORE_ENV, CACHE_ENV, VAT_CACHE_DIR_ENV], resetUnscopedNoticeLedger });

beforeEach(() => {
  dir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-store-lfs-'));
  fixture = createLfsFixtureRepo({ dir, filterScript: FILTER_SCRIPT });
  for (const [name, value] of Object.entries(fixture.env)) vi.stubEnv(name, value);
  process.env[PROJECTION_STORE_ENV] = PROJECTION_STORE_SQLITE;
  process.env[VAT_CACHE_DIR_ENV] = safePath.join(dir, 'cache');
  fixture.configureFilter();
  fixture.commit({
    '.gitattributes': 'docs/*.md filter=lfs diff=lfs merge=lfs -text\n',
    [LFS_DOC]: CONTENT,
    'sub/plain.md': '# Plain\n',
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

/** A realization keyed `markdown.sha256.<hex>`. */
function keyedAt(hex: string): RealizedContent {
  return { contentKey: formatContentKey({ parserKind: 'markdown', keyKind: 'sha256', hex }), contentState: 'keyed' };
}

/** A lookup answering `content` at the LFS file and nothing anywhere else. */
function realizedAtLfsDoc(content: RealizedContent | undefined): RealizedContentKeys {
  const lfsDoc = safePath.join(fixture.repo, LFS_DOC);
  return (absolutePath) => (absolutePath === lfsDoc ? content : undefined);
}

/** `treeUnchanged` of a cache opened over `root`, asked with `realized`. */
async function treeUnchangedAt(root: string, realized: RealizedContentKeys): Promise<boolean> {
  const opened = await openPopulationCache({ root });
  if (opened === undefined) throw new Error('no cache was opened');
  try {
    return opened.cache.treeUnchanged(realized);
  } finally {
    await opened.close();
  }
}

describe('treeUnchanged checks a pulled LFS file against what the run read', () => {
  it('holds when the run keyed the pulled file as its pointer\'s oid (control)', async () => {
    expect(await treeUnchangedAt(fixture.repo, realizedAtLfsDoc(keyedAt(lfsOidOf(CONTENT))))).toBe(true);
  });

  it('fails when the run keyed the pulled file as other bytes, though the tree hash is unchanged', async () => {
    expect(await treeUnchangedAt(fixture.repo, realizedAtLfsDoc(keyedAt(OTHER_HEX)))).toBe(false);
  });

  it('holds when the run realized nothing at a pulled file: its crawl did not include it', async () => {
    expect(await treeUnchangedAt(fixture.repo, realizedAtLfsDoc(undefined))).toBe(true);
  });

  it('holds when the run realized the pulled file without reading it', async () => {
    expect(await treeUnchangedAt(fixture.repo, realizedAtLfsDoc({ contentKey: null, contentState: 'deferred' }))).toBe(true);
  });

  it('does not ask about a pulled file outside the root', async () => {
    expect(await treeUnchangedAt(safePath.join(fixture.repo, 'sub'), realizedAtLfsDoc(keyedAt(OTHER_HEX)))).toBe(true);
  });

  it('does not ask about a file that is not pulled', async () => {
    fixture.writeAndRefresh(LFS_DOC, lfsPointerOf(CONTENT));
    expect(await treeUnchangedAt(fixture.repo, realizedAtLfsDoc(keyedAt(OTHER_HEX)))).toBe(true);
  });
});

/** The start of the notice a tree with pulled LFS files and no configured filter gets. */
const LFS_FILTER_NOTICE = 'with Git LFS files in it, but this environment configures no git-lfs filter';

/** What opening a cache over the fixture wrote to stderr. */
async function stderrOfOpen(): Promise<string> {
  const stderr = captureStderr();
  try {
    const opened = await openPopulationCache({ root: fixture.repo });
    await opened?.close();
  } finally {
    stderr.restore();
  }
  return stderr.written.join('');
}

describe('the notice that no LFS filter is configured', () => {
  it('is given when a pulled LFS file is keyed with no filter configured', async () => {
    fixture.git('config', '--remove-section', 'filter.lfs');
    expect(await stderrOfOpen()).toContain(LFS_FILTER_NOTICE);
  });

  it('is not given when no LFS file is pulled: nothing could be re-cleaned', async () => {
    fixture.writeAndRefresh(LFS_DOC, lfsPointerOf(CONTENT));
    fixture.git('config', '--remove-section', 'filter.lfs');
    expect(await stderrOfOpen()).not.toContain(LFS_FILTER_NOTICE);
  });
});

describe('an LFS file the key cannot decide', () => {
  it('opens no store and says why, as every tree git cannot key', async () => {
    // A pointer written CRLF cleans to the committed pointer, so its stat is recorded clean, but its
    // size on disk is neither the pointer's nor the content's.
    fixture.writeAndRefresh(LFS_DOC, lfsPointerOf(CONTENT).replaceAll('\n', '\r\n'));
    const stderr = captureStderr();
    try {
      expect(await openPopulationCache({ root: fixture.repo })).toBeUndefined();
    } finally {
      stderr.restore();
    }
    const written = stderr.written.join('');
    expect(written).toContain('git cannot key this tree');
    expect(written).toContain(LFS_DOC);
  });
});

describe('a pull landing between the key and the write', () => {
  it('files no extent: the run is skipped-tree-changed', async () => {
    fixture.writeAndRefresh(LFS_DOC, lfsPointerOf(CONTENT));
    const root = fixture.repo;
    const outcome = await withPopulationCache({ root }, async (cache) => {
      if (cache === undefined) throw new Error('no cache was opened');
      const pulledMidRun: PopulationCache = {
        ...cache,
        treeUnchanged: (realized) => {
          fixture.writeAndRefresh(LFS_DOC, CONTENT);
          return cache.treeUnchanged(realized);
        },
      };
      const registry = new ContributorRegistry();
      registry.register(new FilesystemExtentContributor((at) => crawlSourceFor(at, []), DEFAULT_CONTENT_DEMAND));
      return (await withPopulationRun((run) => populate({ root, registry, run, cache: pulledMidRun }))).outcome;
    });
    expect(outcome).toEqual({ population: 'derived', stored: 'skipped-tree-changed' });
  });
});
