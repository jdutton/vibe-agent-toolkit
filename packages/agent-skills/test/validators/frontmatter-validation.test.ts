/**
 * Unit tests for frontmatter-validation.ts
 *
 * Focused on branches not covered by skill-validator.test.ts:
 * - XML tags in name field
 * - Empty/whitespace description
 * - Type guard edge cases (non-string name/description)
 * - Schema validation for VAT-generated skills
 */

import vm from 'node:vm';

import type { ValidationIssue } from '@vibe-agent-toolkit/schema';
import { describe, expect, it } from 'vitest';

import {
	XML_TAG_SCAN_PATTERNS,
	detectExtraFrontmatterFields,
	validateFrontmatterRules as validateFrontmatterRulesIn,
	validateFrontmatterSchema as validateFrontmatterSchemaIn,
} from '../../src/validators/frontmatter-validation.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Dotted document-internal pointers live in `ValidationIssue.field`; the file
 * they point INTO lives in `location`. Both entry points now take that file, so
 * these thin wrappers supply one fixture location for every case below.
 */
const FIELD_FRONTMATTER = 'frontmatter';
const FIELD_FRONTMATTER_NAME = 'frontmatter.name';
const FIELD_FRONTMATTER_DESC = 'frontmatter.description';
const SKILL_LOCATION = 'skills/demo/SKILL.md';

function validateFrontmatterSchema(
	frontmatter: Record<string, unknown>,
	isVATGenerated: boolean,
): ValidationIssue[] {
	return validateFrontmatterSchemaIn(frontmatter, isVATGenerated, SKILL_LOCATION);
}

function validateFrontmatterRules(frontmatter: Record<string, unknown>): ValidationIssue[] {
	return validateFrontmatterRulesIn(frontmatter, SKILL_LOCATION);
}

function findIssueByCode(issues: ValidationIssue[], code: string): ValidationIssue | undefined {
	return issues.find((i) => i.code === code);
}

/**
 * Assert one issue was emitted for `code` with the given severity and anchored
 * at `field` INSIDE {@link SKILL_LOCATION}, and return it for any further
 * case-specific assertions.
 *
 * Every case below checks the same four things, so they live here rather than
 * as a four-line block repeated thirty times (which the duplication gate
 * rightly rejects — and which made the anchor split invisible in the diff).
 */
function expectIssueAt(
	issues: ValidationIssue[],
	code: string,
	severity: ValidationIssue['severity'],
	field: string,
): ValidationIssue | undefined {
	const issue = findIssueByCode(issues, code);
	expect(issue).toBeDefined();
	expect(issue?.severity).toBe(severity);
	expect(issue?.field).toBe(field);
	expect(issue?.location).toBe(SKILL_LOCATION);
	return issue;
}

function validFrontmatter(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { name: 'my-skill', description: 'Does something useful', ...overrides };
}

/**
 * How long a shipped pattern may run before the harness calls it runaway.
 *
 * A wall-clock literal, and justified rather than inherited. What it separates
 * is categorical, not marginal: on 400k characters the worst shipped pattern
 * measures 10.4 ms idle and 18.8 ms under ten CPU burners, while a pattern with
 * polynomial backtracking takes minutes on the same input and an exponential one
 * never returns. Backtracking defects do not arrive as a 2× slowdown, so 500 ms
 * is ~27× headroom on a contended machine and still nowhere near a runaway. It
 * also costs nothing when it passes — only a FAILING pattern spends it.
 *
 * A scaling assertion (time grows sub-quadratically across sizes) was measured
 * and REJECTED as the oracle: interleaved, min-of-5 and min-of-7, over 4× and 8×
 * size spans, it returned ratios from 4.9 to 27.9 against a linear ideal of 4–8
 * under load — it would fail green builds at any threshold that still separates
 * quadratic. A scan that costs single-digit milliseconds cannot be timed
 * relatively on a shared runner. Do not reinstate it without new measurements.
 */
const COMPLETION_DEADLINE_MS = 500;

/**
 * The deadline for the two positive controls. They are PAID in full every run —
 * the pattern is deliberately runaway, so the harness always waits this out — so
 * it is small. Any deadline works: a catastrophic pattern blows all of them.
 */
const CONTROL_DEADLINE_MS = 25;

/**
 * Exhaust one regex over `input`. Runs as a STRING inside a vm context because
 * only code compiled in that context is subject to the timeout below.
 */
const SCAN_SOURCE = `(() => {
	const re = new RegExp(source, flags);
	if (!re.global) { re.test(input); return; }
	re.lastIndex = 0;
	let match;
	while ((match = re.exec(input)) !== null) {
		if (match[0].length === 0) re.lastIndex += 1;
	}
})()`;

