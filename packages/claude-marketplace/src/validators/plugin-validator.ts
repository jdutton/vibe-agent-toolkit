/* eslint-disable security/detect-non-literal-fs-filename -- File paths are validated before use */
import { existsSync, readFileSync } from 'node:fs';

import { calculateValidationStatus, countBySeverity, type ValidationIssue } from '@vibe-agent-toolkit/agent-schema';
import {
	type AnchorRootOptions,
	detectKebabCaseViolation,
	detectMissingRecommendedFields,
	generateFixSuggestion,
	resolveAnchorRoot,
	type ValidationResult,
} from '@vibe-agent-toolkit/agent-skills';
import { issueLocation, safePath } from '@vibe-agent-toolkit/utils';

import { ClaudePluginSchema } from '../schemas/claude-plugin.js';

const PLUGIN_TYPE = 'claude-plugin' as const;

/**
 * Derive `status`, `summary` and `issueCounts` from ONE issue set.
 *
 * These three fields are three views of the same findings, so they are
 * computed together — maintaining them independently is how a result ends up
 * declaring `{errors: 0, warnings: 0, info: 0}` directly above the issues it
 * just reported.
 *
 * `summary` keys off `issues.length`, not `status === 'success'`: an
 * info-only set is `success` (see `calculateValidationStatus`) yet still has
 * findings to report.
 */
function summarizeIssues(
	issues: readonly ValidationIssue[]
): Pick<ValidationResult, 'issueCounts' | 'status' | 'summary'> {
	return {
		status: calculateValidationStatus(issues),
		summary: issues.length === 0 ? 'Valid plugin' : `Found ${issues.length} issue(s)`,
		issueCounts: countBySeverity(issues),
	};
}

/**
 * Apply schema-success post-checks: set metadata, warn on missing version,
 * and surface recommended-field observations. Mutates `issues` and
 * `validationResult` in place; callers re-use the computed status/summary.
 *
 * Extracted from `validatePlugin` to keep cognitive complexity under the
 * project threshold.
 */
function applyPostSchemaChecks(args: {
	/** Project-relative POSIX location of plugin.json (anchor contract). */
	pluginJsonLocation: string;
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
	const { pluginJsonLocation, data, strict, issues, validationResult } = args;

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
			location: pluginJsonLocation,
			fix: 'Add a "version" field to plugin.json (semver format, e.g. "1.0.0")',
		});
	}

	// Recommended-metadata observations from plugin-dev cross-walk.
	// These ship at info severity — schema parse already errored on
	// anything structurally required.
	issues.push(...detectMissingRecommendedFields(data, pluginJsonLocation));

	// Re-derive every summary field: this function has just pushed issues that
	// the caller's initial derivation could not have seen.
	Object.assign(validationResult, summarizeIssues(issues));
}

/**
 * Validate a plugin directory structure against the ClaudePluginSchema.
 *
 * @see https://code.claude.com/docs/en/plugins-reference — Official plugin manifest spec
 * @param pluginPath - Absolute path to plugin directory
 * @param options - `strict` raises recommended-field findings to errors;
 *   `locationRoot` is the anchor base for emitted locations (see
 *   {@link AnchorRootOptions}).
 * @returns Validation result with issues
 */
export async function validatePlugin(
	pluginPath: string,
	options?: { strict?: boolean } & AnchorRootOptions
): Promise<ValidationResult> {
	const issues: ValidationIssue[] = [];
	const pluginJsonPath = safePath.join(pluginPath, '.claude-plugin', 'plugin.json');
	// Anchor contract: relative to the run's ONE stated root, never absolute.
	const location = issueLocation(pluginJsonPath, resolveAnchorRoot(options?.locationRoot, pluginPath));

	// Check plugin.json exists
	if (!existsSync(pluginJsonPath)) {
		issues.push({
			severity: 'error',
			code: 'PLUGIN_MISSING_MANIFEST',
			message: 'Plugin manifest not found',
			location,
			fix: 'Create .claude-plugin/plugin.json with required fields (name, description, version)',
		});

		return {
			path: pluginPath,
			type: PLUGIN_TYPE,
			status: 'error',
			summary: 'Plugin manifest missing',
			issues,
			issueCounts: countBySeverity(issues),
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
			location,
			fix: 'Fix JSON syntax errors in plugin.json',
		});

		return {
			path: pluginPath,
			type: PLUGIN_TYPE,
			status: 'error',
			summary: 'Plugin manifest is invalid JSON',
			issues,
			issueCounts: countBySeverity(issues),
		};
	}

	// Pre-schema kebab-case observation. Fires alongside the schema-level
	// error so audit output names the violation specifically.
	if (typeof (pluginData as { name?: unknown } | null)?.name === 'string') {
		const kebabIssue = detectKebabCaseViolation(
			'plugin',
			(pluginData as { name: string }).name,
			location,
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
				location,
				field: zodIssue.path.join('.'),
				fix: generateFixSuggestion(zodIssue),
			});
		}
	}

	const validationResult: ValidationResult = {
		path: pluginPath,
		type: PLUGIN_TYPE,
		...summarizeIssues(issues),
		issues,
	};

	if (result.success) {
		applyPostSchemaChecks({
			pluginJsonLocation: location,
			data: result.data,
			strict: options?.strict === true,
			issues,
			validationResult,
		});
	}

	return validationResult;
}
