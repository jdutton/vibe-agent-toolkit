/**
 * Unit tests for validation rules and thresholds
 */

import { describe, expect, it } from 'vitest';

import {
	createIssue,
	isOverridable,
	NAVIGATION_FILE_PATTERNS,
	NON_OVERRIDABLE_RULES,
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

	it('should include case-insensitive variants', () => {
		expect(NAVIGATION_FILE_PATTERNS).toContain('readme.md');
		expect(NAVIGATION_FILE_PATTERNS).toContain('INDEX.md');
		expect(NAVIGATION_FILE_PATTERNS).toContain('TOC.md');
		expect(NAVIGATION_FILE_PATTERNS).toContain('OVERVIEW.md');
	});
});

describe('NON_OVERRIDABLE_RULES', () => {
	it('should mark required rules as non-overridable', () => {
		expect(NON_OVERRIDABLE_RULES).toContain('INVALID_FRONTMATTER');
		expect(NON_OVERRIDABLE_RULES).toContain('MISSING_NAME');
		expect(NON_OVERRIDABLE_RULES).toContain('RESERVED_WORD_IN_NAME');
		expect(NON_OVERRIDABLE_RULES).toContain('BROKEN_INTERNAL_LINK');
		expect(NON_OVERRIDABLE_RULES).toContain('CIRCULAR_REFERENCE');
		expect(NON_OVERRIDABLE_RULES).toContain('OUTSIDE_PROJECT_BOUNDARY');
		expect(NON_OVERRIDABLE_RULES).toContain('FILENAME_COLLISION');
		expect(NON_OVERRIDABLE_RULES).toContain('WINDOWS_BACKSLASH_IN_PATH');
	});

	it('should not include best practice rules', () => {
		expect(NON_OVERRIDABLE_RULES).not.toContain('SKILL_LENGTH_EXCEEDS_RECOMMENDED');
		expect(NON_OVERRIDABLE_RULES).not.toContain('SKILL_TOTAL_SIZE_LARGE');
		expect(NON_OVERRIDABLE_RULES).not.toContain('SKILL_TOO_MANY_FILES');
		expect(NON_OVERRIDABLE_RULES).not.toContain('REFERENCE_TOO_DEEP');
	});
});

describe('VALIDATION_RULES', () => {
	it('should define all required rules', () => {
		expect(VALIDATION_RULES.INVALID_FRONTMATTER).toBeDefined();
		expect(VALIDATION_RULES.MISSING_NAME).toBeDefined();
		expect(VALIDATION_RULES.RESERVED_WORD_IN_NAME).toBeDefined();
		expect(VALIDATION_RULES.BROKEN_INTERNAL_LINK).toBeDefined();
		expect(VALIDATION_RULES.CIRCULAR_REFERENCE).toBeDefined();
		expect(VALIDATION_RULES.OUTSIDE_PROJECT_BOUNDARY).toBeDefined();
		expect(VALIDATION_RULES.FILENAME_COLLISION).toBeDefined();
		expect(VALIDATION_RULES.WINDOWS_BACKSLASH_IN_PATH).toBeDefined();
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
		expect(VALIDATION_RULES.INVALID_FRONTMATTER.category).toBe('required');
		expect(VALIDATION_RULES.MISSING_NAME.category).toBe('required');
		expect(VALIDATION_RULES.RESERVED_WORD_IN_NAME.category).toBe('required');
		expect(VALIDATION_RULES.BROKEN_INTERNAL_LINK.category).toBe('required');
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

describe('isOverridable', () => {
	it('should return false for required rules', () => {
		expect(isOverridable('INVALID_FRONTMATTER')).toBe(false);
		expect(isOverridable('MISSING_NAME')).toBe(false);
		expect(isOverridable('RESERVED_WORD_IN_NAME')).toBe(false);
		expect(isOverridable('BROKEN_INTERNAL_LINK')).toBe(false);
		expect(isOverridable('CIRCULAR_REFERENCE')).toBe(false);
		expect(isOverridable('OUTSIDE_PROJECT_BOUNDARY')).toBe(false);
		expect(isOverridable('FILENAME_COLLISION')).toBe(false);
		expect(isOverridable('WINDOWS_BACKSLASH_IN_PATH')).toBe(false);
	});

	it('should return true for best practice rules', () => {
		expect(isOverridable('SKILL_LENGTH_EXCEEDS_RECOMMENDED')).toBe(true);
		expect(isOverridable('SKILL_TOTAL_SIZE_LARGE')).toBe(true);
		expect(isOverridable('SKILL_TOO_MANY_FILES')).toBe(true);
		expect(isOverridable('REFERENCE_TOO_DEEP')).toBe(true);
		expect(isOverridable('LINKS_TO_NAVIGATION_FILES')).toBe(true);
		expect(isOverridable('DESCRIPTION_TOO_VAGUE')).toBe(true);
		expect(isOverridable('NO_PROGRESSIVE_DISCLOSURE')).toBe(true);
	});
});

describe('createIssue', () => {
	it('should create basic issue from rule', () => {
		const rule = VALIDATION_RULES.MISSING_NAME;
		const issue = createIssue(rule);

		expect(issue.severity).toBe('error');
		expect(issue.code).toBe('MISSING_NAME');
		expect(issue.message).toBe('Skill must have a name (frontmatter, H1, or filename)');
		expect(issue.fix).toBe('Add name to frontmatter: name: my-skill');
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
