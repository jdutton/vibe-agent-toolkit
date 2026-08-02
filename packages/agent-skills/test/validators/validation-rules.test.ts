/**
 * Unit tests for validation rules and thresholds
 */

import picomatch from 'picomatch';
import { describe, expect, it } from 'vitest';

import {
	AGENT_INSTRUCTION_FILE_PATTERNS,
	createIssue,
	isAgentInstructionBasename,
	isNavigationBasename,
	isNeverPackagedBasename,
	NAVIGATION_FILE_PATTERNS,
	NEVER_PACKAGE_IN_SKILL_BUNDLE,
	toAnyDepthGlobs,
	VALIDATION_RULES,
	VALIDATION_THRESHOLDS,
} from '../../src/validators/validation-rules.js';

describe('VALIDATION_THRESHOLDS', () => {
	it('should have correct research-based thresholds', () => {
		expect(VALIDATION_THRESHOLDS.RECOMMENDED_SKILL_LINES).toBe(500);
		expect(VALIDATION_THRESHOLDS.MAX_TOTAL_LINES).toBe(2000);
		expect(VALIDATION_THRESHOLDS.MAX_FILE_COUNT).toBe(6);
		expect(VALIDATION_THRESHOLDS.MAX_REFERENCE_DEPTH).toBe(2);
		expect(VALIDATION_THRESHOLDS.MIN_DESCRIPTION_LENGTH).toBe(50);
	});
});

describe('NAVIGATION_FILE_PATTERNS', () => {
	it('should include common navigation file patterns', () => {
		expect(NAVIGATION_FILE_PATTERNS).toContain('README.md');
		expect(NAVIGATION_FILE_PATTERNS).toContain('index.md');
		expect(NAVIGATION_FILE_PATTERNS).toContain('toc.md');
		expect(NAVIGATION_FILE_PATTERNS).toContain('overview.md');
	});

	// Enumerating spellings provably cannot win: the list carried README.md/readme.md
	// but never `Readme.md`, the single most common real spelling. Matching is
	// case-insensitive now, so exactly ONE canonical spelling per name may appear —
	// a second spelling is dead weight that implies enumeration still matters.
	it('carries exactly one canonical spelling per name (matching is case-insensitive)', () => {
		const lowered = NAVIGATION_FILE_PATTERNS.map((p) => p.toLowerCase());
		expect(new Set(lowered).size).toBe(NAVIGATION_FILE_PATTERNS.length);
	});

	it('AGENT_INSTRUCTION_FILE_PATTERNS carries one canonical spelling per name too', () => {
		const lowered = AGENT_INSTRUCTION_FILE_PATTERNS.map((p) => p.toLowerCase());
		expect(new Set(lowered).size).toBe(AGENT_INSTRUCTION_FILE_PATTERNS.length);
	});
});

/**
 * On a case-insensitive filesystem (macOS APFS, Windows), `Claude.md` and
 * `claude.md` satisfy Claude Code's project-local instruction lookup exactly as
 * `CLAUDE.md` does — so a case-sensitive never-package list leaves the exact harm
 * the feature exists to prevent fully reachable.
 */
describe('never-package basename matchers (case-insensitive)', () => {
	const AGENT_INSTRUCTION_SPELLINGS = [
		'CLAUDE.md',
		'Claude.md',
		'claude.md',
		'CLAUDE.MD',
		'AGENTS.md',
		'Agents.md',
		'agents.md',
		'GEMINI.md',
		'gemini.md',
		'CLAUDE.local.md',
		'claude.local.md',
	];

	const NAVIGATION_SPELLINGS = [
		'README.md',
		'Readme.md',
		'ReadMe.md',
		'readme.md',
		'README.MD',
		'index.md',
		'Index.md',
		'INDEX.md',
		'toc.md',
		'TOC.md',
		'Toc.md',
		'overview.md',
		'Overview.md',
		'OVERVIEW.md',
	];

	const NOT_MATCHED = ['SKILL.md', 'notes.md', 'my-README.md', 'claude.md.bak', 'readme.txt'];

	it.each(AGENT_INSTRUCTION_SPELLINGS)('isAgentInstructionBasename(%s) is true', (name) => {
		expect(isAgentInstructionBasename(name)).toBe(true);
		expect(isNeverPackagedBasename(name)).toBe(true);
	});

	it.each(NAVIGATION_SPELLINGS)('isNavigationBasename(%s) is true', (name) => {
		expect(isNavigationBasename(name)).toBe(true);
		expect(isNeverPackagedBasename(name)).toBe(true);
	});

	it.each(NOT_MATCHED)('isNeverPackagedBasename(%s) is false', (name) => {
		expect(isNeverPackagedBasename(name)).toBe(false);
	});

	it('navigation files are not agent-instruction files (the two tiers stay separate)', () => {
		expect(isAgentInstructionBasename('README.md')).toBe(false);
		expect(isNavigationBasename('CLAUDE.md')).toBe(false);
	});
});

