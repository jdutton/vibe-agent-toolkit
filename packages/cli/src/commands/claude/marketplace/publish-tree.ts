/**
 * Compose a publish tree from build output + metadata files.
 *
 * Takes the marketplace artifacts from dist/.claude/plugins/marketplaces/<name>/
 * and combines them with CHANGELOG.md, README.md, and LICENSE into a clean
 * directory ready to be committed to the publish branch.
 */

import { cpSync, existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';

import { safePath } from '@vibe-agent-toolkit/utils';

import {
  parseUnreleasedSection,
  parseVersionSection,
  readChangelog,
} from './changelog-utils.js';
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
  changelog?: ChangelogOptions;
  readme?: ReadmeOptions;
  license?: LicenseOptions;
}

export interface ComposeResult {
  version: string;
  changelogDelta: string;
  files: string[];
  /**
   * Plugins listed in the published marketplace.json with their resolved versions.
   * Used by the publish flow to push per-plugin source-repo tags after a successful
   * branch push. Plugins without a `version` field are skipped.
   */
  publishedPlugins: { name: string; version: string }[];
}

/** Shape we read defensively out of the published marketplace.json. */
interface PublishedPluginInfo {
  name: string;
  version?: string;
}

export async function composePublishTree(options: ComposeOptions): Promise<ComposeResult> {
  const { marketplaceName, configDir, outputDir, version } = options;
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
  // Use cpSync instead of async cp() — Node 22 cp() drops files in nested directories
  cpSync(buildDir, outputDir, { recursive: true });
  files.push('.claude-plugin/marketplace.json', 'plugins/');

  // 2b. Read the published marketplace.json so the publish flow knows which
  //     plugins (and resolved versions) to tag after a successful push. The
  //     build pipeline writes this file; we just observe it here. Defensive
  //     parsing because marketplace.json is build output, not validated input
  //     at this layer.
  const marketplaceJsonPath = safePath.join(outputDir, '.claude-plugin', 'marketplace.json');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path constructed from validated config
  const marketplaceJsonRaw = readFileSync(marketplaceJsonPath, 'utf-8');
  const marketplaceJson = JSON.parse(marketplaceJsonRaw) as { plugins?: PublishedPluginInfo[] };
  // Plugins without a resolved version are not eligible for tagging — skip them.
  const publishedPlugins = (marketplaceJson.plugins ?? [])
    .filter((p): p is { name: string; version: string } =>
      Boolean(p.name) && typeof p.version === 'string' && p.version.length > 0,
    )
    .map((p) => ({ name: p.name, version: p.version }));

  // 3. Process changelog — VAT copies the source file byte-for-byte into the publish tree.
  //    We only extract a release-note string for the commit body (changelogDelta).
  //    Accept both Keep a Changelog workflows:
  //      (B) pre-stamped `## [version]` section — preferred when present, and
  //      (A) non-empty `## [Unreleased]` — fallback.
  //    Error if both are empty.
  if (options.changelog) {
    const rawChangelog = readChangelog(options.changelog.sourcePath, configDir);

    const stampedSection = parseVersionSection(rawChangelog, version);
    const unreleasedSection = parseUnreleasedSection(rawChangelog).trim();

    if (stampedSection === '' && unreleasedSection === '') {
      throw new Error(
        `Changelog "${options.changelog.sourcePath}" has neither a non-empty [Unreleased] ` +
          `section nor a [${version}] section. Document the release before publishing.`,
      );
    }

    changelogDelta = stampedSection === '' ? unreleasedSection : stampedSection;

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path constructed from validated config
    await writeFile(safePath.join(outputDir, 'CHANGELOG.md'), rawChangelog);
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

  return { version, changelogDelta, files, publishedPlugins };
}
