/**
 * Copy YAML data files from <package>/src to <package>/dist after `tsc`.
 *
 * Invoked from a package's build script, run from the package directory:
 *   "build": "tsc && tsx ../dev-tools/src/copy-yaml-assets.ts"
 *
 * Walks `<cwd>/src` (the calling package's source tree), copies every
 * `.yaml` / `.yml` to the same relative path under `<cwd>/dist`. Needed for
 * packages that ship YAML data assets (e.g. the linkAuth macros in
 * `@vibe-agent-toolkit/utils`) — `tsc` only emits `.js` / `.d.ts`.
 *
 * No CLI flags — convention over configuration; the calling package's cwd
 * is the package root by definition when invoked from its npm script.
 */

import { copyFileSync, readdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';

const pkgRoot = process.cwd();
const srcDir = safePath.join(pkgRoot, 'src');
const distDir = safePath.join(pkgRoot, 'dist');

function walk(dir: string): void {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- walks calling package's own src/ tree, not user input
  for (const entry of readdirSync(dir)) {
    const full = safePath.join(dir, entry);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is a filesystem-walk result, not user input
    if (statSync(full).isDirectory()) {
      walk(full);
    } else if (entry.endsWith('.yaml') || entry.endsWith('.yml')) {
      const rel = safePath.relative(srcDir, full);
      const dest = safePath.join(distDir, rel);
      mkdirSyncReal(dirname(dest), { recursive: true });
      copyFileSync(full, dest);
    }
  }
}

walk(srcDir);
