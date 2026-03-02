/**
 * `vat audit settings` subcommand
 *
 * Shows effective merged Claude settings with provenance, or validates a specific file.
 */

import {
  analyzeRuleConflicts,
  auditSettings,
  getSettingsFileFields,
  resolveSettingsPaths,
  validateSettingsFile,
  type EffectiveSettings,
  type RuleConflict,
  type SettingsPathEntry,
} from '@vibe-agent-toolkit/claude-marketplace';
import { Command } from 'commander';

import { handleCommandError } from '../utils/command-error.js';
import { createLogger } from '../utils/logger.js';
import { writeYamlOutput } from '../utils/output.js';

export interface AuditSettingsOptions {
  showPaths?: boolean;
  file?: string;
  type?: 'managed' | 'user' | 'project';
  debug?: boolean;
}

type Logger = ReturnType<typeof createLogger>;

/**
 * Format an EffectiveSettings value for YAML output.
 * Returns a simplified object with `value`, `source`, and `level`.
 */
function formatProvenanceValue(
  pv: { value: unknown; provenance: { file: string; level: string }; overrode?: unknown }
): { value: unknown; source: string; level: string; locked?: boolean } {
  return {
    value: pv.value,
    source: pv.provenance.file,
    level: pv.provenance.level,
    ...(pv.provenance.level === 'managed' ? { locked: true } : {}),
  };
}

async function runShowPaths(startTime: number, logger: Logger): Promise<void> {
  const cwd = process.cwd();
  const result = await resolveSettingsPaths(cwd);
  const hasLegacyError = result.paths.some((p: SettingsPathEntry) => p.status === 'error' && p.exists);

  writeYamlOutput({
    status: hasLegacyError ? 'error' : 'success',
    paths: result.paths.map((p: SettingsPathEntry) => ({
      label: p.label,
      path: p.path,
      exists: p.exists,
      readable: p.readable,
      level: p.level,
      ...(p.status === 'error' && p.exists
        ? { status: 'error', message: p.message }
        : {}),
    })),
    duration: `${Date.now() - startTime}ms`,
  });

  if (hasLegacyError) {
    logger.error('Legacy managed-settings.json path detected — IT admin must migrate.');
    process.exit(1);
  }
  process.exit(0);
}

async function runValidateFile(
  options: AuditSettingsOptions,
  startTime: number,
  logger: Logger
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded by caller
  const filePath = options.file!;
  const result = await validateSettingsFile(filePath, options.type);
  const fields = result.valid ? await getSettingsFileFields(filePath) : [];
  const duration = `${Date.now() - startTime}ms`;

  if (result.valid) {
    writeYamlOutput({
      status: 'success',
      file: filePath,
      detectedType: result.detectedType,
      valid: true,
      fields,
      duration,
    });
    logger.info(`Settings file is valid (${result.detectedType})`);
    process.exit(0);
  } else {
    writeYamlOutput({
      status: 'error',
      file: filePath,
      detectedType: result.detectedType,
      valid: false,
      errors: result.errors,
      duration,
    });
    logger.error(`Settings file is invalid: ${result.errors.length} error(s)`);
    process.exit(1);
  }
}

function buildPermissionsSummary(
  permissions: EffectiveSettings['permissions']
): Record<string, unknown> {
  const summary: Record<string, unknown> = {};

  if (permissions.deny.length > 0) {
    summary['deny'] = permissions.deny.map(r => ({
      rule: r.rule,
      source: r.provenance.file,
      level: r.provenance.level,
    }));
  }
  if (permissions.allow.length > 0) {
    summary['allow'] = permissions.allow.map(r => ({
      rule: r.rule,
      source: r.provenance.file,
      level: r.provenance.level,
    }));
  }
  if (permissions.ask.length > 0) {
    summary['ask'] = permissions.ask.map(r => ({
      rule: r.rule,
      source: r.provenance.file,
      level: r.provenance.level,
    }));
  }
  if (permissions.defaultMode) {
    summary['defaultMode'] = formatProvenanceValue(permissions.defaultMode);
  }

  return summary;
}

function buildMarketplacesSummary(effective: EffectiveSettings): Record<string, unknown> {
  const summary: Record<string, unknown> = {};

  if (effective.extraKnownMarketplaces) {
    const pv = effective.extraKnownMarketplaces;
    const registered = Object.entries(
      pv.value
    ).map(([name, entry]) => ({
      name,
      source: entry.source,
      layer: pv.provenance.level,
      ...(entry.autoUpdate === undefined ? {} : { autoUpdate: entry.autoUpdate }),
    }));
    if (registered.length > 0) {
      summary['registered'] = registered;
    }

    // Check for GitHub repos without GITHUB_TOKEN
    const warnings: string[] = [];
    for (const [name, entry] of Object.entries(pv.value)) {
      if (entry.source.source === 'github' && !process.env['GITHUB_TOKEN']) {
        warnings.push(`Marketplace '${name}' sources from a private GitHub repo but GITHUB_TOKEN is not set`);
      }
    }
    if (warnings.length > 0) {
      summary['warnings'] = warnings;
    }
  }

  if (effective.enabledPlugins) {
    const pv = effective.enabledPlugins;
    const enabled = Object.entries(pv.value)
      .filter(([, v]) => v)
      .map(([name]) => ({ plugin: name, layer: pv.provenance.level }));
    if (enabled.length > 0) {
      summary['enabledPlugins'] = enabled;
    }
  }

  if (effective.strictKnownMarketplaces) {
    const pv = effective.strictKnownMarketplaces;
    summary['governance'] = {
      strictKnownMarketplaces: pv.value,
      layer: pv.provenance.level,
    };
  }

  return summary;
}

