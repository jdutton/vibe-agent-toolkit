/**
 * The marketplace build's filesystem work, classified by the tree it touches.
 *
 * A copy reads one tree and writes another, and its errno cannot say which: `EACCES`
 * is raised for an unreadable LICENSE and for a read-only `dist/` alike. So every read
 * is classified on the side of the tree it reads (the build's INPUT is `source`; a tree
 * the run itself wrote earlier is `destination`), and only a write is left to the
 * marketplace tree's own boundary (a `destination` fault). The refusal table decides
 * the code; neither is a defect in VAT. The tree written into is the marketplace's
 * staged tree (see `buildMarketplace`): nothing here touches the built marketplace.
 */

import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { copyRegularFile, copyTree, type FsSide, proveTreeReadable, withFsFault } from '@vibe-agent-toolkit/utils';

/**
 * One write into the marketplace tree this build owns (`dist/.claude/plugins/…`, staged): a
 * raw fault the OS raises is a `destination` fault, naming what it was doing. An already
 * classified fault (a refused read), a coded refusal, and a non-filesystem throw pass
 * through untouched.
 *
 * @param what - Completes "Could not …", naming the path
 */
export function writingMarketplace<T>(what: string, write: () => Promise<T>): Promise<T> {
  return withFsFault({ side: 'destination', action: what }, write);
}

/**
 * Copy one file of the build's INPUT into the marketplace tree: the read is the
 * source's (opened without blocking — a named pipe is refused, never waited on),
 * the write the destination's.
 *
 * @param source - Absolute path the build reads
 * @param target - Absolute path in the marketplace tree
 * @param sourceLabel - What a read refusal says the build was reading
 * @param targetLabel - What a write refusal says the build was writing
 */
export async function copyFileIntoMarketplace(
  source: string,
  target: string,
  sourceLabel: string,
  targetLabel: string,
): Promise<void> {
  await writingMarketplace(`write ${targetLabel}`, async () => {
    await mkdir(dirname(target), { recursive: true });
    await copyRegularFile(source, target, { side: 'source', reading: sourceLabel });
  });
}

/**
 * Copy a directory tree into the marketplace tree: every file is proven
 * readable first (`proveTreeReadable`), then the copy is written by the same walk,
 * links kept as links. Both read the tree on its `side`.
 *
 * @param source - The directory the build reads, and the side of the run it is on
 * @param target - Absolute directory in the marketplace tree
 * @param sourceLabel - What the build reads, for a write refusal's message
 * @param targetLabel - What a write refusal says the build was writing
 */
export async function copyTreeIntoMarketplace(
  source: { readonly path: string; readonly side: FsSide },
  target: string,
  sourceLabel: string,
  targetLabel: string,
): Promise<void> {
  // Every file of it, links kept as links: a refusal names the entry the OS refused.
  const walk = { links: 'preserve', side: source.side } as const;
  await proveTreeReadable(source.path, walk);
  await writingMarketplace(`copy ${sourceLabel} into ${targetLabel}`, () => copyTree(source.path, target, walk));
}
