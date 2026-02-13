/**
 * Unit tests for frontmatter-validation.ts
 *
 * Focused on branches not covered by skill-validator.test.ts:
 * - XML tags in name field
 * - Empty/whitespace description
 * - Type guard edge cases (non-string name/description)
 * - Schema validation for VAT-generated skills
 */

import { describe, expect, it } from 'vitest';

import { validateFrontmatterRules, validateFrontmatterSchema } from '../../src/validators/frontmatter-validation.js';
import type { ValidationIssue } from '../../src/validators/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const LOC_FRONTMATTER_NAME = 'frontmatter.name';
const LOC_FRONTMATTER_DESC = 'frontmatter.description';

function findIssueByCode(issues: ValidationIssue[], code: string): ValidationIssue | undefined {
	return issues.find((i) => i.code === code);
}

function validFrontmatter(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { name: 'my-skill', description: 'Does something useful', ...overrides };
}

// ---------------------------------------------------------------------------
// validateFrontmatterSchema
// ---------------------------------------------------------------------------

describe('validateFrontmatterSchema', () => {
	describe('valid frontmatter', () => {
		it('should return no issues for valid frontmatter', () => {
			const issues = validateFrontmatterSchema(validFrontmatter(), false);
			expect(issues).toHaveLength(0);
		});

		it('should return no issues for valid VAT-generated frontmatter', () => {
			const issues = validateFrontmatterSchema(
				validFrontmatter({ metadata: { version: '1.0.0' } }),
				true,
			);
			expect(issues).toHaveLength(0);
		});
	});

	describe('missing required fields', () => {
		it('should report SKILL_MISSING_NAME when name is absent', () => {
			const issues = validateFrontmatterSchema({ description: 'Valid description' }, false);

			const issue = findIssueByCode(issues, 'SKILL_MISSING_NAME');
			expect(issue).toBeDefined();
			expect(issue?.severity).toBe('error');
			expect(issue?.location).toBe('frontmatter');
		});

		it('should report SKILL_MISSING_NAME when name is empty string', () => {
			const issues = validateFrontmatterSchema({ name: '', description: 'Valid' }, false);

			const issue = findIssueByCode(issues, 'SKILL_MISSING_NAME');
			expect(issue).toBeDefined();
		});

		it('should report SKILL_MISSING_DESCRIPTION when description is absent', () => {
			const issues = validateFrontmatterSchema({ name: 'my-skill' }, false);

			const issue = findIssueByCode(issues, 'SKILL_MISSING_DESCRIPTION');
			expect(issue).toBeDefined();
			expect(issue?.severity).toBe('error');
			expect(issue?.location).toBe('frontmatter');
		});

		it('should report SKILL_MISSING_DESCRIPTION when description is empty string', () => {
			const issues = validateFrontmatterSchema({ name: 'my-skill', description: '' }, false);

			const issue = findIssueByCode(issues, 'SKILL_MISSING_DESCRIPTION');
			expect(issue).toBeDefined();
		});
	});

	describe('invalid name format', () => {
		it('should report SKILL_NAME_INVALID for uppercase name', () => {
			const issues = validateFrontmatterSchema(validFrontmatter({ name: 'MySkill' }), false);

			const issue = findIssueByCode(issues, 'SKILL_NAME_INVALID');
			expect(issue).toBeDefined();
			expect(issue?.severity).toBe('error');
			expect(issue?.location).toBe(LOC_FRONTMATTER_NAME);
			expect(issue?.fix).toContain('lowercase');
		});

		it('should report SKILL_NAME_INVALID for name with spaces', () => {
			const issues = validateFrontmatterSchema(validFrontmatter({ name: 'my skill' }), false);

			const issue = findIssueByCode(issues, 'SKILL_NAME_INVALID');
			expect(issue).toBeDefined();
		});

		it('should report SKILL_NAME_INVALID for name starting with hyphen', () => {
			const issues = validateFrontmatterSchema(validFrontmatter({ name: '-my-skill' }), false);

			const issue = findIssueByCode(issues, 'SKILL_NAME_INVALID');
			expect(issue).toBeDefined();
		});
	});

	describe('description too long', () => {
		it('should report SKILL_DESCRIPTION_TOO_LONG when over 1024 chars', () => {
			const issues = validateFrontmatterSchema(
				validFrontmatter({ description: 'x'.repeat(1025) }),
				false,
			);

			const issue = findIssueByCode(issues, 'SKILL_DESCRIPTION_TOO_LONG');
			expect(issue).toBeDefined();
			expect(issue?.severity).toBe('error');
			expect(issue?.location).toBe(LOC_FRONTMATTER_DESC);
			expect(issue?.message).toContain('1025');
		});
	});

	describe('VAT-generated schema', () => {
		it('should return no mapped issues when VAT schema fails on unmapped fields', () => {
			// VAT schema requires metadata.version, but the mapper only handles
			// name/description fields, so unmapped errors produce no issues
			const issues = validateFrontmatterSchema(validFrontmatter(), true);
			expect(issues).toHaveLength(0);
		});

		it('should still detect name errors under VAT schema', () => {
			const issues = validateFrontmatterSchema(
				{ name: 'Invalid Name!', description: 'Valid', metadata: { version: '1.0.0' } },
				true,
			);

			const issue = findIssueByCode(issues, 'SKILL_NAME_INVALID');
			expect(issue).toBeDefined();
		});
	});
});

