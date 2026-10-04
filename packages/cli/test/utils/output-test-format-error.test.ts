/**
 * `writeTestFormatError` prints one `file:line:column: severity: message` line
 * on stderr — the shape editors and CI annotators parse.
 */

import { describe, expect, it, vi } from 'vitest';

import { writeTestFormatError } from '../../src/utils/output.js';

describe('writeTestFormatError', () => {
  it('writes one compiler-style line, severity included', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      writeTestFormatError('docs/a.md', 3, 7, 'warning', 'link is broken');
      expect(stderr.mock.calls.map((call) => String(call[0]))).toEqual(['docs/a.md:3:7: warning: link is broken\n']);
    } finally {
      stderr.mockRestore();
    }
  });
});
