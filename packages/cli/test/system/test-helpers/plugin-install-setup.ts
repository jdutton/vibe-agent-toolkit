/**
 * What the `vat claude plugin install` system suites share: a fake home, a built-package fixture
 * as `vat build` leaves one, and the install run itself with its report parsed.
 */

import * as fs from 'node:fs';
import { chmodSync } from 'node:fs';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { expect } from 'vitest';

import { PLUGIN_INSTALL_REPORT_SCHEMA } from '../../../src/commands/claude/plugin/install-schema.js';
import { executeCliAndParseYaml, fakeHomeEnv, writeTestFile } from '../test-common.js';

/** Write `content` at `filePath`, creating its directory. */
export function plantFile(filePath: string, content: string): void {
  mkdirSyncReal(safePath.join(filePath, '..'), { recursive: true });
  writeTestFile(filePath, content);
}

// String constants to avoid sonarjs/no-duplicate-string violations
// Used as suffix after claudeDir (which already includes '.claude')
export const PLUGINS_MARKETPLACES = safePath.join('plugins', 'marketplaces');

/**
 * Create an isolated temp/home/claudeDir context for a single test.
 * Extracted to eliminate the repeated 4-line setup block across tests.
 */
export function createInstallTestContext(createTempDir: () => string): {
  tempDir: string;
  fakeHome: string;
  claudeDir: string;
} {
  const tempDir = createTempDir();
  const fakeHome = safePath.join(tempDir, 'home');
  const claudeDir = safePath.join(fakeHome, '.claude');
  mkdirSyncReal(fakeHome, { recursive: true });
  return { tempDir, fakeHome, claudeDir };
}

/**
 * Create a plugin tree directory structure that mirrors the output of `vat build`.
 * Places files at: <projectDir>/dist/.claude/plugins/marketplaces/<marketplace>/plugins/<plugin>/
 *
 * When `skills` is provided on a plugin entry, they are placed in the proper
 * `plugins/<plugin>/skills/<skillName>/` subdirectory (real `vat build` layout).
 * When omitted, a flat `SKILL.md` is written at the plugin root (legacy test layout).
 */
export function setupPluginTestProject(
  baseDir: string,
  name: string,
  marketplaceName: string,
  plugins: Array<{ name: string; skills?: string[] }>
): { projectDir: string; marketplacesDir: string } {
  const projectDir = safePath.join(baseDir, name);
  mkdirSyncReal(projectDir, { recursive: true });

  writeTestFile(
    safePath.join(projectDir, 'package.json'),
    JSON.stringify({ name: '@test/my-plugin-pkg', version: '1.2.3' })
  );

  const marketplacesDir = safePath.join(projectDir, 'dist', '.claude', 'plugins', 'marketplaces');
  for (const plugin of plugins) {
    const pluginDir = safePath.join(marketplacesDir, marketplaceName, 'plugins', plugin.name);
    mkdirSyncReal(pluginDir, { recursive: true });
    writeTestFile(safePath.join(pluginDir, 'plugin.json'), JSON.stringify({ name: plugin.name, version: '1.2.3' }));

    if (plugin.skills) {
      for (const skillName of plugin.skills) {
        const skillDir = safePath.join(pluginDir, 'skills', skillName);
        mkdirSyncReal(skillDir, { recursive: true });
        writeTestFile(safePath.join(skillDir, 'SKILL.md'), `# ${skillName}\nTest skill content`);
      }
    } else {
      writeTestFile(safePath.join(pluginDir, 'SKILL.md'), `# ${plugin.name}\nTest plugin content`);
    }
  }

  return { projectDir, marketplacesDir };
}

type InstallReport = ReturnType<typeof PLUGIN_INSTALL_REPORT_SCHEMA.parse>;