// ---------------------------------------------------------------------------
// validateFrontmatterRules
// ---------------------------------------------------------------------------

describe('validateFrontmatterRules', () => {
	describe('valid frontmatter', () => {
		it('should return no issues for valid frontmatter', () => {
			const issues = validateFrontmatterRules(validFrontmatter());
			expect(issues).toHaveLength(0);
		});
	});

	describe('reserved words in name', () => {
		it('should report SKILL_NAME_RESERVED_WORD for name containing "claude"', () => {
			const issues = validateFrontmatterRules(validFrontmatter({ name: 'claude-helper' }));

			const issue = findIssueByCode(issues, 'SKILL_NAME_RESERVED_WORD');
			expect(issue).toBeDefined();
			expect(issue?.severity).toBe('error');
			expect(issue?.location).toBe(LOC_FRONTMATTER_NAME);
		});

		it('should report SKILL_NAME_RESERVED_WORD for name containing "anthropic"', () => {
			const issues = validateFrontmatterRules(validFrontmatter({ name: 'anthropic-tools' }));

			const issue = findIssueByCode(issues, 'SKILL_NAME_RESERVED_WORD');
			expect(issue).toBeDefined();
		});

		it('should detect reserved words case-insensitively', () => {
			const issues = validateFrontmatterRules(validFrontmatter({ name: 'CLAUDE-Helper' }));

			const issue = findIssueByCode(issues, 'SKILL_NAME_RESERVED_WORD');
			expect(issue).toBeDefined();
		});
	});

	describe('XML tags in name', () => {
		it('should report SKILL_NAME_XML_TAGS when name contains angle brackets', () => {
			const issues = validateFrontmatterRules(validFrontmatter({ name: '<my-skill>' }));

			const issue = findIssueByCode(issues, 'SKILL_NAME_XML_TAGS');
			expect(issue).toBeDefined();
			expect(issue?.severity).toBe('error');
			expect(issue?.location).toBe(LOC_FRONTMATTER_NAME);
			expect(issue?.fix).toContain('Remove');
		});

		it('should report SKILL_NAME_XML_TAGS when name contains only <', () => {
			const issues = validateFrontmatterRules(validFrontmatter({ name: 'skill<name' }));

			const issue = findIssueByCode(issues, 'SKILL_NAME_XML_TAGS');
			expect(issue).toBeDefined();
		});

		it('should report SKILL_NAME_XML_TAGS when name contains only >', () => {
			const issues = validateFrontmatterRules(validFrontmatter({ name: 'skill>name' }));

			const issue = findIssueByCode(issues, 'SKILL_NAME_XML_TAGS');
			expect(issue).toBeDefined();
		});

		it('should report both XML tags and reserved word when both present', () => {
			const issues = validateFrontmatterRules(validFrontmatter({ name: '<claude>' }));

			expect(findIssueByCode(issues, 'SKILL_NAME_XML_TAGS')).toBeDefined();
			expect(findIssueByCode(issues, 'SKILL_NAME_RESERVED_WORD')).toBeDefined();
		});
	});

	describe('XML tags in description', () => {
		it('should report SKILL_DESCRIPTION_XML_TAGS when description contains tags', () => {
			const issues = validateFrontmatterRules(
				validFrontmatter({ description: '<b>bold</b> text' }),
			);

			const issue = findIssueByCode(issues, 'SKILL_DESCRIPTION_XML_TAGS');
			expect(issue).toBeDefined();
			expect(issue?.severity).toBe('error');
			expect(issue?.location).toBe(LOC_FRONTMATTER_DESC);
		});
	});

	describe('empty/whitespace description', () => {
		it('should report SKILL_DESCRIPTION_EMPTY for whitespace-only description', () => {
			const issues = validateFrontmatterRules(validFrontmatter({ description: '   ' }));

			const issue = findIssueByCode(issues, 'SKILL_DESCRIPTION_EMPTY');
			expect(issue).toBeDefined();
			expect(issue?.severity).toBe('error');
			expect(issue?.location).toBe(LOC_FRONTMATTER_DESC);
			expect(issue?.fix).toContain('Add description');
		});

		it('should report SKILL_DESCRIPTION_EMPTY for tab-only description', () => {
			const issues = validateFrontmatterRules(validFrontmatter({ description: '\t\t' }));

			const issue = findIssueByCode(issues, 'SKILL_DESCRIPTION_EMPTY');
			expect(issue).toBeDefined();
		});

		it('should report SKILL_DESCRIPTION_EMPTY for newline-only description', () => {
			const issues = validateFrontmatterRules(validFrontmatter({ description: '\n\n' }));

			const issue = findIssueByCode(issues, 'SKILL_DESCRIPTION_EMPTY');
			expect(issue).toBeDefined();
		});
	});

	describe('type guard edge cases (non-string values)', () => {
		it('should skip name validation when name is a number', () => {
			const issues = validateFrontmatterRules(validFrontmatter({ name: 42 }));

			// No name-related issues should be produced since the type guard skips non-strings
			const nameIssues = issues.filter((i) => i.code.startsWith('SKILL_NAME'));
			expect(nameIssues).toHaveLength(0);
		});

		it('should skip name validation when name is null', () => {
			const issues = validateFrontmatterRules(validFrontmatter({ name: null }));

			const nameIssues = issues.filter((i) => i.code.startsWith('SKILL_NAME'));
			expect(nameIssues).toHaveLength(0);
		});

		it('should skip name validation when name is undefined', () => {
			const issues = validateFrontmatterRules({ description: 'Valid description' });

			const nameIssues = issues.filter((i) => i.code.startsWith('SKILL_NAME'));
			expect(nameIssues).toHaveLength(0);
		});

		it('should skip name validation when name is a boolean', () => {
			const issues = validateFrontmatterRules(validFrontmatter({ name: true }));

			const nameIssues = issues.filter((i) => i.code.startsWith('SKILL_NAME'));
			expect(nameIssues).toHaveLength(0);
		});

		it('should skip description validation when description is a number', () => {
			const issues = validateFrontmatterRules(validFrontmatter({ description: 123 }));

			const descIssues = issues.filter((i) => i.code.startsWith('SKILL_DESCRIPTION'));
			expect(descIssues).toHaveLength(0);
		});

		it('should skip description validation when description is null', () => {
			const issues = validateFrontmatterRules(validFrontmatter({ description: null }));

			const descIssues = issues.filter((i) => i.code.startsWith('SKILL_DESCRIPTION'));
			expect(descIssues).toHaveLength(0);
		});

		it('should skip description validation when description is undefined', () => {
			const issues = validateFrontmatterRules({ name: 'my-skill' });

			const descIssues = issues.filter((i) => i.code.startsWith('SKILL_DESCRIPTION'));
			expect(descIssues).toHaveLength(0);
		});

		it('should skip description validation when description is an object', () => {
			const issues = validateFrontmatterRules(validFrontmatter({ description: { text: 'hello' } }));

			const descIssues = issues.filter((i) => i.code.startsWith('SKILL_DESCRIPTION'));
			expect(descIssues).toHaveLength(0);
		});

		it('should return no issues when both name and description are non-strings', () => {
			const issues = validateFrontmatterRules({ name: 42, description: false });

			expect(issues).toHaveLength(0);
		});
	});
});
