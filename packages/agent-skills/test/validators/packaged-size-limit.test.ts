/* eslint-disable security/detect-non-literal-fs-filename -- fixture paths built from this test's own mkdtemp root, no external input */
import * as fs from 'node:fs';

import { applyAllowFilter } from '@vibe-agent-toolkit/schema';
import { createSymlink, safePath, symlinkCapability, type SymlinkCapability } from '@vibe-agent-toolkit/utils';
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
function writeBundle(files: Record<string, number>, name = 'demo'): string {
  const skillDir = safePath.join(root, 'skills', name);
  mkdirSyncReal(skillDir, { recursive: true });
  for (const [rel, bytes] of Object.entries(files)) {
    const target = safePath.join(skillDir, rel);
    mkdirSyncReal(safePath.join(target, '..'), { recursive: true });
    fs.writeFileSync(target, Buffer.alloc(bytes, 0x61));
  }
  return skillDir;
}

/** The build-time lane's measure: bytes summed off the filesystem. */
function packagedFiles(bytes: number): { of: 'packaged-files'; bytes: number } {
  return { of: 'packaged-files', bytes };
}

/** Codes emitted for a bundle, in order — the shape most assertions below need. */
function codesFor(dir: string, limit: number): string[] {
  return checkPackagedSizeLimit(dir, limit).map(issue => issue.code);
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
  // BINARY units, and the labels say so. Every size this module prints is read
  // against a ceiling that is exactly 30 x 2^20, so rendering totals in decimal MB
  // beside a MiB ceiling left the two sides of the comparison unconvertible by eye
  // ("51.7 MB ... over the 30 MiB ceiling" — how far over?). A function dividing by
  // 1024 must never label its result "MB", so the unit table moved with the base.
  it.each([
    [0, '0 B'],
    [999, '999 B'],
    [1023, '1023 B'],
    [1024, '1.0 KiB'],
    [35_700_000, '34.0 MiB'],
    [2_500_000_000, '2.3 GiB'],
    [1_500_000_000_000, '1.4 TiB'],
    // The loop's own bound: TiB is the last unit, so a petabyte-scale number keeps
    // climbing the value and stops climbing the unit rather than reading past the
    // end of the table.
    [4_000_000_000_000_000, '3638.0 TiB'],
  ])('renders %i as %s', (bytes, expected) => expect(formatBytes(bytes)).toBe(expected));

  it('renders the API ceiling as the round binary number it is', () => {
    // The vendor writes "30 MB" and means 30 MiB; this is the only rendering under
    // which their number and VAT's agree.
    expect(formatBytes(API_SKILL_MAX_UPLOAD_BYTES)).toBe('30.0 MiB');
  });
});

