#!/usr/bin/env node
/**
 * Validate all SKILL.md files in the project
 *
 * Finds all SKILL.md files (excluding dist/node_modules) and validates them
 * using the skill validator. Exits with non-zero code if any validation fails.
 */

import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { validateSkill, type ValidationIssue } from '@vibe-agent-toolkit/agent-skills';

export interface ValidationSummary {
  totalSkills: number;
  passed: number;
  failed: number;
  warnings: number;
  errors: ValidationError[];
}

export interface ValidationError {
  skillPath: string;
  errorCount: number;
  warningCount: number;
  issues: Array<{
    severity: string;
    code: string;
    message: string;
    location: string;
  }>;
}

/**
 * Recursively find all SKILL.md files in a directory
 */
export function findSkillFiles(dir: string, results: string[] = []): string[] {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Scanning project directories
    const entries = readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);

      // Skip dist and node_modules
      if (entry.name === 'dist' || entry.name === 'node_modules') {
        continue;
      }

      if (entry.isDirectory()) {
        findSkillFiles(fullPath, results);
      } else if (entry.name === 'SKILL.md') {
        results.push(fullPath);
      }
    }
  } catch (error) {
    // Log warning but continue validation of accessible directories
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.warn(`⚠️  Skipping directory ${dir}: ${errorMessage}`);
  }

  return results;
}

/**
 * Validate a single skill and return status update
 */
export async function validateSingleSkill(
  skillPath: string,
  summary: ValidationSummary
): Promise<void> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Validating discovered skill paths
  if (!existsSync(skillPath)) {
    summary.failed++;
    summary.errors.push({
      skillPath,
      errorCount: 1,
      warningCount: 0,
      issues: [
        {
          severity: 'error',
          code: 'FILE_NOT_FOUND',
          message: 'File does not exist',
          location: skillPath,
        },
      ],
    });
    return;
  }

  // Validate skill
  const result = await validateSkill({
    skillPath,
    rootDir: dirname(skillPath),
  });

  const errorCount = result.issues.filter((i: ValidationIssue) => i.severity === 'error').length;
  const warningCount = result.issues.filter((i: ValidationIssue) => i.severity === 'warning').length;

  // Update summary based on validation result
  if (result.status === 'error') {
    summary.failed++;
    summary.errors.push({
      skillPath,
      errorCount,
      warningCount,
      issues: result.issues.map((issue: ValidationIssue) => ({
        severity: issue.severity,
        code: issue.code,
        message: issue.message,
        location: issue.location ?? skillPath,
      })),
    });
  } else if (result.status === 'warning') {
    summary.warnings++;
    summary.passed++; // Warnings don't fail validation
  } else {
    summary.passed++;
  }

  // Show progress
  const skillName = result.metadata?.name ?? basename(dirname(skillPath));
  if (result.status === 'error') {
    console.log(`   ❌ ${skillName} (${errorCount} error${errorCount === 1 ? '' : 's'})`);
  } else if (result.status === 'warning') {
    console.log(`   ⚠️  ${skillName} (${warningCount} warning${warningCount === 1 ? '' : 's'})`);
  } else {
    console.log(`   ✅ ${skillName}`);
  }
}

/**
 * Output validation summary
 */
export function outputSummary(summary: ValidationSummary, duration: number): void {
  console.log(`\n📊 Summary:`);
  console.log(`   Total: ${summary.totalSkills}`);
  console.log(`   Passed: ${summary.passed}`);
  console.log(`   Failed: ${summary.failed}`);
  console.log(`   Warnings: ${summary.warnings}`);
  console.log(`   Duration: ${duration}ms\n`);

  // Output errors in detail
  if (summary.errors.length > 0) {
    console.error('❌ Validation errors:\n');
    for (const error of summary.errors) {
      console.error(`   ${error.skillPath}:`);
      for (const issue of error.issues) {
        console.error(`      ${issue.severity}: ${issue.message} (${issue.code})`);
        console.error(`      Location: ${issue.location}`);
      }
      console.error('');
    }
  }
}

// Main execution with top-level await (only when run directly)
if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  const startTime = Date.now();

  // Find all SKILL.md files (excluding dist and node_modules)
  const skillPaths = findSkillFiles('packages');

  if (skillPaths.length === 0) {
    console.log('✅ No SKILL.md files found to validate');
    process.exit(0);
  }

  console.log(`🔍 Validating ${skillPaths.length} skill${skillPaths.length === 1 ? '' : 's'}...\n`);

  const summary: ValidationSummary = {
    totalSkills: skillPaths.length,
    passed: 0,
    failed: 0,
    warnings: 0,
    errors: [],
  };

  // Validate each skill
  for (const skillPath of skillPaths) {
    await validateSingleSkill(skillPath, summary);
  }

  const duration = Date.now() - startTime;
  outputSummary(summary, duration);

  // Exit with error if any skills failed
  if (summary.failed > 0) {
    process.exit(1);
  }

  process.exit(0);
}
