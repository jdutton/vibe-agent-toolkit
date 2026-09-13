/**
 * `vat okf validate [bundle]` — conformance for the OKF bundles a project declares.
 *
 * Producer-side, and the exit code says so: OKF §11 tells CONSUMERS not to
 * reject a bundle over broken cross-links or unknown keys, but VAT is tooling
 * for the publisher — the one party who can fix them — so a finding at `error`
 * severity fails the command. An adopter who wants a softer gate lowers
 * `okf.bundles.<name>.severity`; the finding is still reported either way.
 */

import { dirname } from 'node:path';

import {
  okfBundleRuns,
  parseConfigFile,
  validateOkfBundle,
  type OkfBundleReport,
  type OkfFinding,
} from '@vibe-agent-toolkit/resources';
import { buildReport, exitCodeForSeverityCounts, reportSchema, type Finding, type Report } from '@vibe-agent-toolkit/schema';
import { findConfigFile, issueLocation, safePath } from '@vibe-agent-toolkit/utils';
import { z } from 'zod';

import { handleReportCommandError } from '../../utils/command-error.js';
import { createLogger } from '../../utils/logger.js';
import { writeStructuredOutput } from '../../utils/output.js';

export interface OkfValidateOptions {
  format?: 'yaml' | 'json';
  specVersion?: string;
  debug?: boolean;
}

/** One checked bundle's `data` row: what was read, never the findings (those are the envelope's). */
export const OkfBundleSummarySchema = z.object({
  /** The `okf.bundles.<name>` key. */
  bundle: z.string(),
  /** The root as the config file wrote it — never the resolved absolute path. */
  root: z.string(),
  /** Every non-reserved `.md` beneath the root, bundle-relative and sorted. */
  conceptDocuments: z.array(z.string()),
  /** Every `index.md` / `log.md` beneath the root, bundle-relative and sorted. */
  reservedDocuments: z.array(z.string()),
  /** What the root `index.md` declares, when it declares a well-formed one. Reported, never obeyed. */
  declaredOkfVersion: z.string().optional(),
}).strict();

export const OkfValidateDataSchema = z.object({
  bundles: z.array(OkfBundleSummarySchema),
  /**
   * Present only when there was nothing to check, and says what to declare or
   * which root to look at.
   *
   * 🪤 The command used to print `status: passed`, `bundles: []`, exit 0 when a
   * project declared no `okf.bundles` at all — a report indistinguishable from
   * a bundle read in full and found conformant, so a mistyped key
   * (`okf.bundle:`, `okf.Bundles:`) read as a clean bill of health. The
   * envelope's REQUIRED `examined` now says `0` in that case, and this sentence
   * says why. The exit code stays 0: nothing failed, and failing a build for a
   * feature the project never opted into would be worse.
   */
  notice: z.string().optional(),
}).strict();

export type OkfBundleSummary = z.infer<typeof OkfBundleSummarySchema>;
export type OkfValidateData = z.infer<typeof OkfValidateDataSchema>;

/** The document this command publishes. */
export const OKF_VALIDATE_REPORT_SCHEMA = reportSchema(OkfValidateDataSchema);

export type OkfValidateReport = Report<OkfValidateData>;

/** One bundle's report beside the absolute root it was read from. */
export interface CheckedOkfBundle {
  readonly report: OkfBundleReport;
  /** The resolved absolute root, so a finding can name a project-relative file. */
  readonly root: string;
}

/**
 * The bundles whose root was read successfully and held not one markdown file.
 *
 * 🪤 The same green-without-running shape the `notice` exists for, one level
 * down. A `root:` typo that lands on a real-but-wrong directory, or a root
 * written one level too deep, produces zero findings and an `examined` that
 * only THIS bundle's rows explain — so the run says so in words too.
 *
 * A bundle carrying findings is excluded even when its document lists are empty:
 * that is the unreadable-root case, which already says the truthful thing in its
 * own finding, and "contains no .md files" would be a second, wronger sentence
 * about a directory that does not exist.
 *
 * @param bundles - Every bundle report in the run
 * @returns The names of the vacuous ones, in report order
 */
function vacuousBundles(bundles: readonly OkfBundleReport[]): string[] {
  return bundles
    .filter(
      (report) =>
        report.findings.length === 0 &&
        report.conceptDocuments.length === 0 &&
        report.reservedDocuments.length === 0,
    )
    .map((report) => report.bundle);
}

/**
 * The sentence a run with one or more vacuous bundles carries.
 *
 * @param vacuous - Names of the bundles whose root held no markdown at all
 * @returns A notice naming each of them and the config key to check
 */
function vacuousNotice(vacuous: readonly string[]): string {
  const named = vacuous.map((bundle) => `'${bundle}'`).join(', ');
  const subject = vacuous.length === 1 ? 'it' : 'them';
  return `${named} contains no .md files, so nothing was checked in ${subject}. A root pointing one level too deep, or at a real-but-wrong directory, reads exactly like this — check \`okf.bundles.<name>.root\`.`;
}