describe('checkPackagedSizeLimit', () => {
  // The threshold is a parameter precisely so this suite never writes 30 MB to
  // disk; a fixture that slow would be a fixture nobody runs.
  const LIMIT = 10_000;

  it('stays silent on a bundle under the ceiling', () => {
    const dir = writeBundle({ 'SKILL.md': 500, 'references/guide.md': 500 });
    expect(checkPackagedSizeLimit(dir, LIMIT)).toEqual([]);
  });

  it('reports a bundle OVER the ceiling', () => {
    const dir = writeBundle({ 'SKILL.md': 500, 'scripts/runtime.wasm': 9_600 });
    const issues = checkPackagedSizeLimit(dir, LIMIT);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe('PACKAGED_SIZE_EXCEEDS_API_LIMIT');
    expect(issues[0]?.severity).toBe('warning');
  });

  // The `at` boundary, explicitly. It used to be pinned only incidentally, by a
  // fixture in 'names the largest files' that happens to sum to exactly the limit
  // — which two readers missed, concluding that flipping `<` to `<=` would survive
  // the suite. It would not, and now the suite says so in its own name.
  //
  // ⚠️ This lane keeps `>=` while the UPLOAD lane was corrected to `>`, and the
  // difference is deliberate. The API's ceiling is inclusive — a request body of
  // exactly 31,457,280 bytes was accepted live, one byte more was refused 413 —
  // so an uploader holding the real body must not refuse at the ceiling. This
  // check holds FILE bytes, and per-part multipart framing is never zero, so
  // files totalling exactly the limit always become a request over it. Firing
  // here is therefore not conservatism, it is correct. Do not "harmonise" the
  // two operators; they are applied to different quantities.
  it('fires AT exactly the ceiling in FILE bytes, because the request will be larger still', () => {
    const dir = writeBundle({ 'SKILL.md': 400, 'scripts/runtime.wasm': 9_600 });
    expect(codesFor(dir, LIMIT)).toEqual(['PACKAGED_SIZE_EXCEEDS_API_LIMIT']);
    // One byte less is silence — the pair is what makes the boundary a boundary.
    const under = writeBundle({ 'SKILL.md': 399, 'scripts/runtime.wasm': 9_600 }, 'under');
    expect(checkPackagedSizeLimit(under, LIMIT)).toEqual([]);
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

  // ── The finding's anchor ────────────────────────────────────────────────────
  // `location: '.'` is the same constant string for every skill in a multi-skill
  // build, so an allow glob written against it either matches every bundle or
  // none. The `link` anchor is what makes ONE bundle waivable — the same rule the
  // rest of this lane follows (referenced-path-missing, mcp-tool-qualification).
  it('anchors the finding on the largest file, which is the thing to remove', () => {
    const dir = writeBundle({ 'SKILL.md': 500, 'scripts/runtime.wasm': 9_600 });
    const issue = checkPackagedSizeLimit(dir, LIMIT)[0];
    expect(issue?.link).toBe('scripts/runtime.wasm');
    expect(issue?.location).toBe('.');
  });

  it('lets an allow entry waive ONE bundle while another bundle still fires', () => {
    const waived = writeBundle({ 'SKILL.md': 500, 'scripts/runtime.wasm': 9_600 }, 'waived');
    const other = writeBundle({ 'SKILL.md': 500, 'assets/data.bin': 9_600 }, 'other');
    const issues = [
      ...checkPackagedSizeLimit(waived, LIMIT),
      ...checkPackagedSizeLimit(other, LIMIT),
    ];

    const { emitted } = applyAllowFilter(issues, {
      allow: {
        PACKAGED_SIZE_EXCEEDS_API_LIMIT: [
          { paths: ['**/runtime.wasm'], reason: 'Runtime bundled deliberately; this skill is never API-published.' },
        ],
      },
    });

    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.link).toBe('assets/data.bin');
  });

  // ── Parity with what the uploader actually sends ────────────────────────────
  // `vat claude org skills install` drops `evals`, `node_modules` and `.git`
  // directories from the multipart body, so counting them here reports a bundle
  // over a ceiling the upload it describes would never reach. VAT documents the
  // reachable case into existence: a root `evals/` with no `evals.json` "is
  // ordinary content and still ships", so `vat build` packages it and the
  // uploader drops it unconditionally.
  it.each(['evals', 'node_modules', '.git'])(
    'does not count a %s directory, which the uploader never sends',
    (excluded) => {
      const dir = writeBundle(
        { 'SKILL.md': 500, [`${excluded}/fixture.bin`]: 9_600 },
        excluded.replace('.', ''),
      );
      expect(checkPackagedSizeLimit(dir, LIMIT)).toEqual([]);
    },
  );

  it('still counts a FILE named evals, which the uploader does send', () => {
    // The uploader excludes these names by DIRECTORY (a real one, or a symbolic
    // link resolving to one). A regular file of that name goes over the wire, so
    // it goes on the scale here.
    const dir = writeBundle({ 'SKILL.md': 500, evals: 9_600 });
    expect(codesFor(dir, LIMIT)).toEqual(['PACKAGED_SIZE_EXCEEDS_API_LIMIT']);
  });

  // ── "VAT could not weigh this" is never silence ─────────────────────────────
  // An unreadable entry used to contribute ZERO bytes and no receipt, which
  // under-counts in exactly the direction that produces a clean bill of health:
  // the build reports nothing and the upload eats a 413 eleven seconds later.
  // RESOURCE_UNREADABLE does NOT cover this — it is emitted by walk-link-graph
  // over the SOURCE link graph, which never stats the packaged output.
  it('reports a bundle root it cannot read rather than calling it empty', () => {
    expect(codesFor(safePath.join(root, 'absent'), LIMIT)).toEqual(['SCAN_PATH_UNREADABLE']);
  });

  it('does not fail the build when it cannot look — the receipt is a warning', () => {
    const issues = checkPackagedSizeLimit(safePath.join(root, 'absent'), LIMIT);
    expect(issues[0]?.severity).toBe('warning');
    expect(issues[0]?.location).toBe('.');
  });
});

// Symlink creation needs privilege on Windows; the behaviours below are
// POSIX-observable and gated on the real capability rather than on the platform.
const cap = symlinkCapability();

/** The capability token, for a suite already gated on it by `skipIf`. */
function requireSymlinks(): SymlinkCapability {
  if (cap === null) throw new Error('unreachable: this suite is gated on symlinkCapability()');
  return cap;
}

describe.skipIf(cap === null)('checkPackagedSizeLimit — links in the packaged output', () => {
  const LIMIT = 10_000;

  it('counts a symlinked FILE at the size of its target, which is what uploads', () => {
    // `statSync` follows the link and the uploader reads the link's contents —
    // both see the target's bytes, so the walk must too.
    const dir = writeBundle({ 'SKILL.md': 500, 'assets/real.bin': 9_600 });
    createSymlink(requireSymlinks(), safePath.join(dir, 'assets/real.bin'), safePath.join(dir, 'link.bin'));
    expect(checkPackagedSizeLimit(dir, LIMIT)[0]?.message).toContain('link.bin (9.4 KiB)');
  });

  it('reports a symlinked DIRECTORY it cannot weigh instead of scoring it zero', () => {
    // `Dirent.isDirectory()` is lstat-based, so a symlinked directory is never
    // pushed onto the walk stack and its bytes are never counted. That is a real
    // under-count, and the receipt is the only thing that says so.
    const dir = writeBundle({ 'SKILL.md': 500 });
    const heavy = writeBundle({ 'payload.bin': 9_600 }, 'heavy');
    createSymlink(requireSymlinks(), heavy, safePath.join(dir, 'vendor'), 'dir');
    const issues = checkPackagedSizeLimit(dir, LIMIT);
    expect(issues.map(i => i.code)).toEqual(['SCAN_PATH_UNREADABLE']);
    expect(issues[0]?.location).toBe('vendor');
  });

  it('reports a dangling link rather than counting it as zero bytes', () => {
    const dir = writeBundle({ 'SKILL.md': 500 });
    createSymlink(requireSymlinks(), safePath.join(dir, 'gone.bin'), safePath.join(dir, 'ghost.bin'));
    const issues = checkPackagedSizeLimit(dir, LIMIT);
    expect(issues.map(i => i.code)).toEqual(['SCAN_PATH_UNREADABLE']);
    expect(issues[0]?.location).toBe('ghost.bin');
  });
});

describe('describeOversizeBundle', () => {
  // `vat claude org skills install` refuses over-ceiling bundles BEFORE uploading,
  // using this same builder, so an author meets one wording whether the finding
  // reaches them at build time or at upload time. These pin the shared contract —
  // if the uploader ever grows its own copy of this sentence, that is the drift
  // this suite exists to make visible.
  //
  // What the two lanes CANNOT share is the number: the build weighs files on disk,
  // the uploader weighs the multipart request it is about to send. `measure.of` is
  // how each says which, and the suite below holds them to saying different things.
  const oversize = [
    { path: 'scripts/runtime.wasm', bytes: 35_700_000 },
    { path: 'SKILL.md', bytes: 70_800 },
    { path: 'resources/guide.md', bytes: 54_400 },
    { path: 'resources/a.md', bytes: 10 },
    { path: 'resources/b.md', bytes: 10 },
  ];
  const oversizeTotal = oversize.reduce((sum, f) => sum + f.bytes, 0);

  it('leads with the largest files, which are usually the whole diagnosis', () => {
    const message = describeOversizeBundle(oversize, packagedFiles(oversizeTotal));
    expect(message).toContain('scripts/runtime.wasm (34.0 MiB)');
    expect(message).toContain('SKILL.md (69.1 KiB)');
    expect(message).toContain('resources/guide.md (53.1 KiB)');
    // The rest are counted, not listed — a bundle this size has too many to name.
    expect(message).toContain('and 2 more files');
    expect(message).not.toContain('resources/a.md');
  });

  it('does not say "1 more files" when exactly one file goes unnamed', () => {
    const four = oversize.slice(0, 4);
    const message = describeOversizeBundle(four, packagedFiles(four.reduce((sum, f) => sum + f.bytes, 0)));
    expect(message).toContain('and 1 more file');
    expect(message).not.toContain('1 more files');
  });

  it('states both sides of the comparison in the SAME unit', () => {
    // "51.7 MB ... over the 30 MiB ceiling" cannot be compared as written: the
    // reader has to convert one side to know how far over they are. Both sides are
    // now binary, and the ceiling still reads as the vendor's own "30".
    const message = describeOversizeBundle(oversize, packagedFiles(oversizeTotal));
    expect(message).toContain('is 34.2 MiB');
    expect(message).toContain('over the 30.0 MiB');
    expect(message).not.toMatch(/\d MB/);
  });

  it('renders a caller-supplied limit in the same unit as everything else', () => {
    expect(describeOversizeBundle(oversize, packagedFiles(oversizeTotal), 1_000_000))
      .toContain('over the 976.6 KiB');
  });

  it('does not say "1 files" when the bundle is a single file', () => {
    expect(describeOversizeBundle([{ path: 'big.bin', bytes: 40_000_000 }], packagedFiles(40_000_000)))
      .toContain('across 1 file,');
  });

  // ── The two lanes measure different things and must say which ───────────────
  // The build-time walk cannot build a multipart body — it weighs files on disk.
  // The uploader weighs the request it is about to send. Both are correct, and a
  // message that let a reader believe they were the same number would be the
  // defect: an author who trims a bundle to "29.9 MiB of files" can still eat a
  // 413, because 1,000 parts carry ~180 KiB of boundaries and headers.
  it('says it weighed the packaged FILES when that is what was weighed', () => {
    const message = describeOversizeBundle(oversize, packagedFiles(oversizeTotal));
    expect(message).toContain('Packaged skill is');
    expect(message).not.toContain('framing');
  });

  it('says it weighed the REQUEST, and separates the file bytes from the framing', () => {
    const message = describeOversizeBundle(
      oversize,
      { of: 'upload-request', bytes: oversizeTotal + 180_000 },
    );
    expect(message).toContain('Upload request body is 34.3 MiB');
    // The file bytes are still reported, so the two numbers are legible apart.
    expect(message).toContain('34.2 MiB of file content across 5 files');
    expect(message).toContain('multipart framing');
  });
});
