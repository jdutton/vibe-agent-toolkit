/**
 * `vat audit settings` subcommand
 *
 * Shows effective merged Claude settings with provenance, or validates a specific file.
 * Every mode publishes the report envelope through the one writer: `data.mode`
 * says which mode ran, `findings` carry what is wrong (each with a registered
 * `SETTINGS_*` code and the settings file as `location`), and `examined`
 * counts the settings documents read.
 */

import {
  analyzeRuleConflicts,
  auditSettings,
  getSettingsFileFields,
  resolveSettingsPaths,
  validateSettingsFile,
  type EffectiveSettings,
  type ProvenanceValue,
  type RuleConflict,
  type SettingsPathEntry,
} from '@vibe-agent-toolkit/claude-marketplace';
import {
  buildReport,
  countBySeverity,
  createRegistryIssue,
  toFindings,
  type Finding,
  type Gate,
  type IssueCode,
  type ValidationIssue,
} from '@vibe-agent-toolkit/schema';
import { isAbsoluteAnyPlatform, isFilesystemAccessError, isPathAbsentError, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { Command } from 'commander';

import { CommandRefusalError, errorMessageOf, refusalCodeOf } from '../utils/command-refusal.js';
import { endWithRefusal, endWithReport, NOTHING_FINISHED } from '../utils/document-writer.js';
import { createLogger } from '../utils/logger.js';
import { relativizePath } from '../utils/relativize-paths.js';

import type { AuditSettingsData, AuditSettingsReport } from './audit-settings-schema.js';

export interface AuditSettingsOptions {
  showPaths?: boolean;
  file?: string;
  type?: string;
  debug?: boolean;
}

type Logger = ReturnType<typeof createLogger>;

/** `vat audit settings` has no `--strict`: warnings never move its exit code. */
const SETTINGS_GATE: Gate = { strict: false };

/** The types `--type` accepts. */
const SETTINGS_TYPES = ['managed', 'user', 'project'] as const;

type SettingsType = (typeof SETTINGS_TYPES)[number];

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
  pv: ProvenanceValue<unknown>,
  root: string,
): FormattedProvenanceValue {
  return {
    value: pv.value,
    source: spell(pv.provenance.file, root),
    level: pv.provenance.level,
    ...(pv.provenance.level === 'managed' ? { locked: true } : {}),
    ...(pv.overrode ? { overrode: formatProvenanceValue(pv.overrode, root) } : {}),
  };
}

/** One `data.paths[]` entry of `--show-paths`. */
type FormattedPathEntry = Extract<AuditSettingsData, { mode: 'paths' }>['paths'][number];

/**
 * Format a resolved settings path for the report's `data`.
 *
 * `exists`/`readable` are passed through verbatim, including the
 * `'undetermined'` value — a probe that could not run must not be rendered as a
 * confident `false`. A legacy path's error is the report's
 * `SETTINGS_PATH_DEPRECATED` finding, never a `status` inside `data`: that
 * would be a second status beside the envelope's.
 */
export function formatSettingsPathEntry(p: SettingsPathEntry, root: string): FormattedPathEntry {
  return {
    label: p.label,
    path: spell(p.path, root),
    exists: p.exists,
    readable: p.readable,
    level: p.level,
    ...(p.accessError === undefined ? {} : { accessError: p.accessError }),
  };
}

/**
 * A settings path in this document's ONE coordinate system: forward-slashed and
 * relative to `data.root`, the directory the command ran in — a user or managed
 * file outside it reads `../…`, never the absolute path with `$HOME` in it. The
 * one exception is a file on another Windows drive, which has no relative
 * spelling: it is published as the absolute path rather than dropped.
 */
function spell(file: string, root: string): string {
  return relativizePath(safePath.resolve(root, file), root);
}

/**
 * A registered settings finding at its default severity, located at `file`
 * relative to `root`. A finding's `location` must be relative, so a file with
 * no relative spelling (another Windows drive) leads the message instead — it
 * is said, never silently dropped.
 */
