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

import { isPathAbsentError } from '@vibe-agent-toolkit/utils';
import { CommandExecutionError } from '@vibe-agent-toolkit/utils/process';

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
    // Decided by the failure's SHAPE, never its message text. npm ran and exited
    // non-zero: the package was not linked, or npm itself erred — nothing to undo.
    if (error instanceof CommandExecutionError) {
      console.log(`   (was not linked or npm error - skipped)`);
      return true;
    }
    // npm never ran: the spawn found no `npm` (ENOENT). That is not "was not
    // linked" — nothing was unlinked, and the operator must be told.
    if (isPathAbsentError(error)) {
      console.error(`❌ Failed to unlink ${packageName}: npm was not found on PATH`);
      return false;
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
