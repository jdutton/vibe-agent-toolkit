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
 *
 * ## This module is the ONLY thing that stats the packaged bytes
 *
 * That is why an entry it cannot weigh gets a receipt rather than a zero — see
 * {@link walkBundle}. No other validator revisits these files, so a silent zero
 * here is a silent zero everywhere.
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
 * The API measures the REQUEST. This check measures the bundle's file bytes,
 * because at build time there is no request to weigh — see
 * {@link checkPackagedSizeLimit} for why that is left as it is rather than
 * modelled.
 *
 * The gap between the two is not small. `buildMultipartFormData` frames every
 * file part with a 51-byte boundary line, a `Content-Disposition` header of
 * 61 bytes plus the filename, a 42-byte content-type-and-blank-line, and a
 * 2-byte trailing CRLF — **156 bytes plus the filename's length, per file** —
 * and closes the body with a 53-byte terminator. Measured: one part with a
 * 14-character filename costs 170 bytes of framing, and a 1,000-file bundle
 * with `resources/`-shaped names costs ~185,000. So a bundle whose FILES sit
 * just under the ceiling can be a REQUEST comfortably over it. An earlier
 * version of this comment put the residue at "a few hundred bytes… roughly a
 * kilobyte", which understates it by two orders of magnitude on a many-file
 * bundle.
 *
 * The uploader therefore weighs the body it built rather than the sum of its
 * file bytes, and says so in its own message ({@link OversizeMeasure}). Neither
 * lane pads its threshold with a fudge factor: an invented margin is a number
 * nobody can re-derive.
 *
 * ## The two lanes compare DIFFERENTLY, and that is the correct answer
 *
 * The ceiling is INCLUSIVE, measured: a request body of exactly 31,457,280 bytes
 * (31,456,735 file bytes plus 545 of framing) returned `status: success`, and one
 * byte more returned `413`. So:
 *
 * - **Request bytes: `>` refuses.** The uploader knows the exact body and must
 *   not refuse one the API would take.
 * - **File bytes: `>=` refuses** — this lane, {@link checkPackagedSizeLimit}.
 *   Framing is never zero, so files totalling exactly the limit ALWAYS frame up
 *   into a request larger than the limit and earn a real 413.
 *
 * An earlier version of this comment claimed "both fire AT the ceiling rather
 * than only above it" and offered that as the conservative reading. It was
 * reasoned, never measured, and the measurement above refutes it for the request
 * lane. Do not harmonise the two operators: they are applied to different
 * quantities and each is right about the one it can see.
 *
 * @vendor-claim reviewed=2026-09-06 verify=Re-measure rather than re-read — the docs do not state the unit. Upload two skill bundles via `vat claude org skills install`, one just under and one just over this constant, and confirm the first is accepted and the second returns 413. Adjust only if the bracket moves.
 */
export const API_SKILL_MAX_UPLOAD_BYTES = 31_457_280;

/**
 * Directory names that never reach the Skills API, so their bytes never count
 * toward its ceiling.
 *
 * 🔑 **This must stay identical to the uploader's exclusion set**, because the
 * two halves apply the SAME constant and the SAME sentence and must therefore
 * apply them to the same file set. They did not: the walk summed everything
 * under the output directory while `vat claude org skills install` dropped these
 * three directories from the multipart body, so a bundle of 31.0 MB of shipped
 * content plus a 1.0 MB `evals/` fired at build and uploaded fine — a false
 * positive on the only lane that shows the finding to the AUTHOR, which is the
 * lane whose credibility the check depends on.
 *
 * The case is reachable and documented into existence: a root `evals/` holding
 * no `evals.json` is ordinary content, so `vat build` packages it and the
 * uploader drops it unconditionally.
 *
 * The exclusion is by DIRECTORY, so a regular FILE named `evals` is weighed here
 * because it is sent there. The uploader spells its own test
 * `directoryLike && NEVER_UPLOADED_DIR_NAMES.has(entry.name)`, where
 * `directoryLike` is a real directory OR a symbolic link resolving to one — this
 * walk cannot descend a linked directory at all (`Dirent.isDirectory()` is
 * lstat-based), so it weighs one as zero and files a `SCAN_PATH_UNREADABLE`
 * receipt for it. Both lanes therefore leave a linked `evals` out of the total;
 * they differ only in whether they say so.
 *
 * ⚠️ ONE asymmetry remains, and it can only under-count: the uploader also
 * withholds the skill's DECLARED eval-suite unit, which it resolves from the
 * governing VAT config asynchronously. This walk is synchronous and knows only
 * an output directory. In a built bundle that unit is normally absent anyway —
 * the packager drops declared test input on the way in and reports what it
 * dropped — so the residue is a bundle weighed slightly heavy, never light.
 */
