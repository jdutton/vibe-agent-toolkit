/**
 * jscpd-update-baseline.ts
 *
 * Update the duplication baseline after intentional refactoring.
 * Use this when you've successfully reduced duplication.
 */

import { writeFileSync } from 'node:fs';

import { safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';

import { buildJscpdArgs, runJscpd } from './common.js';

interface CloneFile {
  name: string;
  [k: string]: unknown;
}
interface Clone {
  firstFile: CloneFile;
  secondFile: CloneFile;
  [k: string]: unknown;
}

const BASELINE_FILE = safePath.join('.github', '.jscpd-baseline.json');

/**
 * IMPORTANT: Test files are INTENTIONALLY included in duplication checks.
 * This matches the configuration in jscpd-check-new.ts.
 * See that file for detailed explanation of why we check test code duplication.
 *
 * Configuration is shared via buildJscpdArgs() from common.ts to ensure consistency.
 */
const JSCPD_ARGS = buildJscpdArgs();

console.log('🔄 Updating duplication baseline...\n');

// Run jscpd and read the report it wrote — never a stale one from a run that crashed.
const currentReport = runJscpd<Clone>(JSCPD_ARGS);
const currentClones: Clone[] = currentReport.duplicates ?? [];

// Normalize paths to forward slashes so the baseline is cross-platform portable
// (jscpd emits backslashes on Windows; Linux/CI emits forward slashes).
const normalizedClones = currentClones.map((clone) => ({
  ...clone,
  firstFile: { ...clone.firstFile, name: toForwardSlash(clone.firstFile.name) },
  secondFile: { ...clone.secondFile, name: toForwardSlash(clone.secondFile.name) },
}));

// Save as new baseline
writeFileSync(BASELINE_FILE, JSON.stringify({ duplicates: normalizedClones }, null, 2));

console.log('✅ Baseline updated!');
console.log(`   Clones: ${String(currentClones.length)}`);
console.log(`   Duplication: ${String(currentReport.statistics.total.percentage.toFixed(2))}%`);
console.log(`   Lines: ${String(currentReport.statistics.total.duplicatedLines)} / ${String(currentReport.statistics.total.totalLines)}\n`);

console.log(`📝 Baseline saved to: ${BASELINE_FILE}`);
console.log(`   Commit this file to version control.\n`);
