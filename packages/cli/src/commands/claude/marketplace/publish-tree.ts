/**
 * Compose a publish tree from build output + metadata files.
 *
 * Takes the marketplace artifacts from dist/.claude/plugins/marketplaces/<name>/
 * and combines them with CHANGELOG.md, README.md, and LICENSE into a clean
 * directory ready to be committed to the publish branch.
 */

import { existsSync, readFileSync } from 'node:fs';
import { cp, writeFile } from 'node:fs/promises';

import { safePath } from '@vibe-agent-toolkit/utils';

import { parseUnreleasedSection, readChangelog, stampChangelog } from './changelog-utils.js';
import { generateLicenseText, readLicenseFile } from './license-utils.js';

export interface ChangelogOptions {
  sourcePath: string;
}

export interface ReadmeOptions {
  sourcePath: string;
}

export type LicenseOptions =
  | { type: 'spdx'; value: string; ownerName: string }
  | { type: 'file'; filePath: string };

export interface ComposeOptions {
  marketplaceName: string;
  configDir: string;
  outputDir: string;
  version: string;
  date: string;
  changelog?: ChangelogOptions;
  readme?: ReadmeOptions;
  license?: LicenseOptions;
}

export interface ComposeResult {
  version: string;
  changelogDelta: string;
  files: string[];
}

export async function composePublishTree(options: ComposeOptions): Promise<ComposeResult> {
  const { marketplaceName, configDir, outputDir, version, date } = options;
  const files: string[] = [];
  let changelogDelta = '';

  // 1. Verify build output exists
  const buildDir = safePath.join(configDir, 'dist', '.claude', 'plugins', 'marketplaces', marketplaceName);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path constructed from validated config
  if (!existsSync(buildDir)) {
    throw new Error(
      `Marketplace build output not found at ${buildDir}. Run "vat build" first.`,
    );
  }

  // 2. Copy marketplace artifacts to output
  await cp(buildDir, outputDir, { recursive: true });
  files.push('.claude-plugin/marketplace.json', 'plugins/');

  // 3. Process changelog
  if (options.changelog) {
    const rawChangelog = readChangelog(options.changelog.sourcePath, configDir);
    const unreleased = parseUnreleasedSection(rawChangelog);

    if (unreleased.trim() === '') {
      throw new Error(
        `Changelog "${options.changelog.sourcePath}" has an empty [Unreleased] section. ` +
          `Add release notes before publishing.`,
      );
    }

    changelogDelta = unreleased.trim();
    const stamped = stampChangelog(rawChangelog, version, date);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path constructed from validated config
    await writeFile(safePath.join(outputDir, 'CHANGELOG.md'), stamped);
    files.push('CHANGELOG.md');
  }

  // 4. Process readme
  if (options.readme) {
    const readmePath = safePath.resolve(configDir, options.readme.sourcePath);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path from validated config
    const readmeContent = readFileSync(readmePath, 'utf-8');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path constructed from validated config
    await writeFile(safePath.join(outputDir, 'README.md'), readmeContent);
    files.push('README.md');
  }

  // 5. Process license
  if (options.license) {
    let licenseContent: string;
    if (options.license.type === 'spdx') {
      licenseContent = generateLicenseText(
        options.license.value,
        options.license.ownerName,
        new Date().getFullYear(),
      );
    } else {
      licenseContent = readLicenseFile(options.license.filePath, configDir);
    }
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path constructed from validated config
    await writeFile(safePath.join(outputDir, 'LICENSE'), licenseContent);
    files.push('LICENSE');
  }

  return { version, changelogDelta, files };
}
