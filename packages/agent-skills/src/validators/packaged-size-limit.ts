/**
 * PACKAGED_SIZE_EXCEEDS_API_LIMIT — the packaged skill is too large to upload to
 * the Anthropic Skills API.
 *
 * ## Why this needs its own detector rather than a threshold on an existing one
 *
 * VAT ships two checks whose names suggest they already answer this, and neither
 * can:
 *
 * - `SKILL_TOTAL_SIZE_LARGE` counts **lines** across bundled markdown (≤2000).
 * - `SKILL_TOO_MANY_FILES` counts **files** (≤6).
 *
 * The shape that actually blocks a publish is one large binary, which has no
 * lines and is one file. The measured instance is a 35.7 MB `.wasm` runtime
 * bundled by three skills in a single adopter marketplace: over the ceiling on
 * its own, before a byte of markdown counts, and invisible to both checks above.
 * Before this module there was no byte measurement anywhere in the validators.
 *
 * ## Why the message names the largest files
 *
 * A total alone ("34.9 MB, limit 30 MB") tells an author they have a problem and
 * not where it is; a bundle at that size has hundreds of files and the true cause
 * is nearly always one or two of them. The adopter who reported this built the
 * same thing locally and said naming the largest files "is the thing that made
 * the cause obvious in one line". So the finding leads with the offenders.
 *
 * ## Built phase only
 *
 * The bytes that matter are the bytes that ship, and a `files:` config entry
 * materializes files at build time — a source tree can lack the very artifact
 * that blows the ceiling. Measuring the source directory would answer a
 * different question and get it wrong in both directions.
 */

import { readdirSync, statSync, type Dirent } from 'node:fs';

import { CODE_REGISTRY, type ValidationIssue } from '@vibe-agent-toolkit/schema';
import { safePath } from '@vibe-agent-toolkit/utils';

/**
 * The Skills API's refusal ceiling, in bytes. The vendor documents it as "Total
 * upload size must be under 30 MB (uncompressed)" and the 413 says "requests up
 * to 30MBs", neither of which says whether MB means 10^6 or 2^20 — a 1.4 MB gap.
 *
 * **This is measured, not read.** VAT first assumed decimal (30,000,000) as the
 * conservative reading. Uploading against the live API disproved it:
 *
 * | Bundle content bytes | Result |
 * |---|---|
 * | 30,700,000 | **accepted** — above decimal 30 MB, so decimal is wrong |
 * | 31,500,000 | 413 refused |
 * | 35,900,338 | 413 refused |
 *
 * That brackets the ceiling to (30,700,000, 31,500,000], and 2^20 × 30 =
 * 31,457,280 is the only round number in the window. So the limit is mebibytes,
 * and the old decimal constant warned ~1.46 MB early — a false-positive band on
 * every bundle between 30.0 and 31.4 MB, which is exactly where a big bundle
 * lands.
 *
 * ## What this counts versus what the API counts
 *
 * The API measures the REQUEST; this check measures the bundle's file bytes.
 * Multipart framing (a boundary and headers per part) makes the request a few
 * hundred bytes larger, so a bundle within roughly a kilobyte under the ceiling
 * can still be refused. That residue is deliberately not padded out with a fudge
 * factor: an invented margin is a number nobody can re-derive, and the check
 * already fires AT the ceiling rather than only above it.
 *
 * @vendor-claim reviewed=2026-09-06 verify=Re-measure rather than re-read — the docs do not state the unit. Upload two skill bundles via `vat claude org skills install`, one just under and one just over this constant, and confirm the first is accepted and the second returns 413. Adjust only if the bracket moves.
 */
export const API_SKILL_MAX_UPLOAD_BYTES = 31_457_280;

/** How the vendor writes the ceiling, for messages: their "30 MB" is 30 MiB. */
const CEILING_LABEL = '30 MiB';

/** Naive English pluralisation; every noun this file counts is regular. */
function plural(noun: string, count: number): string {
  return count === 1 ? noun : `${noun}s`;
}

/** How many offenders the message names before it stops listing. */
const LARGEST_FILES_NAMED = 3;

interface SizedFile {
  /** Path relative to the packaged skill root. */
  readonly path: string;
  readonly bytes: number;
}

/** Decimal units, to match the vendor's own. */
const BYTE_UNITS = ['kB', 'MB', 'GB', 'TB'] as const;

