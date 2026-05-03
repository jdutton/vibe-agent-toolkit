/* eslint-disable security/detect-non-literal-fs-filename -- File paths are validated before use */
import { existsSync, readFileSync } from 'node:fs';

import {
	calculateValidationStatus,
	detectKebabCaseViolation,
	detectMissingRecommendedFields,
	generateFixSuggestion,
	type ValidationIssue,
	type ValidationResult,
} from '@vibe-agent-toolkit/agent-skills';
import { safePath } from '@vibe-agent-toolkit/utils';

import { ClaudePluginSchema } from '../schemas/claude-plugin.js';

const PLUGIN_TYPE = 'claude-plugin' as const;

interface FrontmatterNameReadResult {
	skillFrontmatterName?: string;
}

/**
 * Best-effort read of a co-located SKILL.md's frontmatter `name` field.
 *
 * Returns `{ skillFrontmatterName: undefined }` when SKILL.md is absent,
 * unreadable, has no frontmatter, or the frontmatter has no `name`. Silent
 * failure is intentional — the skill validator handles its own errors, and
 * this helper only exists to enable the plugin-side cross-check.
 *
 * Accepts a minimal YAML subset: only extracts `name: <value>` from the first
 * frontmatter block. Full YAML parsing is not needed here because the skill
 * validator already reports every frontmatter-parse failure separately.
 */
/**
 * Extract the YAML frontmatter block from file content, or undefined when
 * the content does not begin with a `---` fence.
 *
 * Uses indexOf instead of regex to avoid slow-regex lint errors.
 */
function extractFrontmatterBlock(content: string): string | undefined {
	// Normalize CRLF to LF so Windows-authored SKILL.md files parse identically.
	// Matches the convention in parsers/frontmatter-parser.ts.
	const normalized = content.replaceAll('\r\n', '\n');
	const FENCE = '---';
	if (!normalized.startsWith(`${FENCE}\n`)) {
		return undefined;
	}
	const openerEnd = FENCE.length + 1;
	const closerStart = normalized.indexOf(`\n${FENCE}`, openerEnd);
	return closerStart === -1 ? undefined : normalized.slice(openerEnd, closerStart);
}

/** Strip optional surrounding single or double quotes from a YAML scalar. */
function stripYamlQuotes(raw: string): string {
	if (raw.length >= 2) {
		const first = raw.at(0);
		const last = raw.at(-1);
		if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
			return raw.slice(1, -1);
		}
	}
	return raw;
}

function readColocatedSkillFrontmatterName(pluginDir: string): FrontmatterNameReadResult {
	const skillPath = safePath.join(pluginDir, 'SKILL.md');
	if (!existsSync(skillPath)) {
		return {};
	}

	let content: string;
	try {
		content = readFileSync(skillPath, 'utf-8');
	} catch {
		return {};
	}

	const frontmatter = extractFrontmatterBlock(content);
	if (frontmatter === undefined) {
		return {};
	}

	// Find the `name:` line using a non-backtracking line scan.
	const nameLine = frontmatter.split('\n').find((line) => line.startsWith('name:'));
	if (nameLine === undefined) {
		return {};
	}

	const raw = nameLine.slice('name:'.length).trim();
	if (raw.length === 0) {
		return {};
	}

	return { skillFrontmatterName: stripYamlQuotes(raw) };
}

/**
 * Return a SKILL_CLAUDE_PLUGIN_NAME_MISMATCH issue when the plugin's co-located
 * root SKILL.md has a `name` frontmatter field that disagrees with `pluginName`,
 * or undefined when the names agree or SKILL.md is absent / unreadable.
 */
function checkPluginSkillNameMismatch(
	pluginPath: string,
	pluginJsonPath: string,
	pluginName: string,
): ValidationIssue | undefined {
	const { skillFrontmatterName } = readColocatedSkillFrontmatterName(pluginPath);
	if (skillFrontmatterName === undefined || skillFrontmatterName === pluginName) {
		return undefined;
	}
	return {
		severity: 'warning',
		code: 'SKILL_CLAUDE_PLUGIN_NAME_MISMATCH',
		message: `plugin.json name "${pluginName}" does not match co-located SKILL.md frontmatter name "${skillFrontmatterName}"`,
		location: pluginJsonPath,
		fix: 'Align the names: update plugin.json `name` to match SKILL.md `name` (the skill is authoritative), or intentionally namespace the plugin (configure `validation.severity` or `validation.allow` with a reason).',
	};
}

/**
 * Apply schema-success post-checks: set metadata, warn on missing version,
 * and cross-check skill-claude-plugin name agreement. Mutates `issues` and
 * `validationResult` in place; callers re-use the computed status/summary.
 *
 * Extracted from `validatePlugin` to keep cognitive complexity under the
 * project threshold.
 */