/**
 * The glob lane and the basename lane must never disagree — one matcher, two
 * spellings of the same answer. This test is the drift guard: if a future change
 * makes the globs case-sensitive again (or the Set), the two verdicts diverge here.
 */
describe('toAnyDepthGlobs', () => {
	const isNeverPackagedPath = picomatch(toAnyDepthGlobs(NEVER_PACKAGE_IN_SKILL_BUNDLE), { dot: true });

	const SPELLINGS = [
		'CLAUDE.md',
		'Claude.md',
		'claude.md',
		'AGENTS.md',
		'Agents.md',
		'GEMINI.md',
		'README.md',
		'Readme.md',
		'readme.md',
		'Index.md',
		'Overview.md',
	];

	it.each(SPELLINGS)('matches %s at the tree root', (name) => {
		expect(isNeverPackagedPath(name)).toBe(true);
	});

	it.each(SPELLINGS)('matches %s at any depth', (name) => {
		expect(isNeverPackagedPath(`docs/nested/${name}`)).toBe(true);
	});

	it.each(['SKILL.md', 'docs/notes.md', 'docs/my-README.md'])('does not match %s', (path) => {
		expect(isNeverPackagedPath(path)).toBe(false);
	});

	it('glob verdict and basename verdict agree for every spelling', () => {
		for (const name of [...SPELLINGS, 'SKILL.md', 'notes.md', 'my-README.md']) {
			expect(isNeverPackagedPath(name)).toBe(isNeverPackagedBasename(name));
		}
	});
});


describe('VALIDATION_RULES', () => {
	it('should define all required rules', () => {
		expect(VALIDATION_RULES.BROKEN_INTERNAL_LINK).toBeDefined();
		expect(VALIDATION_RULES.CIRCULAR_REFERENCE).toBeDefined();
		expect(VALIDATION_RULES.OUTSIDE_PROJECT_BOUNDARY).toBeDefined();
		expect(VALIDATION_RULES.WINDOWS_BACKSLASH_IN_PATH).toBeDefined();
		// FILENAME_COLLISION is NOT asserted here: it belongs to CODE_REGISTRY and
		// is emitted by the packager. Its coverage lives in skill-packager.test.ts.
	});

	it('should define all best practice rules', () => {
		expect(VALIDATION_RULES.SKILL_LENGTH_EXCEEDS_RECOMMENDED).toBeDefined();
		expect(VALIDATION_RULES.SKILL_TOTAL_SIZE_LARGE).toBeDefined();
		expect(VALIDATION_RULES.SKILL_TOO_MANY_FILES).toBeDefined();
		expect(VALIDATION_RULES.REFERENCE_TOO_DEEP).toBeDefined();
		expect(VALIDATION_RULES.LINKS_TO_NAVIGATION_FILES).toBeDefined();
		expect(VALIDATION_RULES.DESCRIPTION_TOO_VAGUE).toBeDefined();
		expect(VALIDATION_RULES.NO_PROGRESSIVE_DISCLOSURE).toBeDefined();
	});

	it('should have required rules with category "required"', () => {
		expect(VALIDATION_RULES.BROKEN_INTERNAL_LINK.category).toBe('required');
		expect(VALIDATION_RULES.CIRCULAR_REFERENCE.category).toBe('required');
		expect(VALIDATION_RULES.OUTSIDE_PROJECT_BOUNDARY.category).toBe('required');
	});

	it('should have best practice rules with category "best_practice"', () => {
		expect(VALIDATION_RULES.SKILL_LENGTH_EXCEEDS_RECOMMENDED.category).toBe('best_practice');
		expect(VALIDATION_RULES.SKILL_TOTAL_SIZE_LARGE.category).toBe('best_practice');
		expect(VALIDATION_RULES.SKILL_TOO_MANY_FILES.category).toBe('best_practice');
		expect(VALIDATION_RULES.REFERENCE_TOO_DEEP.category).toBe('best_practice');
	});

	it('should have message functions for all rules', () => {
		for (const rule of Object.values(VALIDATION_RULES)) {
			expect(rule.message).toBeTypeOf('function');
			const message = rule.message({});
			expect(message).toBeTypeOf('string');
			expect(message.length).toBeGreaterThan(0);
		}
	});

	it('should have fix strings for all rules', () => {
		for (const rule of Object.values(VALIDATION_RULES)) {
			expect(rule.fix).toBeTypeOf('string');
			expect(rule.fix.length).toBeGreaterThan(0);
		}
	});
});


