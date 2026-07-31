import type { z } from 'zod';

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
