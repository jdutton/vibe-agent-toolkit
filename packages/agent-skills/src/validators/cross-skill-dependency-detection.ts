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
 *
 * The text half (a backtick-wrapped `plugin:skill` ref or an
 * `ANTHROPIC_*_KEY` with a "requires" / "depends on" phrase in the 60
 * characters before it, each distinct token once, refs then keys) is the
 * skill-text core's `crossSkillAuth` family (over the whole file) and
 * `crossSkillAuthBody` family (over the frontmatter parser's body) in
 * `@vibe-agent-toolkit/resources`. The comparison against `description` is
 * judgement, and stays here.
 */

import type { SkillTextFacts } from '@vibe-agent-toolkit/resources';
import { CODE_REGISTRY, type ValidationIssue } from '@vibe-agent-toolkit/schema';

import { recordsOf } from './skill-text-records.js';


/** Document-internal pointer — belongs in `ValidationIssue.field`, not `location`. */
const DESCRIPTION_FIELD = 'frontmatter.description';

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
 * @param facts - The document's skill-text record.
 * @param family - Which scan the lane reads: `crossSkillAuth` (the whole file,
 *   frontmatter included — the packaging lane) or `crossSkillAuthBody` (the
 *   frontmatter parser's body — the skill lane).
 * @param location - Project-relative POSIX path of the containing SKILL.md.
 * @returns One issue per undeclared dependency (deduplicated by token).
 */
export function detectUndeclaredCrossSkillAuth(
	frontmatter: Readonly<Record<string, unknown>>,
	facts: SkillTextFacts,
	family: 'crossSkillAuth' | 'crossSkillAuthBody',
	location: string,
): ValidationIssue[] {
	const description = frontmatter['description'];
	if (typeof description !== 'string' || description.trim() === '') {
		// Without a description we cannot judge whether the dependency is
		// declared; defer to SKILL_MISSING_DESCRIPTION / SKILL_DESCRIPTION_EMPTY.
		return [];
	}

	const issues: ValidationIssue[] = [];
	const registryEntry = CODE_REGISTRY.SKILL_CROSS_SKILL_AUTH_UNDECLARED;
	const undeclared = (message: string): ValidationIssue => ({
		severity: registryEntry.defaultSeverity,
		code: 'SKILL_CROSS_SKILL_AUTH_UNDECLARED',
		message,
		location,
		field: DESCRIPTION_FIELD,
		fix: registryEntry.fix,
		reference: registryEntry.reference,
	});

	// Sibling-skill backtick refs, then ANTHROPIC_*_KEY env vars: the core's order.
	for (const { patternId, matchText: token } of recordsOf(facts, family)) {
		if (patternId === 'sibling-skill-ref') {
			const skillName = skillPartOfRef(token);
			if (!descriptionDeclaresAny(description, siblingSkillShards(skillName))) {
				issues.push(undeclared(`Body declares a dependency on \`${token}\` but the description does not mention "${skillName}".`));
			}
		} else if (!descriptionDeclaresAny(description, envKeyShards(token))) {
			issues.push(undeclared(`Body declares a dependency on ${token} but the description does not mention it.`));
		}
	}

	return issues;
}
