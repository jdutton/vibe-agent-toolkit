import { readFileSync } from 'node:fs';

import {
	type AnchorRootOptions,
	describeIssues,
	detectHostedIncompatibleShape,
	detectKebabCaseViolation,
	detectMissingRecommendedFields,
	detectPackagedAgentInstructionFiles,
	generateFixSuggestion,
	resolveAnchorRoot,
	type ValidationResult,
} from '@vibe-agent-toolkit/agent-skills';
import { CODE_REGISTRY, type ValidationIssue } from '@vibe-agent-toolkit/schema';
import { isFilesystemAccessError, isPathAbsentError, issueLocation, safePath } from '@vibe-agent-toolkit/utils';

import { ClaudePluginSchema } from '../schemas/claude-plugin.js';

const PLUGIN_TYPE = 'claude-plugin' as const;

/**
 * Apply schema-success post-checks: set metadata, warn on missing version,
 * and surface recommended-field observations. Mutates `issues` and
 * `validationResult` in place; callers re-use the computed status/description/summary.
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
	Object.assign(validationResult, describeIssues(issues, PLUGIN_TYPE));
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
	const anchorRoot = resolveAnchorRoot(options?.locationRoot, pluginPath);
	const location = issueLocation(pluginJsonPath, anchorRoot);

	// Repo-internal agent guidance sitting beside plugin.json. No link points at
	// it and plugin artifacts are exempt from the skill orphan rules, so this scan
	// is the only thing that sees it.
	//
	// `pluginPath` is whatever tree the caller handed us, and the two are NOT the
	// same claim: an INSTALLED plugin (the dominant `vat audit` population — no VAT
	// config, no `files:` entry anywhere) is a distributed artifact, so the file
	// demonstrably shipped; a plugin SOURCE directory in an adopter's repo is not,
	// because `vat build`'s tree-copy now excludes these basenames at any depth and
	// a `files:` glob filters them out of its matches. The finding fires for both
	// (the file IS in the scanned tree); the remediation must not prescribe deleting
	// a file the build already excludes — see PACKAGED_AGENT_INSTRUCTION_FILE's
	// registry entry, which states both lanes.
	// No declared dests: this lane inspects a plugin TREE, and a plugin has no
	// `files:` block of its own — the per-skill `files:` config that could sanction
	// a dest lives in the project config the SKILL lanes read. `[]` is the honest
	// answer here, not a defaulted one.
	issues.push(...detectPackagedAgentInstructionFiles(pluginPath, anchorRoot, []));

	// One read decides missing / unreadable / unparseable: `existsSync` would read
	// a refused parent as absent, and one `try` around read + parse would report a
	// refused file as invalid JSON — each with a fix the reader cannot act on.
	let content: string;
	try {
		content = readFileSync(pluginJsonPath, 'utf-8');
	} catch (error) {
		const halted = pluginManifestReadIssue(error, location);
		issues.push(halted);
		const headline = halted.code === 'PLUGIN_MISSING_MANIFEST' ? 'missing' : 'unreadable';
		return {
			path: pluginPath,
			type: PLUGIN_TYPE,
			...describeIssues(issues, PLUGIN_TYPE, `Plugin manifest ${headline}`),
			issues,
		};
	}

	let pluginData: unknown;
	try {
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
			...describeIssues(issues, PLUGIN_TYPE, 'Plugin manifest is invalid JSON'),
			issues,
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

	// Directory-shape check. Independent of manifest contents, so it runs whether
	// or not the schema parsed. Deliberately NOT escalated by `strict`: the
	// hosted-sync behaviour it reports is observed, not documented by Anthropic,
	// and `bin/` remains a supported CLI feature — see plugin-hosted-shape.ts.
	issues.push(...detectHostedIncompatibleShape(pluginPath, anchorRoot));

	const validationResult: ValidationResult = {
		path: pluginPath,
		type: PLUGIN_TYPE,
		...describeIssues(issues, PLUGIN_TYPE),
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

/**
 * The finding for a `plugin.json` read that threw: absence is
 * `PLUGIN_MISSING_MANIFEST`; any other OS refusal is `SCAN_PATH_UNREADABLE`
 * naming only the errno (the OS message carries the absolute path); anything
 * else is a defect and propagates.
 */
function pluginManifestReadIssue(error: unknown, location: string): ValidationIssue {
	if (isPathAbsentError(error)) {
		return {
			severity: 'error',
			code: 'PLUGIN_MISSING_MANIFEST',
			message: 'Plugin manifest not found',
			location,
			fix: 'Create .claude-plugin/plugin.json with required fields (name, description, version)',
		};
	}
	if (!isFilesystemAccessError(error)) throw error;
	const { defaultSeverity, description, fix, reference } = CODE_REGISTRY.SCAN_PATH_UNREADABLE;
	const errno = String((error as { code?: unknown }).code);
	return { severity: defaultSeverity, code: 'SCAN_PATH_UNREADABLE', message: `${description} (${location}: read refused with ${errno})`, location, fix, reference };
}
