/**
 * Compose a publish tree from build output + metadata files.
 *
 * Takes the marketplace artifacts from dist/.claude/plugins/marketplaces/<name>/
 * and combines them with CHANGELOG.md, README.md, and LICENSE into a clean
 * directory ready to be committed to the publish branch.
 */

import { cpSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';

import { safePath } from '@vibe-agent-toolkit/utils';

import { CommandRefusalError } from '../../../utils/command-refusal.js';
import { configNamedFileAbsent, readInputFile, requireInputPath } from '../../../utils/project-root-policy.js';

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
  changelog?: ChangelogOptions;
  readme?: ReadmeOptions;
  license?: LicenseOptions;
}

export interface ComposeResult {
  /**
   * Version derived from the staged marketplace.json:
   *   - single-plugin marketplace → that plugin's version
   *   - multi-plugin (or zero-plugin) marketplace → undefined
   *
   * Consumers should render `v${version}` only when defined; for the undefined
   * case (multi-plugin), per-plugin versions in `publishedPlugins` are the
   * source of truth.
   */
  version: string | undefined;
  changelogDelta: string;
  files: string[];
  /**
   * Plugins listed in the published marketplace.json with their resolved versions.
   * Used to derive the marketplace label version (see `deriveLabelVersion`).
   * Plugins without a `version` field are skipped.
   */
  publishedPlugins: { name: string; version: string }[];
}

/** Shape we read defensively out of the published marketplace.json. */
interface PublishedPluginInfo {
  name: string;
  version?: string;
}

/**
 * Derive a label version from the staged plugin list. A marketplace with exactly
 * one plugin can borrow that plugin's version as its label; anything else (zero
 * or multiple plugins) leaves the label undefined; the per-plugin `version`
 * fields in the published marketplace.json carry the truth.
 *
 * Note: `publishedPlugins` is the *version-filtered* list — entries lacking a
 * `version` field are dropped upstream. The "one plugin" branch therefore
 * means "exactly one *versioned* plugin." This relies on the build pipeline
 * assigning a `version` to every plugin in the staged `marketplace.json`;
 * a future flow that stages an unversioned plugin alongside a versioned one
 * would emit a single-plugin label even though the marketplace contains two
 * entries. Threading the raw plugin count if that assumption breaks is the
 * obvious fix.
 */
function deriveLabelVersion(
  publishedPlugins: { name: string; version: string }[],
): string | undefined {
  return publishedPlugins.length === 1 ? publishedPlugins[0]?.version : undefined;
}

/**
 * Read the configured changelog, copy it byte-for-byte into outputDir, and
 * return the release-note string for the commit body. Accepts both Keep a
 * Changelog workflows:
 *   (B) pre-stamped `## [version]` section — preferred when a label version
 *       is available and that section is non-empty
 *   (A) non-empty `## [Unreleased]` — fallback, and the only path when the
 *       label is undefined (multi-plugin marketplaces)
 * Throws when both sections are empty.
 */
async function extractChangelogDelta(
  changelog: ChangelogOptions,
  configDir: string,
  outputDir: string,
  derivedVersion: string | undefined,
): Promise<string> {
  const rawChangelog = readChangelog(changelog.sourcePath, configDir);

  const stampedSection = derivedVersion
    ? parseVersionSection(rawChangelog, derivedVersion)
    : '';
  const unreleasedSection = parseUnreleasedSection(rawChangelog).trim();

  if (stampedSection === '' && unreleasedSection === '') {
    const reason = derivedVersion
      ? `has neither a non-empty [Unreleased] section nor a [${derivedVersion}] section`
      : `has no non-empty [Unreleased] section`;
    throw new CommandRefusalError(
      'INPUT_UNREADABLE',
      `Changelog "${changelog.sourcePath}" ${reason}. Document the release before publishing.`,
    );
  }

  await writeFile(safePath.join(outputDir, 'CHANGELOG.md'), rawChangelog);

  return stampedSection === '' ? unreleasedSection : stampedSection;
}

