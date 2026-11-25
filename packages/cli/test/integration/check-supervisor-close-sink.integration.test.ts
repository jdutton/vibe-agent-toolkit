/**
 * `closeOverlapSink` closes a given-up spawn's `stderr.log` read fd even when closing its write fd
 * throws, so a failed close never leaks the other fd. Integration tier: real fds.
 */
import { closeSync, fstatSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeOverlapSink, openOverlapSink } from '../../src/commands/resources/check-supervisor.js';
import { cleanupTestTempDir, createTestTempDir } from '../system/test-common.js';

describe('closeOverlapSink', () => {
  let dir: string;

  beforeEach(() => {
    dir = createTestTempDir('vat-close-sink-');
  });

  afterEach(() => {
    cleanupTestTempDir(dir);
  });

  it('closes the read fd when closing the write fd throws, and rethrows that error', () => {
    const sink = openOverlapSink(safePath.join(dir, 'progress.log'));
    // Closed already, so the sink's close of it throws EBADF.
    closeSync(sink.writeFd);

    expect(() => closeOverlapSink(sink)).toThrow(expect.objectContaining({ code: 'EBADF' }));
    expect(() => fstatSync(sink.readFd), 'the read fd is closed').toThrow(expect.objectContaining({ code: 'EBADF' }));
  });
});
