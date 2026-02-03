/**
 * jscpd-update-baseline.ts
 *
 * Update the duplication baseline after intentional refactoring.
 * Use this when you've successfully reduced duplication.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildJscpdArgs, safeExecSync } from './common.js';

const BASELINE_FILE = join('.github', '.jscpd-baseline.json');

/**
 * IMPORTANT: Test files are INTENTIONALLY included in duplication checks.
 * This matches the configuration in jscpd-check-new.ts.
 * See that file for detailed explanation of why we check test code duplication.
 *
 * Configuration is shared via buildJscpdArgs() from common.ts to ensure consistency.
 */
const JSCPD_ARGS = buildJscpdArgs();

console.log('🔄 Updating duplication baseline...\n');

// Run jscpd
try {
  safeExecSync('npx', ['jscpd', ...JSCPD_ARGS], { encoding: 'utf-8', stdio: 'pipe' });
} catch {
  // Expected - jscpd exits with error if duplications found
}

// Read current report
const reportPath = './jscpd-report/jscpd-report.json';
const currentReport = JSON.parse(readFileSync(reportPath, 'utf-8'));
const currentClones = currentReport.duplicates ?? [];

// Save as new baseline
writeFileSync(BASELINE_FILE, JSON.stringify({ duplicates: currentClones }, null, 2));

console.log('✅ Baseline updated!');
console.log(`   Clones: ${String(currentClones.length)}`);
console.log(`   Duplication: ${String(currentReport.statistics.total.percentage.toFixed(2))}%`);
console.log(`   Lines: ${String(currentReport.statistics.total.duplicatedLines)} / ${String(currentReport.statistics.total.totalLines)}\n`);

console.log(`📝 Baseline saved to: ${BASELINE_FILE}`);
console.log(`   Commit this file to version control.\n`);
