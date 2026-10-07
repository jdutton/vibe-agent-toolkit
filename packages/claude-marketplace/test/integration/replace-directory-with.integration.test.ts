/**
 * `replaceDirectoryWith` swaps a caller-filled copy in only once the fill
 * resolves: a fill that rejects must cost neither the previous tree nor leave
 * its staged sibling behind — `vat agent install --force` rests on exactly that.
 */
import fs from 'node:fs/promises';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { replaceDirectoryWith } from '../../src/install/plugin-registry.js';

let root: string;
let dest: string;

beforeEach(async () => {
  root = await fs.mkdtemp(safePath.join(normalizedTmpdir(), 'vat-replace-with-'));
  dest = safePath.join(root, 'skill');
  await fs.mkdir(dest);
  await fs.writeFile(safePath.join(dest, 'SKILL.md'), 'previous\n');
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('replaceDirectoryWith', () => {
  it('keeps the previous tree, and leaves no staged sibling, when the fill rejects half-way', async () => {
    const boom = new Error('copy refused');
    const run = replaceDirectoryWith(dest, async (staged) => {
      await fs.writeFile(safePath.join(staged, 'SKILL.md'), 'partial\n');
      throw boom;
    });

    await expect(run).rejects.toBe(boom);
    expect(await fs.readFile(safePath.join(dest, 'SKILL.md'), 'utf-8')).toBe('previous\n');
    expect(await fs.readdir(root)).toEqual(['skill']);
  });

  it('swaps the filled tree in whole and removes the previous one', async () => {
    const warnings = await replaceDirectoryWith(dest, (staged) => fs.writeFile(safePath.join(staged, 'NEW.md'), 'new\n'));

    expect(warnings).toEqual([]);
    expect(await fs.readdir(dest)).toEqual(['NEW.md']);
    expect(await fs.readdir(root)).toEqual(['skill']);
  });
});