const deadlineContext = vm.createContext({});

/**
 * Run `pattern` over `input` under a deadline V8 enforces by TERMINATING
 * execution. A runaway regex ignores every JS-level timer — it never yields —
 * so `vi.useFakeTimers`, `testTimeout` and a trailing `performance.now()`
 * assertion all fail to fire and the process simply hangs. `node:vm`'s timeout
 * is enforced by a watchdog thread outside the JS stack, so it interrupts the
 * backtracking itself and the caller gets an assertable value back.
 *
 * The regex is rebuilt from `source`/`flags` inside the context: identical
 * matching semantics, and nothing crosses the realm boundary but strings.
 */
function runPatternUnderDeadline(
	pattern: RegExp,
	input: string,
	timeout: number,
): 'completed' | 'timed out' {
	Object.assign(deadlineContext, { source: pattern.source, flags: pattern.flags, input });
	try {
		// eslint-disable-next-line sonarjs/code-eval -- SCAN_SOURCE is a module-local constant; the only values crossing into the context are the pattern's own source/flags and the test's input string. Compiling IN the context is what makes the timeout below enforceable.
		vm.runInContext(SCAN_SOURCE, deadlineContext, { timeout });
		return 'completed';
	} catch (error) {
		// Structural, not `instanceof Error`: the termination error is constructed in
		// the vm's own realm, so it fails a cross-realm prototype check.
		if ((error as { code?: string } | null)?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
			return 'timed out';
		}
		throw error;
	}
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

			expectIssueAt(issues, 'SKILL_MISSING_NAME', 'error', FIELD_FRONTMATTER);
		});

		it('should report SKILL_MISSING_DESCRIPTION when description is absent in VAT mode', () => {
			const issues = validateFrontmatterSchema(
				{ name: 'my-skill', metadata: { version: '1.0.0' } },
				true,
			);

			expectIssueAt(issues, 'SKILL_MISSING_DESCRIPTION', 'error', FIELD_FRONTMATTER);
		});
	});

	describe('invalid name format', () => {
		it('should report SKILL_NAME_INVALID for uppercase name', () => {
			const issues = validateFrontmatterSchema(validFrontmatter({ name: 'MySkill' }), false);

			const issue = expectIssueAt(issues, 'SKILL_NAME_INVALID', 'error', FIELD_FRONTMATTER_NAME);
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

			const issue = expectIssueAt(issues, 'SKILL_DESCRIPTION_TOO_LONG', 'error', FIELD_FRONTMATTER_DESC);
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

			expectIssueAt(issues, 'RESERVED_WORD_IN_NAME', 'warning', FIELD_FRONTMATTER_NAME);
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

			const issue = expectIssueAt(issues, 'SKILL_NAME_XML_TAGS', 'error', FIELD_FRONTMATTER_NAME);
			expect(issue?.fix).toContain('Remove');
		});

		it.each([
			['a lone <', 'skill<name'],
			['a lone >', 'skill>name'],
			['a generic-type identifier', 'list<item>'],
		])('should NOT report SKILL_NAME_XML_TAGS for %s (%s)', (_label, name) => {
			const issues = validateFrontmatterRules(validFrontmatter({ name }));

			expect(findIssueByCode(issues, 'SKILL_NAME_XML_TAGS')).toBeUndefined();
		});

		it('should report both XML tags and reserved word when both present', () => {
			const issues = validateFrontmatterRules(validFrontmatter({ name: '<claude>' }));

			expect(findIssueByCode(issues, 'SKILL_NAME_XML_TAGS')).toBeDefined();
			expect(findIssueByCode(issues, 'RESERVED_WORD_IN_NAME')).toBeDefined();
		});
	});

	describe('XML tags in description', () => {
		// The vendor rule is "Cannot contain XML tags" — a tag, not an angle bracket.
		// Lane 1: unambiguous markup. It fires wherever it sits, backticks included.
		it.each([
			['an opening/closing pair', '<b>bold</b> text'],
			['a closing tag after a word', 'Ends the prompt</instructions>'],
			['a self-closing tag', 'Line one<br/> line two'],
			['a self-closing tag with a space', 'Insert <br /> between items'],
			['a tag with an attribute', 'Renders <div class="x">content'],
			['a tag at the very start', '<test>content</test>'],
			['an HTML comment', 'Contains an <!-- injected --> comment'],
			['a processing instruction', 'Starts with <?xml version="1.0"?>'],
			['a CDATA section', 'Contains <![CDATA[payload]]> text'],
			['a doctype', 'Opens with <!DOCTYPE html> first'],
			// A naive backtick pairing makes this ONE code span and strips the tag with
			// it; a stray or odd backtick must never exempt real markup.
			['markup swallowed by a stray backtick pair', 'Backtick ` then <b>x</b> and a final `'],
			['markup fully wrapped in backticks', 'Explains `<b>bold</b>` markup'],
		])('should report SKILL_DESCRIPTION_XML_TAGS for %s', (_label, description) => {
			const issues = validateFrontmatterRules(validFrontmatter({ description }));

			expectIssueAt(issues, 'SKILL_DESCRIPTION_XML_TAGS', 'error', FIELD_FRONTMATTER_DESC);
		});

		// Lane 2: a bare `<word>`, which is indistinguishable from a placeholder. It
		// fires unless it reads as part of a path or identifier — the reading that
		// keeps real tags firing — and backticking it is the documented remedy.
		it.each([
			['a standalone opening tag', 'Wrap input in <example> blocks'],
			['a namespaced tag', 'Emits <xsl:template> nodes'],
			['a tag in parentheses', 'Handles markup (<note>) inline'],
			['an unquoted placeholder standing alone as a token', 'Run vat build <dir> to package'],
			['a placeholder standing alone inside quotes', 'Use when the user says "deploy to <env>"'],
			// The old `(?![/\\])` lookahead let ANY tag escape by putting a slash after
			// it; a slash only reads as a path when a literal segment follows.
			['a tag followed by a slash and another tag', 'Emits <example>/<example> pairs'],
			// The old lookbehind let a tag glued to the preceding word escape. A word
			// character AFTER `>` is the tell: a compound token ends in punctuation.
			['a tag glued between two words', 'Renders in<thinking>mode here'],
		])('should report SKILL_DESCRIPTION_XML_TAGS for %s', (_label, description) => {
			const issues = validateFrontmatterRules(validFrontmatter({ description }));

			expectIssueAt(issues, 'SKILL_DESCRIPTION_XML_TAGS', 'error', FIELD_FRONTMATTER_DESC);
		});

		it.each([
			[
				'the claude-plugins-official example-plugin description (path placeholder)',
				'Demonstrates the `skills/<name>/SKILL.md` layout',
			],
			['a path placeholder outside backticks', 'Reads skills/<name>/SKILL.md files'],
			['a placeholder followed by a path separator', 'Reads <name>/SKILL.md files'],
			['a backticked placeholder', 'Run `vat build <dir>` to package'],
			['a backticked bare tag', 'Explains the `<example>` convention'],
			['a backticked identifier template', 'Use when reviewing a PR `<owner>/<repo>#<n>`'],
			['a placeholder continuing an identifier', 'Use when reviewing a PR acme/widgets#<n>'],
			['a comparison with spaces', 'Warns when a < b'],
			['a comparison without spaces', 'Warns when x<y'],
			// `<y and y>` has an attribute run with no assignment in it, so it is prose
			// inside angle brackets, not a tag.
			['a two-sided comparison', 'Use when x <y and y> z'],
			['a URL inside angle brackets', 'Docs <see https://docs.example.com> explain it'],
			['an arrow', 'Maps input -> output'],
			['a fat arrow', 'Maps input => output'],
			['less-or-equal', 'Keeps size <= 10'],
			['greater-or-equal', 'Keeps size >= 10'],
			['a generic type', 'Returns Promise<Result> values'],
			['a heredoc marker', 'Supports cat << EOF input'],
			['a lone greater-than', 'Pipes output > file'],
		])('should NOT report SKILL_DESCRIPTION_XML_TAGS for %s', (_label, description) => {
			const issues = validateFrontmatterRules(validFrontmatter({ description }));

			expect(findIssueByCode(issues, 'SKILL_DESCRIPTION_XML_TAGS')).toBeUndefined();
		});

		it('should tell the author to backtick an ambiguous placeholder', () => {
			const issues = validateFrontmatterRules(
				validFrontmatter({ description: 'Use when deploying to <env> today' }),
			);

			const issue = findIssueByCode(issues, 'SKILL_DESCRIPTION_XML_TAGS');
			expect(issue?.fix).toContain('backticks');
		});
	});

	// -------------------------------------------------------------------------
	// Backtracking guard
	//
	// Catastrophic backtracking blocks the event loop, so vitest's testTimeout
	// cannot fire and any `performance.now()` assertion AFTER the scan is never
	// reached: the run hangs until the CI job is killed, with no failing test
	// name. Every scan below therefore runs inside `node:vm` under a timeout,
	// which V8 enforces by terminating execution from a watchdog thread — a
	// deadline that can actually interrupt a runaway regex.
	//
	// ESLint refuses BOTH runaway shapes at the desk (`sonarjs/slow-regex` and
	// `security/detect-unsafe-regex` for a nested quantifier,
	// `sonarjs/super-linear-regex` for two adjacent overlapping stars) — each
	// verified by mutating ANGLE_GROUP into that shape. This guard is not a claim
	// that the linter is blind; it measures BEHAVIOUR on real adversarial input,
	// where the linter reasons about shape, and it is what makes a miss arrive as
	// a named failure rather than as a job timeout. The two `reports a timeout`
	// cases are its positive controls: without them, every assertion here would
	// also pass if the deadline never fired.
	// -------------------------------------------------------------------------
	describe('backtracking guard', () => {
		it.each([
			['unclosed tag openers', '<a '.repeat(34_000)],
			['nested openers', '<'.repeat(100_000)],
			['one long unterminated attribute run', `<a ${'x '.repeat(50_000)}`],
			['a self-closing near miss', `<a ${'/'.repeat(100_000)}`],
			['an unterminated backtick run', `\`${'<a '.repeat(34_000)}`],
			['one unterminated tag name', `<a${'x'.repeat(100_000)}`],
			['alternating groups', '<a>/'.repeat(25_000)],
		])('completes every shipped pattern on 100k chars of %s', (_label, input) => {
			for (const pattern of XML_TAG_SCAN_PATTERNS) {
				expect(runPatternUnderDeadline(pattern, input, COMPLETION_DEADLINE_MS)).toBe('completed');
			}
		});

		it('reports a timeout instead of hanging on EXPONENTIAL backtracking', () => {
			// A nested quantifier. On 64 characters it runs for longer than this
			// machine will exist; the harness has to come back with a value anyway.
			// eslint-disable-next-line sonarjs/slow-regex, security/detect-unsafe-regex -- deliberately catastrophic: this test asserts the HARNESS reports it. Both rules firing here is the proof that the shape is refused at the desk too; never copy it into src.
			const exponential = /<(?:[\w.:-]+)*>/;

			expect(runPatternUnderDeadline(exponential, `<${'a'.repeat(64)}!`, CONTROL_DEADLINE_MS)).toBe(
				'timed out',
			);
		});

		it('reports a timeout instead of hanging on POLYNOMIAL backtracking', () => {
			// Two ADJACENT overlapping stars — star height 1, quadratic in the length
			// of an unterminated group. This is the shape ANGLE_GROUP deliberately
			// avoids by letting `[^<>]*` be its only quantifier.
			// eslint-disable-next-line sonarjs/super-linear-regex -- deliberately quadratic: this test asserts the HARNESS reports it. This is exactly the shape ANGLE_GROUP would have had with a name class in front of `[^<>]*`; never copy it into src.
			const quadratic = /<[A-Za-z][\w.:-]*[^<>]*>/g;

			expect(
				runPatternUnderDeadline(quadratic, `<a${'x'.repeat(200_000)}`, CONTROL_DEADLINE_MS),
			).toBe('timed out');
		});

		it('takes 400k characters of tag-dense text through the REAL validator', () => {
			// Tag-dense, not a long failed scan: this one exercises the match loop and
			// the neighbour inspection 100k times over, where the cases above mostly
			// exercise a regex that never matches.
			const description = '<a>/'.repeat(100_000);

			// This is the only place the real validator meets a large input in THIS
			// thread, where nothing can interrupt it. Clear every pattern under the
			// deadline first, so a runaway pattern fails here by assertion instead of
			// hanging the file — verified by mutating ANGLE_GROUP into both runaway
			// shapes, each of which reds this test by name in about a second.
			for (const pattern of XML_TAG_SCAN_PATTERNS) {
				expect(runPatternUnderDeadline(pattern, description, COMPLETION_DEADLINE_MS)).toBe(
					'completed',
				);
			}

			// Asserting the VERDICT, not a duration: a scan that bailed early would
			// also "finish fast". `<a>` followed by `/<` is a tag, not a path.
			const issues = validateFrontmatterRules(validFrontmatter({ description }));

			expect(findIssueByCode(issues, 'SKILL_DESCRIPTION_XML_TAGS')).toBeDefined();
		});
	});

	describe('empty/whitespace description', () => {
		it('should report SKILL_DESCRIPTION_EMPTY for whitespace-only description', () => {
			const issues = validateFrontmatterRules(validFrontmatter({ description: '   ' }));

			const issue = expectIssueAt(issues, 'SKILL_DESCRIPTION_EMPTY', 'error', FIELD_FRONTMATTER_DESC);
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

			const issue = expectIssueAt(issues, 'SKILL_DESCRIPTION_OVER_CLAUDE_CODE_LIMIT', 'warning', FIELD_FRONTMATTER_DESC);
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
