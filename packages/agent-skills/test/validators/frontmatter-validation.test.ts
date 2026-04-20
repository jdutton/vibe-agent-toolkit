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

import {
	detectExtraFrontmatterFields,
	validateFrontmatterRules,
	validateFrontmatterSchema,
} from '../../src/validators/frontmatter-validation.js';
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

	describe('optional name and description in base schema', () => {
		it('should not report issues when name is absent (optional)', () => {
			const issues = validateFrontmatterSchema({ description: 'Valid description' }, false);

			const issue = findIssueByCode(issues, 'SKILL_MISSING_NAME');
			expect(issue).toBeUndefined();
		});

		it('should report SKILL_MISSING_NAME when name is empty string', () => {
			const issues = validateFrontmatterSchema({ name: '', description: 'Valid' }, false);

			const issue = findIssueByCode(issues, 'SKILL_MISSING_NAME');
			expect(issue).toBeDefined();
		});

		it('should not report issues when description is absent (optional)', () => {
			const issues = validateFrontmatterSchema({ name: 'my-skill' }, false);

			const issue = findIssueByCode(issues, 'SKILL_MISSING_DESCRIPTION');
			expect(issue).toBeUndefined();
		});

		it('should report SKILL_MISSING_DESCRIPTION when description is empty string', () => {
			const issues = validateFrontmatterSchema({ name: 'my-skill', description: '' }, false);

			const issue = findIssueByCode(issues, 'SKILL_MISSING_DESCRIPTION');
			expect(issue).toBeDefined();
		});
	});

	describe('required name and description in VAT schema', () => {
		it('should report SKILL_MISSING_NAME when name is absent in VAT mode', () => {
			const issues = validateFrontmatterSchema(
				{ description: 'Valid', metadata: { version: '1.0.0' } },
				true,
			);

			const issue = findIssueByCode(issues, 'SKILL_MISSING_NAME');
			expect(issue).toBeDefined();
			expect(issue?.severity).toBe('error');
			expect(issue?.location).toBe('frontmatter');
		});

		it('should report SKILL_MISSING_DESCRIPTION when description is absent in VAT mode', () => {
			const issues = validateFrontmatterSchema(
				{ name: 'my-skill', metadata: { version: '1.0.0' } },
				true,
			);

			const issue = findIssueByCode(issues, 'SKILL_MISSING_DESCRIPTION');
			expect(issue).toBeDefined();
			expect(issue?.severity).toBe('error');
			expect(issue?.location).toBe('frontmatter');
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
		it('should report RESERVED_WORD_IN_NAME for name containing "claude"', () => {
			const issues = validateFrontmatterRules(validFrontmatter({ name: 'claude-helper' }));

			const issue = findIssueByCode(issues, 'RESERVED_WORD_IN_NAME');
			expect(issue).toBeDefined();
			expect(issue?.severity).toBe('warning');
			expect(issue?.location).toBe(LOC_FRONTMATTER_NAME);
		});

		it('should report RESERVED_WORD_IN_NAME for name containing "anthropic"', () => {
			const issues = validateFrontmatterRules(validFrontmatter({ name: 'anthropic-tools' }));

			const issue = findIssueByCode(issues, 'RESERVED_WORD_IN_NAME');
			expect(issue).toBeDefined();
		});

		it('should detect reserved words case-insensitively', () => {
			const issues = validateFrontmatterRules(validFrontmatter({ name: 'CLAUDE-Helper' }));

			const issue = findIssueByCode(issues, 'RESERVED_WORD_IN_NAME');
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
			expect(findIssueByCode(issues, 'RESERVED_WORD_IN_NAME')).toBeDefined();
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

	describe('SKILL_DESCRIPTION_OVER_CLAUDE_CODE_LIMIT', () => {
		it('should warn when description exceeds 250 characters', () => {
			const issues = validateFrontmatterRules(
				validFrontmatter({ description: 'x'.repeat(260) }),
			);

			const issue = findIssueByCode(issues, 'SKILL_DESCRIPTION_OVER_CLAUDE_CODE_LIMIT');
			expect(issue).toBeDefined();
			expect(issue?.severity).toBe('warning');
			expect(issue?.location).toBe(LOC_FRONTMATTER_DESC);
			expect(issue?.message).toContain('260');
		});

		it('should not warn at exactly 250 characters', () => {
			const issues = validateFrontmatterRules(
				validFrontmatter({ description: 'x'.repeat(250) }),
			);

			const issue = findIssueByCode(issues, 'SKILL_DESCRIPTION_OVER_CLAUDE_CODE_LIMIT');
			expect(issue).toBeUndefined();
		});
	});

	describe('SKILL_DESCRIPTION_FILLER_OPENER', () => {
		it('should warn on "This skill..." opener', () => {
			const issues = validateFrontmatterRules(
				validFrontmatter({ description: 'This skill processes PDF files' }),
			);

			const issue = findIssueByCode(issues, 'SKILL_DESCRIPTION_FILLER_OPENER');
			expect(issue).toBeDefined();
			expect(issue?.severity).toBe('warning');
		});

		it('should warn on "A skill that..." opener', () => {
			const issues = validateFrontmatterRules(
				validFrontmatter({ description: 'A skill that extracts data' }),
			);

			expect(findIssueByCode(issues, 'SKILL_DESCRIPTION_FILLER_OPENER')).toBeDefined();
		});

		it('should warn on "Use when you want to..." variant', () => {
			const issues = validateFrontmatterRules(
				validFrontmatter({ description: 'Use when you want to process files' }),
			);

			expect(findIssueByCode(issues, 'SKILL_DESCRIPTION_FILLER_OPENER')).toBeDefined();
		});

		it('should NOT warn on "Use when <concrete trigger>" pattern', () => {
			const issues = validateFrontmatterRules(
				validFrontmatter({
					description: 'Use when the user asks about PDF extraction or form filling',
				}),
			);

			expect(findIssueByCode(issues, 'SKILL_DESCRIPTION_FILLER_OPENER')).toBeUndefined();
		});

		it('should NOT warn on verb-phrase openers', () => {
			const issues = validateFrontmatterRules(
				validFrontmatter({ description: 'Extracts text and tables from PDFs' }),
			);

			expect(findIssueByCode(issues, 'SKILL_DESCRIPTION_FILLER_OPENER')).toBeUndefined();
		});
	});

	describe('SKILL_DESCRIPTION_WRONG_PERSON', () => {
		it('should warn on "I can..." first-person phrasing', () => {
			const issues = validateFrontmatterRules(
				validFrontmatter({ description: 'Processes PDFs. I can extract tables and forms.' }),
			);

			const issue = findIssueByCode(issues, 'SKILL_DESCRIPTION_WRONG_PERSON');
			expect(issue).toBeDefined();
			expect(issue?.severity).toBe('warning');
		});

		it('should warn on "You can..." second-person phrasing', () => {
			const issues = validateFrontmatterRules(
				validFrontmatter({ description: 'You can use this to extract tables from PDFs' }),
			);

			expect(findIssueByCode(issues, 'SKILL_DESCRIPTION_WRONG_PERSON')).toBeDefined();
		});

		it('should NOT warn on third-person phrasing', () => {
			const issues = validateFrontmatterRules(
				validFrontmatter({
					description: 'Extracts text and tables from PDFs for downstream processing',
				}),
			);

			expect(findIssueByCode(issues, 'SKILL_DESCRIPTION_WRONG_PERSON')).toBeUndefined();
		});

		it('should NOT match words like "Iowa" that contain "I" substring', () => {
			const issues = validateFrontmatterRules(
				validFrontmatter({
					description: 'Analyzes Iowa weather patterns and Ionic breeze reports',
				}),
			);

			expect(findIssueByCode(issues, 'SKILL_DESCRIPTION_WRONG_PERSON')).toBeUndefined();
		});
	});
});

// ---------------------------------------------------------------------------
// detectExtraFrontmatterFields (SKILL_FRONTMATTER_EXTRA_FIELDS)
// ---------------------------------------------------------------------------

describe('detectExtraFrontmatterFields', () => {
	it('returns no issues for standard agentskills.io fields', () => {
		const issues = detectExtraFrontmatterFields({
			name: 'my-skill',
			description: 'Desc',
			license: 'MIT',
			compatibility: 'any',
			metadata: { version: '1.0.0' },
		});
		expect(issues).toHaveLength(0);
	});

	it('returns no issues for standard Claude Code fields', () => {
		const issues = detectExtraFrontmatterFields({
			name: 'my-skill',
			description: 'Desc',
			'allowed-tools': 'Bash Edit',
			'argument-hint': '<path>',
			'disable-model-invocation': false,
			'user-invocable': true,
			model: 'sonnet',
			context: 'fork',
			agent: 'planner',
			hooks: { PostToolUse: {} },
		});
		expect(issues).toHaveLength(0);
	});

	it('fires for a single non-standard field', () => {
		const issues = detectExtraFrontmatterFields({
			name: 'my-skill',
			description: 'Desc',
			version: '1.0.0',
		});
		expect(issues).toHaveLength(1);
		const issue = findIssueByCode(issues, 'SKILL_FRONTMATTER_EXTRA_FIELDS');
		expect(issue).toBeDefined();
		expect(issue?.severity).toBe('warning');
		expect(issue?.message).toContain('version');
	});

	it('fires for every non-standard field', () => {
		const issues = detectExtraFrontmatterFields({
			name: 'my-skill',
			description: 'Desc',
			version: '1.0.0',
			customField: 'foo',
		});
		expect(issues).toHaveLength(2);
		const codes = issues.map((i) => i.code);
		expect(codes.every((c) => c === 'SKILL_FRONTMATTER_EXTRA_FIELDS')).toBe(true);
		const messages = issues.map((i) => i.message).join(' ');
		expect(messages).toContain('version');
		expect(messages).toContain('customField');
	});

	it('returns no issues for empty frontmatter', () => {
		const issues = detectExtraFrontmatterFields({});
		expect(issues).toHaveLength(0);
	});

	it('suggests metadata.* in the fix hint', () => {
		const issues = detectExtraFrontmatterFields({ extraThing: 'foo' });
		expect(issues).toHaveLength(1);
		const issue = findIssueByCode(issues, 'SKILL_FRONTMATTER_EXTRA_FIELDS');
		expect(issue?.fix).toContain('metadata');
	});
});
