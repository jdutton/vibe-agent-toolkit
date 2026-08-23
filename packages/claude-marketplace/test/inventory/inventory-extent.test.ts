/**
 * The inventory extent's TRANSLATION, at unit scale.
 *
 * The two-arm agreement lives in
 * `test/integration/inventory-extent-corpus.integration.test.ts`; this file pins
 * only what the declaration says, because the cascade ORDER and the conditional
 * gitignore rule are decisions a corpus shadow can pass over in silence — an
 * order is only observable where two rules catch one candidate, and a corpus
 * without gitignored link targets never reaches the fourth rule at all.
 */

import {
	AGENT_INSTRUCTION_FILE_PATTERNS,
	NAVIGATION_FILE_PATTERNS,
} from '@vibe-agent-toolkit/agent-skills';
import type { ExtentRefusalRule } from '@vibe-agent-toolkit/resources';
import { describe, expect, it } from 'vitest';

import {
	INVENTORY_EXTENT_KIND,
	INVENTORY_MAX_DEPTH,
	INVENTORY_REFUSED_AGENT_INSTRUCTION_FILE,
	INVENTORY_REFUSED_DIRECTORY_TARGET,
	INVENTORY_REFUSED_GITIGNORED,
	INVENTORY_REFUSED_NAVIGATION_FILE,
	InventorySkillExtentContributor,
	inventoryExtentContributorId,
	inventoryExtentDeclaration,
	inventoryExtentName,
} from '../../src/index.js';

/** The SKILL.md path, as the extractor would state it against the projection root. */
const SKILL_REL = 'skills/demo/SKILL.md';

/**
 * One expected refusal rule, with every matcher it does NOT use left at its
 * schema default.
 *
 * Written as a builder rather than four literal objects deliberately: a literal
 * expectation is a verbatim copy of the source's own array, which asserts that
 * the file equals itself and re-fails on every unrelated schema addition. Naming
 * only the matcher each rule actually uses is what makes the assertion say
 * something.
 */
function rule(
	label: string,
	matchers: Partial<Omit<ExtentRefusalRule, 'label'>>,
): ExtentRefusalRule {
	return { label, patterns: [], basenames: [], kinds: [], flags: {}, payload: null, ...matchers };
}

/** The labels of a declaration's cascade, in cascade order. */
function labelsOf(hasGitTracker: boolean): string[] {
	return inventoryExtentDeclaration(SKILL_REL, hasGitTracker).refusals.map((rule) => rule.label);
}

describe('inventoryExtentDeclaration', () => {
	it('reproduces collectLinkedFiles\'s walk options as a declaration', () => {
		const declaration = inventoryExtentDeclaration(SKILL_REL, true);
		expect(declaration).toEqual({
			kind: INVENTORY_EXTENT_KIND,
			closureFrom: SKILL_REL,
			// `maxDepth: Infinity` at the call site — the declaration's spelling of it.
			maxDepth: INVENTORY_MAX_DEPTH,
			follow: ['markdown-link', 'markdown-link-reference', 'markdown-definition'],
			// The schema default, materialized by `parse`. This lane reads hrefs the
			// way the walker does — RFC 3986 — and must NOT pick up Claude Code's
			// `@`-import dialect, which is declared only where an `@` token really is
			// an import.
			referenceDialect: 'href',
			refusals: [
				rule(INVENTORY_REFUSED_DIRECTORY_TARGET, { kinds: ['directory'] }),
				// Ungated, unlike the packaging translation: the call site passes the
				// literal `excludeNavigationFiles: true`.
				rule(INVENTORY_REFUSED_NAVIGATION_FILE, { basenames: [...NAVIGATION_FILE_PATTERNS] }),
				rule(INVENTORY_REFUSED_AGENT_INSTRUCTION_FILE, { basenames: [...AGENT_INSTRUCTION_FILE_PATTERNS] }),
				// The walker's gitignore branch is EXISTENCE-GATED, so the rule is a
				// conjunction over two columns and not a single-column match.
				rule(INVENTORY_REFUSED_GITIGNORED, { flags: { gitignored: true, exists: true } }),
			],
			// No `deferredArtifacts` at the call site means `refusesAgentInstructionFile`
			// short-circuits and refuses every one of them, so there is no hatch to model.
			admitPaths: [],
		});
	});

	it('omits the gitignore rule when the population has no oracle to fill the column', () => {
		// Omitted, not emitted-empty: `resource_realizations.gitignored` is false on
		// every row without a tracker, so a rule keyed on it would be a declared
		// branch that cannot run. The other three are unaffected.
		expect(labelsOf(false)).toEqual([
			INVENTORY_REFUSED_DIRECTORY_TARGET,
			INVENTORY_REFUSED_NAVIGATION_FILE,
			INVENTORY_REFUSED_AGENT_INSTRUCTION_FILE,
		]);
		expect(labelsOf(true)).toEqual([...labelsOf(false), INVENTORY_REFUSED_GITIGNORED]);
	});

	it('orders the cascade the way classifyExclusion orders its branches', () => {
		// The order IS the behaviour: first match wins and each rule carries its own
		// label, so a gitignored DIRECTORY must report `directory-target` — which is
		// what the walker does, its kind branch being first after the deferred check.
		const labels = labelsOf(true);
		expect(labels.indexOf(INVENTORY_REFUSED_DIRECTORY_TARGET)).toBeLessThan(
			labels.indexOf(INVENTORY_REFUSED_NAVIGATION_FILE),
		);
		expect(labels.indexOf(INVENTORY_REFUSED_NAVIGATION_FILE)).toBeLessThan(
			labels.indexOf(INVENTORY_REFUSED_AGENT_INSTRUCTION_FILE),
		);
		expect(labels.indexOf(INVENTORY_REFUSED_AGENT_INSTRUCTION_FILE)).toBeLessThan(
			labels.indexOf(INVENTORY_REFUSED_GITIGNORED),
		);
	});

	it('rejects a declaration with no root, rather than projecting an unrooted extent', () => {
		expect(() => inventoryExtentDeclaration('', true)).toThrow();
	});
});

describe('InventorySkillExtentContributor', () => {
	it('runs in the closure stratum under an inventory-specific id', () => {
		const contributor = new InventorySkillExtentContributor('demo');
		expect(contributor.stratum).toBe('closure');
		expect(contributor.kind).toBe(INVENTORY_EXTENT_KIND);
		expect(contributor.id).toBe(inventoryExtentContributorId('demo'));
	});

	it('names an extent that cannot collide with the packaging translation\'s', () => {
		// Both translations use kind `skill`, and an extent's context id is
		// `(kind, rootId, name)` — so the NAME is the only discriminator, and a
		// population holding both extents for one skill depends on this prefix.
		expect(inventoryExtentName('demo')).not.toBe('demo');
		expect(inventoryExtentName('demo')).toContain('demo');
	});
});
