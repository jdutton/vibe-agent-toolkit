/**
 * Marketplace publish command.
 *
 * Pushes built marketplace artifacts to a Git branch for distribution.
 * Composes marketplace build output with CHANGELOG, README, and LICENSE,
 * then creates a squashed commit on the target branch.
 */

import { mkdtempSync } from 'node:fs';


import type { ClaudeMarketplaceConfig } from '@vibe-agent-toolkit/resources';
import { buildReport, type Gate } from '@vibe-agent-toolkit/schema';
import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { Command } from 'commander';

import { refusalCodeOf } from '../../../utils/command-refusal.js';
import { endWithRefusal, endWithReport, NOTHING_FINISHED } from '../../../utils/document-writer.js';
import { createLogger, type Logger } from '../../../utils/logger.js';
import { redactUrlCredentials } from '../../../utils/url-redact.js';
import { assertMarketplaceDeclared, loadClaudeProjectConfig } from '../claude-config.js';

import { createCommitMessage, publishToGitBranch } from './git-publish.js';
import { assertRenderableLicense, isFilePath } from './license-utils.js';
import type { MarketplacePublishData, MarketplacePublishReport } from './publish-schema.js';
import { composePublishTree, type ComposeOptions, type LicenseOptions } from './publish-tree.js';

export interface MarketplacePublishOptions {
  dryRun?: boolean;
  push?: boolean;
  branch?: string;
  force?: boolean;
  marketplace?: string;
  debug?: boolean;
}

/**
 * One published marketplace, as the report's `data.published[]` row.
 *
 * `version` is the marketplace label version: the single plugin's version
 * when the marketplace contains exactly one plugin, otherwise `null`
 * (multi-plugin marketplaces have no aggregate version — per-plugin versions
 * are in the published marketplace.json).
 */
type PublishResult = MarketplacePublishData['published'][number];

/** The remote publish pushes to when `publish.remote` is not set. */
const DEFAULT_REMOTE = 'origin';

/** Publish has no `--strict`: nothing it reports is a warning to gate on. */
const GATE: Gate = { strict: false };

export function createMarketplacePublishCommand(): Command {
  const command = new Command('publish');

  command
    .description('Publish built marketplace to a Git branch')
    .option('--dry-run', 'Show what would be published without pushing')
    .option('--no-push', 'Create local branch only, do not push to remote')
    .option('--branch <name>', 'Override publish branch')
    .option('--force', 'Force-push (first publish or recovery)')
    .option('--marketplace <name>', 'Publish specific marketplace only')
    .option('--debug', 'Enable debug logging')
    .action(marketplacePublishCommand)
    .addHelpText('after', `
Description:
  Pushes built marketplace artifacts to a Git branch for distribution.
  Requires vat build to have been run first.

  Composes:
  - Marketplace artifacts from dist/.claude/plugins/marketplaces/
  - CHANGELOG.md — copied BYTE-FOR-BYTE from the source. Release notes
    for the commit body are extracted from either a pre-stamped
    [version] section matching package.json, or (as a fallback) a
    non-empty [Unreleased] section. Publish fails if neither is
    present. VAT never mutates CHANGELOG.md.
  - Per-plugin CHANGELOG.md — when plugins/<name>/CHANGELOG.md exists
    (or the marketplace plugin entry's changelog field points to one),
    it is bundled into the published marketplace at
    plugins/<name>/CHANGELOG.md alongside the marketplace-level
    CHANGELOG.md.
  - README.md
  - LICENSE (SPDX shortcut or file)

  Creates one squashed commit per version on the target branch.

Per-plugin versioning:
  Each plugin can declare its own version via plugins/<name>/.claude-plugin/plugin.json:version
  or the marketplace config's per-plugin version field. Precedence:
    marketplace config > plugin.json:version > root package.json:version
  When neither is set, all plugins inherit the root version (existing
  single-version model — preserved for backwards compatibility).

Output:
  YAML report -> stdout: status (ok | findings | error), examined
  (marketplaces with a publish: block), and data.published[] of
  { marketplace, version (null for a multi-plugin marketplace), branch,
  files, dryRun }. A refusal after a marketplace was published still lists it.
  Progress -> stderr

Exit Codes:
  0 - Published (or dry-run completed)
  1 - No marketplace declares a publish: block (RESOURCE_CHECK_BROKEN)
  2 - Publish could not run (error.code): USAGE_INVALID (an undeclared
      --marketplace), CONFIG_INVALID (no config, a license value VAT cannot
      render, a configured changelog/readme/license file that does not exist,
      an unknown git remote), INPUT_UNREADABLE (no build output, or build
      output with no readable marketplace.json — run vat build; a changelog
      with no release notes for this version),
      EXTERNAL_API_FAILED (the push was rejected), RUN_INCOMPLETE (a git step
      failed)

Example:
  $ vat build && vat claude marketplace publish --no-push  # Create local branch
  $ git push origin claude-marketplace                     # Push when ready
`);

  return command;
}

/**
 * Resolve a license config value to typed LicenseOptions.
 */
function resolveLicenseOptions(
  licenseValue: string,
  ownerName: string,
): LicenseOptions {
  if (isFilePath(licenseValue)) {
    return { type: 'file', filePath: licenseValue };
  }
  assertRenderableLicense(licenseValue);
  return { type: 'spdx', value: licenseValue, ownerName };
}

