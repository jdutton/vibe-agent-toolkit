/**
 * Cross-skill dependency detection
 *
 * SKILL_CROSS_SKILL_AUTH_UNDECLARED — fires when SKILL.md body prose declares
 * a dependency on a sibling skill (backtick-wrapped `plugin:skill`) or on an
 * `ANTHROPIC_*_API_KEY` / `ANTHROPIC_*_KEY` environment variable but the
 * frontmatter `description` field does not name that dependency.
 *
 * Agents that load a skill by description alone must be able to see its
 * auth/pre-flight requirements without reading the body. When the dependency
 * is silent in the description, a sibling skill can be loaded in isolation
 * and fail mysteriously at runtime.
 *
 * The detector is narrow on purpose: false positives cost author attention,
 * so we only match the two explicit patterns where the author has already
 * stated the dependency in the body.
 */

import { CODE_REGISTRY } from './code-registry.js';
import type { ValidationIssue } from './types.js';

const DESCRIPTION_LOC = 'frontmatter.description';

/**
 * Backtick-wrapped skill reference, e.g. `plugin:skill-name` or
 * `plugin:namespaced-skill`. Plugin and skill parts are both kebab-case.
 * We require a colon so bare words like `` `scripts` `` don't match.
 */
const BACKTICK_SKILL_REF_RE = /`([a-z][a-z0-9-]*):([a-z][a-z0-9-]*)`/gi;

/**
 * ANTHROPIC_<ANYTHING>_API_KEY or ANTHROPIC_<ANYTHING>_KEY, e.g.
 * ANTHROPIC_ADMIN_API_KEY, ANTHROPIC_WORKBENCH_API_KEY, ANTHROPIC_ORG_KEY.
 * The generic `ANTHROPIC_API_KEY` (no segment) is intentionally excluded —
 * it is the universal default, not a cross-skill dependency.
 */
const ANTHROPIC_KEY_RE = /\bANTHROPIC_[A-Z][A-Z0-9_]*_(?:API_)?KEY\b/g;

/**
 * Phrases that introduce a dependency statement. Case-insensitive.
 * We look for the phrase within ~60 characters of the dependency token.
 */
const DEPENDENCY_INTRO_RE = /\b(requires?|depends?\s+on)\b/i;

const LOOKBEHIND_CHARS = 60;

/**
 * Build the set of description-recognizable shards for a sibling-skill
 * reference. For `plugin:vat-enterprise-org`, we accept the full skill
 * name (`vat-enterprise-org`) or the trailing segment without prefix
 * (`enterprise-org`).
 */
function siblingSkillShards(skill: string): string[] {
	const shards = new Set<string>([skill]);
	const dashIndex = skill.indexOf('-');
	if (dashIndex !== -1 && dashIndex + 1 < skill.length) {
		shards.add(skill.slice(dashIndex + 1));
	}
	return [...shards];
}

/**
 * Build the set of description-recognizable shards for an ANTHROPIC_*_KEY
 * environment variable. The full verbatim token plus a humanized phrase
 * (`admin api key` for `ANTHROPIC_ADMIN_API_KEY`).
 */
function envKeyShards(envKey: string): string[] {
	const shards = new Set<string>([envKey]);
	// Strip the ANTHROPIC_ prefix and the trailing _KEY / _API_KEY, then convert
	// to space-separated lowercase. ANTHROPIC_ADMIN_API_KEY -> "admin api key".
	const stripped = envKey.replace(/^ANTHROPIC_/, '').replace(/_KEY$/, '');
	if (stripped.length > 0) {
		const humanized = stripped.toLowerCase().replaceAll('_', ' ');
		// Re-attach "key" so the phrase reads naturally in a description.
		shards.add(`${humanized} key`);
	}
	return [...shards];
}

/**
 * Returns true when `description` contains at least one of the shards
 * (case-insensitive substring match). Empty shard list means no dependency
 * declaration is needed.
 */
function descriptionDeclaresAny(description: string, shards: readonly string[]): boolean {
	const lower = description.toLowerCase();
	return shards.some((shard) => lower.includes(shard.toLowerCase()));
}

