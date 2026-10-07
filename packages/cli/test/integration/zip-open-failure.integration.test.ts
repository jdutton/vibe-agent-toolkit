/**
 * adm-zip answers a failed `open` of an entry by `chmod`ing the path and trying
 * again; on a file that does not exist yet that `chmod` throws `ENOENT`, which
 * replaced the real errno — a run out of descriptors (`EMFILE`) was blamed on the
 * archive. The real adm-zip runs here; only the one `open` is refused.
 */
import * as nodeFs from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import AdmZip from 'adm-zip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openZip } from '../../src/utils/archive-staging.js';

let root: string;

beforeEach(() => {
  root = nodeFs.mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-zip-open-'));
});
afterEach(() => {
  nodeFs.rmSync(root, { recursive: true, force: true });
});

/** node's fs, except that opening `refused` for writing fails with `code`. */
function fsRefusingOpen(refused: string, code: string): typeof nodeFs {
  return {
    ...nodeFs,
    openSync: ((...args: Parameters<typeof nodeFs.openSync>) => {
      if (String(args[0]).endsWith(refused) && args[1] === 'w') throw Object.assign(new Error(`${code}: refused, open '${String(args[0])}'`), { code, syscall: 'open', path: String(args[0]) });
      return nodeFs.openSync(...args);
    }) as typeof nodeFs.openSync,
  };
}

describe('openZip(...).extractTo', () => {
  it.each([
    ['EMFILE', 'RUN_INCOMPLETE'],
    ['EROFS', 'RUN_INCOMPLETE'],
    ['EACCES', 'INPUT_UNREADABLE'],
  ])('classifies an entry it could not open (%s) by the open\'s own errno: %s', (code, refusal) => {
    const archive = safePath.join(root, 'skill.zip');
    const zip = new AdmZip();
    zip.addFile('SKILL.md', Buffer.from('# s\n'));
    zip.writeZip(archive);
    const extracted = safePath.join(root, 'staged');
    mkdirSyncReal(extracted);

    let thrown: unknown;
    try {
      openZip(archive, fsRefusingOpen('SKILL.md', code)).extractTo(archive, extracted);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({ refusal });
    expect(String((thrown as Error).message)).toContain(code);
  });
});
