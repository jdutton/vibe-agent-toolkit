/**
 * jscpd-check-new.ts
 *
 * Fails pre-commit only if NEW duplication is introduced.
 * Compares current scan to baseline, ignoring existing technical debt.
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs';

import { ExitCode } from '@vibe-agent-toolkit/schema';
import { safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';

import { buildJscpdArgs, runJscpd } from './common.js';

// Type definitions for jscpd output
interface CloneLocation {
  name: string;
  startLoc: { line: number };
  endLoc: { line: number };
}

interface Clone {
  format: string;
  firstFile: CloneLocation;
  secondFile: CloneLocation;
}

const BASELINE_FILE = safePath.join('.github', '.jscpd-baseline.json');

/**
 * IMPORTANT: Test files are INTENTIONALLY included in duplication checks.
 *
 * Why we check test code duplication (shift-left principle):
 *
 * 1. **Consistency with SonarQube**: SonarQube checks both src and test code.
 *    Pre-commit checks should catch the same issues to prevent CI surprises.
 *
 * 2. **Early Detection**: Catching duplication in local pre-commit is faster and
 *    cheaper than discovering it in CI after push (shift-left testing).
 *
 * 3. **Test Quality**: Duplicated test code is just as problematic as duplicated
 *    production code. It makes tests harder to maintain, update, and understand.
 *
 * 4. **Baseline Approach**: We baseline existing duplication (technical debt) but
 *    prevent NEW duplication from being introduced going forward.
 *
 * Configuration is shared via buildJscpdArgs() and JSCPD_CONFIG from common.ts.
 */
const JSCPD_ARGS = buildJscpdArgs();

/**
 * Create clone signature for comparison
 */
function getCloneSignature(clone: Clone) {
  // Normalize paths to forward slashes so baselines generated on Linux/CI
  // match when duplication-check runs on Windows (where jscpd reports backslashes).
  const first = toForwardSlash(clone.firstFile.name);
  const second = toForwardSlash(clone.secondFile.name);
  return `${clone.format}:${first}:${clone.firstFile.startLoc.line}-${clone.firstFile.endLoc.line}:${second}:${clone.secondFile.startLoc.line}-${clone.secondFile.endLoc.line}`;
}

/**
 * Check for new duplications
 */
function checkNewDuplications() {
  console.log('🔍 Checking for new code duplication...\n');

  // Run current scan
  const currentReport = runJscpd<Clone>(JSCPD_ARGS);
  const currentClones = currentReport.duplicates ?? [];

  // Load baseline
  if (!existsSync(BASELINE_FILE)) {
    console.log('📝 No baseline found. Creating baseline from current state...');
    writeFileSync(BASELINE_FILE, JSON.stringify({ duplicates: currentClones }, null, 2));
    console.log(`✅ Baseline saved to ${BASELINE_FILE}`);
    console.log(`   Current duplication: ${String(currentReport.statistics.total.percentage.toFixed(2))}%`);
    console.log(`   (${String(currentClones.length)} clones)\n`);
    process.exit(ExitCode.OK);
  }

  const baseline = JSON.parse(readFileSync(BASELINE_FILE, 'utf-8')) as { duplicates?: Clone[] };
  const baselineClones = baseline.duplicates ?? [];

  // Build baseline signature set for comparison
  const baselineSignatures = new Set(baselineClones.map(getCloneSignature));

  // Find new clones (not in baseline)
  const newClones = currentClones.filter((clone: Clone) =>
    !baselineSignatures.has(getCloneSignature(clone))
  );

  // Report results
  if (newClones.length === 0) {
    console.log('✅ No new code duplication detected!');
    console.log(`   Current: ${String(currentClones.length)} clones (${String(currentReport.statistics.total.percentage.toFixed(2))}%)`);
    console.log(`   Baseline: ${String(baselineClones.length)} clones\n`);
    process.exit(ExitCode.OK);
  }

  // New duplications found - FAIL
  console.log(`❌ NEW code duplication detected! (${String(newClones.length)} new clones)\n`);

  for (const clone of newClones) {
    const fileA = String(clone.firstFile.name);
    const fileB = String(clone.secondFile.name);
    const linesA = `${String(clone.firstFile.startLoc.line)}-${String(clone.firstFile.endLoc.line)}`;
    const linesB = `${String(clone.secondFile.startLoc.line)}-${String(clone.secondFile.endLoc.line)}`;
    const lines = clone.firstFile.endLoc.line - clone.firstFile.startLoc.line + 1;

    console.log(`  📁 ${fileA}:${linesA}`);
    console.log(`     ↔ ${fileB}:${linesB}`);
    console.log(`     (${String(lines)} lines duplicated)\n`);
  }

  console.log('💡 To fix:');
  console.log('   1. Extract duplicated code into shared utilities');
  console.log('   2. Refactor to eliminate duplication');
  console.log('   3. Or update baseline: bun run duplication-update-baseline\n');

  process.exit(ExitCode.FINDINGS);
}

checkNewDuplications();
