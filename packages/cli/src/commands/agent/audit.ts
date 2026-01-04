/**
 * Agent audit command - audits Claude Skills for quality and compatibility
 */

import * as path from 'node:path';

import { detectFormat } from '@vibe-agent-toolkit/discovery';
import { validateSkill, type ValidationResult } from '@vibe-agent-toolkit/runtime-claude-skills';

import { handleCommandError } from '../../utils/command-error.js';
import { createLogger } from '../../utils/logger.js';
import { writeYamlOutput } from '../../utils/output.js';

export interface AuditCommandOptions {
  debug?: boolean;
  recursive?: boolean;
}

export async function auditCommand(
  targetPath: string | undefined,
  options: AuditCommandOptions
): Promise<void> {
  const logger = createLogger(options.debug ? { debug: true } : {});
  const startTime = Date.now();

  try {
    const scanPath = targetPath ? path.resolve(targetPath) : process.cwd();
    logger.debug(`Auditing Claude Skills at: ${scanPath}`);

    // Get validation results
    const results = await getValidationResults(scanPath, options.recursive ?? false, logger);

    // Calculate and output summary
    const summary = calculateSummary(results, startTime);
    writeYamlOutput(summary);

    // Log human-readable output and exit
    handleAuditResults(results, summary, logger);
  } catch (error) {
    handleCommandError(error, logger, startTime, 'AgentAudit');
  }
}

async function getValidationResults(
  scanPath: string,
  recursive: boolean,
  logger: ReturnType<typeof createLogger>
): Promise<ValidationResult[]> {
  const format = detectFormat(scanPath);

  if (format === 'claude-skill') {
    logger.debug('Detected single Claude Skill');
    const result = await validateSkill({ skillPath: scanPath });
    return [result];
  }

  if (format === 'vat-agent') {
    const skillPath = path.join(scanPath, 'SKILL.md');
    logger.debug('Detected VAT agent, validating SKILL.md');
    const result = await validateSkill({ skillPath, isVATGenerated: true });
    return [result];
  }

  logger.debug('Scanning directory for Claude Skills');
  return scanDirectory(scanPath, recursive, logger);
}

function calculateSummary(results: ValidationResult[], startTime: number) {
  const successCount = results.filter((r: ValidationResult) => r.status === 'success').length;
  const warningCount = results.filter((r: ValidationResult) => r.status === 'warning').length;
  const errorCount = results.filter((r: ValidationResult) => r.status === 'error').length;

  const totalErrors = results.reduce((sum: number, r: ValidationResult) =>
    sum + r.issues.filter(i => i.severity === 'error').length, 0
  );
  const totalWarnings = results.reduce((sum: number, r: ValidationResult) =>
    sum + r.issues.filter(i => i.severity === 'warning').length, 0
  );
  const totalInfo = results.reduce((sum: number, r: ValidationResult) =>
    sum + r.issues.filter(i => i.severity === 'info').length, 0
  );

  let status: string;
  if (errorCount > 0) {
    status = 'error';
  } else if (warningCount > 0) {
    status = 'warning';
  } else {
    status = 'success';
  }

  return {
    status,
    summary: {
      filesScanned: results.length,
      success: successCount,
      warnings: warningCount,
      errors: errorCount,
    },
    issues: {
      errors: totalErrors,
      warnings: totalWarnings,
      info: totalInfo,
    },
    files: results,
    duration: `${Date.now() - startTime}ms`,
  };
}

function handleAuditResults(
  results: ValidationResult[],
  summary: { summary: { errors: number; warnings: number; success: number } },
  logger: ReturnType<typeof createLogger>
): void {
  const { errors: errorCount, warnings: warningCount, success: successCount } = summary.summary;

  if (errorCount > 0) {
    logErrors(results, errorCount, logger);
    process.exit(1);
  }

  if (warningCount > 0) {
    logWarnings(results, warningCount, logger);
  } else {
    logger.info(`Audit successful: ${successCount} file(s) passed`);
  }

  process.exit(0);
}

function logErrors(
  results: ValidationResult[],
  errorCount: number,
  logger: ReturnType<typeof createLogger>
): void {
  logger.error(`Audit failed: ${errorCount} file(s) with errors`);
  const errorResults = results.filter((r: ValidationResult) => r.status === 'error');

  for (const result of errorResults) {
    logger.error(`\n${result.path}:`);
    const errorIssues = result.issues.filter((i: { severity: string }) => i.severity === 'error');
    logIssues(errorIssues, logger.error.bind(logger));
  }
}

function logWarnings(
  results: ValidationResult[],
  warningCount: number,
  logger: ReturnType<typeof createLogger>
): void {
  logger.info(`Audit passed with warnings: ${warningCount} file(s)`);
  const warningResults = results.filter((r: ValidationResult) => r.status === 'warning');

  for (const result of warningResults) {
    logger.info(`\n${result.path}:`);
    const warningIssues = result.issues.filter((i: { severity: string }) => i.severity === 'warning');
    logIssues(warningIssues, logger.info.bind(logger));
  }
}

function logIssues(
  issues: Array<{ code: string; message: string; location?: string; fix?: string }>,
  logFn: (message: string) => void
): void {
  for (const issue of issues) {
    logFn(`  [${issue.code}] ${issue.message}`);
    if (issue.location) {
      logFn(`    at: ${issue.location}`);
    }
    if (issue.fix) {
      logFn(`    fix: ${issue.fix}`);
    }
  }
}

async function scanDirectory(
  dirPath: string,
  recursive: boolean,
  logger: ReturnType<typeof createLogger>
): Promise<ValidationResult[]> {
  const fs = await import('node:fs/promises');
  const results: ValidationResult[] = [];

  const entries = await fs.readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);

    if (entry.isFile() && entry.name === 'SKILL.md') {
      logger.debug(`Validating: ${fullPath}`);
      const result = await validateSkill({ skillPath: fullPath });
      results.push(result);
    } else if (entry.isDirectory() && recursive) {
      const subResults = await scanDirectory(fullPath, recursive, logger);
      results.push(...subResults);
    }
  }

  return results;
}
