/**
 * Copy YAML data files from <package>/src to <package>/dist after `tsc`.
 *
 * Invoked from a package's build script, run from the package directory:
 *   "build": "tsc && tsx ../dev-tools/src/copy-yaml-assets.ts"
 *
 * Walks `<cwd>/src` (the calling package's source tree), copies every
 * `.yaml` / `.yml` to the same relative path under `<cwd>/dist`. Needed for
 * packages that ship YAML data assets (e.g. the linkAuth macros in
 * `@vibe-agent-toolkit/resources`) — `tsc` only emits `.js` / `.d.ts`.
 *
 * No CLI flags — convention over configuration; the calling package's cwd
 * is the package root by definition when invoked from its npm script.
 */

import { readdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

import { copyRegularFile, forEachInOrder, mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';

const pkgRoot = process.cwd();
const srcDir = safePath.join(pkgRoot, 'src');
const distDir = safePath.join(pkgRoot, 'dist');

async function walk(dir: string): Promise<void> {
  await forEachInOrder(readdirSync(dir), async (entry) => {
    const full = safePath.join(dir, entry);
    if (statSync(full).isDirectory()) {
      await walk(full);
    } else if (entry.endsWith('.yaml') || entry.endsWith('.yml')) {
      const rel = safePath.relative(srcDir, full);
      const dest = safePath.join(distDir, rel);
      mkdirSyncReal(dirname(dest), { recursive: true });
      // One regular file, its mode kept; a named pipe is refused rather than waited on.
      await copyRegularFile(full, dest, { side: 'source', reading: `the YAML asset ${rel}` });
    }
  });
}

await walk(srcDir);