function settingsFinding(code: IssueCode, message: string, file: string, root: string, field?: string): ValidationIssue {
  const extras = field === undefined || field === '' ? {} : { field };
  if (file === '') return createRegistryIssue(code, message, extras);
  const spelled = spell(file, root);
  return isAbsoluteAnyPlatform(spelled)
    ? createRegistryIssue(code, `${spelled}: ${message}`, extras)
    : createRegistryIssue(code, message, { ...extras, location: spelled });
}

async function runShowPaths(root: string, logger: Logger): Promise<AuditSettingsReport> {
  const result = await resolveSettingsPaths(root);

  const issues: ValidationIssue[] = [];
  for (const p of result.paths) {
    if (p.status === 'error' && p.exists !== false) {
      issues.push(settingsFinding('SETTINGS_PATH_DEPRECATED', p.message ?? 'Deprecated settings path is present', p.path, root));
    }
    if (p.exists === 'undetermined' || p.readable === 'undetermined') {
      issues.push(settingsFinding(
        'SCAN_PATH_UNREADABLE',
        `Could not determine access to ${p.path} (${p.accessError ?? 'unknown error'}) — this path was not checked`,
        p.path,
        root,
      ));
    }
  }

  const { errors, warnings } = countBySeverity(issues);
  if (errors > 0) logger.error('Legacy managed-settings.json path detected — IT admin must migrate.');
  if (warnings > 0) logger.warn(`${warnings} settings path(s) could not be checked.`);

  return buildReport<AuditSettingsData>({
    // A path whose existence was determined was examined — absent is an answer; undetermined is not.
    examined: result.paths.filter((p) => p.exists !== 'undetermined').length,
    findings: toFindings(issues),
    data: { mode: 'paths', root, paths: result.paths.map((p) => formatSettingsPathEntry(p, root)) },
    gate: SETTINGS_GATE,
  });
}

/** The `--type` the operator passed, or a `USAGE_INVALID` refusal for one the command does not know. */
function declaredType(type: string | undefined): SettingsType | undefined {
  if (type === undefined) return undefined;
  if ((SETTINGS_TYPES as readonly string[]).includes(type)) return type as SettingsType;
  throw new CommandRefusalError('USAGE_INVALID', `--type must be one of ${SETTINGS_TYPES.join(', ')} (got '${type}')`);
}

/**
 * A read of the `--file` settings file, or the refusal that says why nothing
 * was read: `USAGE_INVALID` for a path that names nothing (the same ending
 * `vat audit <missing>` gives), `INPUT_UNREADABLE` for one the OS refuses.
 * Neither is a finding about the file — a finding needs a file that was read.
 */
async function readSettingsFile<T>(filePath: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (isPathAbsentError(error)) {
      throw new CommandRefusalError('USAGE_INVALID', `Settings file does not exist: ${filePath}`, { cause: error });
    }
    if (!isFilesystemAccessError(error)) throw error;
    throw new CommandRefusalError('INPUT_UNREADABLE', `Cannot read ${filePath}: ${errorMessageOf(error)}`, { cause: error });
  }
}

async function runValidateFile(filePath: string, type: string | undefined, root: string, logger: Logger): Promise<AuditSettingsReport> {
  const settingsType = declaredType(type);
  const result = await readSettingsFile(filePath, () => validateSettingsFile(filePath, settingsType));
  // `null` means the file is not a JSON object — distinct from "no fields", and
  // published as `fields: null` rather than as an empty list.
  const fields = await readSettingsFile(filePath, () => getSettingsFileFields(filePath));

  const issues: ValidationIssue[] = result.findings.map((finding) =>
    settingsFinding(finding.code, finding.message, filePath, root, finding.field));

  if (result.summary.errors > 0) {
    logger.error(`Settings file is invalid: ${result.summary.errors} error(s)`);
  } else {
    logger.info(`Settings file is valid (${result.detectedType}, type ${result.typeConfidence})`);
  }

  return buildReport<AuditSettingsData>({
    // The one document named — whether it parses is a finding about it.
    examined: 1,
    findings: toFindings(issues),
    data: { mode: 'file', root, file: spell(filePath, root), detectedType: result.detectedType, typeConfidence: result.typeConfidence, fields },
    gate: SETTINGS_GATE,
  });
}

