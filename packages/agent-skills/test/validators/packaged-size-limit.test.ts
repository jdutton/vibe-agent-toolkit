/* eslint-disable security/detect-non-literal-fs-filename -- fixture paths built from this test's own mkdtemp root, no external input */
import * as fs from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { mkdirSyncReal, normalizedTmpdir } from '@vibe-agent-toolkit/utils/fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  API_SKILL_MAX_UPLOAD_BYTES,
  checkPackagedSizeLimit,
  describeOversizeBundle,
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
  // The vendor writes "under 30 MB (uncompressed)" without saying MB or MiB, and the
  // two readings differ by 1.46 MB. This is not a reading — it is the measurement:
  // a 30,700,000-byte bundle was ACCEPTED by the live Skills API (which refutes the
  // decimal reading outright) and 31,500,000 was refused 413, bracketing the ceiling
  // onto 30 MiB. Pinned so it cannot drift back to decimal, which would re-introduce
  // a false-positive warning on every bundle between 30.0 and 31.4 MB.
  it('is 30 MiB, the measured ceiling — not the decimal reading of "30 MB"', () => {
    expect(API_SKILL_MAX_UPLOAD_BYTES).toBe(31_457_280);
    expect(API_SKILL_MAX_UPLOAD_BYTES).not.toBe(30_000_000);
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

describe('describeOversizeBundle', () => {
  // `vat claude org skills install` refuses over-ceiling bundles BEFORE uploading,
  // using this same builder, so an author meets one wording whether the finding
  // reaches them at build time or at upload time. These pin the shared contract —
  // if the uploader ever grows its own copy of this sentence, that is the drift
  // this suite exists to make visible.
  const oversize = [
    { path: 'scripts/runtime.wasm', bytes: 35_700_000 },
    { path: 'SKILL.md', bytes: 70_800 },
    { path: 'resources/guide.md', bytes: 54_400 },
    { path: 'resources/a.md', bytes: 10 },
    { path: 'resources/b.md', bytes: 10 },
  ];
  const oversizeTotal = oversize.reduce((sum, f) => sum + f.bytes, 0);

  it('leads with the largest files, which are usually the whole diagnosis', () => {
    const message = describeOversizeBundle(oversize, oversizeTotal);
    expect(message).toContain('scripts/runtime.wasm (35.7 MB)');
    expect(message).toContain('SKILL.md (70.8 kB)');
    expect(message).toContain('resources/guide.md (54.4 kB)');
    // The rest are counted, not listed — a bundle this size has too many to name.
    expect(message).toContain('and 2 more files');
    expect(message).not.toContain('resources/a.md');
  });

  it('names the ceiling as the vendor writes it, so it matches the docs and the 413', () => {
    // The vendor's "30 MB" is 30 MiB. Rendering the constant in decimal would print
    // "31.5 MB" and leave the author unable to match this against either the
    // documentation or the API's own refusal text.
    expect(describeOversizeBundle(oversize, oversizeTotal)).toContain('over the 30 MiB');
    expect(describeOversizeBundle(oversize, oversizeTotal)).not.toContain('over the 31.5 MB');
  });

  it('renders a caller-supplied limit in decimal, matching the totals beside it', () => {
    // A non-default limit is a test's or a caller's, not the vendor's ceiling, so
    // the MiB label would misattribute where the number came from.
    expect(describeOversizeBundle(oversize, oversizeTotal, 1_000_000)).toContain('over the 1.0 MB');
  });

  it('does not say "1 files" when the bundle is a single file', () => {
    expect(describeOversizeBundle([{ path: 'big.bin', bytes: 40_000_000 }], 40_000_000))
      .toContain('across 1 file,');
  });
});
