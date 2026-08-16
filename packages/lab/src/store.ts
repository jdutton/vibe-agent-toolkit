/**
 * Reading and writing reports on disk.
 *
 * Reports are JSON, one file per observation, and the filename carries enough
 * of the coordinate to be recognisable in a directory listing without opening
 * anything. The envelope inside is still the authority — a filename is a
 * convenience, never a source of truth, because a renamed file would otherwise
 * silently change what a report claims to be.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

import { safePath } from '@vibe-agent-toolkit/utils';

import type { Coordinate } from './envelope/coordinate.js';
import {
  type EnvelopeResult,
  readEnvelope,
  REPORT_FORMAT_VERSION,
  type ReportEnvelope,
} from './envelope/envelope.js';

/** How many characters of a commit or fingerprint appear in a filename. */
const SHORT_ID_LENGTH = 8;

/**
 * Reduce a value to something safe to put in a filename.
 *
 * Lossy on purpose — and therefore **never used alone for an identifier that
 * must stay distinct**. Replacing every unsafe character with a dash maps
 * `a/b` and `a:b` onto the same string, so a name built from this alone would
 * let two different subjects overwrite each other's measurements, invisibly:
 * the surviving file looks perfectly well-formed. {@link distinctSlug} is what
 * callers use for identifiers; this is only for values that are already
 * constrained (a facet name, a hex commit).
 *
 * @param value - Raw value
 * @returns A filename-safe rendering, not guaranteed unique
 */
function slug(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._-]/g, '-');
}

/**
 * A filename-safe rendering that cannot collide for two different inputs.
 *
 * Keeps the readable slug — a directory listing is useless otherwise — and
 * appends a short digest of the *raw* value, so two ids that slug identically
 * still land on different filenames.
 *
 * @param value - Raw value
 * @returns A readable, collision-free rendering
 */
function distinctSlug(value: string): string {
  const digest = createHash('sha256').update(value, 'utf8').digest('hex').slice(0, SHORT_ID_LENGTH);
  return `${slug(value)}-${digest}`;
}

/**
 * The short identifier for axis B, whichever kind it is.
 *
 * @param coordinate - The report's coordinate
 * @returns A short, stable string naming the subject version
 */
function subjectVersionTag(coordinate: Coordinate): string {
  const version = coordinate.subjectVersion;
  if (version.kind === 'snapshot') {
    return `snap-${version.fingerprint.slice(0, SHORT_ID_LENGTH)}`;
  }
  const commit = version.commit.slice(0, SHORT_ID_LENGTH);
  // A dirty tree's identity is NOT its commit — the bytes measured were not the
  // bytes at that commit, and two different dirty states share the HEAD they
  // branched from. Without the fingerprint here, every dirty run at one commit
  // would write to one filename and silently overwrite the last, which is the
  // failure this whole naming scheme exists to prevent.
  return version.dirty
    ? `${commit}-dirty-${(version.workingFingerprint ?? '').slice(0, SHORT_ID_LENGTH)}`
    : commit;
}

/**
 * The short identifier for axis C.
 *
 * A dirty build's identity is NOT its commit — the bytes measured were not the
 * bytes at that commit — and unlike a dirty *subject* there is no fingerprint to
 * fall back on, because what ran is the built output rather than the checkout
 * (see `InstrumentVersion.dirty`). So a dirty instrument is pinned by *when it
 * was observed* instead. That is weaker than an identity and it is meant to be:
 * it cannot say two dirty runs measured the same build, but it does guarantee
 * that a second dirty run never silently overwrites the first, which is the
 * failure this whole naming scheme exists to prevent.
 *
 * @param envelope - The report being named
 * @returns A short, stable string naming the instrument build
 */
function instrumentTag(envelope: ReportEnvelope<unknown>): string {
  const instrument = envelope.coordinate.instrument;
  const build =
    instrument.commit === null ? 'release' : instrument.commit.slice(0, SHORT_ID_LENGTH);
  const base = `vat-${slug(instrument.version)}-${build}`;
  return instrument.dirty === true ? `${base}-dirty-${slug(envelope.capturedAt)}` : base;
}

