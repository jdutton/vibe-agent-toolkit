/**
 * A named pipe has no content to decode, and opening one for reading blocks
 * until a writer appears — so a FIFO a parse or packaging lane reached through
 * `readDecodableBytes` hung the whole run. It is refused unread, coded `EFTYPE`
 * (an environmental errno, so every lane's own refusal convention applies).
 *
 * System tier: the fixture is a real FIFO, made by spawning `mkfifo`. POSIX only.
 */
import { describe, expect, it } from 'vitest';

import { fsFaultOf } from '../../src/errors/errno-table.js';
import { readDecodableBytes, readTextContent, readTextContentSync } from '../../src/text-file.js';

import { outcomeOrHang, setupFifoSuite } from './fifo-race.js';

describe.skipIf(process.platform === 'win32')('text-file readers — a named pipe', () => {
  const suite = setupFifoSuite('vat-text-fifo-', 'pipe.md');

  it.for([
    ['readDecodableBytes', (path: string) => readDecodableBytes(path)],
    ['readTextContent', (path: string) => readTextContent(path)],
  ] as const)('%s refuses it unopened-for-content, as an environmental EFTYPE', async ([, read]) => {
    const outcome = await outcomeOrHang(read(suite.fifo()));
    expect(outcome).toMatchObject({ code: 'EFTYPE', path: suite.fifo() });
    expect(fsFaultOf(outcome)).toBeDefined();
  });

  it('readTextContentSync refuses it the same way', () => {
    // Synchronous, so no race can bound it: a blocking open would hang the worker itself.
    expect(() => readTextContentSync(suite.fifo())).toThrow(expect.objectContaining({ code: 'EFTYPE' }) as unknown as Error);
  });
});