/**
 * The sentence a run carries when it examined less than a reader would assume.
 *
 * @param bundles - Every bundle report in the run
 * @returns The notice, or nothing when every declared bundle held documents
 */
function noticeFor(bundles: readonly OkfBundleReport[]): string | undefined {
  if (bundles.length === 0) return NO_BUNDLES_NOTICE;
  const vacuous = vacuousBundles(bundles);
  return vacuous.length > 0 ? vacuousNotice(vacuous) : undefined;
}

const NO_BUNDLES_NOTICE =
  'No OKF bundles are declared, so nothing was checked. Declare one under `okf.bundles.<name>.root` in vibe-agent-toolkit.config.yaml; every non-reserved .md beneath that root is then checked for frontmatter carrying a non-empty `type`.';

/**
 * A bundle's finding as the envelope publishes it: the same code, severity and
 * message, with `location` the project-relative path of the document — the
 * file you would open — rather than a bundle-relative `document` a reader had
 * to join with the bundle's root by hand.
 *
 * @param finding - The lane's finding
 * @param root - The bundle's absolute root
 * @param projectRoot - What `location` is relative to
 * @returns The published finding
 */
function toFinding(finding: OkfFinding, root: string, projectRoot: string): Finding {
  return {
    code: finding.code,
    severity: finding.severity,
    message: finding.message,
    location: issueLocation(safePath.join(root, finding.document), projectRoot),
    ...(finding.link === undefined ? {} : { link: finding.link }),
    ...(finding.line === undefined ? {} : { line: finding.line }),
  };
}

/**
 * Assemble the report for a set of checked bundles. Pure, so the status rule
 * and the denominator are unit-testable.
 *
 * `examined` counts every document that was opened and judged — concept and
 * reserved alike — across every bundle. A declared-but-empty bundle and an
 * empty declaration both examine zero, and the notice tells them apart.
 *
 * @param checked - One report per bundle that was actually checked, with its root
 * @param projectRoot - What every finding's `location` is relative to
 * @returns The report
 */
export function summarizeOkfBundles(
  checked: readonly CheckedOkfBundle[],
  projectRoot: string,
): OkfValidateReport {
  const bundles = checked.map((entry) => entry.report);
  const findings = checked.flatMap((entry) =>
    entry.report.findings.map((finding) => toFinding(finding, entry.root, projectRoot)),
  );
  const examined = bundles.reduce(
    (sum, report) => sum + report.conceptDocuments.length + report.reservedDocuments.length,
    0,
  );
  const notice = noticeFor(bundles);

  return buildReport<OkfValidateData>({
    examined,
    findings,
    data: {
      bundles: bundles.map((report) => ({
        bundle: report.bundle,
        root: report.root,
        conceptDocuments: report.conceptDocuments,
        reservedDocuments: report.reservedDocuments,
        ...(report.declaredOkfVersion === undefined ? {} : { declaredOkfVersion: report.declaredOkfVersion }),
      })),
      ...(notice === undefined ? {} : { notice }),
    },
  });
}

/**
 * Check every selected bundle and assemble the report.
 *
 * Separate from the action so the shape is testable without a process exit.
 *
 * @param bundleArg - A single declared bundle name, or undefined for all of them
 * @param options - Output format and the optional revision to cross-check against
 */
export async function okfValidateReport(
  bundleArg: string | undefined,
  options: OkfValidateOptions,
): Promise<OkfValidateReport> {
  const configPath = findConfigFile(process.cwd());
  if (!configPath) {
    throw new Error('No vibe-agent-toolkit.config.yaml found. Run from a project directory.');
  }

  const config = await parseConfigFile(configPath);
  const projectRoot = dirname(configPath);
  const runs = okfBundleRuns(config.okf, projectRoot, {
    ...(bundleArg !== undefined && { bundle: bundleArg }),
    ...(options.specVersion !== undefined && { specVersion: options.specVersion }),
  });

  const checked: CheckedOkfBundle[] = [];
  for (const run of runs) {
    checked.push({ report: await validateOkfBundle(run), root: run.root });
  }

  return summarizeOkfBundles(checked, projectRoot);
}

/** Action handler for `vat okf validate [bundle]`. */
export async function okfValidateCommand(
  bundleArg: string | undefined,
  options: OkfValidateOptions,
): Promise<void> {
  const logger = createLogger(options.debug === true ? { debug: true } : {});
  const startTime = Date.now();

  try {
    const report = { ...(await okfValidateReport(bundleArg, options)), durationMs: Date.now() - startTime };
    writeStructuredOutput(report, options.format);
    // Read from the counts the report PUBLISHES, not from the status word: an
    // adopter who promotes or lowers a bundle's severity then gates on exactly
    // the number a reader can see.
    process.exit(exitCodeForSeverityCounts(report.summary));
  } catch (error) {
    handleReportCommandError(error, logger, startTime, 'OKF validate', options.format);
  }
}
