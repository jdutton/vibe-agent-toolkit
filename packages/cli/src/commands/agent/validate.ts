/**
 * Agent validate command - validates agent manifest and prerequisites
 *
 * Publishes the `Report<T>` envelope (`validate-schema.ts`): one manifest per
 * run, its schema violations and unreachable references as findings located at
 * the manifest. A path that names no manifest, or one that cannot be read as
 * YAML, has nothing to report findings about — the envelope's error branch,
 * classified by the loader's code.
 */

import { validateAgent, type ValidationResult } from '@vibe-agent-toolkit/agent-config';
import { buildReport, toFindings } from '@vibe-agent-toolkit/schema';
import { isAbsoluteAnyPlatform, issueLocation, safePath } from '@vibe-agent-toolkit/utils';

import { resolveAgentPath } from '../../utils/agent-discovery.js';
import { CommandRefusalError, refusalCodeOf } from '../../utils/command-refusal.js';
import { endWithRefusal, endWithReport, NOTHING_FINISHED } from '../../utils/document-writer.js';
import { createLogger, type Logger } from '../../utils/logger.js';
import { requireProjectRoot } from '../../utils/project-root-policy.js';

import type { AgentValidateReport } from './validate-schema.js';

export interface ValidateCommandOptions {
  debug?: boolean;
}

/** `vat agent validate` offers no `--strict`: warnings never fail it. */
const GATE = { strict: false } as const;

/**
 * A location the document can publish, or a refusal when it is not relative.
 *
 * Every location in the document is relative to the working directory, and on
 * Windows a manifest on another drive than the working directory has no
 * relative path: `path.relative` hands back the absolute one, which the
 * published schema refuses — so the run used to die on its own document with
 * an uncaught schema error and print nothing. That is the invocation's
 * mistake, and it is said as one.
 *
 * @param location - `issueLocation(manifestPath, root)`
 * @param root - The working directory
 * @returns The location, unchanged, when it is relative
 * @throws CommandRefusalError `USAGE_INVALID` when it is absolute
 */
export function relativeLocationOrRefuse(location: string, root: string): string {
  if (isAbsoluteAnyPlatform(location)) {
    throw new CommandRefusalError(
      'USAGE_INVALID',
      `vat agent validate reports locations relative to the working directory, and ${location} has no path relative to ${root} (it is on another drive). Run from the manifest's drive.`,
    );
  }
  return location;
}

/**
 * Build the report. Pure: no file system, no clock, no `process.exit`.
 *
 * @param result - What the validator found about the one manifest it read
 * @param root - The working directory: the ONE base the manifest path and every location are relative to
 * @param durationMs - How long the run took
 * @returns The report; `examined` is 1 — the manifest was read
 */
function buildAgentValidateReport(result: ValidationResult, root: string, durationMs: number): AgentValidateReport {
  return buildReport({
    examined: 1,
    findings: toFindings(result.issues),
    data: {
      root,
      manifest: {
        name: result.manifest.name,
        version: result.manifest.version,
        path: relativeLocationOrRefuse(issueLocation(result.manifest.path, root), root),
      },
    },
    gate: GATE,
    durationMs,
  });
}

/** The human half, on stderr. */
function logOutcome(report: AgentValidateReport, logger: Logger): void {
  if (report.summary.errors > 0) {
    logger.error('Agent validation failed');
  } else if (report.findings.length > 0) {
    logger.info('Validation passed with findings:');
  } else {
    logger.info('Agent validation successful');
  }
  for (const finding of report.findings) {
    logger.error(`  - [${finding.severity}] ${finding.message} [${finding.code}]`);
  }
}

export async function validateCommand(
  pathOrName: string,
  options: ValidateCommandOptions
): Promise<void> {
  const logger = createLogger(options.debug ? { debug: true } : {});
  const startTime = Date.now();
  const root = safePath.resolve(process.cwd());

  let report: AgentValidateReport;
  try {
    // Resolve agent name to path if needed
    const targetPath = await resolveAgentPath(pathOrName, logger);
    logger.debug(`Validating agent: ${targetPath}`);

    // The manifest first: a path naming nothing, or one the OS refuses, is the
    // same refusal wherever the command runs. Then spec §7: a projectRoot.
    const result = await validateAgent(targetPath, { locationRoot: root });
    requireProjectRoot(process.cwd(), 'vat agent validate');

    report = buildAgentValidateReport(result, root, Date.now() - startTime);
  } catch (error) {
    // By code: the loader's NOT_FOUND is the invocation's mistake, its
    // UNREADABLE the input's; anything uncoded is a defect in VAT.
    endWithRefusal('agent validate', refusalCodeOf(error), error, 'yaml', GATE, NOTHING_FINISHED);
  }

  logOutcome(report, logger);
  endWithReport('agent validate', report, 'yaml');
}
