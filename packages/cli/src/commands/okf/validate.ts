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
import type { SeverityCounts } from '@vibe-agent-toolkit/schema';
import { findConfigFile } from '@vibe-agent-toolkit/utils';

import { handleCommandError } from '../../utils/command-error.js';
import { createLogger } from '../../utils/logger.js';
import { writeJsonOutput, writeYamlOutput } from '../../utils/output.js';

export interface OkfValidateOptions {
  format?: 'yaml' | 'json';
  specVersion?: string;
  debug?: boolean;
}

/** The document this command publishes. */
interface OkfValidateReport {
  status: OkfValidateStatus;
  bundles: OkfBundleReport[];
  findingCount: number;
  issueCounts: SeverityCounts;
  /** Present only when there was nothing to check; says what to declare. */
  notice?: string;
}

/**
 * `no-bundles` is a third word on purpose, and it is not cosmetic.
 *
 * 🪤 This command used to print `status: passed`, `bundles: []`, exit 0 when a
 * project declared no `okf.bundles` at all — a report indistinguishable from a
 * bundle that was read in full and found conformant. A mistyped key
 * (`okf.bundle:`, `okf.Bundles:`) therefore reads as a clean bill of health,
 * which is the *green-without-running* shape this repo keeps rediscovering.
 *
 * `vat resources check` already answers the identical situation properly — "No
 * checks are declared. Add them under `resources.checks` …" — so this follows a
 * convention the repo holds rather than inventing one.
 *
 * The exit code stays 0: nothing failed, and failing a build for a feature the
 * project never opted into would be worse. It is the status *word* that must not
 * claim a pass, because that word is what a human and a CI log actually read.
 */
export type OkfValidateStatus = 'passed' | 'failed' | 'no-bundles';

/** The summary half of the report: pure, so the status rule is testable. */
export interface OkfValidateSummary {
  status: OkfValidateStatus;
  findingCount: number;
  /**
   * The severity distribution, published BESIDE the status rather than folded
   * into it.
   *
   * Load-bearing here specifically because OKF severity is adopter-configurable
   * per bundle (`okf.bundles.<name>.severity`). A project that lowers a bundle
   * to `warning` gets `status: passed` and exit 0 for a bundle carrying real
   * conformance findings — correct, and completely opaque from the status word
   * alone. The distribution is the only thing in the report that distinguishes
   * "nothing was found" from "everything found was downgraded".
   */
  issueCounts: SeverityCounts;
  notice?: string;
}

/**
 * Count one bundle set's findings by severity.
 *
 * Not `countBySeverity` from `@vibe-agent-toolkit/schema`: that takes
 * `ValidationIssue[]`, whose `code` is the shared `IssueCode` registry union,
 * and an OKF finding's code is drawn from the specification's own vocabulary
 * rather than that registry. The counts field is still typed as the shared
 * `SeverityCounts`, so the SHAPE stays checked against the canonical one and a
 * bucket cannot be added, renamed or dropped here alone.
 *
 * @param findings - Every finding across every bundle that was checked
 * @returns The per-severity distribution
 */
function countOkfFindings(findings: readonly OkfFinding[]): SeverityCounts {
  let errors = 0;
  let warnings = 0;
  let info = 0;
  for (const finding of findings) {
    if (finding.severity === 'error') {
      errors += 1;
    } else if (finding.severity === 'warning') {
      warnings += 1;
    } else {
      info += 1;
    }
  }
  return { errors, warnings, info };
}

/**
 * Decide the status word and the counts for a set of bundle reports.
 *
 * @param bundles - One report per bundle that was actually checked
 * @returns The status, the finding count and severity distribution, and a
 *   notice when nothing was declared
 */
export function summarizeOkfBundles(bundles: readonly OkfBundleReport[]): OkfValidateSummary {
  const findings = bundles.flatMap((report) => report.findings);
  const findingCount = findings.length;
  const issueCounts = countOkfFindings(findings);

  if (bundles.length === 0) {
    return {
      status: 'no-bundles',
      findingCount,
      issueCounts,
      notice:
        'No OKF bundles are declared, so nothing was checked. Declare one under `okf.bundles.<name>.root` in vibe-agent-toolkit.config.yaml; every non-reserved .md beneath that root is then checked for frontmatter carrying a non-empty `type`.',
    };
  }

  return { status: issueCounts.errors > 0 ? 'failed' : 'passed', findingCount, issueCounts };
}

/**
 * Assemble the report for every selected bundle.
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
  const runs = okfBundleRuns(config.okf, dirname(configPath), {
    ...(bundleArg !== undefined && { bundle: bundleArg }),
    ...(options.specVersion !== undefined && { specVersion: options.specVersion }),
  });

  const bundles: OkfBundleReport[] = [];
  for (const run of runs) {
    bundles.push(await validateOkfBundle(run));
  }

  return { ...summarizeOkfBundles(bundles), bundles };
}

/** Action handler for `vat okf validate [bundle]`. */
export async function okfValidateCommand(
  bundleArg: string | undefined,
  options: OkfValidateOptions,
): Promise<void> {
  const logger = createLogger(options.debug === true ? { debug: true } : {});
  const startTime = Date.now();

  try {
    const report = await okfValidateReport(bundleArg, options);
    if (options.format === 'json') {
      writeJsonOutput(report);
    } else {
      writeYamlOutput(report);
    }
    // Read from the counts the report PUBLISHES, not from the status word: an
    // adopter who promotes or lowers a bundle's severity then gates on exactly
    // the number a reader can see.
    process.exit(report.issueCounts.errors > 0 ? 1 : 0);
  } catch (error) {
    handleCommandError(error, logger, startTime, 'OKF validate', options.format);
  }
}