describe('createIssue', () => {
	it('should create basic issue from rule', () => {
		const rule = VALIDATION_RULES.WINDOWS_BACKSLASH_IN_PATH;
		const issue = createIssue(rule);

		expect(issue.severity).toBe('error');
		expect(issue.code).toBe('WINDOWS_BACKSLASH_IN_PATH');
		expect(issue.message).toBe('Path uses Windows backslashes');
		expect(issue.fix).toBe('Use forward slashes for cross-platform compatibility');
	});

	it('should create issue with context variables', () => {
		const rule = VALIDATION_RULES.SKILL_LENGTH_EXCEEDS_RECOMMENDED;
		const issue = createIssue(rule, { lines: 750 });

		expect(issue.message).toBe('SKILL.md is 750 lines (recommended ≤500)');
	});

	it('should create issue with location', () => {
		const rule = VALIDATION_RULES.BROKEN_INTERNAL_LINK;
		const issue = createIssue(rule, { href: 'missing.md' }, '/path/to/SKILL.md');

		expect(issue.location).toBe('/path/to/SKILL.md');
		expect(issue.message).toBe('Link target not found: missing.md');
	});

	it('should handle multiple context variables', () => {
		const rule = VALIDATION_RULES.CIRCULAR_REFERENCE;
		const issue = createIssue(rule, { chain: 'A → B → C → A' });

		expect(issue.message).toBe('Circular reference detected: A → B → C → A');
	});

	it('should handle unknown context values gracefully', () => {
		const rule = VALIDATION_RULES.BROKEN_INTERNAL_LINK;
		const issue = createIssue(rule, {}); // Missing 'href' context

		expect(issue.message).toBe('Link target not found: unknown');
	});
});

describe('fix hints are framework-aware', () => {
	it('PACKAGED_UNREFERENCED_FILE fix names the removed ignoreValidationErrors field nowhere', () => {
		const rule = VALIDATION_RULES.PACKAGED_UNREFERENCED_FILE;
		expect(rule.fix).not.toMatch(/ignoreValidationErrors/);
	});

	// The remedy used to read "Allow via validation.allow if the file is consumed
	// programmatically" — which sent readers to hand-maintain a waiver list that
	// duplicates their own `files:` map, since a declared dest is exempt outright.
	// The text must point at `files:` and must not prescribe a waiver.
	it('PACKAGED_UNREFERENCED_FILE fix prescribes files:, not a validation.allow waiver', () => {
		const rule = VALIDATION_RULES.PACKAGED_UNREFERENCED_FILE;
		expect(rule.fix).toMatch(/\.files\b/);
		expect(rule.fix).not.toMatch(/Allow via validation\.allow/i);
	});
});

describe('Rule message context interpolation', () => {
	it('SKILL_TOTAL_SIZE_LARGE should show total lines', () => {
		const rule = VALIDATION_RULES.SKILL_TOTAL_SIZE_LARGE;
		const message = rule.message({ totalLines: 2500 });
		expect(message).toBe('Total skill size is 2500 lines (recommended ≤2000)');
	});

	it('SKILL_TOO_MANY_FILES should show file count', () => {
		const rule = VALIDATION_RULES.SKILL_TOO_MANY_FILES;
		const message = rule.message({ fileCount: 10 });
		expect(message).toBe('Skill includes 10 files (recommended ≤6)');
	});

	it('REFERENCE_TOO_DEEP should show depth in hops', () => {
		const rule = VALIDATION_RULES.REFERENCE_TOO_DEEP;
		const message = rule.message({ depth: 4 });
		expect(message).toBe('Link chain is 4 hops deep (recommended ≤2). Each linked file\'s own links create additional hops.');
	});

	it('LINKS_TO_NAVIGATION_FILES should show file list', () => {
		const rule = VALIDATION_RULES.LINKS_TO_NAVIGATION_FILES;
		const message = rule.message({ files: 'README.md, index.md' });
		expect(message).toBe('Links to navigation files: README.md, index.md');
	});

	it('DESCRIPTION_TOO_VAGUE should show length', () => {
		const rule = VALIDATION_RULES.DESCRIPTION_TOO_VAGUE;
		const message = rule.message({ length: 25 });
		expect(message).toBe('Description is 25 characters (recommended ≥50)');
	});

	it('NO_PROGRESSIVE_DISCLOSURE should show lines', () => {
		const rule = VALIDATION_RULES.NO_PROGRESSIVE_DISCLOSURE;
		const message = rule.message({ lines: 800 });
		expect(message).toBe('SKILL.md is 800 lines with no reference files');
	});
});