/** Run `vat claude plugin install <args>` under `fakeHome` and parse the report it publishes. */
export async function runInstall(
  binPath: string,
  fakeHome: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<{ status: number | null; output: string; report: InstallReport }> {
  const { result, parsed } = await executeCliAndParseYaml(binPath, ['claude', 'plugin', 'install', ...args], {
    env: { ...fakeHomeEnv(fakeHome), ...env },
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}`, report: PLUGIN_INSTALL_REPORT_SCHEMA.parse(parsed) };
}

/**
 * Run `vat claude plugin install <projectDir>` and assert it exits 0 with status: ok.
 * Returns the parsed report for further assertions.
 */
export async function runPluginInstall(binPath: string, projectDir: string, fakeHome: string): Promise<InstallReport> {
  const { status, report } = await runInstall(binPath, fakeHome, [projectDir]);
  expect(status).toBe(0);
  expect(report.status).toBe('ok');
  return report;
}

/**
 * Lock a directory (holding a file) inside `<parentDir>/<entry>/<lockedRel>` of a previous
 * install, re-install `projectDir`, and restore the lock on every copy of it under `parentDir`
 * — the re-install parks the previous tree beside `entry`, so the locked copy may have moved.
 */
export async function reinstallOverLockedEntry(
  binPath: string,
  fakeHome: string,
  projectDir: string,
  where: { parentDir: string; entry: string; lockedRel: string[] },
): Promise<{ status: number | null; report: InstallReport }> {
  const locked = safePath.join(where.parentDir, where.entry, ...where.lockedRel);
  plantFile(safePath.join(locked, 'held.txt'), 'x');
  chmodSync(locked, 0o555);
  try {
    return await runInstall(binPath, fakeHome, [projectDir]);
  } finally {
    for (const entry of fs.readdirSync(where.parentDir)) {
      const leftover = safePath.join(where.parentDir, entry, ...where.lockedRel);
      if (fs.existsSync(leftover)) chmodSync(leftover, 0o755);
    }
  }
}

/** Run the install and assert it was refused as the input's (exit 2), its message naming each of `mentions`. */
export async function expectInputRefusal(binPath: string, fakeHome: string, args: string[], mentions: string[]): Promise<void> {
  const { status, report } = await runInstall(binPath, fakeHome, args);
  expect(status).toBe(2);
  expect(report).toMatchObject({ status: 'error', error: { code: 'INPUT_UNREADABLE' } });
  for (const mention of mentions) expect(report.error?.message).toContain(mention);
}

/** The plugin keys Claude's registry under `claudeDir` holds. */
export function installedKeys(claudeDir: string): string[] {
  const registry = JSON.parse(fs.readFileSync(safePath.join(claudeDir, 'plugins', 'installed_plugins.json'), 'utf-8')) as { plugins: Record<string, unknown> };
  return Object.keys(registry.plugins).sort((a, b) => a.localeCompare(b));
}

/**
 * An installed `old-plugin@r-market` (unless `installOld` is false), a legacy
 * flat skill `legacy` under the skills dir, and a package `new-pkg` (one plugin,
 * `new-plugin`) whose `vat.replaces` is `replaces` — every replaces case's start.
 */
export async function setupReplacesCase(
  binPath: string,
  createTempDir: () => string,
  replaces: unknown,
  installOld = true,
): Promise<{ tempDir: string; fakeHome: string; claudeDir: string; projectDir: string; marketplacesDir: string; legacySkill: string }> {
  const { tempDir, fakeHome, claudeDir } = createInstallTestContext(createTempDir);
  if (installOld) {
    const old = setupPluginTestProject(tempDir, 'old-pkg', 'r-market', [{ name: 'old-plugin', skills: ['old-skill'] }]);
    await runPluginInstall(binPath, old.projectDir, fakeHome);
  }
  const legacySkill = safePath.join(claudeDir, 'skills', 'legacy', 'SKILL.md');
  plantFile(legacySkill, '# legacy\n');
  // A later version of the SAME package: `vat.replaces` names what this package used to publish, and
  // only the package that installed a marketplace may replace it (another package's install is refused).
  const replacing = setupPluginTestProject(tempDir, 'new-pkg', 'r-market', [{ name: 'new-plugin', skills: ['new-skill'] }]);
  writeTestFile(safePath.join(replacing.projectDir, 'package.json'), JSON.stringify({ name: '@test/my-plugin-pkg', version: '1.2.4', vat: { replaces } }));
  return { tempDir, fakeHome, claudeDir, legacySkill, ...replacing };
}