export const NEVER_UPLOADED_DIR_NAMES: ReadonlySet<string> = new Set(['evals', 'node_modules', '.git']);

/** Naive English pluralisation; every noun this file counts is regular. */
function plural(noun: string, count: number): string {
  return count === 1 ? noun : `${noun}s`;
}

/** How many offenders the message names before it stops listing. */
const LARGEST_FILES_NAMED = 3;

export interface SizedFile {
  /** Path relative to the packaged skill root. */
  readonly path: string;
  readonly bytes: number;
}

/** An entry whose bytes could not be established, and why. */
export interface UnweighedEntry {
  /** Path relative to the packaged skill root; `.` for the root itself. */
  readonly path: string;
  /** Phrase completing "…, so its bytes were not counted": the cause, in the open. */
  readonly reason: string;
}

/** What one walk of a packaged bundle establishes — and what it could not. */
export interface BundleWalk {
  readonly files: readonly SizedFile[];
  readonly unweighed: readonly UnweighedEntry[];
}

/**
 * Binary units, because the only threshold any of these numbers is read against
 * is binary: {@link API_SKILL_MAX_UPLOAD_BYTES} is exactly 30 × 2^20, measured.
 * Rendered in decimal, a total and the ceiling it is compared to could not be
 * compared as written — "51.7 MB … over the 30 MiB ceiling" makes the reader do
 * the conversion before they know how far over they are. The base and the labels
 * move together: a function dividing by 1024 must not print "MB".
 */
const BYTE_UNITS = ['KiB', 'MiB', 'GiB', 'TiB'] as const;

/** Human-readable bytes, in the binary units the API's ceiling is expressed in. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // `?? ''` is unreachable — `unit` is bounded by the loop condition — but
  // noUncheckedIndexedAccess types the read as possibly-undefined and a
  // non-null assertion would hide a real bug if that bound ever moved.
  return `${value.toFixed(1)} ${BYTE_UNITS[unit] ?? ''}`.trimEnd();
}

/** Mutable accumulator for {@link walkBundle}; the exported view is readonly. */
interface WalkAccumulator {
  files: SizedFile[];
  unweighed: UnweighedEntry[];
}

/** Whatever the platform gave us, as text a reader can act on. */
function causeOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A path as the finding spells it: bundle-relative POSIX, and `.` for the root. */
function bundleRelative(root: string, target: string): string {
  return safePath.relative(root, target) || '.';
}

/**
 * Every regular file under `root` with its size, plus every entry whose size
 * could NOT be established.
 *
 * ## Why "could not weigh it" is a return value and not a zero
 *
 * Every unreadable entry used to be swallowed into `[]`/`undefined` and summed
 * as ZERO. That under-counts in exactly the direction that produces a clean bill
 * of health: `statSync` failing on the 35.7 MB `.wasm` (an ELOOP symlink cycle, a
 * Windows file lock, a file removed between readdir and stat) took the total from
 * ~36 MB to ~2 MB, the build reported no warnings, and the upload ate a 413
 * eleven seconds later — precisely the outcome this module exists to prevent.
 *
 * Nothing else was going to say so. `RESOURCE_UNREADABLE` — which an earlier
 * version of this comment claimed "already owns 'VAT could not read this'" — is
 * emitted by `walk-link-graph.ts` over the SOURCE link graph and never stats the
 * packaged output. This walk is the only thing that touches these bytes, so the
 * receipt is its own to emit (`SCAN_PATH_UNREADABLE`, warning: a size check must
 * not be the thing that fails a build, but it must never be silent about what it
 * could not put on the scale).
 *
 * ## Symlinks, exactly
 *
 * A symlinked FILE is measured through the link: `statSync` follows it, so a link
 * resolving to a 30 MB file contributes 30 MB — which matches the uploader, whose
 * `readFileSync` reads the target's bytes.
 *
 * A symlinked DIRECTORY is NOT walked and contributes nothing, because
 * `Dirent.isDirectory()` is lstat-based and answers `false` for it, so the entry
 * never reaches the stack. That is a genuine under-count, so it becomes an
 * unweighed entry rather than a silent zero — as does any other non-regular
 * entry (device, socket, FIFO) and any dangling link, whose `statSync` throws.
 */
function walkBundle(root: string): BundleWalk {
  const acc: WalkAccumulator = { files: [], unweighed: [] };
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;
    for (const dirent of readDirOrRecord(dir, root, acc)) {
      const full = safePath.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        if (!NEVER_UPLOADED_DIR_NAMES.has(dirent.name)) stack.push(full);
        continue;
      }
      weighEntry(full, bundleRelative(root, full), acc);
    }
  }
  return acc;
}