/**
 * The staged copy of the build's `marketplace.json`, parsed.
 *
 * The build output is this command's INPUT. A directory holding no manifest is
 * a build that stopped half-way, and a manifest that is not JSON is a damaged
 * one: both are the project's state — `INPUT_UNREADABLE` — never a defect in
 * VAT, which is what a raw errno or `SyntaxError` would publish.
 *
 * @throws {CommandRefusalError} `INPUT_UNREADABLE`, naming the build output project-relative
 */
function readBuiltMarketplaceJson(outputDir: string, marketplaceName: string): { plugins?: PublishedPluginInfo[] } {
  const built = `dist/.claude/plugins/marketplaces/${marketplaceName}`;
  const raw = readInputFile(safePath.join(outputDir, '.claude-plugin', 'marketplace.json'), {
    code: 'INPUT_UNREADABLE',
    message: `Marketplace build output at ${built} holds no .claude-plugin/marketplace.json — the build did not finish. Run "vat build" first.`,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new CommandRefusalError(
      'INPUT_UNREADABLE',
      `${built}/.claude-plugin/marketplace.json is not valid JSON. Run "vat build" to regenerate it.`,
      { cause: error },
    );
  }
  if (!isMarketplaceManifest(parsed)) {
    throw new CommandRefusalError(
      'INPUT_UNREADABLE',
      `${built}/.claude-plugin/marketplace.json is not a marketplace manifest (an object whose "plugins", when present, is a list of objects). Run "vat build" to regenerate it.`,
    );
  }
  return parsed;
}

/** A non-null, non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether parsed JSON has the one shape this command reads from a built
 * manifest: an object whose `plugins`, when present, is a list of objects.
 * Each entry's own fields are read defensively by the caller.
 */
function isMarketplaceManifest(value: unknown): value is { plugins?: PublishedPluginInfo[] } {
  if (!isRecord(value)) return false;
  const { plugins } = value;
  return plugins === undefined || (Array.isArray(plugins) && plugins.every(isRecord));
}

export async function composePublishTree(options: ComposeOptions): Promise<ComposeResult> {
  const { marketplaceName, configDir, outputDir } = options;
  const files: string[] = [];
  let changelogDelta = '';

  // 1. Verify build output exists
  const buildDir = safePath.join(configDir, 'dist', '.claude', 'plugins', 'marketplaces', marketplaceName);
  requireInputPath(buildDir, {
    code: 'INPUT_UNREADABLE',
    message: `Marketplace build output not found at dist/.claude/plugins/marketplaces/${marketplaceName}. Run "vat build" first.`,
  });

  // 2. Copy marketplace artifacts to output
  // Use cpSync instead of async cp() — Node 22 cp() drops files in nested directories
  cpSync(buildDir, outputDir, { recursive: true });
  files.push('.claude-plugin/marketplace.json', 'plugins/');

  // 2b. Read the published marketplace.json to recover each plugin's resolved
  //     version for label derivation. The build pipeline writes this file; we
  //     just observe it here. Defensive parsing because marketplace.json is
  //     build output, not validated input at this layer.
  const marketplaceJson = readBuiltMarketplaceJson(outputDir, marketplaceName);
  // Plugins without a resolved version don't contribute to the label — skip them.
  const publishedPlugins = (marketplaceJson.plugins ?? [])
    .filter((p): p is { name: string; version: string } =>
      Boolean(p.name) && typeof p.version === 'string' && p.version.length > 0,
    )
    .map((p) => ({ name: p.name, version: p.version }));

  const derivedVersion = deriveLabelVersion(publishedPlugins);

  // 3. Process changelog
  if (options.changelog) {
    changelogDelta = await extractChangelogDelta(
      options.changelog, configDir, outputDir, derivedVersion,
    );
    files.push('CHANGELOG.md');
  }

  // 4. Process readme
  if (options.readme) {
    const readmePath = safePath.resolve(configDir, options.readme.sourcePath);
    const readmeContent = readInputFile(readmePath, configNamedFileAbsent('publish.readme', options.readme.sourcePath));
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
    await writeFile(safePath.join(outputDir, 'LICENSE'), licenseContent);
    files.push('LICENSE');
  }

  return { version: derivedVersion, changelogDelta, files, publishedPlugins };
}