function applyPostSchemaChecks(args: {
	pluginPath: string;
	pluginJsonPath: string;
	data: {
		name: string;
		version?: string | undefined;
		description?: unknown;
		license?: unknown;
		author?: unknown;
	};
	strict: boolean;
	issues: ValidationIssue[];
	validationResult: ValidationResult;
}): void {
	const { pluginPath, pluginJsonPath, data, strict, issues, validationResult } = args;

	validationResult.metadata = {
		name: data.name,
		...(data.version !== undefined && { version: data.version }),
	};

	// Warn when version is missing — Claude Code caches plugins by version,
	// and without it the cache directory becomes "unknown/", causing stale
	// skill resolution across upgrades.
	if (data.version === undefined) {
		issues.push({
			severity: strict ? 'error' : 'warning',
			code: 'PLUGIN_MISSING_VERSION',
			message: 'plugin.json missing version field — Claude Code will cache as "unknown/", causing stale skill resolution across upgrades',
			location: pluginJsonPath,
			fix: 'Add a "version" field to plugin.json (semver format, e.g. "1.0.0")',
		});
	}

	// Recommended-metadata observations from plugin-dev cross-walk.
	// These ship at info severity — schema parse already errored on
	// anything structurally required.
	issues.push(...detectMissingRecommendedFields(data, pluginJsonPath));

	const mismatchIssue = checkPluginSkillNameMismatch(pluginPath, pluginJsonPath, data.name);
	if (mismatchIssue !== undefined) {
		issues.push(mismatchIssue);
	}

	if (issues.length > 0) {
		validationResult.status = calculateValidationStatus(issues);
		validationResult.summary = `Found ${issues.length} issue(s)`;
	}
}

/**
 * Validate a plugin directory structure against the ClaudePluginSchema.
 *
 * @see https://code.claude.com/docs/en/plugins-reference — Official plugin manifest spec
 * @param pluginPath - Absolute path to plugin directory
 * @returns Validation result with issues
 */
export async function validatePlugin(
	pluginPath: string,
	options?: { strict?: boolean }
): Promise<ValidationResult> {
	const issues: ValidationIssue[] = [];
	const pluginJsonPath = safePath.join(pluginPath, '.claude-plugin', 'plugin.json');

	// Check plugin.json exists
	if (!existsSync(pluginJsonPath)) {
		issues.push({
			severity: 'error',
			code: 'PLUGIN_MISSING_MANIFEST',
			message: 'Plugin manifest not found',
			location: `${pluginPath}/.claude-plugin/plugin.json`,
			fix: 'Create .claude-plugin/plugin.json with required fields (name, description, version)',
		});

		return {
			path: pluginPath,
			type: PLUGIN_TYPE,
			status: 'error',
			summary: 'Plugin manifest missing',
			issues,
		};
	}

	// Parse and validate plugin.json
	let pluginData: unknown;
	try {
		const content = readFileSync(pluginJsonPath, 'utf-8');
		pluginData = JSON.parse(content);
	} catch (error) {
		issues.push({
			severity: 'error',
			code: 'PLUGIN_INVALID_JSON',
			message: `Failed to parse plugin.json: ${error instanceof Error ? error.message : 'Unknown error'}`,
			location: pluginJsonPath,
			fix: 'Fix JSON syntax errors in plugin.json',
		});

		return {
			path: pluginPath,
			type: PLUGIN_TYPE,
			status: 'error',
			summary: 'Plugin manifest is invalid JSON',
			issues,
		};
	}

	// Pre-schema kebab-case observation. Fires alongside the schema-level
	// error so audit output names the violation specifically.
	if (typeof (pluginData as { name?: unknown } | null)?.name === 'string') {
		const kebabIssue = detectKebabCaseViolation(
			'plugin',
			(pluginData as { name: string }).name,
			pluginJsonPath,
		);
		if (kebabIssue) {
			issues.push(kebabIssue);
		}
	}

	// Validate against schema
	const result = ClaudePluginSchema.safeParse(pluginData);
	if (!result.success) {
		for (const zodIssue of result.error.issues) {
			issues.push({
				severity: 'error',
				code: 'PLUGIN_INVALID_SCHEMA',
				message: zodIssue.message,
				location: `${pluginJsonPath}:${zodIssue.path.join('.')}`,
				fix: generateFixSuggestion(zodIssue),
			});
		}
	}

	const status = calculateValidationStatus(issues);

	const validationResult: ValidationResult = {
		path: pluginPath,
		type: PLUGIN_TYPE,
		status,
		summary:
			status === 'success' ? 'Valid plugin' : `Found ${issues.length} issue(s)`,
		issues,
	};

	if (result.success) {
		applyPostSchemaChecks({
			pluginPath,
			pluginJsonPath,
			data: result.data,
			strict: options?.strict === true,
			issues,
			validationResult,
		});
	}

	return validationResult;
}