/** Human-readable bytes, decimal to match the vendor's own units. */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < BYTE_UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  // `?? ''` is unreachable — `unit` is bounded by the loop condition — but
  // noUncheckedIndexedAccess types the read as possibly-undefined and a
  // non-null assertion would hide a real bug if that bound ever moved.
  return `${value.toFixed(1)} ${BYTE_UNITS[unit] ?? ''}`.trimEnd();
}

/**
 * Every regular file under `root`, with its size, relative to `root`.
 *
 * Symlinks are measured with `statSync` (following the link) rather than
 * `lstatSync`: the packaged output is what gets uploaded, and a link that
 * resolves to a 30 MB file contributes 30 MB to that upload. A broken link
 * contributes nothing and is skipped rather than thrown on — a size check must
 * not be the thing that fails a build, and `RESOURCE_UNREADABLE` already owns
 * "VAT could not read this".
 */
function sizedFilesUnder(root: string): SizedFile[] {
  const out: SizedFile[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;
    for (const dirent of readDirSafely(dir)) {
      const full = safePath.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        stack.push(full);
        continue;
      }
      const bytes = fileSizeOrUndefined(full);
      if (bytes !== undefined) out.push({ path: safePath.relative(root, full), bytes });
    }
  }
  return out;
}

/** Directory entries, or none when the directory cannot be read. */
function readDirSafely(dir: string): Dirent[] {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- caller-supplied packaged output dir
  try { return readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

/** Size of a regular file, or `undefined` for anything else or an unreadable entry. */
function fileSizeOrUndefined(path: string): number | undefined {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- as above
    const stats = statSync(path);
    return stats.isFile() ? stats.size : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Emit `PACKAGED_SIZE_EXCEEDS_API_LIMIT` when the packaged bundle at `outputDir`
 * is at or over the API upload ceiling.
 *
 * One issue for the bundle, not one per file: unlike a per-reference finding, the
 * defect here IS the total — no single file is "the" problem unless it alone
 * exceeds the ceiling, and emitting per file would hand an adopter a waiver
 * granularity that cannot express the actual fix. The largest files are named in
 * the message, where they are diagnosis rather than separate findings.
 *
 * @param outputDir Absolute path to the packaged skill output.
 * @param limitBytes Ceiling to compare against. Defaults to the documented API
 *   limit; parameterized so a test can drive it with a few kilobytes instead of
 *   writing 30 MB of fixture to disk.
 */
export function checkPackagedSizeLimit(
  outputDir: string,
  limitBytes: number = API_SKILL_MAX_UPLOAD_BYTES,
): ValidationIssue[] {
  const files = sizedFilesUnder(outputDir);
  const total = files.reduce((sum, file) => sum + file.bytes, 0);
  if (total < limitBytes) return [];

  const largest = [...files].sort((a, b) => b.bytes - a.bytes).slice(0, LARGEST_FILES_NAMED);
  const named = largest.map(file => `${file.path} (${formatBytes(file.bytes)})`).join(', ');
  const remainder = files.length - largest.length;
  const tail = remainder > 0 ? `, and ${remainder} more ${plural('file', remainder)}` : '';

  const registryEntry = CODE_REGISTRY.PACKAGED_SIZE_EXCEEDS_API_LIMIT;
  // Name the real ceiling the way the vendor does ("30 MB", meaning 30 MiB) so the
  // author can match the message against the docs and the 413 they would have got.
  // A caller-supplied limit is a test's, and reads better in the decimal units the
  // totals are already reported in.
  const ceiling = limitBytes === API_SKILL_MAX_UPLOAD_BYTES ? CEILING_LABEL : formatBytes(limitBytes);
  return [{
    severity: registryEntry.defaultSeverity,
    code: 'PACKAGED_SIZE_EXCEEDS_API_LIMIT',
    message:
      `Packaged skill is ${formatBytes(total)} across ${files.length} ` +
      `${plural('file', files.length)}, over the ${ceiling} Anthropic Skills API ` +
      `upload ceiling. Largest: ${named}${tail}`,
    // The bundle root, because the finding is about the bundle. Naming the
    // largest file here would claim that one file is the defect, which is only
    // true when it alone exceeds the ceiling.
    location: '.',
    fix: registryEntry.fix,
    reference: registryEntry.reference,
  }];
}
