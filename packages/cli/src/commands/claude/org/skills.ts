/**
 * `vat claude org skills` — manage organization skills via Skills API.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, basename } from 'node:path';

import { buildMultipartFormData } from '@vibe-agent-toolkit/claude-marketplace';
import type { MultipartFile } from '@vibe-agent-toolkit/claude-marketplace';
import { Command } from 'commander';

import { autopaginateSkills, executeOrgCommand } from './helpers.js';

const SKILL_ID_ARG = '<skill-id>';
const SKILL_ID_DESC = 'Skill ID (slug)';
const DEBUG_OPT_DESC = 'Enable debug logging';

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
	// Extract name field from YAML
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
		const fullPath = join(dir, entry.name);
		if (entry.isDirectory()) {
			results.push(...collectFiles(fullPath, base));
		} else {
			results.push({
				relativePath: relative(base, fullPath),
				absolutePath: fullPath,
			});
		}
	}

	return results;
}

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
		.description('Upload a skill to the organization via Skills API')
		.argument('<source>', 'Path to built skill directory or ZIP file')
		.option('--title <title>', 'Display title (defaults to SKILL.md name field)')
		.option('--debug', DEBUG_OPT_DESC)
		.action(async (source: string, options: { title?: string; debug?: boolean }) => {
			await executeOrgCommand('OrgSkillsInstall', options.debug, async ({ client, logger }) => {
				// Resolve source path
				const sourcePath = source.startsWith('/') ? source : join(process.cwd(), source);

				// eslint-disable-next-line security/detect-non-literal-fs-filename -- path from CLI arg, validated by user
				if (!existsSync(sourcePath)) {
					throw new Error(`Source not found: ${sourcePath}`);
				}

				// eslint-disable-next-line security/detect-non-literal-fs-filename -- path from CLI arg
				const stat = statSync(sourcePath);
				const isZip = !stat.isDirectory() && sourcePath.endsWith('.zip');

				let displayTitle: string;
				const files: MultipartFile[] = [];

				if (isZip) {
					// ZIP upload — send as single file, API auto-extracts
					displayTitle = options.title ?? basename(sourcePath, '.zip');
					// eslint-disable-next-line security/detect-non-literal-fs-filename -- path from CLI arg
					const zipContent = readFileSync(sourcePath);
					files.push({
						fieldName: 'files[]',
						filename: basename(sourcePath),
						content: zipContent,
					});
					logger.info(`Uploading ZIP: ${sourcePath} (${(zipContent.length / 1024).toFixed(1)}KB)`);
				} else if (stat.isDirectory()) {
					// Directory upload — send each file as separate files[] entry
					const skillMdPath = join(sourcePath, 'SKILL.md');
					// eslint-disable-next-line security/detect-non-literal-fs-filename -- derived from CLI arg
					if (!existsSync(skillMdPath)) {
						throw new Error(`SKILL.md not found in ${sourcePath}. Is this a built skill directory?`);
					}

					displayTitle = options.title ?? extractDisplayTitle(skillMdPath);

					// API requires files inside a top-level directory (e.g. skill_name/SKILL.md)
					const dirName = basename(sourcePath);
					const allFiles = collectFiles(sourcePath);
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
					logger.info(`Uploading directory: ${sourcePath} (${files.length} files, ${(totalSize / 1024).toFixed(1)}KB)`);
				} else {
					throw new Error(`Source must be a directory or .zip file: ${sourcePath}`);
				}

				logger.info(`Display title: ${displayTitle}`);

				const multipart = buildMultipartFormData(
					{ display_title: displayTitle },
					files,
				);

				const result = await client.uploadSkill<{
					id: string;
					type: string;
					display_title: string;
					latest_version: string;
					created_at: string;
				}>(multipart);

				return {
					id: result.id,
					displayTitle: result.display_title,
					version: result.latest_version,
					createdAt: result.created_at,
				};
			});
		})
		.addHelpText('after', `
Description:
  Uploads a skill to the organization via the Anthropic Skills API (beta).
  Accepts a built skill directory (with SKILL.md at root) or a ZIP file.
  Requires ANTHROPIC_API_KEY (regular key, not admin key).

  The display_title defaults to the "name" field from SKILL.md frontmatter.
  Use --title to override.

Example:
  $ vat claude org skills install dist/skills/org-admin
  $ vat claude org skills install my-skill.zip --title "My Custom Skill"
`);

	// delete
	const deleteCmd = new Command('delete');
	deleteCmd
		.description('Delete a skill from the organization')
		.argument(SKILL_ID_ARG, SKILL_ID_DESC)
		.option('--debug', DEBUG_OPT_DESC)
		.action(async (skillId: string, options: { debug?: boolean }) => {
			await executeOrgCommand('OrgSkillsDelete', options.debug, async ({ client, logger }) => {
				logger.info(`Deleting skill: ${skillId}`);
				const result = await client.deleteSkill<{ id: string; type: string }>(skillId);
				return { id: result.id, deleted: result.type === 'skill_deleted' };
			});
		})
		.addHelpText('after', `
Description:
  Deletes a skill from the organization. Uses the Skills API (beta).
  Requires ANTHROPIC_API_KEY (regular key, not admin key).

Example:
  $ vat claude org skills delete skill_abc123
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
