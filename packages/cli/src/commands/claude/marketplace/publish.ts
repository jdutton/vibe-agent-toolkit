/**
 * Marketplace publish command.
 *
 * Pushes built marketplace artifacts to a Git branch for distribution.
 * Composes marketplace build output with CHANGELOG, README, and LICENSE,
 * then creates a squashed commit on the target branch.
 */

import { mkdtempSync } from 'node:fs';


import type { ClaudeMarketplaceConfig } from '@vibe-agent-toolkit/resources';
import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { Command } from 'commander';

import { handleCommandError } from '../../../utils/command-error.js';
import { createLogger, type Logger } from '../../../utils/logger.js';
import { writeYamlOutput } from '../../../utils/output.js';
import { redactUrlCredentials } from '../../../utils/url-redact.js';
import { loadClaudeProjectConfig } from '../claude-config.js';

import { createCommitMessage, publishToGitBranch } from './git-publish.js';
import { isFilePath, isSpdxIdentifier } from './license-utils.js';
import { composePublishTree, type ComposeOptions, type LicenseOptions } from './publish-tree.js';

export interface MarketplacePublishOptions {
  dryRun?: boolean;
  push?: boolean;
  branch?: string;
  force?: boolean;
  marketplace?: string;
  debug?: boolean;
}

interface PublishResult {
  marketplace: string;
  /**
   * Marketplace label version: the single plugin's version when the marketplace
   * contains exactly one plugin, otherwise undefined (multi-plugin marketplaces
   * have no aggregate version — per-plugin versions are in the published
   * marketplace.json).
   */
  version: string | undefined;
  branch: string;
  files: string[];
  dryRun: boolean;
}

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
  YAML summary -> stdout
  Progress -> stderr

Exit Codes:
  0 - Published successfully (or dry-run completed)
  1 - Publish error (missing build, changelog missing release notes for version)
  2 - System error

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
  if (isSpdxIdentifier(licenseValue)) {
    return { type: 'spdx', value: licenseValue, ownerName };
  }
  throw new Error(
    `License "${licenseValue}" is neither a known SPDX identifier nor a file path.`,
  );
}

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
  const remote = publishConfig.remote ?? 'origin';

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
    commitMessage,
    force: options.force ?? false,
    dryRun: options.dryRun ?? false,
    noPush: options.push === false,
    logger,
  });

  return {
    marketplace: mpName,
    version: labelVersion,
    branch,
    files: composeResult.files,
    dryRun: options.dryRun ?? false,
  };
}

async function marketplacePublishCommand(_options: MarketplacePublishOptions, command: Command): Promise<void> {
  // Commander nests --debug on a parent command, so use optsWithGlobals()
  const options = command.optsWithGlobals() as MarketplacePublishOptions;
  const logger = createLogger(options.debug ? { debug: true } : {});
  const startTime = Date.now();

  try {
    const { configDir, claudeConfig } = await loadClaudeProjectConfig();

    if (!claudeConfig?.marketplaces) {
      throw new Error(
        'No marketplaces defined in config. Add a claude.marketplaces section to vibe-agent-toolkit.config.yaml.',
      );
    }

    const results: PublishResult[] = [];

    for (const [mpName, mpConfig] of Object.entries(claudeConfig.marketplaces)) {
      if (options.marketplace && options.marketplace !== mpName) {
        continue;
      }
      if (!mpConfig.publish) {
        logger.info(`Skipping "${mpName}" (no publish config)`);
        continue;
      }

      const result = await publishOneMarketplace({
        mpName, mpConfig, publishConfig: mpConfig.publish, configDir, options, logger,
      });
      results.push(result);
    }

    if (results.length === 0) {
      throw new Error(
        options.marketplace
          ? `Marketplace "${options.marketplace}" not found or has no publish config.`
          : 'No marketplaces with publish config found.',
      );
    }

    writeYamlOutput({
      status: 'success',
      published: results,
    });

    process.exit(0);
  } catch (error) {
    handleCommandError(error, logger, startTime, 'MarketplacePublish');
  }
}