/** Directory entries, recording a receipt when the directory cannot be read. */
function readDirOrRecord(dir: string, root: string, acc: WalkAccumulator): Dirent[] {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- caller-supplied packaged output dir
    return readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    acc.unweighed.push({
      path: bundleRelative(root, dir),
      reason: `VAT could not read the directory (${causeOf(error)})`,
    });
    return [];
  }
}

/** Record one non-directory entry: its size, or why it has none VAT can use. */
function weighEntry(full: string, rel: string, acc: WalkAccumulator): void {
  let stats;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- as above
    stats = statSync(full);
  } catch (error) {
    acc.unweighed.push({ path: rel, reason: `VAT could not stat it (${causeOf(error)})` });
    return;
  }
  if (stats.isFile()) {
    acc.files.push({ path: rel, bytes: stats.size });
    return;
  }
  acc.unweighed.push({
    path: rel,
    reason: 'it is not a regular file (a symbolic link to a directory, a device, or a socket)',
  });
}

/** The bundle's files, heaviest first — the order both the message and the anchor want. */
function largestFirst(files: readonly SizedFile[]): SizedFile[] {
  return [...files].sort((a, b) => b.bytes - a.bytes);
}

/**
 * What went on the scale, and WHICH scale it was.
 *
 * The two lanes cannot weigh the same thing. The build-time walk sums file bytes
 * off the filesystem; there is no request at build time to weigh. The uploader
 * weighs the multipart body it is holding, which is what the API measures. Both
 * are correct about what they can see, and the one thing neither may do is let a
 * reader believe they are the same number — an author who trims a bundle to
 * "29.9 MiB of files" can still earn a 413, because the framing is ~156 bytes per
 * file plus the filename (see {@link API_SKILL_MAX_UPLOAD_BYTES}).
 *
 * So the measure travels with the number, and the sentence says which it is.
 */
export interface OversizeMeasure {
  readonly of: 'packaged-files' | 'upload-request';
  readonly bytes: number;
}

/**
 * The one sentence describing an over-ceiling upload, shared by the build-time
 * validator and by `vat claude org skills install`'s pre-flight refusal.
 *
 * Both refuse for the same external reason, so neither owns the wording: the
 * uploader's copy would otherwise drift from the validator's, and an author who
 * met the warning at build would meet a differently-worded version of it at
 * upload. It takes already-measured files rather than a directory because the
 * uploader knows something the walker cannot — which files it EXCLUDED (the
 * declared eval suite) — and must describe the bundle it is actually sending.
 * The exclusions it can state up front are shared as
 * {@link NEVER_UPLOADED_DIR_NAMES}, so both sides weigh the same file set.
 *
 * The two lanes differ in exactly one place, {@link OversizeMeasure}: the request
 * variant reports the body it weighed AND the file bytes inside it, so the
 * framing is visible as the difference rather than as an unexplained discrepancy.
 */
export function describeOversizeBundle(
  files: readonly SizedFile[],
  measure: OversizeMeasure,
  limitBytes: number = API_SKILL_MAX_UPLOAD_BYTES,
): string {
  const largest = largestFirst(files).slice(0, LARGEST_FILES_NAMED);
  const named = largest.map(file => `${file.path} (${formatBytes(file.bytes)})`).join(', ');
  const remainder = files.length - largest.length;
  const tail = remainder > 0 ? `, and ${remainder} more ${plural('file', remainder)}` : '';
  const across = `${files.length} ${plural('file', files.length)}`;
  const fileBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  const subject = measure.of === 'upload-request'
    ? `Upload request body is ${formatBytes(measure.bytes)} — ${formatBytes(fileBytes)} `
      + `of file content across ${across}, plus per-part multipart framing —`
    : `Packaged skill is ${formatBytes(measure.bytes)} across ${across},`;
  return (
    `${subject} over the ${formatBytes(limitBytes)} Anthropic Skills API ` +
    `upload ceiling. Largest: ${named}${tail}`
  );
}

/** One receipt per entry the walk could not put on the scale. */
function unweighedIssues(entries: readonly UnweighedEntry[]): ValidationIssue[] {
  const registryEntry = CODE_REGISTRY.SCAN_PATH_UNREADABLE;
  return entries.map(entry => ({
    severity: registryEntry.defaultSeverity,
    code: 'SCAN_PATH_UNREADABLE' as const,
    message:
      `Not weighed against the ${formatBytes(API_SKILL_MAX_UPLOAD_BYTES)} Anthropic Skills API upload ceiling: `
      + `${entry.reason}. The packaged size VAT measured is a LOWER BOUND.`,
    location: entry.path,
    fix: registryEntry.fix,
    reference: registryEntry.reference,
  }));
}

