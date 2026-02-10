#!/usr/bin/env node
/**
 * Unlink all publishable packages from global npm
 *
 * Usage: bun run unlink-all
 *
 * This removes global npm links created by link-all, cleaning up the
 * development environment. Consumer projects will need to run `npm install`
 * to restore normal package versions.
 */

import { processPackages, safeExecSync } from './common.js';

function unlinkPackage(packageName: string, _packagePath: string): boolean {
  try {
    console.log(`🔓 Unlinking: ${packageName}`);
    // Unlink from global npm using -g flag
    safeExecSync('npm', ['unlink', '-g', packageName], {
      stdio: 'pipe',
    });
    return true;
  } catch (error) {
    // npm unlink can fail if package wasn't linked - that's okay
    // Also ignore npm internal errors (bugs in npm itself)
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (
      errorMessage.includes('ENOENT') ||
      errorMessage.includes('not found') ||
      errorMessage.includes('ERR_PNPM_') ||
      errorMessage.includes('Cannot read properties of null')
    ) {
      console.log(`   (was not linked or npm error - skipped)`);
      return true;
    }
    console.error(`❌ Failed to unlink ${packageName}:`, error);
    return false;
  }
}

const exitCode = processPackages({
  action: 'unlink',
  actionVerb: 'Unlinked',
  introMessage: '🔓 VAT Development: Unlinking all packages from global npm\n',
  successMessage:
    '\n💡 In projects that used these links, run:\n' +
    '   npm install\n' +
    '   (to restore normal package versions)',
  packageHandler: unlinkPackage,
});

process.exit(exitCode);
