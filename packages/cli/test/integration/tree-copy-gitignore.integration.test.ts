/* eslint-disable security/detect-non-literal-fs-filename */
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';

import { mkdirSyncReal, safeExecSync, safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { treeCopyPlugin } from '../../src/commands/claude/plugin/tree-copy.js';
import { createTempDirTracker } from '../system/test-common.js';

describe('treeCopyPlugin — gitignore enforcement', () => {
  const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-tree-copy-gi-');

  it('does not copy files matching .gitignore', async () => {
    const root = createTempDir();
    const src = safePath.join(root, 'plugins', 'p1');
    const dest = safePath.join(root, 'out', 'p1');
    mkdirSyncReal(src, { recursive: true });
    mkdirSyncReal(dest, { recursive: true });

    safeExecSync('git', ['init', '-q'], { cwd: root });
    safeExecSync('git', ['config', 'user.email', 't@t'], { cwd: root });
    safeExecSync('git', ['config', 'user.name', 't'], { cwd: root });

    await writeFile(
      safePath.join(root, '.gitignore'),
      'plugins/p1/node_modules/\nplugins/p1/.env\n',
    );
    await mkdir(safePath.join(src, 'node_modules'), { recursive: true });
    await writeFile(safePath.join(src, 'node_modules', 'junk.js'), '//');
    await writeFile(safePath.join(src, '.env'), 'SECRET=x');
    await mkdir(safePath.join(src, 'commands'), { recursive: true });
    await writeFile(safePath.join(src, 'commands', 'ok.md'), '# ok');

    safeExecSync('git', ['add', '-A'], { cwd: root });
    safeExecSync('git', ['commit', '-q', '-m', 'init'], { cwd: root });

    await treeCopyPlugin({ sourceDir: src, destDir: dest });

    expect(existsSync(safePath.join(dest, 'node_modules'))).toBe(false);
    expect(existsSync(safePath.join(dest, '.env'))).toBe(false);
    expect(existsSync(safePath.join(dest, 'commands', 'ok.md'))).toBe(true);

    cleanupTempDirs();
  });
});
