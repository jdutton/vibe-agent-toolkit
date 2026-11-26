/**
 * The run's on-disk content source, which the blob stage and the harness pass
 * both read through: the bytes keyed under the blob's parser kind, null when the
 * file is gone, and every other failure loud.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { normalizedTmpdir, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { mkdirSyncReal } from '@vibe-agent-toolkit/utils/fs';
import { afterEach, describe, expect, it } from 'vitest';

import { computeContentKey } from '../../src/content-key.js';
import { NO_GIT_MEMBERS, RunContentCache } from '../../src/projection/content-cache.js';
import type { HarnessFrontierEntry } from '../../src/projection/harness/reach.js';
import { runContentSource } from '../../src/projection/run-population.js';

const WIDGETS = '# acme widgets\n';

const made: string[] = [];

/**
 * A temp root holding one `CLAUDE.md`, and the frontier entry naming it.
 *
 * @param content - The file's bytes, which the entry's key is minted from
 * @returns The file's absolute path and the entry
 */
function entryFor(content: string): { absolutePath: string; entry: HarnessFrontierEntry } {
  const directory = toForwardSlash(mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-harness-reader-')));
  made.push(directory);
  const absolutePath = safePath.join(directory, 'CLAUDE.md');
  writeFileSync(absolutePath, content, 'utf-8');
  const contentKey = computeContentKey(Buffer.from(content, 'utf-8'), 'markdown');
  return { absolutePath, entry: { contentKey, path: 'CLAUDE.md', rootId: 'acme', absolutePath } };
}

describe('runContentSource', () => {
  afterEach(() => {
    for (const directory of made.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it('reads the bytes under the blob\'s key, measured in them', async () => {
    const { entry } = entryFor(WIDGETS);
    await expect(runContentSource(new RunContentCache(NO_GIT_MEMBERS)).read(entry)).resolves.toMatchObject({
      key: entry.contentKey,
      content: WIDGETS,
      byteLength: Buffer.byteLength(WIDGETS, 'utf8'),
    });
  });

  it('answers rewritten bytes under their own key, for the caller to refuse', async () => {
    const { absolutePath, entry } = entryFor(WIDGETS);
    writeFileSync(absolutePath, '# rewritten\n', 'utf-8');
    const read = await runContentSource(new RunContentCache(NO_GIT_MEMBERS)).read(entry);
    expect(read?.content).toBe('# rewritten\n');
    expect(read?.key).not.toBe(entry.contentKey);
  });

  it('answers null when the file is gone', async () => {
    const { absolutePath, entry } = entryFor(WIDGETS);
    rmSync(absolutePath);
    await expect(runContentSource(new RunContentCache(NO_GIT_MEMBERS)).read(entry)).resolves.toBeNull();
  });

  it('rethrows a failure that is not an absence', async () => {
    const { absolutePath, entry } = entryFor(WIDGETS);
    rmSync(absolutePath);
    mkdirSyncReal(absolutePath);
    await expect(runContentSource(new RunContentCache(NO_GIT_MEMBERS)).read(entry)).rejects.toThrow();
  });
});
