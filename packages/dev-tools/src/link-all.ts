#!/usr/bin/env node
/**
 * Link all publishable packages globally for development testing
 *
 * Usage: bun run link-all
 *
 * This creates global npm links for all non-private packages in the monorepo,
 * making them available for `npm link @vibe-agent-toolkit/package-name` in
 * other projects.
 *
 * IMPORTANT: npm workspace bug with `npm link`
 * ============================================
 *
 * Problem:
 * When running `npm link` in a monorepo with workspace dependencies, npm can
 * fail with "Cannot read properties of null (reading 'package')" if there are
 * existing global installations of the same packages. This happens because:
 *
 * 1. npm link is a "global operation" (sets npm_config_global=true)
 * 2. Packages with postinstall scripts run during npm link
 * 3. If a globally installed version of vat exists, postinstall scripts use the
 *    OLD global version instead of the NEW workspace version
 * 4. This can cause npm's internal arborist to lose track of package references
 * 5. Result: npm error even though the code/packages are valid
 *
 * Solution:
 * Before linking, check for existing global installations and recommend
 * uninstalling them temporarily. After global installs are removed, npm link
 * works correctly because there's no version conflict.
 *
 * The fix for postinstall scripts (checking npm_command === 'install' vs 'link')
 * helps prevent state corruption, but doesn't fully solve the workspace conflict.
 *
 * Affected packages typically include:
 * - vibe-agent-toolkit (umbrella package with bin conflict - skipped by default)
 * - @vibe-agent-toolkit/cli (provides vat command)
 * - @vibe-agent-toolkit/agent-config (has complex workspace deps)
 * - @vibe-agent-toolkit/vat-example-cat-agents (has postinstall script)
 *
 * Known npm workspace bug (as of npm v11.5.1):
 * Some packages may fail to link with "Cannot read properties of null" even
 * with no global installations. This appears to be an npm arborist bug when:
 * - Package has multiple workspace:* dependencies
 * - npm tries to resolve the dependency tree during link
 * - Arborist loses track of package references
 *
 * This is OK! Most packages (16-17/19) link successfully, which is sufficient
 * for development. The CLI package usually works after retrying once.
 *
 * Debugging tips:
 * - Check `npm list -g --depth=0` for VAT packages
 * - Look for "Cannot read properties of null" in npm logs
 * - Try `npm uninstall -g <package>` before linking (fixes ~90% of cases)
 * - Check /Users/$USER/.npm/_logs for detailed npm errors
 * - If 2-3 packages persistently fail, that's expected npm workspace behavior
 */

import { processPackages, safeExecSync } from './common.js';

/**
 * Check for globally installed VAT packages that might interfere with npm link
 * Returns list of packages that should be uninstalled
 */
function checkForGlobalInstallations(): string[] {
  try {
    const result = safeExecSync('npm', ['list', '-g', '--depth=0', '--json'], {
      stdio: 'pipe',
      encoding: 'utf8',
    });

    const globalPackages = JSON.parse(result as string) as {
      dependencies?: Record<string, { version: string; resolved?: string }>;
    };

    const problematicPackages: string[] = [];

    if (globalPackages.dependencies) {
      // Check for umbrella package
      if ('vibe-agent-toolkit' in globalPackages.dependencies) {
        problematicPackages.push('vibe-agent-toolkit');
      }

      // Check for CLI package (provides vat command)
      if ('@vibe-agent-toolkit/cli' in globalPackages.dependencies) {
        // Only flag if it's a real install (not a symlink from previous npm link)
        const pkg = globalPackages.dependencies['@vibe-agent-toolkit/cli'];
        if (pkg.resolved && !pkg.resolved.includes('file:')) {
          problematicPackages.push('@vibe-agent-toolkit/cli');
        }
      }
    }

    return problematicPackages;
  } catch {
    // If we can't check, proceed anyway
    return [];
  }
}

/**
 * Display warning about global installations that might cause issues
 */
function warnAboutGlobalInstallations(packages: string[]): void {
  if (packages.length === 0) {
    return;
  }

  console.log('\n⚠️  WARNING: Global VAT installations detected\n');
  console.log('The following globally installed packages may interfere with npm link:');
  for (const pkg of packages) {
    console.log(`   - ${pkg}`);
  }
  console.log('\nIf linking fails with "Cannot read properties of null", try:');
  console.log('');
  for (const pkg of packages) {
    console.log(`   npm uninstall -g ${pkg}`);
  }
  console.log('');
  console.log('You can reinstall them after linking is complete.');
  console.log('');
  console.log('Press Ctrl+C to cancel, or waiting 3 seconds to continue...\n');

  // Give user time to cancel
  const start = Date.now();
  while (Date.now() - start < 3000) {
    // Busy wait for 3 seconds
  }
}

function linkPackage(packageName: string, packagePath: string): boolean {
  // --install-strategy=shallow prevents npm arborist from deeply resolving
  // workspace:* dependencies, which crashes with "Cannot read properties of null"
  // in monorepos (npm/arborist bug as of npm v11.5.1).
  const args = ['link', '--install-strategy=shallow'];

  try {
    console.log(`🔗 Linking: ${packageName}`);
    safeExecSync('npm', args, {
      cwd: packagePath,
      stdio: 'pipe',
    });
    return true;
  } catch (_error: unknown) {
    const msg = _error instanceof Error ? _error.message : String(_error);
    const firstLine = msg.split('\n')[0] ?? msg;
    console.error(`⚠️  First attempt failed for ${packageName}: ${firstLine}`);
    return false;
  }
}

// Check for global installations before linking
const problematicPackages = checkForGlobalInstallations();
warnAboutGlobalInstallations(problematicPackages);

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
