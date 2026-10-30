/**
 * The host a ZIP VAT writes says it was made on: Unix, on EVERY host — so the `0644`/`0755` modes in
 * each entry's external attributes are read by every host-aware reader, VAT's own included.
 *
 * The ZIP library stamps `version made by` with the host it RUNS on (NTFS, 10, on Windows), and a
 * reader trusts the Unix mode only under host 3. A round-trip on macOS or Linux cannot fail for
 * that, so the library is made to stamp what it stamps on Windows, and the byte itself is read.
 * `zipOfDirectory` walks a real tree, so it is held, modes and host together, by
 * `integration/archive-zip-modes.integration.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';

const CENTRAL_SIGNATURE = Buffer.from([0x50, 0x4b, 0x01, 0x02]);

// Only what the library stamps changes: every entry it builds says "made on Windows", as it does there.
vi.mock('adm-zip', async (importOriginal) => (await import('./adm-zip-as-on-windows.js')).admZipAsOnWindows(importOriginal));

const { zipOfEntries } = await import('../src/archive/zip-reader.js');

/** The host byte of `version made by` in every central-directory record of `zip`. */
function madeOnHosts(zip: Buffer): number[] {
  const hosts: number[] = [];
  for (let at = zip.indexOf(CENTRAL_SIGNATURE); at !== -1; at = zip.indexOf(CENTRAL_SIGNATURE, at + 4)) hosts.push(zip.readUInt8(at + 5));
  return hosts;
}

describe('the host a ZIP VAT writes says it was made on', () => {
  it('is Unix for every entry zipOfEntries writes, wherever VAT runs', () => {
    const zip = zipOfEntries([
      { place: 'skill', data: undefined, executable: false },
      { place: 'skill/SKILL.md', data: Buffer.from('# skill'), executable: false },
      { place: 'skill/run.sh', data: Buffer.from('echo'), executable: true },
    ]);

    expect(madeOnHosts(zip)).toEqual([3, 3, 3]);
  });
});
