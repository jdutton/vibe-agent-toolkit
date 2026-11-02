/**
 * `withMemoryInstrument`: an `npx:` build is measured as `node <cli>/dist/bin.js`
 * from an install of the pinned spec — never through npx and the package's
 * cwd-resolving wrapper, which is a second vat process the other kinds never run.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it, vi } from 'vitest';

import { withMemoryInstrument } from '../src/facets/memory/npx-entry.js';
import type { ResolvedInstrument } from '../src/harness/types.js';

const SPEC = 'vibe-agent-toolkit@0.1.43';
const NPX: ResolvedInstrument = {
  command: 'npx',
  leadingArgs: ['--yes', SPEC],
  version: { version: '0.1.43', commit: null, dirty: null, closure: null },
};
const CLI_BIN = 'node_modules/@vibe-agent-toolkit/cli/dist/bin.js';

/**
 * An installer that lays down the given files under the prefix.
 *
 * @param files - Paths relative to the prefix
 * @returns The installer, as a spy
 */
function installing(...files: string[]): (spec: string, prefix: string) => Promise<void> {
  return vi.fn(async (_spec: string, prefix: string) => {
    for (const file of files) {
      const path = safePath.join(prefix, file);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, '');
    }
  });
}

describe('withMemoryInstrument', () => {
  it('runs a tree: or dist: build as given, installing nothing', async () => {
    const tree: ResolvedInstrument = { ...NPX, command: process.execPath, leadingArgs: ['/x/dist/bin.js'] };
    const install = installing();

    await expect(withMemoryInstrument(tree, install, async (used) => used)).resolves.toBe(tree);
    expect(install).not.toHaveBeenCalled();
  });

  it('runs an npx: build as node <installed cli>/dist/bin.js, keeping its coordinate', async () => {
    const install = installing(CLI_BIN);

    const used = await withMemoryInstrument(NPX, install, async (instrument) => instrument);

    expect(install).toHaveBeenCalledWith(SPEC, expect.any(String));
    expect(used.command).toBe(process.execPath);
    expect(used.leadingArgs).toHaveLength(1);
    expect(used.leadingArgs[0]).toMatch(/\/node_modules\/@vibe-agent-toolkit\/cli\/dist\/bin\.js$/);
    expect(used.version).toBe(NPX.version);
  });

  it('prefers the cli nested under the named package over a hoisted one', async () => {
    const nested = `node_modules/vibe-agent-toolkit/${CLI_BIN}`;
    const used = await withMemoryInstrument(NPX, installing(CLI_BIN, nested), async (instrument) => instrument);

    expect(used.leadingArgs[0]).toContain('/node_modules/vibe-agent-toolkit/node_modules/');
  });

  it('refuses an install that holds no cli entry, naming the spec', async () => {
    await expect(withMemoryInstrument(NPX, installing(), async () => 0)).rejects.toThrow(SPEC);
  });
});