/** Test seam: a config `license` value as the composer's options. */
export const __internal = { resolveLicenseOptions };

/**
 * Build ComposeOptions for a single marketplace entry.
 */
function buildComposeOptions(
  mpName: string,
  configDir: string,
  publishConfig: NonNullable<ClaudeMarketplaceConfig['publish']>,
  licenseOpts: LicenseOptions | undefined,
): ComposeOptions {
  const opts: ComposeOptions = {
    marketplaceName: mpName,
    configDir,
    outputDir: mkdtempSync(safePath.join(normalizedTmpdir(), `vat-publish-tree-${mpName}-`)),
  };
  if (publishConfig.changelog) {
    opts.changelog = { sourcePath: publishConfig.changelog };
  }
  if (publishConfig.readme) {
    opts.readme = { sourcePath: publishConfig.readme };
  }
  if (licenseOpts) {
    opts.license = licenseOpts;
  }
  return opts;
}

interface PublishOneOptions {
  mpName: string;
  mpConfig: ClaudeMarketplaceConfig;
  publishConfig: NonNullable<ClaudeMarketplaceConfig['publish']>;
  configDir: string;
  options: MarketplacePublishOptions;
  logger: Logger;
}

/**
 * Publish a single marketplace and return the result.
 */
async function publishOneMarketplace(ctx: PublishOneOptions): Promise<PublishResult> {
  const { mpName, mpConfig, publishConfig, configDir, options, logger } = ctx;
  const branch = options.branch ?? publishConfig.branch ?? 'claude-marketplace';
  const remote = publishConfig.remote ?? DEFAULT_REMOTE;

  const licenseOpts = publishConfig.license
    ? resolveLicenseOptions(publishConfig.license, mpConfig.owner.name)
    : undefined;

  const composeOpts = buildComposeOptions(mpName, configDir, publishConfig, licenseOpts);
  const composeResult = await composePublishTree(composeOpts);

  const labelVersion = composeResult.version;
  const banner = labelVersion
    ? `Publishing marketplace "${mpName}" v${labelVersion}`
    : `Publishing marketplace "${mpName}"`;
  logger.info(banner);

  // Resolve source repo for commit metadata
  const sourceRepo = typeof publishConfig.sourceRepo === 'string'
    ? publishConfig.sourceRepo
    : undefined;

  const headline = labelVersion ? `publish v${labelVersion}` : `publish ${mpName}`;
  const commitMessage = createCommitMessage(
    headline,
    composeResult.changelogDelta,
    sourceRepo ? { sourceRepo } : undefined,
  );

  if (options.dryRun) {
    logger.info(`[dry-run] Would publish to ${redactUrlCredentials(remote)}/${branch}`);
    logger.info(`[dry-run] Version: ${labelVersion ?? '(multi-plugin — no aggregate version)'}`);
    logger.info(`[dry-run] Files: ${composeResult.files.join(', ')}`);
  } else if (options.push === false) {
    logger.info(`[no-push] Creating local branch ${branch}`);
  }

  await publishToGitBranch({
    publishDir: composeOpts.outputDir,
    branch,
    remote,
    remoteFromConfig: publishConfig.remote !== undefined,
    commitMessage,
    force: options.force ?? false,
    dryRun: options.dryRun ?? false,
    noPush: options.push === false,
    logger,
  });

  return {
    marketplace: mpName,
    version: labelVersion ?? null,
    branch,
    files: composeResult.files,
    dryRun: options.dryRun ?? false,
  };
}

/** The report over the marketplaces published — a refusal's finished work reads the same list. */
function publishReport(published: readonly PublishResult[], durationMs: number): MarketplacePublishReport {
  return buildReport({ examined: published.length, findings: [], data: { published: [...published] }, gate: GATE, durationMs });
}

async function marketplacePublishCommand(_options: MarketplacePublishOptions, command: Command): Promise<void> {
  // Commander nests --debug on a parent command, so use optsWithGlobals()
  const options = command.optsWithGlobals() as MarketplacePublishOptions;
  const logger = createLogger(options.debug ? { debug: true } : {});
  const startTime = Date.now();
  // Pushed as each marketplace publishes, so a refusal on the next one still
  // reports what already reached its branch.
  const published: PublishResult[] = [];

  try {
    const { configDir, claudeConfig } = await loadClaudeProjectConfig();
    const marketplaces = claudeConfig?.marketplaces ?? {};
    assertMarketplaceDeclared(options.marketplace, Object.keys(marketplaces));

    for (const [mpName, mpConfig] of Object.entries(marketplaces)) {
      if (options.marketplace && options.marketplace !== mpName) {
        continue;
      }
      if (!mpConfig.publish) {
        logger.info(`Skipping "${mpName}" (no publish config)`);
        continue;
      }

      published.push(await publishOneMarketplace({
        mpName, mpConfig, publishConfig: mpConfig.publish, configDir, options, logger,
      }));
    }
  } catch (error) {
    const finished = published.length === 0
      ? NOTHING_FINISHED
      : { examined: published.length, findings: [], data: { published } };
    endWithRefusal('claude marketplace publish', refusalCodeOf(error), error, 'yaml', GATE, finished);
  }

  // Nothing published because nothing declares `publish:` is examined-zero:
  // the writer refuses that green.
  endWithReport('claude marketplace publish', publishReport(published, Date.now() - startTime), 'yaml');
}
