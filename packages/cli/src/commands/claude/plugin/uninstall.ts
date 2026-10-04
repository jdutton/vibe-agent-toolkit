// packages/cli/src/commands/claude/plugin/uninstall.ts
/**
 * `vat claude plugin uninstall` — reverse what `installPlugin()` wrote,
 * published as the `Report<T>` envelope (`uninstall-schema.ts`).
 *
 * One uninstall request per run (a key, or `--all`). Nothing to remove is an
 * answer. A plugin directory the registry never recorded is removed and
 * reported as a `PLUGIN_UNINSTALL_INCOMPLETE` finding at its key.
 */

import { readFileSync } from 'node:fs';

import { findPluginsByPackage, getClaudeUserPaths, parsePluginKey, uninstallPlugin } from '@vibe-agent-toolkit/claude-marketplace';
import { buildReport, toFindings, type ValidationIssue } from '@vibe-agent-toolkit/schema';
import { safePath } from '@vibe-agent-toolkit/utils';
import { Command } from 'commander';

import { CommandRefusalError, refusalCodeOf } from '../../../utils/command-refusal.js';
import { endWithRefusal, endWithReport, NOTHING_FINISHED, type FinishedWork } from '../../../utils/document-writer.js';
import { createLogger } from '../../../utils/logger.js';
import { unstatablePathRefusal } from '../../../utils/project-root-policy.js';

import type { PluginUninstallData, PluginUninstallReport } from './uninstall-schema.js';

interface PluginUninstallCommandOptions {
  all?: boolean;
  dryRun?: boolean;
  debug?: boolean;
}

export function createPluginUninstallCommand(): Command {
  const command = new Command('uninstall');

  command
    .description('Remove a skill package from Claude Code')
    .argument('[plugin@marketplace]', 'Plugin key to uninstall (e.g. my-skill@my-marketplace)')
    .option('-a, --all', 'Uninstall all plugins from the npm package in the current directory', false)
    .option('--dry-run', 'Preview removal without making changes', false)
    .option('--debug', 'Enable debug logging')
    .action(pluginUninstallCommand)
    .addHelpText('after', `
Description:
  Removes an installed PLUGIN from Claude Code, reversing the artifacts
  installPlugin() writes: the marketplace plugin directory, its cache dir, the
  installed_plugins and known_marketplaces registry entries, and the settings
  entry. With --all, finds all plugins installed from the npm package in the
  current directory.

  Does NOT remove skills installed flat into ~/.claude/skills/ — that is what
  "vat claude plugin install <dir|zip>", "--dev", and "vat skills install"
  produce, and those skills are not registered as plugins. Remove them by
  deleting the skill directory.

  Idempotent: a plugin that is not installed is reported removed: false, exit 0.

Output (YAML report on stdout):
  - status: ok, findings (a warning below), or error when the run could not uninstall
  - examined: uninstall requests (1)
  - data.dryRun: whether anything was actually removed
  - data.plugins[]: { key, removed } per plugin
  - findings: PLUGIN_UNINSTALL_INCOMPLETE (warning) for a plugin directory no
    registry recorded — removed, but its installer may have left more

Exit Codes:
  0 - Uninstalled, or nothing to remove (a warning does not fail the run)
  2 - The run could not uninstall: no key and no --all, a key that is not
      <plugin>@<marketplace>, or --all outside an npm package (USAGE_INVALID);
      --all over a package.json that is unreadable or not JSON, or a Claude
      registry that is (INPUT_UNREADABLE); a removal or registry rewrite that
      failed partway (RUN_INCOMPLETE — plugins already uninstalled are still listed)

Example:
  $ vat claude plugin uninstall my-skill@my-marketplace
  $ vat claude plugin uninstall --all           # uninstall all from cwd package
  $ vat claude plugin uninstall --all --dry-run # preview
`);

  return command;
}

/** `vat claude plugin uninstall` has no `--strict`: a warning never fails it. */
const GATE = { strict: false } as const;

/** One uninstall request per run — a key, or `--all`. */
const UNINSTALL_REQUESTS = 1;

/** What one plugin's uninstall did. */
interface PluginUninstallOutcome {
  readonly key: string;
  readonly removed: boolean;
  /** Set when the plugin directory existed with no registry entry. */
  readonly warning?: string | undefined;
}

