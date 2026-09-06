/* eslint-disable security/detect-non-literal-fs-filename -- fixture paths built from this test's own mkdtemp root, no external input */
import * as fs from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { mkdirSyncReal, normalizedTmpdir } from '@vibe-agent-toolkit/utils/fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  API_SKILL_MAX_UPLOAD_BYTES,
  checkPackagedSizeLimit,
  formatBytes,
} from '../../src/validators/packaged-size-limit.js';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-size-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Write a packaged bundle of `{ relativePath: byteCount }` and return its root. */
function writeBundle(files: Record<string, number>): string {
  const skillDir = safePath.join(root, 'skills', 'demo');
  mkdirSyncReal(skillDir, { recursive: true });
  for (const [rel, bytes] of Object.entries(files)) {
    const target = safePath.join(skillDir, rel);
    mkdirSyncReal(safePath.join(target, '..'), { recursive: true });
    fs.writeFileSync(target, Buffer.alloc(bytes, 0x61));
  }
  return skillDir;
}

describe('API_SKILL_MAX_UPLOAD_BYTES', () => {
  // The vendor writes "under 30 MB (uncompressed)" without saying MB or MiB. VAT
  // reads it decimal, deliberately: that fires slightly early rather than waving
  // through a bundle the upload will reject. Pinned so the reading cannot drift
  // to mebibytes silently — the two differ by 1.4 MB.
  it('is 30 million bytes, the decimal reading of the documented ceiling', () => {
    expect(API_SKILL_MAX_UPLOAD_BYTES).toBe(30_000_000);
  });
});

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [999, '999 B'],
    [1_000, '1.0 kB'],
    [35_700_000, '35.7 MB'],
  ])('renders %i as %s', (bytes, expected) => expect(formatBytes(bytes)).toBe(expected));
});

describe('checkPackagedSizeLimit', () => {
  // The threshold is a parameter precisely so this suite never writes 30 MB to
  // disk; a fixture that slow would be a fixture nobody runs.
  const LIMIT = 10_000;

  it('stays silent on a bundle under the ceiling', () => {
    const dir = writeBundle({ 'SKILL.md': 500, 'references/guide.md': 500 });
    expect(checkPackagedSizeLimit(dir, LIMIT)).toEqual([]);
  });

  it('reports a bundle at or over the ceiling', () => {
    const dir = writeBundle({ 'SKILL.md': 500, 'scripts/runtime.wasm': 9_600 });
    const issues = checkPackagedSizeLimit(dir, LIMIT);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe('PACKAGED_SIZE_EXCEEDS_API_LIMIT');
    expect(issues[0]?.severity).toBe('warning');
  });

  // The reason this check exists at all: SKILL_TOTAL_SIZE_LARGE counts LINES and
  // SKILL_TOO_MANY_FILES counts FILES, so a single large binary — no lines, one
  // file — is invisible to both while being the shape that blocks a publish.
  it('fires on one large binary in an otherwise tiny bundle', () => {
    const dir = writeBundle({ 'SKILL.md': 100, 'scripts/duckdb-eh.wasm': 12_000 });
    const issues = checkPackagedSizeLimit(dir, LIMIT);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('duckdb-eh.wasm');
  });

  // A bare total tells an author they have a problem without telling them where
  // it is; the adopter who reported this said naming the files is what made the
  // cause obvious in one line.
  it('names the largest files, biggest first', () => {
    const dir = writeBundle({
      'SKILL.md': 100,
      'scripts/big.wasm': 8_000,
      'assets/medium.bin': 1_500,
      'assets/small.bin': 400,
    });
    const message = checkPackagedSizeLimit(dir, LIMIT)[0]?.message ?? '';
    expect(message.indexOf('big.wasm')).toBeLessThan(message.indexOf('medium.bin'));
    expect(message).toContain('4 files');
  });

  it('counts only the three largest by name and totals the rest', () => {
    const dir = writeBundle({
      'a.bin': 3_000, 'b.bin': 3_000, 'c.bin': 3_000, 'd.bin': 1_000, 'e.bin': 500,
    });
    const message = checkPackagedSizeLimit(dir, LIMIT)[0]?.message ?? '';
    expect(message).toContain('and 2 more files');
  });

  it('sums files across nested directories rather than only the root', () => {
    const dir = writeBundle({ 'a/b/c/deep.bin': 6_000, 'a/b/other.bin': 5_000 });
    expect(checkPackagedSizeLimit(dir, LIMIT)).toHaveLength(1);
  });

  it('returns nothing for a bundle directory that does not exist', () => {
    // A size check must never be the thing that fails a build; "VAT could not
    // look" is RESOURCE_UNREADABLE's job, not this code's.
    expect(checkPackagedSizeLimit(safePath.join(root, 'absent'), LIMIT)).toEqual([]);
  });
});
