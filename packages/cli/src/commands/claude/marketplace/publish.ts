/**
 * Marketplace publish command.
 *
 * Pushes built marketplace artifacts to a Git branch for distribution.
 * Composes marketplace build output with CHANGELOG, README, and LICENSE,
 * then creates a squashed commit on the target branch.
 */

import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ClaudeMarketplaceConfig } from '@vibe-agent-toolkit/resources';
import { normalizedTmpdir } from '@vibe-agent-toolkit/utils';
import { Command } from 'commander';

import { handleCommandError } from '../../../utils/command-error.js';
import { createLogger, type Logger } from '../../../utils/logger.js';
import { writeYamlOutput } from '../../../utils/output.js';
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
  version: string;
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
  - CHANGELOG.md (stamped with version and date)
  - README.md
  - LICENSE (SPDX shortcut or file)

  Creates one squashed commit per version on the target branch.

Output:
  YAML summary -> stdout
  Progress -> stderr

Exit Codes:
  0 - Published successfully (or dry-run completed)
  1 - Publish error (missing build, empty changelog)
  2 - System error

Example:
  $ vat build && vat claude marketplace publish --no-push  # Create local branch
  $ git push origin claude-marketplace                     # Push when ready
`);

  return command;
}

/**
 * Read version from package.json in the given directory.
 */
function readProjectVersion(configDir: string): string {
  const packageJsonPath = join(configDir, 'package.json');
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path constructed from validated config dir
    const raw = readFileSync(packageJsonPath, 'utf-8');
    const parsed = JSON.parse(raw) as { version?: string };
    if (!parsed.version) {
      throw new Error('package.json is missing a "version" field.');
    }
    return parsed.version;
  } catch (error) {
    if (error instanceof Error && error.message.includes('ENOENT')) {
      throw new Error(`package.json not found at ${packageJsonPath}. Run from a project directory with package.json.`);
    }
    throw error;
  }
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
  version: string,
  date: string,
  publishConfig: NonNullable<ClaudeMarketplaceConfig['publish']>,
  licenseOpts: LicenseOptions | undefined,
): ComposeOptions {
  const opts: ComposeOptions = {
    marketplaceName: mpName,
    configDir,
    outputDir: mkdtempSync(join(normalizedTmpdir(), `vat-publish-tree-${mpName}-`)),
    version,
    date,
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
  version: string;
  date: string;
  options: MarketplacePublishOptions;
  logger: Logger;
}

/**
 * Publish a single marketplace and return the result.
 */
async function publishOneMarketplace(ctx: PublishOneOptions): Promise<PublishResult> {
  const { mpName, mpConfig, publishConfig, configDir, version, date, options, logger } = ctx;
  const branch = options.branch ?? publishConfig.branch ?? 'claude-marketplace';
  const remote = publishConfig.remote ?? 'origin';

  logger.info(`Publishing marketplace "${mpName}" v${version}`);

  const licenseOpts = publishConfig.license
    ? resolveLicenseOptions(publishConfig.license, mpConfig.owner.name)
    : undefined;

  const composeOpts = buildComposeOptions(mpName, configDir, version, date, publishConfig, licenseOpts);
  const composeResult = await composePublishTree(composeOpts);

  // Resolve source repo for commit metadata
  const sourceRepo = typeof publishConfig.sourceRepo === 'string'
    ? publishConfig.sourceRepo
    : undefined;

  const commitMessage = createCommitMessage(
    composeResult.version,
    composeResult.changelogDelta,
    sourceRepo ? { sourceRepo } : undefined,
  );

  if (options.dryRun) {
    logger.info(`[dry-run] Would publish to ${remote}/${branch}`);
    logger.info(`[dry-run] Version: ${version}`);
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
    version,
    branch,
    files: composeResult.files,
    dryRun: options.dryRun ?? false,
  };
}

async function marketplacePublishCommand(options: MarketplacePublishOptions): Promise<void> {
  const logger = createLogger(options.debug ? { debug: true } : {});
  const startTime = Date.now();

  try {
    const { configDir, claudeConfig } = await loadClaudeProjectConfig();

    if (!claudeConfig?.marketplaces) {
      throw new Error(
        'No marketplaces defined in config. Add a claude.marketplaces section to vibe-agent-toolkit.config.yaml.',
      );
    }

    const version = readProjectVersion(configDir);
    const today = new Date().toISOString().slice(0, 10);
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
        mpName, mpConfig, publishConfig: mpConfig.publish, configDir, version, date: today, options, logger,
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
