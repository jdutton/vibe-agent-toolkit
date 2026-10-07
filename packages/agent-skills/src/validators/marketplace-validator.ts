import { readFileSync } from 'node:fs';

import { CODE_REGISTRY, type ValidationIssue } from '@vibe-agent-toolkit/schema';
import { isFilesystemAccessError, isPathAbsentError, issueLocation, promised, safePath } from '@vibe-agent-toolkit/utils';

import { MarketplaceManifestSchema } from '../schemas/marketplace-manifest.js';

import { type AnchorRootOptions, resolveAnchorRoot } from './anchor-root.js';
import { describeIssues } from './describe-issues.js';
import type { ValidationResult } from './types.js';
import { generateFixSuggestion } from './validation-utils.js';

const MARKETPLACE_TYPE = 'marketplace' as const;
const UNREADABLE_CODE = 'SCAN_PATH_UNREADABLE' as const;

/**
 * Validate a marketplace directory structure against the MarketplaceManifestSchema.
 *
 * @see https://code.claude.com/docs/en/plugins-reference — Official marketplace manifest spec
 * @param marketplacePath - Absolute path to marketplace directory
 * @param options - Anchor base for emitted locations (see {@link AnchorRootOptions})
 * @returns Validation result with issues
 */
export function validateMarketplace(
	marketplacePath: string,
	options?: AnchorRootOptions,
): Promise<ValidationResult> {
	return promised(() => validateMarketplaceNow(marketplacePath, options));
}

/** The synchronous body of {@link validateMarketplace}. */
function validateMarketplaceNow(marketplacePath: string, options?: AnchorRootOptions): ValidationResult {
	const issues: ValidationIssue[] = [];
	const marketplaceJsonPath = safePath.join(marketplacePath, '.claude-plugin', 'marketplace.json');
	// Anchor contract: relative to the run's ONE stated root, never absolute.
	const location = issueLocation(marketplaceJsonPath, resolveAnchorRoot(options?.locationRoot, marketplacePath));

	// One read decides all three outcomes. A separate `existsSync` would read a
	// refused parent as "absent", and one `try` around read + parse would read a
	// refused file as "invalid JSON" — both send the reader to the wrong fix.
	let content: string;
	try {
		content = readFileSync(marketplaceJsonPath, 'utf-8');
	} catch (error) {
		const halted = manifestReadFailure(error, location, {
			code: 'MARKETPLACE_MISSING_MANIFEST',
			message: 'Marketplace manifest not found',
			fix: 'Create .claude-plugin/marketplace.json with required fields (name, owner, plugins)',
		});
		issues.push(halted);
		return {
			path: marketplacePath,
			type: MARKETPLACE_TYPE,
			...describeIssues(issues, MARKETPLACE_TYPE, `Marketplace manifest ${halted.code === UNREADABLE_CODE ? 'unreadable' : 'missing'}`),
			issues,
		};
	}

	let marketplaceData: unknown;
	try {
		marketplaceData = JSON.parse(content);
	} catch (error) {
		issues.push({
			severity: 'error',
			code: 'MARKETPLACE_INVALID_JSON',
			message: `Failed to parse marketplace.json: ${error instanceof Error ? error.message : 'Unknown error'}`,
			location,
			fix: 'Fix JSON syntax errors in marketplace.json',
		});

		return {
			path: marketplacePath,
			type: MARKETPLACE_TYPE,
			...describeIssues(issues, MARKETPLACE_TYPE, 'Marketplace manifest is invalid JSON'),
			issues,
		};
	}

	// Validate against schema
	const result = MarketplaceManifestSchema.safeParse(marketplaceData);
	if (!result.success) {
		for (const zodIssue of result.error.issues) {
			issues.push({
				severity: 'error',
				code: 'MARKETPLACE_INVALID_SCHEMA',
				message: zodIssue.message,
				location,
				field: zodIssue.path.join('.'),
				fix: generateFixSuggestion(zodIssue),
			});
		}
	}

	const validationResult: ValidationResult = {
		path: marketplacePath,
		type: MARKETPLACE_TYPE,
		...describeIssues(issues, MARKETPLACE_TYPE),
		issues,
	};

	if (result.success) {
		validationResult.metadata = {
			name: result.data.name,
			...(result.data.description !== undefined && { description: result.data.description }),
			...(result.data.version !== undefined && { version: result.data.version }),
			// The denominator a consumer needs to judge a plugin walk: a string
			// `source` is a relative path into this marketplace's own tree, and the
			// consumer resolves it against the root it chose. Sources, not a count —
			// a count is satisfied by walking the WRONG directories.
			pluginEntries: result.data.plugins.length,
			localPluginSources: result.data.plugins.flatMap((entry) =>
				typeof entry.source === 'string' ? [{ name: entry.name, source: entry.source }] : [],
			),
		};
	}

	return validationResult;
}

/** The finding a manifest validator files when its manifest is absent. */
interface MissingManifestFinding {
	code: ValidationIssue['code'];
	message: string;
	fix: string;
}

/**
 * Classify a failed manifest read: absence (`ENOENT`, `ENOTDIR`) is the
 * validator's own "missing" finding; any other refusal the OS gave is
 * `SCAN_PATH_UNREADABLE` naming the errno — never the absolute path, which the
 * OS message carries and a published finding must not. Anything that is not a
 * filesystem refusal is a defect and is rethrown.
 *
 * Shared by every JSON manifest/registry validator in this package so the three
 * cannot drift on what counts as "missing" versus "unreadable".
 */
export function manifestReadFailure(
	error: unknown,
	location: string,
	missing: MissingManifestFinding,
): ValidationIssue {
	if (isPathAbsentError(error)) {
		return { severity: 'error', code: missing.code, message: missing.message, location, fix: missing.fix };
	}
	if (!isFilesystemAccessError(error)) {
		throw error;
	}
	const entry = CODE_REGISTRY.SCAN_PATH_UNREADABLE;
	const errno = (error as { code?: unknown }).code;
	return {
		severity: entry.defaultSeverity,
		code: UNREADABLE_CODE,
		message: `${entry.description} (${location}: read refused with ${String(errno)})`,
		location,
		fix: entry.fix,
		reference: entry.reference,
	};
}