function formatConflicts(conflicts: RuleConflict[]): Record<string, unknown>[] {
  return conflicts.map(c => ({
    kind: c.kind,
    rule: c.rule.rule,
    ruleSource: c.rule.provenance.file,
    ruleLevel: c.rule.provenance.level,
    ruleList: getRuleList(c.kind),
    shadowedBy: c.shadowedBy.rule,
    shadowedBySource: c.shadowedBy.provenance.file,
    shadowedByLevel: c.shadowedBy.provenance.level,
    shadowedByList: getShadowedByList(c.kind),
  }));
}

function getRuleList(kind: RuleConflict['kind']): string {
  if (kind === 'shadowed-by-deny') return 'ask/allow';
  if (kind === 'shadowed-by-ask') return 'allow';
  return 'same-bucket';
}

function getShadowedByList(kind: RuleConflict['kind']): string {
  if (kind === 'shadowed-by-deny') return 'deny';
  if (kind === 'shadowed-by-ask') return 'ask';
  return 'same-bucket';
}

async function runShowEffective(startTime: number, logger: Logger): Promise<void> {
  const cwd = process.cwd();
  const { effective, layers } = await auditSettings({ projectDir: cwd });
  const duration = `${Date.now() - startTime}ms`;

  const layersSummary = layers.map(l => ({ level: l.level, file: l.file, readable: true }));

  const effectiveSummary: Record<string, unknown> = {};
  if (effective.model) effectiveSummary['model'] = formatProvenanceValue(effective.model);
  if (effective.availableModels) effectiveSummary['availableModels'] = formatProvenanceValue(effective.availableModels);
  if (effective.forceLoginMethod) effectiveSummary['forceLoginMethod'] = formatProvenanceValue(effective.forceLoginMethod);
  if (effective.apiKeyHelper) effectiveSummary['apiKeyHelper'] = formatProvenanceValue(effective.apiKeyHelper);
  if (effective.autoUpdatesChannel) effectiveSummary['autoUpdatesChannel'] = formatProvenanceValue(effective.autoUpdatesChannel);
  if (effective.disableAllHooks) effectiveSummary['disableAllHooks'] = formatProvenanceValue(effective.disableAllHooks);
  if (effective.allowManagedHooksOnly) effectiveSummary['allowManagedHooksOnly'] = formatProvenanceValue(effective.allowManagedHooksOnly);
  if (effective.outputStyle) effectiveSummary['outputStyle'] = formatProvenanceValue(effective.outputStyle);
  if (effective.language) effectiveSummary['language'] = formatProvenanceValue(effective.language);

  const permissionsSummary = buildPermissionsSummary(effective.permissions);
  if (Object.keys(permissionsSummary).length > 0) {
    effectiveSummary['permissions'] = permissionsSummary;
  }

  const marketplacesSummary = buildMarketplacesSummary(effective);
  if (Object.keys(marketplacesSummary).length > 0) {
    effectiveSummary['marketplaces'] = marketplacesSummary;
  }

  const conflicts = analyzeRuleConflicts(effective);
  const output: Record<string, unknown> = {
    status: 'success',
    layers: layersSummary,
    effectiveSettings: effectiveSummary,
    duration,
  };
  if (conflicts.length > 0) {
    output['conflicts'] = formatConflicts(conflicts);
  }

  writeYamlOutput(output);

  if (layers.length === 0) {
    logger.info('No settings files found');
  } else {
    logger.info(`Loaded ${layers.length} settings layer(s)`);
  }

  process.exit(0);
}

export async function runAuditSettings(
  options: AuditSettingsOptions
): Promise<void> {
  const logger = createLogger(options.debug ? { debug: true } : {});
  const startTime = Date.now();

  try {
    if (options.showPaths) return await runShowPaths(startTime, logger);
    if (options.file) return await runValidateFile(options, startTime, logger);
    await runShowEffective(startTime, logger);
  } catch (error) {
    handleCommandError(error, logger, startTime, 'AuditSettings');
  }
}

/**
 * Create the `vat audit settings` subcommand.
 */
export function createAuditSettingsCommand(): Command {
  const cmd = new Command('settings');

  cmd
    .description('Show what Claude is allowed to do in the current directory')
    .option('--show-paths', 'Show all settings file paths with existence and readability status')
    .option('--file <path>', 'Validate a specific settings file')
    .option(
      '--type <type>',
      'Override detected settings type when using --file (managed | user | project)'
    )
    .option('--debug', 'Enable debug logging')
    .action((opts: AuditSettingsOptions) => runAuditSettings(opts))
    .addHelpText(
      'after',
      `
Description:
  Shows what Claude is allowed to do from the current directory. Run it from any
  project to see the exact merged permissions in effect — managed (IT), user
  (~/.claude/settings.json), and project (.claude/settings.json) layers combined.

  Project-level settings are resolved from the current working directory, so the
  output changes depending on where you run the command. This makes it easy to
  answer "why did Claude ask for permission here?" or "is this tool allowed in
  this repo?".

  Also reports any rule conflicts: ask/allow rules shadowed by deny rules, and
  redundant rules within the same bucket.

Output:
  - layers: all loaded settings files in precedence order (highest first)
  - effectiveSettings: merged values with source file and level for each field
  - permissions: accumulated allow/deny/ask rules from all layers
  - conflicts: rules that are unreachable or redundant (omitted if none)

Exit Codes:
  0 - Success
  1 - Invalid settings file (--file mode) or legacy Windows path detected
  2 - System error

Example:
  $ cd ~/my-project && vat audit settings       # What can Claude do here?
  $ vat audit settings --show-paths             # Show all settings file paths
  $ vat audit settings --file managed.json      # Validate a settings file
`
    );

  return cmd;
}