/** The finding for a plugin uninstalled from a directory no registry recorded. */
function incompleteFinding(outcome: PluginUninstallOutcome): ValidationIssue[] {
  if (outcome.warning === undefined) return [];
  return [{
    code: 'PLUGIN_UNINSTALL_INCOMPLETE',
    // Fixed: the cleanup ran, and this verb reads no project config to move it.
    severity: 'warning',
    message: outcome.warning,
    location: outcome.key,
    fix: 'Check Claude Code for leftovers of the plugin the message names (run /plugin), and remove them there.',
  }];
}

/** The work done so far: the report's `data` and findings, for a finished or an interrupted run. */
function finishedWork(outcomes: readonly PluginUninstallOutcome[], dryRun: boolean): FinishedWork & { data: PluginUninstallData } {
  return {
    examined: UNINSTALL_REQUESTS,
    findings: toFindings(outcomes.flatMap(incompleteFinding)),
    data: { dryRun, plugins: outcomes.map(({ key, removed }) => ({ key, removed })) },
  };
}

/**
 * Build the report. Pure: no file system, no `process.exit`.
 *
 * @param outcomes - What each plugin's uninstall did
 * @param dryRun - Whether anything was actually removed
 * @param durationMs - How long the run took
 */
export function buildPluginUninstallReport(
  outcomes: readonly PluginUninstallOutcome[],
  dryRun: boolean,
  durationMs: number,
): PluginUninstallReport {
  return buildReport({ ...finishedWork(outcomes, dryRun), gate: GATE, durationMs });
}

async function pluginUninstallCommand(
  pluginKeyArg: string | undefined,
  options: PluginUninstallCommandOptions
): Promise<void> {
  const logger = createLogger(options.debug ? { debug: true } : {});
  const startTime = Date.now();
  const dryRun = options.dryRun === true;
  const outcomes: PluginUninstallOutcome[] = [];

  try {
    const paths = getClaudeUserPaths();
    for (const pluginKey of resolvePluginKeys(pluginKeyArg, options, logger)) {
      const result = await uninstallPlugin({ pluginKey, paths, dryRun });
      if (result.warning !== undefined) logger.info(`   ⚠️  ${result.warning}`);
      outcomes.push({ key: pluginKey, removed: result.removed, warning: result.warning });
    }
  } catch (error) {
    // Whatever uninstalled before the refusal is still reported.
    endWithRefusal('claude plugin uninstall', refusalCodeOf(error), error, 'yaml', GATE, outcomes.length === 0 ? NOTHING_FINISHED : finishedWork(outcomes, dryRun));
  }

  endWithReport('claude plugin uninstall', buildPluginUninstallReport(outcomes, dryRun, Date.now() - startTime), 'yaml');
}

/** The `name` of the npm package in `dir`, refusing when there is none to read. */
function packageNameIn(dir: string): string {
  const packageJsonPath = safePath.join(dir, 'package.json');
  let raw: string;
  try {
    raw = readFileSync(packageJsonPath, 'utf-8');
  } catch (error) {
    throw unstatablePathRefusal(packageJsonPath, error);
  }
  let name: unknown;
  try {
    name = (JSON.parse(raw) as { name?: unknown }).name;
  } catch (error) {
    throw new CommandRefusalError('INPUT_UNREADABLE', `${packageJsonPath} is not valid JSON: ${String(error)}`, { cause: error });
  }
  if (typeof name !== 'string' || name === '') {
    throw new CommandRefusalError('INPUT_UNREADABLE', `${packageJsonPath} declares no package name, so --all cannot find its plugins.`);
  }
  return name;
}

function resolvePluginKeys(
  pluginKeyArg: string | undefined,
  options: PluginUninstallCommandOptions,
  logger: ReturnType<typeof createLogger>
): string[] {
  if (options.all) {
    const packageName = packageNameIn(process.cwd());
    logger.info(`📦 Finding all plugins from ${packageName}...`);
    return findPluginsByPackage(packageName, getClaudeUserPaths());
  }

  if (!pluginKeyArg) {
    throw new CommandRefusalError(
      'USAGE_INVALID',
      'Plugin key required. Usage:\n' +
      '  vat claude plugin uninstall <plugin@marketplace>\n' +
      '  vat claude plugin uninstall --all'
    );
  }
  // The library's one rule for a key; its PLUGIN_KEY_INVALID refuses as USAGE_INVALID.
  parsePluginKey(pluginKeyArg);
  return [pluginKeyArg];
}
