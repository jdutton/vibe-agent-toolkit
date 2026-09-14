/**
 * The capture printer's three decisions are pure: where vibe-validate wrote
 * (its `VV_TEMP_DIR` override wins over the OS temp dir), which run is newest
 * (lexical order of ISO-dated names), and which files to print in what order
 * (stdout before stderr, never the JSONL merge). The I/O around them is a
 * readdir and a readFile.
 */

import { describe, expect, it } from 'vitest';

import { newestOf, orderCaptures, stepsRootOf } from '../src/print-failed-step-output.js';

describe('stepsRootOf', () => {
  it('reads VV_TEMP_DIR first, the way vibe-validate itself does', () => {
    expect(stepsRootOf({ VV_TEMP_DIR: '/runner/vv' }, '/tmp')).toBe('/runner/vv/vibe-validate/steps');
  });

  it('falls back to the OS temp dir when the override is unset', () => {
    expect(stepsRootOf({}, '/tmp')).toBe('/tmp/vibe-validate/steps');
  });
});

describe('newestOf', () => {
  it('is undefined for no runs', () => {
    expect(newestOf([])).toBeUndefined();
  });

  it('picks the latest date folder and the latest run folder by lexical order', () => {
    expect(newestOf(['2026-09-13', '2026-09-12', '2026-09-11'])).toBe('2026-09-13');
    expect(newestOf(['2026-09-13T23-05-25-217Z-a9f3b88b', '2026-09-13T23-38-14-412Z-a0d387f0'])).toBe(
      '2026-09-13T23-38-14-412Z-a0d387f0',
    );
  });
});

describe('orderCaptures', () => {
  it('prints stdout before stderr and drops the JSONL merge', () => {
    expect(
      orderCaptures(['x-unused-exports-combined.jsonl', 'x-unused-exports-stderr.txt', 'x-unused-exports-stdout.txt']),
    ).toEqual(['x-unused-exports-stdout.txt', 'x-unused-exports-stderr.txt']);
  });

  it('keeps every capture when a step was retried into the same directory', () => {
    expect(orderCaptures(['b-stderr.txt', 'a-stdout.txt', 'b-stdout.txt', 'a-stderr.txt'])).toEqual([
      'a-stdout.txt',
      'b-stdout.txt',
      'a-stderr.txt',
      'b-stderr.txt',
    ]);
  });
});
