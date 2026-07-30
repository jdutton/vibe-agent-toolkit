/**
 * Unit tests for `writeAllSync` — the drain loop behind every piped byte this
 * CLI emits (`writeYamlOutput` for command summaries, `writeHelpSync` for
 * `--help --verbose`).
 *
 * The loop exists for two conditions that are painful to provoke on a real fd
 * and trivial to state against an injected writer:
 *   1. a SHORT write — `fs.writeSync` may accept fewer bytes than offered, and
 *      dropping the remainder is precisely the truncation bug this replaced;
 *   2. EAGAIN — a non-blocking pipe whose buffer is momentarily full, which must
 *      be retried rather than treated as failure.
 *
 * The end-to-end reality (fd 1, a real pipe, `process.exit` racing the write)
 * cannot be faked in-process and is covered by
 * `test/system/stdout-pipe-integrity.system.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import { writeAllSync, type SyncWriter } from '../../src/utils/output.js';

/** An errno-bearing error, the shape `fs.writeSync` throws. */
function errnoError(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

/**
 * A writer that records everything handed to it, accepting at most `chunkSize`
 * bytes per call so the caller must loop.
 */
function recordingWriter(chunkSize: number): { write: SyncWriter; collected: () => string } {
  const chunks: Buffer[] = [];
  return {
    write: (buffer, offset, length) => {
      const n = Math.min(chunkSize, length);
      chunks.push(Buffer.from(buffer.subarray(offset, offset + n)));
      return n;
    },
    collected: () => Buffer.concat(chunks).toString('utf8'),
  };
}

describe('writeAllSync', () => {
  it('delivers every byte when the writer accepts the whole buffer at once', () => {
    const payload = 'complete payload\n';
    const { write, collected } = recordingWriter(Number.MAX_SAFE_INTEGER);

    writeAllSync(write, Buffer.from(payload, 'utf8'));

    expect(collected()).toBe(payload);
  });

  it('loops until done when the writer only accepts a short write each call', () => {
    // 64 KB is the pipe buffer that truncated real output; 7 is deliberately not
    // a divisor of the length, so the final partial chunk is exercised too.
    const payload = 'x'.repeat(65_536 + 13);
    const { write, collected } = recordingWriter(7);

    writeAllSync(write, Buffer.from(payload, 'utf8'));

    expect(collected()).toBe(payload);
    expect(collected()).toHaveLength(65_549);
  });

  it('retries an EAGAIN instead of dropping the remainder', () => {
    const payload = 'retry me';
    const { write, collected } = recordingWriter(3);
    let calls = 0;
    const flaky: SyncWriter = (buffer, offset, length) => {
      calls++;
      // Fail every other call the way a momentarily-full non-blocking pipe does.
      if (calls % 2 === 1) throw errnoError('EAGAIN');
      return write(buffer, offset, length);
    };

    writeAllSync(flaky, Buffer.from(payload, 'utf8'));

    expect(collected()).toBe(payload);
  });

  it('propagates a non-EAGAIN write failure rather than spinning on it', () => {
    const failing: SyncWriter = () => {
      throw errnoError('EPIPE');
    };

    expect(() => writeAllSync(failing, Buffer.from('anything', 'utf8'))).toThrow(
      expect.objectContaining({ code: 'EPIPE' }),
    );
  });

  it('throws rather than looping forever when a writer reports no progress', () => {
    // A writer stuck at 0 would hang the CLI with no output and no error — the
    // one failure mode worse than truncation.
    const stalled: SyncWriter = () => 0;

    expect(() => writeAllSync(stalled, Buffer.from('anything', 'utf8'))).toThrow(
      /Refusing to loop forever/,
    );
  });

  it('does nothing for an empty buffer', () => {
    const neverCalled: SyncWriter = () => {
      throw new Error('writer must not be called for an empty buffer');
    };

    expect(() => writeAllSync(neverCalled, Buffer.alloc(0))).not.toThrow();
  });
});
