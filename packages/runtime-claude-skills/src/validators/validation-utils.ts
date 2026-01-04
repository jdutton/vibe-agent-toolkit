import type { z } from 'zod';

import type { ValidationIssue } from './types.js';

/**
 * Calculate validation status from issues
 *
 * @param issues - Array of validation issues
 * @returns Status based on issue severity
 */
export function calculateValidationStatus(
	issues: ValidationIssue[],
): 'success' | 'warning' | 'error' {
	if (issues.length === 0) {
		return 'success';
	}
	if (issues.some((i) => i.severity === 'error')) {
		return 'error';
	}
	return 'warning';
}

/**
 * Generate fix suggestion from Zod error
 *
 * @param zodIssue - Zod validation issue
 * @returns Human-readable fix suggestion
 */
export function generateFixSuggestion(zodIssue: z.ZodIssue): string {
	const field = zodIssue.path.join('.');

	if (zodIssue.code === 'invalid_type') {
		return `Change '${field}' to ${zodIssue.expected} type`;
	}

	if (zodIssue.code === 'too_small' && zodIssue.type === 'string') {
		return `Provide a value for '${field}'`;
	}

	if (zodIssue.code === 'invalid_string' && zodIssue.validation === 'regex') {
		return `Fix '${field}' format to match expected pattern`;
	}

	return `Fix '${field}' to meet schema requirements`;
}
