#!/usr/bin/env node
/**
 * Link all publishable packages globally for development testing
 *
 * Usage: bun run link-all
 *
 * This creates global npm links for all non-private packages in the monorepo,
 * making them available for `npm link @vibe-agent-toolkit/package-name` in
 * other projects.
 */

import { processPackages, safeExecSync } from './common.js';

function linkPackage(packageName: string, packagePath: string): boolean {
  try {
    console.log(`🔗 Linking: ${packageName}`);
    safeExecSync('npm', ['link'], {
      cwd: packagePath,
      stdio: 'pipe',
    });
    return true;
  } catch (error) {
    console.error(`❌ Failed to link ${packageName}:`, error);
    return false;
  }
}

const exitCode = processPackages({
  action: 'link',
  actionVerb: 'Linked',
  introMessage: '🔗 VAT Development: Linking all publishable packages globally\n',
  successMessage:
    '\n💡 Next step: In your target project, run:\n' +
    '   npm link @vibe-agent-toolkit/package-name\n' +
    '\n💡 To unlink later: bun run unlink-all',
  packageHandler: linkPackage,
});

process.exit(exitCode);
