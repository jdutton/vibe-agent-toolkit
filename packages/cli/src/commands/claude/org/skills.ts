/**
 * `vat claude org skills` — manage organization skills via Skills API.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import {   basename } from 'node:path';

import { evalSuiteUnitPath, readDeclaredSkillName } from '@vibe-agent-toolkit/agent-skills';
import { buildMultipartFormData } from '@vibe-agent-toolkit/claude-marketplace';
import type { MultipartFile, OrgApiClient } from '@vibe-agent-toolkit/claude-marketplace';
import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { Command } from 'commander';

import { resolveSkillPackagingConfig } from '../../../skill-resolution/packaging-config.js';
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
 * The name a SKILL.md declares, which is both the uploaded skill's display
 * title and the top-level directory the API keys it by.
 */
function requireDeclaredName(skillMdPath: string): string {
	const declared = readDeclaredSkillName(skillMdPath);
	if (declared === undefined) {
		throw new Error(
			`SKILL.md has no usable frontmatter "name" field: ${skillMdPath}`,
		);
	}
	return declared;
}

/**
 * Directories never uploaded to the organization, at any depth, by NAME.
 *
 * `evals/` is the conventional home of a skill's eval suite — its answer key.
 * A correctly built skill directory (what this command documents as its input)
 * never contains one, because the packager excludes declared test input; this
 * is the backstop for the easy mistake of pointing the uploader at the *source*
 * tree instead, where the suite does live. The invariant is "a published skill
 * carries no answer key", not "…none when the operator remembered to build".
 *
 * The name match alone cannot uphold that invariant, because the suite's
 * location is the ADOPTER's to declare (`skills.config.<name>.test.evals`;
 * `evals/evals.json` is only the default). It stays as the unconditional
 * fail-safe for the case where no config is discoverable at all — a fetched
 * artifact, an extracted tarball, a tree outside any VAT project — where there
 * is no declaration to read and the convention is the only thing left to honor.
 * The declared location is resolved separately, in
 * {@link declaredTestInputPaths}, and the two are unioned.
 *
 * This lane is deliberately BROADER than the packager, which excludes exactly
 * `<skill-root>/evals` and never guesses from a name (see test-input.ts). Here
 * a mistaken input is the entire scenario and the blast radius is an org-wide
 * publish, so over-withholding a directory literally named `evals` is the cheap
 * error and it is reported rather than silent.
 *
 * `node_modules`/`.git` are development detritus that has no meaning inside a
 * published skill and would silently bloat the multipart payload.
 */
const NEVER_UPLOADED_DIR_NAMES = new Set(['evals', 'node_modules', '.git']);

interface CollectedUploadFiles {
	files: Array<{ relativePath: string; absolutePath: string }>;
	/**
	 * Relative paths of everything deliberately withheld — a directory, or the
	 * single file of a suite declared at the skill root — so the skip is never
	 * silent. Under-reporting here is worse than the leak itself: it would
	 * affirmatively tell the operator nothing was held back.
	 */
	excluded: string[];
}

/**
 * The absolute path of this skill's DECLARED eval suite, when its governing VAT
 * config declares one, as a set of paths to withhold.
 *
 * Resolution is anchored on the DIRECTORY ARGUMENT, not on a governing config
 * being present: `resolveSkillPackagingConfig` walks up from the given skill dir
 * to its nearest-ancestor `vibe-agent-toolkit.config.yaml` — the same walk-up
 * `vat audit`, `vat skill review`, and skill-reference resolution use — and
 * returns `null` when there is none or the skill is not declared there. That is
 * exactly what this backstop needs: the scenario it exists for is an operator
 * pointing at a source tree by mistake, and a source tree sits inside its own
 * project, so the declaration is right there to be read. Requiring a governing
 * config instead would refuse to protect the fetched-artifact case at all, and
 * `null` here is not a failure — it falls through to the name-based fail-safe.
 *
 * `evalSuiteUnitPath` is the shared definition of the suite UNIT (the directory
 * holding `evals.json` and its `fixtures/`, or the single file for a suite at
 * the skill root) and yields `undefined` for a suite that lives outside the
 * skill dir — nothing inside the tree to withhold.
 */
async function declaredTestInputPaths(skillDir: string): Promise<ReadonlySet<string>> {
	const config = await resolveSkillPackagingConfig(safePath.join(skillDir, 'SKILL.md'));
	const declared = config?.test?.evals;
	if (declared === undefined) return new Set();
	const unit = evalSuiteUnitPath(safePath.resolve(skillDir), declared);
	return unit === undefined ? new Set() : new Set([unit]);
}

/**
 * Collect the files under a skill directory that should be uploaded,
 * recursively, returning relative paths alongside what was deliberately left
 * out.
 */
function collectFiles(
	dir: string,
	base: string,
	testInput: ReadonlySet<string>,
	collected: CollectedUploadFiles,
): void {
	// eslint-disable-next-line security/detect-non-literal-fs-filename -- dir from CLI arg
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const fullPath = safePath.join(dir, entry.name);
		const relativePath = safePath.relative(base, fullPath);

		if (
			testInput.has(safePath.resolve(fullPath))
			|| (entry.isDirectory() && NEVER_UPLOADED_DIR_NAMES.has(entry.name))
		) {
			collected.excluded.push(relativePath);
			continue;
		}

		if (entry.isDirectory()) {
			collectFiles(fullPath, base, testInput, collected);
		} else {
			collected.files.push({ relativePath, absolutePath: fullPath });
		}
	}
}

/**
 * Collect the upload payload for a skill directory. Exported for testing.
 *
 * Resolves the declared test-input paths itself rather than accepting them, so
 * no caller can obtain an upload set with the exclusion skipped.
 */
export async function collectSkillUploadFiles(skillDir: string): Promise<CollectedUploadFiles> {
	const collected: CollectedUploadFiles = { files: [], excluded: [] };
	collectFiles(skillDir, skillDir, await declaredTestInputPaths(skillDir), collected);
	return collected;
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

	// The skill's own declared name — not the directory it happens to sit in,
	// which for a built or extracted tree carries no reliable identity.
	const declaredName = requireDeclaredName(skillMdPath);
	const displayTitle = titleOverride ?? declaredName;

	// API requires files inside a top-level directory (e.g. skill_name/SKILL.md)
	const dirName = declaredName;
	const collected = await collectSkillUploadFiles(skillDir);
	const files: MultipartFile[] = [];

	for (const file of collected.files) {
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
	for (const excluded of collected.excluded) {
		logger.info(`   Excluded from upload: ${excluded} (never published with a skill)`);
	}

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

  The skill uploads under the "name" its SKILL.md frontmatter declares, which
  is also the default display_title.

  A skill's eval suite is its answer key and is never uploaded: whatever the
  governing vibe-agent-toolkit.config.yaml declares as this skill's test input
  (skills.config.<name>.test.evals) is withheld, and so is any evals/ directory
  when no config is discoverable. node_modules/ and .git/ are never uploaded
  either. Each exclusion is reported in the output.

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