function buildPermissionsSummary(
  permissions: EffectiveSettings['permissions'],
  root: string,
): Record<string, unknown> {
  const summary: Record<string, unknown> = {};

  if (permissions.deny.length > 0) {
    summary['deny'] = permissions.deny.map(r => ({
      rule: r.rule,
      source: spell(r.provenance.file, root),
      level: r.provenance.level,
    }));
  }
  if (permissions.allow.length > 0) {
    summary['allow'] = permissions.allow.map(r => ({
      rule: r.rule,
      source: spell(r.provenance.file, root),
      level: r.provenance.level,
    }));
  }
  if (permissions.ask.length > 0) {
    summary['ask'] = permissions.ask.map(r => ({
      rule: r.rule,
      source: spell(r.provenance.file, root),
      level: r.provenance.level,
    }));
  }
  if (permissions.defaultMode) {
    summary['defaultMode'] = formatProvenanceValue(permissions.defaultMode, root);
  }

  return summary;
}

/** A marketplace that cannot authenticate, and the settings file that registered it. */
interface MarketplaceWarning {
  message: string;
  file: string;
}

function buildMarketplacesSummary(
  effective: EffectiveSettings
): { summary: Record<string, unknown>; warnings: MarketplaceWarning[] } {
  const summary: Record<string, unknown> = {};
  const marketplaceWarnings: MarketplaceWarning[] = [];

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
        marketplaceWarnings.push({
          message: `Marketplace '${name}' sources from a private GitHub repo but GITHUB_TOKEN is not set`,
          file: pv.provenance.file,
        });
      }
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