/**
 * The filename a report is stored under.
 *
 * Encodes facet, subject, subject version and instrument — the whole coordinate
 * except what would make the name unreadable. Two reports that differ on any
 * MODELLED axis therefore land on different filenames and cannot overwrite each
 * other.
 *
 * ⚠️ **"Any axis" means any axis the coordinate models, and an instrument
 * selected by the ENVIRONMENT is not one of them.** Measured 2026-08-15: two
 * `crawl run` invocations over one subject, differing only in
 * `VAT_INVENTORY_CRAWL` (the switch choosing the incumbent link-walk crawler or
 * the projection crawler), produced two genuinely different measurements and
 * wrote them to a **byte-identical path** — the second silently overwrote the
 * first. That is precisely "the failure this whole naming scheme exists to
 * prevent", and it is silent: nothing warns, and the survivor looks like a
 * complete capture.
 *
 * The lab does not set that variable and does not read it: it spawns the vat
 * binary and the value is inherited from whoever ran the lab, so nothing here
 * can currently notice. Closing this means giving the instrument coordinate an
 * explicit VARIANT (a general operator-supplied label, not a VAT-specific env
 * allowlist) and putting it in {@link instrumentTag} — a coordinate change, so
 * it is recorded here rather than patched around.
 *
 * ✅ Until then the workaround is real and was RUN, not assumed: send each arm to
 * its own `--out` directory, then hand `crawl compare` the two report paths. It
 * prints a correct arm-vs-arm diff, honestly headed "Comparing two reports at the
 * same coordinate" — which is exactly the gap named above, stated by the tool
 * itself. Prefer this over a distinct `--id` per arm: that does reach the
 * filename, but via the SUBJECT axis, so it buys separation by recording that the
 * arms measured two different subjects, which they did not.
 *
 * @param envelope - The report to name
 * @returns A filename, without a directory
 */
export function reportFileName(envelope: ReportEnvelope<unknown>): string {
  return (
    [
      slug(envelope.facet),
      distinctSlug(envelope.coordinate.subject.id),
      slug(subjectVersionTag(envelope.coordinate)),
      instrumentTag(envelope),
    ].join('__') + '.json'
  );
}

/**
 * Write a report into a directory, creating it if needed.
 *
 * @param directory - Where reports live
 * @param envelope - The report to store
 * @returns The absolute path written
 */
export async function writeReport(
  directory: string,
  envelope: ReportEnvelope<unknown>,
): Promise<string> {
  if (envelope.formatVersion !== REPORT_FORMAT_VERSION) {
    throw new Error(
      `Refusing to write a report claiming formatVersion ${String(envelope.formatVersion)}; ` +
        `this build writes ${String(REPORT_FORMAT_VERSION)}.`,
    );
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- report directory chosen by the operator running the lab
  await mkdir(directory, { recursive: true });
  const target = safePath.join(directory, reportFileName(envelope));
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- filename is composed here, not supplied
  await writeFile(target, `${JSON.stringify(envelope, null, 2)}\n`, 'utf-8');
  return target;
}

/**
 * Read a report back.
 *
 * Returns the envelope's own refusal rather than throwing, so a caller
 * comparing many stored reports can report which ones it could not read
 * instead of dying on the first.
 *
 * @param filePath - Path to a stored report
 * @returns The parsed envelope, or a refusal
 */
export async function readReport(filePath: string): Promise<EnvelopeResult<unknown>> {
  let raw: string;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- report path supplied by the operator reading their own captures
    raw = await readFile(filePath, 'utf-8');
  } catch (error) {
    return {
      ok: false,
      refusal: `REFUSED: could not read '${filePath}': ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      refusal: `REFUSED: '${filePath}' is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return readEnvelope(parsed);
}
