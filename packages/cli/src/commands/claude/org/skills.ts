/**
 * `vat claude org skills` — manage organization skills via Skills API.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import {   basename } from 'node:path';

import { buildMultipartFormData } from '@vibe-agent-toolkit/claude-marketplace';
import type { MultipartFile, OrgApiClient } from '@vibe-agent-toolkit/claude-marketplace';
import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { Command } from 'commander';

import { downloadNpmPackage } from '../plugin/helpers.js';

import { autopaginateSkills, executeOrgCommand } from './helpers.js';

const SKILL_ID_ARG = '<skill-id>';
const SKILL_ID_DESC = 'Skill ID (slug)';
const DEBUG_OPT_DESC = 'Enable debug logging';

// ── Helpers ────────────────────────────────────────────────────────────

interface SkillUploadResult {
	id: string;
	displayTitle: string;
	version: string;
	createdAt: string;
}

interface UploadLogger {
	info: (msg: string) => void;
}

/**
 * Send multipart files to the Skills API and return a normalized result.
 */
async function sendSkillUpload(
	client: OrgApiClient,
	displayTitle: string,
	files: MultipartFile[],
): Promise<SkillUploadResult> {
	const multipart = buildMultipartFormData({ display_title: displayTitle }, files);
	const result = await client.uploadSkill<{
		id: string; type: string; display_title: string; latest_version: string; created_at: string;
	}>(multipart);
	return {
		id: result.id,
		displayTitle: result.display_title,
		version: result.latest_version,
		createdAt: result.created_at,
	};
}

/**
 * Extract display_title from SKILL.md frontmatter.
 * Parses the `name` field from YAML frontmatter between --- delimiters.
 */
function extractDisplayTitle(skillMdPath: string): string {
	// eslint-disable-next-line security/detect-non-literal-fs-filename -- path from CLI arg, validated before call
	const content = readFileSync(skillMdPath, 'utf-8');
	// eslint-disable-next-line sonarjs/slow-regex -- bounded by small frontmatter block, not user-controlled input
	const match = /^---\s*\n([\s\S]*?)\n---/.exec(content);
	if (!match?.[1]) {
		throw new Error(`SKILL.md has no frontmatter: ${skillMdPath}`);
	}
	// eslint-disable-next-line sonarjs/slow-regex -- single-line match on small YAML block
	const nameMatch = /^name:\s*(.+)$/m.exec(match[1]);
	if (!nameMatch?.[1]) {
		throw new Error(`SKILL.md frontmatter missing "name" field: ${skillMdPath}`);
	}
	return nameMatch[1].trim();
}

/**
 * Collect all files in a directory recursively, returning relative paths.
 */
function collectFiles(dir: string, baseDir?: string): Array<{ relativePath: string; absolutePath: string }> {
	const base = baseDir ?? dir;
	const results: Array<{ relativePath: string; absolutePath: string }> = [];

	// eslint-disable-next-line security/detect-non-literal-fs-filename -- dir from CLI arg
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const fullPath = safePath.join(dir, entry.name);
		if (entry.isDirectory()) {
			results.push(...collectFiles(fullPath, base));
		} else {
			results.push({
				relativePath: safePath.relative(base, fullPath),
				absolutePath: fullPath,
			});
		}
	}

	return results;
}

/**
 * Upload a single skill directory to the org via Skills API.
 */
async function uploadSkillDir(
	client: OrgApiClient,
	skillDir: string,
	titleOverride: string | undefined,
	logger: UploadLogger,
): Promise<SkillUploadResult> {
	const skillMdPath = safePath.join(skillDir, 'SKILL.md');
	// eslint-disable-next-line security/detect-non-literal-fs-filename -- derived from CLI arg
	if (!existsSync(skillMdPath)) {
		throw new Error(`SKILL.md not found in ${skillDir}. Is this a built skill directory?`);
	}

	const displayTitle = titleOverride ?? extractDisplayTitle(skillMdPath);

	// API requires files inside a top-level directory (e.g. skill_name/SKILL.md)
	const dirName = basename(skillDir);
	const allFiles = collectFiles(skillDir);
	const files: MultipartFile[] = [];

	for (const file of allFiles) {
		// eslint-disable-next-line security/detect-non-literal-fs-filename -- collected from dir walk
		const content = readFileSync(file.absolutePath);
		files.push({
			fieldName: 'files[]',
			filename: `${dirName}/${file.relativePath}`,
			content,
		});
	}

	const totalSize = files.reduce((sum, f) => sum + f.content.length, 0);
	logger.info(`   ${dirName}: ${files.length} files, ${(totalSize / 1024).toFixed(1)}KB, title="${displayTitle}"`);

	return sendSkillUpload(client, displayTitle, files);
}

