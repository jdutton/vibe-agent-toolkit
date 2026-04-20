/**
 * Package-scope YAML-style mixing detection
 *
 * SKILL_DESCRIPTION_STYLE_MIXED_IN_PACKAGE — fires on every skill in a
 * package when the sibling skills' `description` frontmatter lines use a
 * mix of YAML scalar styles (folded, literal, inline-double,
 * inline-single, inline-plain).
 *
 * This detector operates on the RAW frontmatter bytes because the style
 * information is erased by YAML parsers. It is package-scoped: callers
 * must collect every sibling skill's raw content and invoke
 * `detectMixedDescriptionStyles` once.
 *
 * Status: detector implemented and unit-tested, not yet wired into the
 * validator pipeline (requires a package-level aggregation pass at the
 * CLI call site).
 */

import { CODE_REGISTRY } from './code-registry.js';
import type { ValidationIssue } from './types.js';

export type DescriptionYamlStyle =
	| 'folded'
	| 'literal'
	| 'inline-double'
	| 'inline-single'
	| 'inline-plain';

/** Match a `description:` line and capture the value portion. Bounded
 * character classes avoid the super-linear backtracking that
 * `sonarjs/slow-regex` flags on non-greedy `.*?` around `\s*`.
 */
const DESCRIPTION_LINE_RE = /^description:[ \t]*([^\n]*)/m;

/**
 * Classify the YAML scalar style used for the `description` frontmatter line
 * in raw SKILL.md content. Returns null when no description line is found.
 *
 * We inspect the raw marker because post-parse the original style is lost.
 */
export function classifyDescriptionYamlStyle(
	rawContent: string,
): DescriptionYamlStyle | null {
	const match = DESCRIPTION_LINE_RE.exec(rawContent);
	if (match === null) {
		return null;
	}
	const value = (match[1] ?? '').trim();

	if (value.startsWith('>')) {
		return 'folded';
	}
	if (value.startsWith('|')) {
		return 'literal';
	}
	if (value.startsWith('"')) {
		return 'inline-double';
	}
	if (value.startsWith("'")) {
		return 'inline-single';
	}
	if (value === '') {
		// `description:` on its own line with no marker means the next
		// line carries a block scalar we failed to match. Treat as
		// unclassified rather than guess.
		return null;
	}
	return 'inline-plain';
}

export interface DescriptionStyleInput {
	/** Absolute or repo-relative path — used for the issue location. */
	path: string;
	/** Raw SKILL.md content (bytes before YAML parse). */
	rawContent: string;
}

/**
 * Detect mixed YAML scalar styles across a package of sibling skills.
 *
 * When two or more distinct styles are observed, fires one warning per
 * skill that carried a classifiable style. Skills with no classifiable
 * description line are skipped rather than flagged.
 */
export function detectMixedDescriptionStyles(
	skills: readonly DescriptionStyleInput[],
): ValidationIssue[] {
	if (skills.length <= 1) {
		return [];
	}

	const perSkill: Array<{ path: string; style: DescriptionYamlStyle }> = [];
	const styles = new Set<DescriptionYamlStyle>();

	for (const skill of skills) {
		const style = classifyDescriptionYamlStyle(skill.rawContent);
		if (style === null) {
			continue;
		}
		perSkill.push({ path: skill.path, style });
		styles.add(style);
	}

	if (styles.size <= 1) {
		return [];
	}

	const registryEntry = CODE_REGISTRY.SKILL_DESCRIPTION_STYLE_MIXED_IN_PACKAGE;
	const sortedStyles = [...styles].sort((a, b) => a.localeCompare(b));
	const message = `Skill descriptions in this package use mixed YAML styles (${sortedStyles.join(', ')}); pick one for consistency.`;

	return perSkill.map(({ path }) => ({
		severity: registryEntry.defaultSeverity,
		code: 'SKILL_DESCRIPTION_STYLE_MIXED_IN_PACKAGE' as const,
		message,
		location: path,
		fix: registryEntry.fix,
		reference: registryEntry.reference,
	}));
}
