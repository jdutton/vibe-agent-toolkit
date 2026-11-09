/**
 * A stand-in for the npm a Node installation bundles, laid out where that Node's
 * installer lays it, so the lab's npm locator can run against a fixture directory.
 */

import { writeFileSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { mkdirSyncReal } from '@vibe-agent-toolkit/utils/fs';

/** Where a stand-in Node installation was laid. */
interface FakeNode {
  /** The `node` executable's path — never created: the locator only reads its directory. */
  readonly execPath: string;
  /** The bundled `npm-cli.js`. */
  readonly cli: string;
}

/**
 * Lay a stand-in Node installation's bundled npm under `dir`, in one platform's layout:
 *
 * - `win32` — `node.exe` beside `node_modules/npm/bin/npm-cli.js`.
 * - otherwise — `bin/node`, with `lib/node_modules/npm/bin/npm-cli.js` under the same prefix.
 *
 * @param dir - An empty directory
 * @param platform - Whose layout
 * @returns Where it was laid
 */
export function layFakeNode(dir: string, platform: NodeJS.Platform): FakeNode {
  const windows = platform === 'win32';
  const execPath = windows ? safePath.join(dir, 'node.exe') : safePath.join(dir, 'bin', 'node');
  const cli = windows
    ? safePath.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
    : safePath.join(dir, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  mkdirSyncReal(safePath.join(cli, '..'), { recursive: true });
  writeFileSync(cli, '');
  return { execPath, cli };
}