/**
 * List candidate package directories in node_modules (scoped + unscoped).
 */
function listNodeModulePackages(nodeModulesDir: string): string[] {
	// eslint-disable-next-line security/detect-non-literal-fs-filename -- constructed from temp dir
	if (!existsSync(nodeModulesDir)) return [];

	const results: string[] = [];
	// eslint-disable-next-line security/detect-non-literal-fs-filename -- constructed from temp dir
	for (const entry of readdirSync(nodeModulesDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		if (entry.name.startsWith('@')) {
			const scopeDir = safePath.join(nodeModulesDir, entry.name);
			// eslint-disable-next-line security/detect-non-literal-fs-filename -- constructed from temp dir
			for (const scopedEntry of readdirSync(scopeDir, { withFileTypes: true })) {
				if (scopedEntry.isDirectory()) results.push(safePath.join(scopeDir, scopedEntry.name));
			}
		} else {
			results.push(safePath.join(nodeModulesDir, entry.name));
		}
	}
	return results;
}

/**
 * Find the dist/skills/ directory in a package. Checks the package itself
 * first, then scans node_modules for sub-packages that contain built skills.
 */
function findSkillsDir(packageDir: string): string | undefined {
	const direct = safePath.join(packageDir, 'dist', 'skills');
	// eslint-disable-next-line security/detect-non-literal-fs-filename -- constructed from temp dir
	if (existsSync(direct)) return direct;

	const candidates = listNodeModulePackages(safePath.join(packageDir, 'node_modules'));
	for (const pkgDir of candidates) {
		const candidate = safePath.join(pkgDir, 'dist', 'skills');
		// eslint-disable-next-line security/detect-non-literal-fs-filename -- constructed from temp dir
		if (existsSync(candidate)) return candidate;
	}

	return undefined;
}

/**
 * Upload skills from an npm package.
 */
async function installFromNpm(
	npmPackage: string,
	skillFilter: string | undefined,
	client: OrgApiClient,
	logger: UploadLogger,
): Promise<object> {
	const tempDir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-org-skills-'));
	try {
		logger.info(`Downloading: ${npmPackage}`);
		const packageDir = downloadNpmPackage(npmPackage, tempDir);

		const skillsDir = findSkillsDir(packageDir);
		if (!skillsDir) {
			throw new Error(`No dist/skills/ directory found in ${npmPackage}. Was the package built with vat skills build?`);
		}
		logger.info(`Found skills at: ${safePath.relative(packageDir, skillsDir) || 'dist/skills/'}`);

		// eslint-disable-next-line security/detect-non-literal-fs-filename -- constructed from temp dir
		const skillDirs = readdirSync(skillsDir, { withFileTypes: true })
			.filter(e => e.isDirectory())
			.map(e => e.name);

		if (skillDirs.length === 0) {
			throw new Error(`No skills found in dist/skills/ of ${npmPackage}`);
		}

		const toUpload = skillFilter
			? skillDirs.filter(name => name === skillFilter)
			: skillDirs;

		if (toUpload.length === 0) {
			throw new Error(`Skill "${String(skillFilter)}" not found in ${npmPackage}. Available: ${skillDirs.join(', ')}`);
		}

		logger.info(`Found ${toUpload.length} skill(s) to upload from ${npmPackage}`);

		const results: SkillUploadResult[] = [];
		const errors: Array<{ skill: string; error: string }> = [];

		for (const skillName of toUpload) {
			const skillDir = safePath.join(skillsDir, skillName);
			try {
				const result = await uploadSkillDir(client, skillDir, undefined, logger);
				results.push(result);
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				logger.info(`   ⚠ ${skillName}: ${msg}`);
				errors.push({ skill: skillName, error: msg });
			}
		}

		return {
			source: npmPackage,
			skillsUploaded: results.length,
			...(errors.length > 0 ? { skillsFailed: errors.length, errors } : {}),
			skills: results,
		};
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

/**
 * Upload a local skill directory or ZIP file.
 */
async function installFromLocal(
	source: string,
	titleOverride: string | undefined,
	client: OrgApiClient,
	logger: UploadLogger,
): Promise<object> {
	const sourcePath = source.startsWith('/') ? source : safePath.join(process.cwd(), source);

	// eslint-disable-next-line security/detect-non-literal-fs-filename -- path from CLI arg
	if (!existsSync(sourcePath)) {
		throw new Error(`Source not found: ${sourcePath}`);
	}

	// eslint-disable-next-line security/detect-non-literal-fs-filename -- path from CLI arg
	const stat = statSync(sourcePath);

	if (!stat.isDirectory() && sourcePath.endsWith('.zip')) {
		const displayTitle = titleOverride ?? basename(sourcePath, '.zip');
		// eslint-disable-next-line security/detect-non-literal-fs-filename -- path from CLI arg
		const zipContent = readFileSync(sourcePath);
		const files: MultipartFile[] = [{
			fieldName: 'files[]',
			filename: basename(sourcePath),
			content: zipContent,
		}];
		logger.info(`Uploading ZIP: ${sourcePath} (${(zipContent.length / 1024).toFixed(1)}KB)`);
		logger.info(`Display title: ${displayTitle}`);

		return sendSkillUpload(client, displayTitle, files);
	}

	if (!stat.isDirectory()) {
		throw new Error(`Source must be a directory or .zip file: ${sourcePath}`);
	}

	logger.info(`Uploading skill directory: ${sourcePath}`);
	return uploadSkillDir(client, sourcePath, titleOverride, logger);
}

// ── Commands ───────────────────────────────────────────────────────────

export function createOrgSkillsCommand(): Command {
	const command = new Command('skills');

	command
		.description('Manage organization skills (requires ANTHROPIC_API_KEY)')
		.helpCommand(false);

	// list
	const listCmd = new Command('list');
	listCmd
		.description('List organization skills')
		.option('--debug', DEBUG_OPT_DESC)
		.action(async (options: { debug?: boolean }) => {
			await executeOrgCommand('OrgSkillsList', options.debug, async ({ client }) => {
				return autopaginateSkills(client, '/v1/skills');
			});
		})
		.addHelpText('after', `
Description:
  Lists skills in the organization. Uses the Skills API (beta).
  Requires ANTHROPIC_API_KEY (regular key, not admin key).
  Skill IDs are slugs, not UUIDs.

Example:
  $ vat claude org skills list
`);

	// install
	const installCmd = new Command('install');
	installCmd
		.description('Upload skill(s) to the organization via Skills API')
		.argument('[source]', 'Path to built skill directory or ZIP file')
		.option('--from-npm <package>', 'Download skills from an npm package (e.g. vibe-agent-toolkit@0.1.22-rc.3)')
		.option('--skill <name>', 'Upload only this skill (with --from-npm)')
		.option('--title <title>', 'Display title override (single skill only)')
		.option('--debug', DEBUG_OPT_DESC)
		.action(async (source: string | undefined, options: { fromNpm?: string; skill?: string; title?: string; debug?: boolean }) => {
			if (!source && !options.fromNpm) {
				throw new Error('Provide a <source> path or use --from-npm <package>');
			}
			if (source && options.fromNpm) {
				throw new Error('Provide either <source> or --from-npm, not both');
			}

			const commandName = options.fromNpm ? 'OrgSkillsInstallNpm' : 'OrgSkillsInstall';
			await executeOrgCommand(commandName, options.debug, async ({ client, logger }) => {
				if (options.fromNpm) {
					return installFromNpm(options.fromNpm, options.skill, client, logger);
				}
				return installFromLocal(source as string, options.title, client, logger);
			});
		})
		.addHelpText('after', `
Description:
  Uploads skill(s) to the organization via the Anthropic Skills API (beta).
  Accepts a built skill directory, a ZIP file, or an npm package.
  Requires ANTHROPIC_API_KEY (regular key, not admin key).

  The display_title defaults to the "name" field from SKILL.md frontmatter.

Examples:
  $ vat claude org skills install dist/skills/org-admin
  $ vat claude org skills install my-skill.zip --title "My Custom Skill"
  $ vat claude org skills install --from-npm vibe-agent-toolkit@0.1.22-rc.3
  $ vat claude org skills install --from-npm vibe-agent-toolkit@0.1.22-rc.3 --skill org-admin
`);

	// delete
	const deleteCmd = new Command('delete');
	deleteCmd
		.description('Delete a skill from the organization')
		.argument(SKILL_ID_ARG, SKILL_ID_DESC)
		.option('--all', 'Auto-delete all versions before deleting the skill')
		.option('--debug', DEBUG_OPT_DESC)
		.action(async (skillId: string, options: { all?: boolean; debug?: boolean }) => {
			await executeOrgCommand('OrgSkillsDelete', options.debug, async ({ client, logger }) => {
				if (options.all) {
					// Fetch and delete all versions first
					const versions = await autopaginateSkills(client, `/v1/skills/${encodeURIComponent(skillId)}/versions`);
					const versionData = versions.data as Array<{ id: string; version: string }>;
					logger.info(`Deleting ${versionData.length} version(s) of ${skillId}`);
					for (const ver of versionData) {
						await client.deleteSkillVersion(skillId, ver.version);
						logger.info(`   Deleted version ${ver.version}`);
					}
				}

				logger.info(`Deleting skill: ${skillId}`);
				const result = await client.deleteSkill<{ id: string; type: string }>(skillId);
				return { id: result.id, deleted: result.type === 'skill_deleted' };
			});
		})
		.addHelpText('after', `
Description:
  Deletes a skill from the organization. Uses the Skills API (beta).
  Use --all to auto-delete all versions before the skill.
  Requires ANTHROPIC_API_KEY (regular key, not admin key).

Example:
  $ vat claude org skills delete skill_abc123 --all
`);

	// versions subgroup
	const versionsCmd = new Command('versions');
	versionsCmd.description('Manage skill versions').helpCommand(false);

	const versionsListCmd = new Command('list');
	versionsListCmd
		.description('List versions of a skill')
		.argument(SKILL_ID_ARG, SKILL_ID_DESC)
		.option('--debug', DEBUG_OPT_DESC)
		.action(async (skillId: string, options: { debug?: boolean }) => {
			await executeOrgCommand('OrgSkillsVersionsList', options.debug, async ({ client }) => {
				return autopaginateSkills(client, `/v1/skills/${encodeURIComponent(skillId)}/versions`);
			});
		})
		.addHelpText('after', `
Description:
  Lists all versions of a skill. Uses the Skills API (beta).
  Requires ANTHROPIC_API_KEY.

Example:
  $ vat claude org skills versions list skill_abc123
`);

	const versionsDeleteCmd = new Command('delete');
	versionsDeleteCmd
		.description('Delete a specific version of a skill')
		.argument(SKILL_ID_ARG, SKILL_ID_DESC)
		.argument('<version>', 'Version to delete')
		.option('--debug', DEBUG_OPT_DESC)
		.action(async (skillId: string, version: string, options: { debug?: boolean }) => {
			await executeOrgCommand('OrgSkillsVersionsDelete', options.debug, async ({ client, logger }) => {
				logger.info(`Deleting version ${version} of skill ${skillId}`);
				const result = await client.deleteSkillVersion<{ id: string; type: string }>(skillId, version);
				return { id: result.id, deleted: result.type === 'skill_version_deleted' };
			});
		})
		.addHelpText('after', `
Description:
  Deletes a specific version of a skill. Uses the Skills API (beta).
  All versions must be deleted before a skill can be deleted.
  Requires ANTHROPIC_API_KEY.

Example:
  $ vat claude org skills versions delete skill_abc123 1775007400733130
`);

	versionsCmd.addCommand(versionsListCmd);
	versionsCmd.addCommand(versionsDeleteCmd);

	command.addCommand(listCmd);
	command.addCommand(installCmd);
	command.addCommand(deleteCmd);
	command.addCommand(versionsCmd);

	return command;
}
