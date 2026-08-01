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
  summarizeSettingsFindings,
  validateSettingsFile,
  type EffectiveSettings,
  type ProvenanceValue,
  type RuleConflict,
  type SettingsFinding,
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

/** A formatted provenance value; `overrode` recurses down the whole chain. */
export interface FormattedProvenanceValue {
  value: unknown;
  source: string;
  level: string;
  locked?: boolean;
  overrode?: FormattedProvenanceValue;
}

/**
 * Format an EffectiveSettings value for YAML output, INCLUDING what it overrode.
 *
 * The chain is the point: "what is in effect, and what did it replace?" is the
 * question a settings-override audit exists to answer. Emitting only the winning
 * layer made a project override look like the only value ever declared — the
 * merger builds the linked list and this formatter used to throw it away.
 */
export function formatProvenanceValue(
  pv: ProvenanceValue<unknown>
): FormattedProvenanceValue {
  return {
    value: pv.value,
    source: pv.provenance.file,
    level: pv.provenance.level,
    ...(pv.provenance.level === 'managed' ? { locked: true } : {}),
    ...(pv.overrode ? { overrode: formatProvenanceValue(pv.overrode) } : {}),
  };
}

/**
 * Format a resolved settings path for YAML output.
 *
 * `exists`/`readable` are passed through verbatim, including the
 * `'undetermined'` value — a probe that could not run must not be rendered as a
 * confident `false`.
 */
export function formatSettingsPathEntry(p: SettingsPathEntry): Record<string, unknown> {
  return {
    label: p.label,
    path: p.path,
    exists: p.exists,
    readable: p.readable,
    level: p.level,
    ...(p.accessError === undefined ? {} : { accessError: p.accessError }),
    ...(p.status === 'error' && p.exists !== false
      ? { status: 'error', message: p.message }
      : {}),
  };
}

async function runShowPaths(startTime: number, logger: Logger): Promise<void> {
  const cwd = process.cwd();
  const result = await resolveSettingsPaths(cwd);

  const findings: SettingsFinding[] = [];
  for (const p of result.paths) {
    if (p.status === 'error' && p.exists !== false) {
      findings.push({
        path: p.path,
        message: p.message ?? 'Deprecated settings path is present',
        severity: 'error',
      });
    }
    if (p.exists === 'undetermined' || p.readable === 'undetermined') {
      findings.push({
        path: p.path,
        message: `Could not determine access (${p.accessError ?? 'unknown error'}) — this path was not checked`,
        severity: 'warning',
      });
    }
  }

  const { status, issueCounts } = summarizeSettingsFindings(findings);

  writeYamlOutput({
    status,
    issueCounts,
    paths: result.paths.map(formatSettingsPathEntry),
    duration: `${Date.now() - startTime}ms`,
  });

  if (issueCounts.errors > 0) {
    logger.error('Legacy managed-settings.json path detected — IT admin must migrate.');
    process.exit(1);
  }
  if (issueCounts.warnings > 0) {
    logger.warn(`${issueCounts.warnings} settings path(s) could not be checked.`);
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
  // `null` means the fields could not be read — distinct from "no fields", and
  // emitted as `fields: null` rather than as an empty list.
  const fields = await getSettingsFileFields(filePath);
  const duration = `${Date.now() - startTime}ms`;

  writeYamlOutput({
    status: result.status,
    issueCounts: result.issueCounts,
    file: filePath,
    detectedType: result.detectedType,
    typeConfidence: result.typeConfidence,
    fields,
    ...(result.findings.length > 0 ? { findings: result.findings } : {}),
    duration,
  });

  if (result.issueCounts.errors > 0) {
    logger.error(`Settings file is invalid: ${result.issueCounts.errors} error(s)`);
    process.exit(1);
  }

  logger.info(
    `Settings file is valid (${result.detectedType}, type ${result.typeConfidence})`,
  );
  process.exit(0);
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

function buildMarketplacesSummary(
  effective: EffectiveSettings
): { summary: Record<string, unknown>; warnings: string[] } {
  const summary: Record<string, unknown> = {};
  const marketplaceWarnings: string[] = [];

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
    for (const [name, entry] of Object.entries(pv.value)) {
      if (entry.source.source === 'github' && !process.env['GITHUB_TOKEN']) {
        marketplaceWarnings.push(`Marketplace '${name}' sources from a private GitHub repo but GITHUB_TOKEN is not set`);
      }
    }
    if (marketplaceWarnings.length > 0) {
      summary['warnings'] = marketplaceWarnings;
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

  return { summary, warnings: marketplaceWarnings };
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

/**
 * The findings an effective-settings audit produced.
 *
 * A shadowed rule and a marketplace that cannot authenticate are things the
 * reader must act on, so they are warnings — the run used to publish
 * `status: 'success'` with the conflicts listed underneath it, which is the
 * "warnings read as passed" collapse this command is being fixed for.
 */
export function settingsAuditFindings(
  conflicts: readonly RuleConflict[],
  marketplaceWarnings: readonly string[],
): SettingsFinding[] {
  const findings: SettingsFinding[] = conflicts.map(c => ({
    path: c.rule.provenance.file,
    message:
      `Rule "${c.rule.rule}" (${c.rule.provenance.level}, ${getRuleList(c.kind)}) is shadowed by ` +
      `"${c.shadowedBy.rule}" (${c.shadowedBy.provenance.level}, ${getShadowedByList(c.kind)}) — ${c.kind}.`,
    severity: 'warning',
  }));

  for (const warning of marketplaceWarnings) {
    findings.push({ path: '', message: warning, severity: 'warning' });
  }

  return findings;
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

  const marketplaces = buildMarketplacesSummary(effective);
  if (Object.keys(marketplaces.summary).length > 0) {
    effectiveSummary['marketplaces'] = marketplaces.summary;
  }

  const conflicts = analyzeRuleConflicts(effective);
  const { status, issueCounts } = summarizeSettingsFindings(
    settingsAuditFindings(conflicts, marketplaces.warnings),
  );

  const output: Record<string, unknown> = {
    status,
    issueCounts,
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
  if (issueCounts.warnings > 0) {
    logger.warn(
      `${issueCounts.warnings} warning(s): see conflicts / marketplaces.warnings in the output.`,
    );
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
  - status: worst actionable severity (success | warning | error)
  - issueCounts: errors / warnings / info counts, published beside the status
  - layers: all loaded settings files in precedence order (highest first)
  - effectiveSettings: merged values with source file and level for each field;
      each value carries an "overrode" chain naming every value it replaced,
      down to the lowest-precedence layer
  - permissions: accumulated allow/deny/ask rules from all layers
  - conflicts: rules that are unreachable or redundant (omitted if none)

  With --file, "typeConfidence" states how the settings type was determined:
  declared (you passed --type), inferred (a managed-only field settled it),
  ambiguous (user and project share one schema, so it could be either), or
  undetermined (the file could not be read). "fields: null" means the fields
  could not be read at all, as distinct from "fields: []" (none declared).

  With --show-paths, "exists"/"readable" may be the string "undetermined" when
  the probe itself failed (e.g. a permission error on a parent directory) —
  that is not the same answer as false.

Exit Codes:
  0 - No errors (warnings are reported in issueCounts, not in the exit code)
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