/**
 * Emit `PACKAGED_SIZE_EXCEEDS_API_LIMIT` when the packaged bundle at `outputDir`
 * is at or over the API upload ceiling, plus one `SCAN_PATH_UNREADABLE` for every
 * entry whose bytes VAT could not establish.
 *
 * ## This weighs FILES, and deliberately not the request
 *
 * The API refuses on the size of the multipart REQUEST, and the uploader weighs
 * exactly that — the body it is about to send. This lane cannot: there is no
 * request at build time, and the framing is not a property of the bundle. Its
 * per-part cost is `156 + len(filename)`, where the filename is not the packaged
 * path but `<declared-name>/<packaged-path>` as the uploader keys it, and the
 * body also carries whatever fields that endpoint takes — a `display_title` on
 * create, none on a version add. Every one of those is decided at upload time.
 *
 * Adding an ESTIMATE of it here would mean re-deriving the multipart builder's
 * arithmetic in a second place, where it would silently stop matching the first —
 * which is the same defect as a fudge factor, only harder to spot. So this check
 * measures what it can see, the message says "Packaged skill is …", and the
 * uploader's says "Upload request body is …". They are different numbers on
 * purpose, and a bundle that clears this one can still be refused there.
 *
 * One size issue for the bundle, not one per file: unlike a per-reference
 * finding, the defect here IS the total — no single file is "the" problem unless
 * it alone exceeds the ceiling, and emitting per file would hand an adopter a
 * waiver granularity that cannot express the actual fix.
 *
 * ## The anchor, and why the largest file is `link`
 *
 * `location` is the bundle root (`.`) because the finding is about the bundle —
 * but `.` is the SAME STRING for every skill in a multi-skill build, so an allow
 * glob written against it waives all of them or none. That left one escape hatch,
 * `severity.PACKAGED_SIZE_EXCEEDS_API_LIMIT: ignore`, which is project-wide: an
 * adopter with 40 skills, one legitimately bundling a 32 MB runtime it never
 * publishes to the API, had to blind themselves on the other 39.
 *
 * So the largest file rides as `link` — the same convention the rest of this lane
 * uses (`referenced-path-missing`, `mcp-tool-qualification`), where `link` is the
 * specific thing an instance is about and `location` stays the file you open.
 * `applyAllowFilter` matches an allow glob against `location` OR `link`, so:
 *
 * ```yaml
 * validation:
 *   allow:
 *     PACKAGED_SIZE_EXCEEDS_API_LIMIT:
 *       - paths: ["scripts/duckdb-eh.wasm"]
 *         reason: "Runtime this skill needs; never published to the Skills API."
 * ```
 *
 * …waives exactly the bundles whose weight that file explains, and every other
 * skill keeps the check.
 *
 * ⚠️ Two skills bundling the SAME oversized artifact share one anchor, so one
 * entry waives both. That is the right grain for the case that produced this
 * check (one `.wasm`, three skills, one decision), but it is NOT per-skill
 * precision. Per-skill would need an anchor naming the skill, which this call
 * site cannot mint: `location` must be a project-relative path and the packager
 * passes only an absolute output directory. A caller that wants it should pass
 * the bundle root as `issueLocation(outputPath, projectRoot)` and have this
 * function use it in place of `.`.
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
  const { files, unweighed } = walkBundle(outputDir);
  const issues = unweighedIssues(unweighed);
  const total = files.reduce((sum, file) => sum + file.bytes, 0);
  // `>=`, deliberately unlike the uploader's `>`. This weighs FILE bytes, and
  // per-part framing is never zero, so a bundle whose files total exactly the
  // limit is always a request LARGER than the limit — a real 413. See
  // {@link API_SKILL_MAX_UPLOAD_BYTES} for the measured boundary and why the two
  // operators must not be made to match.
  if (total < limitBytes) return issues;

  const registryEntry = CODE_REGISTRY.PACKAGED_SIZE_EXCEEDS_API_LIMIT;
  const heaviest = largestFirst(files)[0];
  issues.push({
    severity: registryEntry.defaultSeverity,
    code: 'PACKAGED_SIZE_EXCEEDS_API_LIMIT',
    message: describeOversizeBundle(files, { of: 'packaged-files', bytes: total }, limitBytes),
    // The bundle root, because the finding is about the bundle. Naming the
    // largest file here would claim that one file is the defect, which is only
    // true when it alone exceeds the ceiling — it rides as `link` instead.
    location: '.',
    // Absent only for a bundle with no weighable file at all, which needs a
    // zero or negative limit to reach this line.
    ...(heaviest === undefined ? {} : { link: heaviest.path }),
    fix: registryEntry.fix,
    reference: registryEntry.reference,
  });
  return issues;
}