/**
 * Returns true when the text surrounding `matchIndex` contains a
 * "requires" / "depends on" phrase within the lookback window.
 */
function hasDependencyIntro(body: string, matchIndex: number): boolean {
	const start = Math.max(0, matchIndex - LOOKBEHIND_CHARS);
	const window = body.slice(start, matchIndex);
	return DEPENDENCY_INTRO_RE.test(window);
}

/**
 * Scan body prose for backtick-wrapped `plugin:skill` references introduced
 * by a dependency phrase. Returns the distinct skill tokens found.
 */
function findSiblingSkillDependencies(body: string): string[] {
	const found = new Set<string>();
	for (const match of body.matchAll(BACKTICK_SKILL_REF_RE)) {
		const fullRef = match[0].slice(1, -1); // strip backticks
		if (hasDependencyIntro(body, match.index ?? 0)) {
			found.add(fullRef);
		}
	}
	return [...found];
}

/**
 * Scan body prose for ANTHROPIC_*_KEY env-var references introduced by a
 * dependency phrase. Returns the distinct env-var tokens found.
 */
function findEnvKeyDependencies(body: string): string[] {
	const found = new Set<string>();
	for (const match of body.matchAll(ANTHROPIC_KEY_RE)) {
		const envKey = match[0];
		// Bare ANTHROPIC_API_KEY is the universal default for Claude API, not a
		// cross-skill dependency signal. The regex above matches it because the
		// [A-Z][A-Z0-9_]* segment can greedily consume "API", leaving "_KEY" to
		// match with the optional (?:API_)? skipped. Skip it explicitly here so
		// the regex stays readable.
		if (envKey === 'ANTHROPIC_API_KEY') continue;
		if (hasDependencyIntro(body, match.index ?? 0)) {
			found.add(envKey);
		}
	}
	return [...found];
}

/**
 * Extract the skill name from a `plugin:skill` reference. Returns the
 * reference unchanged if no colon is present.
 */
function skillPartOfRef(ref: string): string {
	const colonIndex = ref.indexOf(':');
	return colonIndex === -1 ? ref : ref.slice(colonIndex + 1);
}

/**
 * Detect undeclared cross-skill auth / env-var dependencies.
 *
 * @param frontmatter - Parsed frontmatter (uses `description`).
 * @param bodyText - SKILL.md body text (post-frontmatter).
 * @returns One issue per undeclared dependency (deduplicated by token).
 */
export function detectUndeclaredCrossSkillAuth(
	frontmatter: Record<string, unknown>,
	bodyText: string,
): ValidationIssue[] {
	const description = frontmatter['description'];
	if (typeof description !== 'string' || description.trim() === '') {
		// Without a description we cannot judge whether the dependency is
		// declared; defer to SKILL_MISSING_DESCRIPTION / SKILL_DESCRIPTION_EMPTY.
		return [];
	}

	const issues: ValidationIssue[] = [];
	const registryEntry = CODE_REGISTRY.SKILL_CROSS_SKILL_AUTH_UNDECLARED;

	// Sibling-skill backtick refs
	for (const ref of findSiblingSkillDependencies(bodyText)) {
		const skillName = skillPartOfRef(ref);
		if (!descriptionDeclaresAny(description, siblingSkillShards(skillName))) {
			issues.push({
				severity: registryEntry.defaultSeverity,
				code: 'SKILL_CROSS_SKILL_AUTH_UNDECLARED',
				message: `Body declares a dependency on \`${ref}\` but the description does not mention "${skillName}".`,
				location: DESCRIPTION_LOC,
				fix: registryEntry.fix,
				reference: registryEntry.reference,
			});
		}
	}

	// ANTHROPIC_*_KEY env vars
	for (const envKey of findEnvKeyDependencies(bodyText)) {
		if (!descriptionDeclaresAny(description, envKeyShards(envKey))) {
			issues.push({
				severity: registryEntry.defaultSeverity,
				code: 'SKILL_CROSS_SKILL_AUTH_UNDECLARED',
				message: `Body declares a dependency on ${envKey} but the description does not mention it.`,
				location: DESCRIPTION_LOC,
				fix: registryEntry.fix,
				reference: registryEntry.reference,
			});
		}
	}

	return issues;
}