function formatConflicts(conflicts: RuleConflict[], root: string): Extract<AuditSettingsData, { mode: 'effective' }>['conflicts'] {
  return conflicts.map(c => ({
    kind: c.kind,
    rule: c.rule.rule,
    ruleSource: spell(c.rule.provenance.file, root),
    ruleLevel: c.rule.provenance.level,
    ruleList: getRuleList(c.kind),
    shadowedBy: c.shadowedBy.rule,
    shadowedBySource: spell(c.shadowedBy.provenance.file, root),
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
 * a clean status with the conflicts listed underneath it, which is the
 * "warnings read as passed" collapse this command is being fixed for. Each
 * names the settings file to open, relative to `root`.
 */
export function settingsAuditFindings(
  conflicts: readonly RuleConflict[],
  marketplaceWarnings: readonly MarketplaceWarning[],
  root: string,
): Finding[] {
  const issues: ValidationIssue[] = conflicts.map(c => settingsFinding(
    'SETTINGS_RULE_SHADOWED',
    `Rule "${c.rule.rule}" (${c.rule.provenance.level}, ${getRuleList(c.kind)}) is shadowed by ` +
    `"${c.shadowedBy.rule}" (${c.shadowedBy.provenance.level}, ${getShadowedByList(c.kind)}) — ${c.kind}.`,
    c.rule.provenance.file,
    root,
  ));

  for (const warning of marketplaceWarnings) {
    issues.push(settingsFinding('SETTINGS_MARKETPLACE_TOKEN_MISSING', warning.message, warning.file, root));
  }

  return toFindings(issues);
}

/** The merged value of every scalar setting the report shows, with its override chain. */
function effectiveScalars(effective: EffectiveSettings, root: string): Record<string, unknown> {
  const scalars = [
    ['model', effective.model],
    ['availableModels', effective.availableModels],
    ['forceLoginMethod', effective.forceLoginMethod],
    ['apiKeyHelper', effective.apiKeyHelper],
    ['autoUpdatesChannel', effective.autoUpdatesChannel],
    ['disableAllHooks', effective.disableAllHooks],
    ['allowManagedHooksOnly', effective.allowManagedHooksOnly],
    ['outputStyle', effective.outputStyle],
    ['language', effective.language],
  ] as const;
  const summary: Record<string, unknown> = {};
  for (const [key, value] of scalars) {
    if (value) summary[key] = formatProvenanceValue(value as ProvenanceValue<unknown>, root);
  }
  return summary;
}

async function runShowEffective(root: string, logger: Logger): Promise<AuditSettingsReport> {
  const { effective, layers } = await auditSettings({ projectDir: root });

  const effectiveSummary = effectiveScalars(effective, root);
  const permissionsSummary = buildPermissionsSummary(effective.permissions, root);
  if (Object.keys(permissionsSummary).length > 0) {
    effectiveSummary['permissions'] = permissionsSummary;
  }

  const marketplaces = buildMarketplacesSummary(effective);
  if (Object.keys(marketplaces.summary).length > 0) {
    effectiveSummary['marketplaces'] = marketplaces.summary;
  }

  const conflicts = analyzeRuleConflicts(effective);
  const findings = settingsAuditFindings(conflicts, marketplaces.warnings, root);

  if (layers.length === 0) {
    logger.info('No settings files found');
  } else {
    logger.info(`Loaded ${layers.length} settings layer(s)`);
  }
  const { warnings } = countBySeverity(findings);
  if (warnings > 0) {
    logger.warn(`${warnings} warning(s): see findings and data.conflicts in the output.`);
  }

  return buildReport<AuditSettingsData>({
    examined: layers.length,
    findings,
    data: {
      mode: 'effective',
      root,
      layers: layers.map(l => ({ level: l.level, file: spell(l.file, root) })),
      effectiveSettings: effectiveSummary,
      conflicts: formatConflicts(conflicts, root),
    },
    gate: SETTINGS_GATE,
  });
}

/** Run the mode the options name. */
function runMode(options: AuditSettingsOptions, root: string, logger: Logger): Promise<AuditSettingsReport> {
  if (options.showPaths) return runShowPaths(root, logger);
  if (options.file !== undefined) return runValidateFile(options.file, options.type, root, logger);
  return runShowEffective(root, logger);
}

export async function runAuditSettings(
  options: AuditSettingsOptions
): Promise<void> {
  const logger = createLogger(options.debug ? { debug: true } : {});

  try {
    // The report's one stated root: every path in it is relative to where it ran.
    endWithReport('audit settings', await runMode(options, toForwardSlash(process.cwd()), logger), 'yaml');
  } catch (error) {
    endWithRefusal('audit settings', refusalCodeOf(error), error, 'yaml', SETTINGS_GATE, NOTHING_FINISHED);
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
  The report envelope every report verb publishes (YAML on stdout):
  - status: ok (no findings) | findings (at least one) | error (did not finish)
  - examined: settings documents read; summary: findings by severity
  - findings: SETTINGS_* codes, each with the settings file as 'location'
      and the key path as 'field'
  - data.root: the directory it ran in — the one absolute path; every other
      path (location, layers[].file, sources, paths[].path) is relative to it
  - data.mode: effective (default) | file (--file) | paths (--show-paths)
  - data (effective): layers (highest precedence first), effectiveSettings
      (each value with its source and an "overrode" chain down to the
      lowest-precedence layer), conflicts (unreachable or redundant rules)
  - data (file): detectedType, typeConfidence — declared (--type), inferred
      (a managed-only field settled it), ambiguous (user and project share one
      schema) or undetermined (not JSON) — and fields ("fields: null" means the
      file is not a JSON object, as distinct from "fields: []"); an absent or
      unreadable --file is refused (exit 2), never reported
  - data (paths): every settings path; "exists"/"readable" may be the string
      "undetermined" when the probe itself failed — not the same answer as false

Exit Codes:
  0 - No finding at error severity (warnings are in the report, not the exit code)
  1 - An error-severity finding (an invalid settings file, a legacy managed
      path), or no settings document could be read at all
  2 - Did not finish ('status: error'): USAGE_INVALID for a --file that does
      not exist or a --type the command does not know, INPUT_UNREADABLE for a
      --file the OS will not let it read

Example:
  $ cd ~/my-project && vat audit settings       # What can Claude do here?
  $ vat audit settings --show-paths             # Show all settings file paths
  $ vat audit settings --file managed.json      # Validate a settings file
`
    );

  return cmd;
}
