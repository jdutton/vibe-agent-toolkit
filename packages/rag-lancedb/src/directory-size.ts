/**
 * Byte count of a directory tree, for `getStats().dbSizeBytes`.
 */

import fs from 'node:fs';

import { isPathAbsentError, safePath } from '@vibe-agent-toolkit/utils';

/**
 * Total size of every file under `dirPath`, recursively.
 *
 * Absence is the one tolerated failure: a directory that is not there has no
 * bytes, and a file that vanished between the listing and its `stat` (LanceDB
 * compacts and rewrites fragments) is simply not counted. A listing or stat
 * the OS REFUSES throws — "0 bytes" is the answer a reader trusts least at
 * exactly the moment it is most wrong.
 *
 * @param dirPath - Directory to measure
 * @returns Total size in bytes
 */
export function getDirectorySize(dirPath: string): number {
  let items: string[];
  try {
    items = fs.readdirSync(dirPath);
  } catch (error) {
    if (isPathAbsentError(error)) return 0;
    throw error;
  }

  let totalSize = 0;
  for (const item of items) {
    const itemPath = safePath.join(dirPath, item);
    let stats: fs.Stats;
    try {
      stats = fs.statSync(itemPath);
    } catch (error) {
      if (isPathAbsentError(error)) continue;
      throw error;
    }
    totalSize += stats.isDirectory() ? getDirectorySize(itemPath) : stats.size;
  }
  return totalSize;
}
