/**
 * The harness pass's on-disk reader: the bytes while they still key to the
 * blob, null when the file is gone or rewritten, and every other failure loud.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { normalizedTmpdir, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { mkdirSyncReal } from '@vibe-agent-toolkit/utils/fs';
import { afterEach, describe, expect, it } from 'vitest';

import { computeContentKey } from '../../src/content-key.js';
import { diskHarnessContentReader } from '../../src/projection/harness/harness-pass.js';
import type { HarnessFrontierEntry } from '../../src/projection/harness/reach.js';

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

describe('diskHarnessContentReader', () => {
  afterEach(() => {
    for (const directory of made.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it('reads the bytes while they still key to the blob', async () => {
    const { entry } = entryFor(WIDGETS);
    await expect(diskHarnessContentReader(undefined)(entry)).resolves.toBe(WIDGETS);
  });

  it('answers null when the bytes no longer key to the blob', async () => {
    const { absolutePath, entry } = entryFor(WIDGETS);
    writeFileSync(absolutePath, '# rewritten\n', 'utf-8');
    await expect(diskHarnessContentReader(undefined)(entry)).resolves.toBeNull();
  });

  it('answers null when the file is gone', async () => {
    const { absolutePath, entry } = entryFor(WIDGETS);
    rmSync(absolutePath);
    await expect(diskHarnessContentReader(undefined)(entry)).resolves.toBeNull();
  });

  it('rethrows a failure that is not an absence', async () => {
    const { absolutePath, entry } = entryFor(WIDGETS);
    rmSync(absolutePath);
    mkdirSyncReal(absolutePath);
    await expect(diskHarnessContentReader(undefined)(entry)).rejects.toThrow();
  });
});
