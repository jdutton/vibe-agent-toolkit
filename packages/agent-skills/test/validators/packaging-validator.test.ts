/**
 * Unit tests for packaging validation
 */

/* eslint-disable security/detect-non-literal-fs-filename -- Test code with temp directories */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { PackagingValidationResult } from '../../src/validators/packaging-validator.js';
import { validateSkillForPackaging } from '../../src/validators/packaging-validator.js';
import {
	createSkillContent,
	createTransitiveSkillStructure,
	setupNavigationValidationTest,
	setupOverrideValidationTest,
	setupPackagingValidationTest,
	setupSkillWithMetadata,
	setupTempDir,
	setupTransitiveValidationTest,
} from '../test-helpers.js';

const { getTempDir } = setupTempDir('packaging-validator-');

// Use a description that's >= 50 characters to avoid DESCRIPTION_TOO_VAGUE errors
const VALID_DESCRIPTION = 'A comprehensive test skill with a detailed description for validation purposes';

// Constants to avoid duplication warnings
const TEST_SKILL_NAME = 'test-skill';
const LINE_CONTENT = 'Line content\n';
const TEST_REASON = 'Will be refactored in Q2';
const SKILL_HEADER = '\n# Test Skill\n\n';
const SKILL_HEADER_NO_TRAILING = '\n# Test Skill';
const LONG_SKILL_BODY = SKILL_HEADER + LINE_CONTENT.repeat(550);

// Depth chain fixture constants
const LEVEL1_KEY = 'level1.md';
const LEVEL2_KEY = 'level2.md';
const LEVEL3_KEY = 'level3.md';
const LEVEL1_WITH_LINK = '# Level 1\n\nSee [level2](./level2.md).';
const LEVEL2_WITH_LINK = '# Level 2\n\nSee [level3](./level3.md).';
const LEVEL3_TERMINAL = '# Level 3\n\nEnd of chain.';
const SKILL_BODY_WITH_LEVEL1 = '\n# Test Skill\n\nSee [level1](./level1.md).';

/**
 * Create a 3-level depth chain fixture: SKILL.md → level1 → level2 → level3
 */
function createThreeLevelChain(tempDir: string): { skillPath: string } {
	const files = {
		[LEVEL1_KEY]: LEVEL1_WITH_LINK,
		[LEVEL2_KEY]: LEVEL2_WITH_LINK,
		[LEVEL3_KEY]: LEVEL3_TERMINAL,
	};
	const skillContent = createSkillContent(
		{ name: TEST_SKILL_NAME, description: VALID_DESCRIPTION },
		SKILL_BODY_WITH_LEVEL1,
	);
	return createTransitiveSkillStructure(tempDir, files, skillContent);
}

/**
 * Helper to test override validation with common assertions
 */
async function testOverrideValidation(
	overrides: Record<string, unknown>
): Promise<{ typedResult: PackagingValidationResult; lengthOverride: unknown }> {
	const { result, findIgnoredError } = await setupOverrideValidationTest(
		getTempDir,
		LONG_SKILL_BODY,
		overrides,
		{ name: TEST_SKILL_NAME, description: VALID_DESCRIPTION }
	);

	const typedResult = result as PackagingValidationResult;
	expect(typedResult.status).toBe('success');
	expect(typedResult.ignoredErrors).toHaveLength(2);

	const lengthOverride = findIgnoredError('SKILL_LENGTH_EXCEEDS_RECOMMENDED');
	return { typedResult, lengthOverride };
}

describe('validateSkillForPackaging - Size validation', () => {
	it('should pass for SKILL.md under 500 lines', async () => {
		const tempDir = getTempDir();
		const content = createSkillContent(
			{ name: TEST_SKILL_NAME, description: VALID_DESCRIPTION },
			SKILL_HEADER + LINE_CONTENT.repeat(450), // ~450 lines
		);
		const { skillPath } = createTransitiveSkillStructure(tempDir, {}, content);

		const result = await validateSkillForPackaging(skillPath);

		expect(result.status).toBe('success');
		expect(result.activeErrors).toHaveLength(0);
	});

	it('should error for SKILL.md over 500 lines', async () => {
		const tempDir = getTempDir();
		const content = createSkillContent(
			{ name: TEST_SKILL_NAME, description: VALID_DESCRIPTION },
			SKILL_HEADER + LINE_CONTENT.repeat(550), // ~550 lines
		);
		const { skillPath } = createTransitiveSkillStructure(tempDir, {}, content);

		const result = await validateSkillForPackaging(skillPath);

		expect(result.status).toBe('error');
		expect(result.activeErrors).toHaveLength(2); // SKILL_LENGTH + NO_PROGRESSIVE_DISCLOSURE
		const lengthError = result.activeErrors.find(e => e.code === 'SKILL_LENGTH_EXCEEDS_RECOMMENDED');
		expect(lengthError).toBeDefined();
		expect(result.metadata.skillLines).toBeGreaterThan(500);
	});
});

describe('validateSkillForPackaging - Total size validation', () => {
	it('should pass for total lines under 2000', async () => {
		const files = {
			'reference.md': '# Reference\n\n' + 'Content\n'.repeat(900),
			'guide.md': '# Guide\n\n' + 'Content\n'.repeat(900),
		};
		const skillBody = '\n# Test Skill\n\nSee [reference](./reference.md) and [guide](./guide.md).';

		const result = (await setupTransitiveValidationTest(
			getTempDir,
			files,
			skillBody,
			{ name: TEST_SKILL_NAME, description: VALID_DESCRIPTION }
		)) as PackagingValidationResult;

		expect(result.metadata.totalLines).toBeLessThan(2000);
		expect(result.activeErrors.filter((e) => e.code === 'SKILL_TOTAL_SIZE_LARGE')).toHaveLength(0);
	});

	it('should error for total lines over 2000', async () => {
		const files = {
			'reference.md': '# Reference\n\n' + 'Content\n'.repeat(1000),
			'guide.md': '# Guide\n\n' + 'Content\n'.repeat(1100),
		};
		const skillBody = '\n# Test Skill\n\nSee [reference](./reference.md) and [guide](./guide.md).';

		const result = (await setupTransitiveValidationTest(
			getTempDir,
			files,
			skillBody,
			{ name: TEST_SKILL_NAME, description: VALID_DESCRIPTION }
		)) as PackagingValidationResult;

		expect(result.status).toBe('error');
		expect(result.metadata.totalLines).toBeGreaterThan(2000);
		const totalSizeError = result.activeErrors.find((e) => e.code === 'SKILL_TOTAL_SIZE_LARGE');
		expect(totalSizeError).toBeDefined();
	});
});

describe('validateSkillForPackaging - File count validation', () => {
	it('should pass for 6 or fewer files', async () => {
		const tempDir = getTempDir();
		const files = {
			'ref1.md': '# Ref 1',
			'ref2.md': '# Ref 2',
			'ref3.md': '# Ref 3',
			'ref4.md': '# Ref 4',
			'ref5.md': '# Ref 5',
		};
		const skillContent = createSkillContent(
			{ name: TEST_SKILL_NAME, description: VALID_DESCRIPTION },
			'\n# Test Skill\n\n[1](./ref1.md) [2](./ref2.md) [3](./ref3.md) [4](./ref4.md) [5](./ref5.md)',
		);
		const { skillPath } = createTransitiveSkillStructure(tempDir, files, skillContent);

		const result = await validateSkillForPackaging(skillPath);

		expect(result.metadata.fileCount).toBe(6); // 5 refs + SKILL.md
		expect(result.activeErrors.filter((e) => e.code === 'SKILL_TOO_MANY_FILES')).toHaveLength(0);
	});

	it('should error for more than 6 files', async () => {
		const tempDir = getTempDir();
		const files = {
			'ref1.md': '# Ref 1',
			'ref2.md': '# Ref 2',
			'ref3.md': '# Ref 3',
			'ref4.md': '# Ref 4',
			'ref5.md': '# Ref 5',
			'ref6.md': '# Ref 6',
			'ref7.md': '# Ref 7',
		};
		const skillContent = createSkillContent(
			{ name: TEST_SKILL_NAME, description: VALID_DESCRIPTION },
			'\n# Test Skill\n\n[1](./ref1.md) [2](./ref2.md) [3](./ref3.md) [4](./ref4.md) [5](./ref5.md) [6](./ref6.md) [7](./ref7.md)',
		);
		const { skillPath } = createTransitiveSkillStructure(tempDir, files, skillContent);

		const result = await validateSkillForPackaging(skillPath);

		expect(result.status).toBe('error');
		expect(result.metadata.fileCount).toBe(8); // 7 refs + SKILL.md
		const fileCountError = result.activeErrors.find((e) => e.code === 'SKILL_TOO_MANY_FILES');
		expect(fileCountError).toBeDefined();
	});
});

describe('validateSkillForPackaging - Link depth validation', () => {
	it('should pass for depth <= 2', async () => {
		const tempDir = getTempDir();
		const files = {
			[LEVEL1_KEY]: LEVEL1_WITH_LINK,
			[LEVEL2_KEY]: '# Level 2\n\nEnd of chain.',
		};
		const skillContent = createSkillContent(
			{ name: TEST_SKILL_NAME, description: VALID_DESCRIPTION },
			SKILL_BODY_WITH_LEVEL1,
		);
		const { skillPath } = createTransitiveSkillStructure(tempDir, files, skillContent);

		const result = await validateSkillForPackaging(skillPath);

		expect(result.metadata.maxLinkDepth).toBeLessThanOrEqual(2);
		expect(result.activeErrors.filter((e) => e.code === 'REFERENCE_TOO_DEEP')).toHaveLength(0);
	});

	it('should error for depth > 2 when linkFollowDepth is full', async () => {
		const { skillPath } = createThreeLevelChain(getTempDir());

		// With linkFollowDepth: 'full', all links are followed regardless of depth
		const metadata = { packagingOptions: { linkFollowDepth: 'full' as const } };
		const result = await validateSkillForPackaging(skillPath, metadata as never);

		expect(result.status).toBe('error');
		expect(result.metadata.maxLinkDepth).toBeGreaterThan(2);
		const depthError = result.activeErrors.find((e) => e.code === 'REFERENCE_TOO_DEEP');
		expect(depthError).toBeDefined();
	});

	it('should truncate at default depth 2 and exclude deeper files', async () => {
		const { skillPath } = createThreeLevelChain(getTempDir());

		// Default behavior: linkFollowDepth = 2, so level3.md is excluded
		const result = await validateSkillForPackaging(skillPath);

		expect(result.status).toBe('success');
		expect(result.metadata.maxLinkDepth).toBeLessThanOrEqual(2);
		expect(result.metadata.fileCount).toBe(3); // SKILL.md + level1.md + level2.md
		expect(result.metadata.excludedReferenceCount).toBe(1); // level3.md excluded
		expect(result.activeErrors.filter((e) => e.code === 'REFERENCE_TOO_DEEP')).toHaveLength(0);
	});

	it('should include reason detail in excludedReferences for depth-exceeded files', async () => {
		const { skillPath } = createThreeLevelChain(getTempDir());

		const result = await validateSkillForPackaging(skillPath);

		expect(result.metadata.excludedReferenceCount).toBe(1);
		expect(result.metadata.excludedReferences).toHaveLength(1);
		expect(result.metadata.excludedReferences[0]?.reason).toBe('depth-exceeded');
		expect(result.metadata.excludedReferences[0]?.path).toContain('level3.md');
		expect(result.metadata.excludedReferences[0]?.matchedPattern).toBeUndefined();
	});
});

describe('validateSkillForPackaging - Navigation file detection', () => {
	it('should detect links to README.md with full path and line number', async () => {
		const tempDir = getTempDir();
		const files = {
			'docs/README.md': '# Documentation Index',
		};
		const skillContent = createSkillContent(
			{ name: TEST_SKILL_NAME, description: VALID_DESCRIPTION },
			'\n# Test Skill\n\nSee [docs](./docs/README.md).',
		);
		const { skillPath } = createTransitiveSkillStructure(tempDir, files, skillContent);

		const result = await validateSkillForPackaging(skillPath);

		expect(result.status).toBe('error');
		const navError = result.activeErrors.find((e) => e.code === 'LINKS_TO_NAVIGATION_FILES');
		expect(navError).toBeDefined();
		// Should contain full resolved path, not just basename
		expect(navError?.message).toContain(path.resolve(tempDir, 'docs/README.md'));
		// Should contain a line number (colon followed by digits)
		expect(navError?.message).toMatch(/:\d+/);
	});

	it('should detect links to index.md', async () => {
		const files = {
			'docs/index.md': '# Documentation Index',
		};
		const skillBody = '\n# Test Skill\n\nSee [docs](./docs/index.md).';

		const { findNavError } = await setupNavigationValidationTest(
			getTempDir,
			files,
			skillBody,
			{ name: TEST_SKILL_NAME, description: VALID_DESCRIPTION }
		);

		const navError = findNavError();
		expect(navError).toBeDefined();
		expect((navError as { message: string }).message).toContain('index.md');
	});

	it('should not error for specific topic files', async () => {
		const files = {
			'operators.md': '# Operators',
			'calculations.md': '# Calculations',
		};
		const skillBody = '\n# Test Skill\n\nSee [operators](./operators.md) and [calculations](./calculations.md).';

		const { findNavError } = await setupNavigationValidationTest(
			getTempDir,
			files,
			skillBody,
			{ name: TEST_SKILL_NAME, description: VALID_DESCRIPTION }
		);

		const navError = findNavError();
		expect(navError).toBeUndefined();
	});
});

describe('validateSkillForPackaging - Description validation', () => {
	it('should pass for description >= 50 characters', async () => {
		const tempDir = getTempDir();
		const content = createSkillContent(
			{
				name: TEST_SKILL_NAME,
				description: 'This is a comprehensive description that exceeds the minimum length requirement',
			},
			SKILL_HEADER_NO_TRAILING,
		);
		const { skillPath } = createTransitiveSkillStructure(tempDir, {}, content);

		const result = await validateSkillForPackaging(skillPath);

		const descError = result.activeErrors.find((e) => e.code === 'DESCRIPTION_TOO_VAGUE');
		expect(descError).toBeUndefined();
	});

	it('should error for description < 50 characters', async () => {
		const tempDir = getTempDir();
		const content = createSkillContent(
			{ name: TEST_SKILL_NAME, description: 'Short description' },
			SKILL_HEADER_NO_TRAILING,
		);
		const { skillPath } = createTransitiveSkillStructure(tempDir, {}, content);

		const result = await validateSkillForPackaging(skillPath);

		expect(result.status).toBe('error');
		const descError = result.activeErrors.find((e) => e.code === 'DESCRIPTION_TOO_VAGUE');
		expect(descError).toBeDefined();
		expect(descError?.message).toContain('characters');
	});

	it('should not error when description is missing', async () => {
		const tempDir = getTempDir();
		const content = createSkillContent({ name: TEST_SKILL_NAME }, SKILL_HEADER_NO_TRAILING);
		const { skillPath } = createTransitiveSkillStructure(tempDir, {}, content);

		const result = await validateSkillForPackaging(skillPath);

		// Missing description is handled by existing validator, not packaging validator
		const descError = result.activeErrors.find((e) => e.code === 'DESCRIPTION_TOO_VAGUE');
		expect(descError).toBeUndefined();
	});
});

describe('validateSkillForPackaging - Progressive disclosure validation', () => {
	it('should pass for large SKILL.md with reference files', async () => {
		const tempDir = getTempDir();
		const files = {
			'reference.md': '# Reference\n\nDetailed content here.',
		};
		const skillContent = createSkillContent(
			{ name: TEST_SKILL_NAME, description: VALID_DESCRIPTION },
			SKILL_HEADER + LINE_CONTENT.repeat(550) + '\nSee [reference](./reference.md).',
		);
		const { skillPath } = createTransitiveSkillStructure(tempDir, files, skillContent);

		const result = await validateSkillForPackaging(skillPath);

		// Should have SKILL_LENGTH_EXCEEDS_RECOMMENDED but not NO_PROGRESSIVE_DISCLOSURE
		const pdError = result.activeErrors.find((e) => e.code === 'NO_PROGRESSIVE_DISCLOSURE');
		expect(pdError).toBeUndefined();
	});

	it('should error for large SKILL.md without reference files', async () => {
		const result = (await setupPackagingValidationTest(
			getTempDir,
			{ name: TEST_SKILL_NAME, description: VALID_DESCRIPTION },
			SKILL_HEADER + LINE_CONTENT.repeat(550)
		)) as PackagingValidationResult;

		expect(result.status).toBe('error');
		const pdError = result.activeErrors.find((e) => e.code === 'NO_PROGRESSIVE_DISCLOSURE');
		expect(pdError).toBeDefined();
	});

	it('should pass for small SKILL.md without reference files', async () => {
		const result = (await setupPackagingValidationTest(
			getTempDir,
			{ name: TEST_SKILL_NAME, description: VALID_DESCRIPTION },
			SKILL_HEADER + LINE_CONTENT.repeat(400)
		)) as PackagingValidationResult;

		const pdError = result.activeErrors.find((e) => e.code === 'NO_PROGRESSIVE_DISCLOSURE');
		expect(pdError).toBeUndefined();
	});
});

describe('validateSkillForPackaging - Override support', () => {
	it('should ignore errors with simple string override', async () => {
		const { typedResult, lengthOverride } = await testOverrideValidation({
			SKILL_LENGTH_EXCEEDS_RECOMMENDED: 'Legacy skill, refactoring planned for Q2',
			NO_PROGRESSIVE_DISCLOSURE: TEST_REASON,
		});

		expect(typedResult.activeErrors).toHaveLength(0);
		expect((lengthOverride as { reason: string }).reason).toBe('Legacy skill, refactoring planned for Q2');
	});

	it('should ignore errors with object override', async () => {
		const { lengthOverride } = await testOverrideValidation({
			SKILL_LENGTH_EXCEEDS_RECOMMENDED: {
				reason: 'Complex domain requires detailed examples',
				expires: '2026-12-31',
			},
			NO_PROGRESSIVE_DISCLOSURE: TEST_REASON,
		});

		expect((lengthOverride as { reason: string }).reason).toBe('Complex domain requires detailed examples');
	});

	it('should not ignore non-overridable rules', async () => {
		// Attempt to override a best_practice rule (should work)
		const metadata = {
			ignoreValidationErrors: {
				SKILL_LENGTH_EXCEEDS_RECOMMENDED: 'This is allowed',
			},
		};

		const result = (await setupSkillWithMetadata(
			getTempDir,
			LONG_SKILL_BODY,
			{ name: TEST_SKILL_NAME, description: VALID_DESCRIPTION },
			metadata
		)) as PackagingValidationResult;

		// SKILL_LENGTH should be ignored
		expect(result.ignoredErrors.some(e => e.error.code === 'SKILL_LENGTH_EXCEEDS_RECOMMENDED')).toBe(true);

		// But NO_PROGRESSIVE_DISCLOSURE was not overridden, so it should be active
		expect(result.activeErrors.some(e => e.code === 'NO_PROGRESSIVE_DISCLOSURE')).toBe(true);
	});

	it('should detect expired overrides', async () => {
		const metadata = {
			ignoreValidationErrors: {
				SKILL_LENGTH_EXCEEDS_RECOMMENDED: {
					reason: 'Temporary exception',
					expires: '2020-01-01', // Expired
				},
				NO_PROGRESSIVE_DISCLOSURE: TEST_REASON,
			},
		};

		const result = (await setupSkillWithMetadata(
			getTempDir,
			LONG_SKILL_BODY,
			{ name: TEST_SKILL_NAME, description: VALID_DESCRIPTION },
			metadata
		)) as PackagingValidationResult;

		expect(result.status).toBe('error');
		expect(result.expiredOverrides).toHaveLength(1);
		expect(result.expiredOverrides[0]?.error.code).toBe('SKILL_LENGTH_EXCEEDS_RECOMMENDED');
		expect(result.expiredOverrides[0]?.reason).toBe('Temporary exception');
		expect(result.expiredOverrides[0]?.expiredDate).toBe('2020-01-01');
		expect(result.activeErrors).toHaveLength(1); // SKILL_LENGTH becomes active
	});

	it('should keep override active if not expired', async () => {
		const futureDate = new Date();
		futureDate.setFullYear(futureDate.getFullYear() + 1);
		const futureDateStr = futureDate.toISOString().split('T')[0];

		const metadata = {
			ignoreValidationErrors: {
				SKILL_LENGTH_EXCEEDS_RECOMMENDED: {
					reason: 'Time-limited exception',
					expires: futureDateStr,
				},
				NO_PROGRESSIVE_DISCLOSURE: TEST_REASON,
			},
		};

		const result = (await setupSkillWithMetadata(
			getTempDir,
			LONG_SKILL_BODY,
			{ name: TEST_SKILL_NAME, description: VALID_DESCRIPTION },
			metadata
		)) as PackagingValidationResult;

		expect(result.status).toBe('success');
		expect(result.ignoredErrors).toHaveLength(2);
		expect(result.expiredOverrides).toHaveLength(0);
	});
});

describe('validateSkillForPackaging - Metadata reporting', () => {
	it('should report accurate metadata', async () => {
		const tempDir = getTempDir();
		const files = {
			'ref1.md': '# Ref 1\n\n' + 'Content\n'.repeat(100),
			'ref2.md': '# Ref 2\n\nSee [ref1](./ref1.md).',
		};
		const skillContent = createSkillContent(
			{ name: TEST_SKILL_NAME, description: VALID_DESCRIPTION },
			SKILL_HEADER + 'Content\n'.repeat(300) + '\nSee [ref2](./ref2.md).',
		);
		const { skillPath } = createTransitiveSkillStructure(tempDir, files, skillContent);

		const result = await validateSkillForPackaging(skillPath);

		expect(result.metadata.skillLines).toBeGreaterThan(300);
		expect(result.metadata.totalLines).toBeGreaterThan(400);
		expect(result.metadata.fileCount).toBe(3); // SKILL.md + ref1.md + ref2.md
		expect(result.metadata.directFileCount).toBe(1); // Only ref2.md linked directly (ref1.md is transitive)
		expect(result.metadata.maxLinkDepth).toBe(2); // SKILL → ref2 → ref1
		expect(result.metadata.excludedReferenceCount).toBe(0);
		expect(result.metadata.excludedReferences).toEqual([]);
	});

	it('should extract skill name from frontmatter', async () => {
		const tempDir = getTempDir();
		const content = createSkillContent(
			{ name: 'my-awesome-skill', description: VALID_DESCRIPTION },
			SKILL_HEADER_NO_TRAILING,
		);
		const { skillPath } = createTransitiveSkillStructure(tempDir, {}, content);

		const result = await validateSkillForPackaging(skillPath);

		expect(result.skillName).toBe('my-awesome-skill');
	});

	it('should extract skill name from H1 when no frontmatter name', async () => {
		const tempDir = getTempDir();
		const content = createSkillContent(
			{ description: VALID_DESCRIPTION },
			'\n# My H1 Title',
		);
		const { skillPath } = createTransitiveSkillStructure(tempDir, {}, content);

		const result = await validateSkillForPackaging(skillPath);

		expect(result.skillName).toBe('My H1 Title');
	});
});

describe('validateSkillForPackaging - Link collection integration', () => {
	it('should limit bundled files to depth 1 when linkFollowDepth is 1', async () => {
		const { skillPath } = createThreeLevelChain(getTempDir());

		const metadata = { packagingOptions: { linkFollowDepth: 1 } };
		const result = await validateSkillForPackaging(skillPath, metadata as never);

		// Only level1.md should be bundled (depth 1), level2.md excluded at depth boundary
		expect(result.metadata.fileCount).toBe(2); // SKILL.md + level1.md
		expect(result.metadata.excludedReferenceCount).toBeGreaterThan(0);
		expect(result.metadata.maxLinkDepth).toBeLessThanOrEqual(1);
	});

	it('should exclude files matching exclude patterns', async () => {
		const tempDir = getTempDir();
		const files = {
			'guide.md': '# Guide\n\nUser-facing guide content.',
			'internal/notes.md': '# Internal Notes\n\nInternal documentation.',
		};
		const skillContent = createSkillContent(
			{ name: TEST_SKILL_NAME, description: VALID_DESCRIPTION },
			'\n# Test Skill\n\nSee [guide](./guide.md) and [notes](./internal/notes.md).',
		);
		const { skillPath } = createTransitiveSkillStructure(tempDir, files, skillContent);

		const metadata = {
			packagingOptions: {
				excludeReferencesFromBundle: {
					rules: [
						{ patterns: ['internal/**'] },
					],
				},
			},
		};
		const result = await validateSkillForPackaging(skillPath, metadata as never);

		// guide.md bundled, internal/notes.md excluded by pattern
		expect(result.metadata.fileCount).toBe(2); // SKILL.md + guide.md
		expect(result.metadata.excludedReferenceCount).toBe(1);
		expect(result.metadata.excludedReferences).toHaveLength(1);
		expect(result.metadata.excludedReferences[0]?.path).toContain('notes.md');
		expect(result.metadata.excludedReferences[0]?.reason).toBe('pattern-matched');
		expect(result.metadata.excludedReferences[0]?.matchedPattern).toBe('internal/**');
	});

	it('should default to depth 2 with no packaging options', async () => {
		const tempDir = getTempDir();
		const files = {
			[LEVEL1_KEY]: LEVEL1_WITH_LINK,
			[LEVEL2_KEY]: '# Level 2\n\nContent at depth 2.',
		};
		const skillContent = createSkillContent(
			{ name: TEST_SKILL_NAME, description: VALID_DESCRIPTION },
			SKILL_BODY_WITH_LEVEL1,
		);
		const { skillPath } = createTransitiveSkillStructure(tempDir, files, skillContent);

		// No metadata at all - should use default depth of 2
		const result = await validateSkillForPackaging(skillPath);

		// Both level1.md and level2.md should be bundled (within depth 2)
		expect(result.metadata.fileCount).toBe(3); // SKILL.md + level1.md + level2.md
		expect(result.metadata.maxLinkDepth).toBe(2);
		expect(result.metadata.excludedReferenceCount).toBe(0);
		expect(result.metadata.excludedReferences).toEqual([]);
	});

	it('should error when skill links to a directory', async () => {
		const tempDir = getTempDir();
		const conceptsDir = path.join(tempDir, 'concepts');
		fs.mkdirSync(conceptsDir, { recursive: true });
		fs.writeFileSync(path.join(conceptsDir, 'README.md'), '# Concepts');

		const skillContent = createSkillContent(
			{ name: TEST_SKILL_NAME, description: VALID_DESCRIPTION },
			'\n# Test\n\nSee [Concepts](./concepts/) for details.',
		);
		const { skillPath } = createTransitiveSkillStructure(tempDir, {}, skillContent);

		const result = await validateSkillForPackaging(skillPath);

		expect(result.status).toBe('error');
		const dirError = result.activeErrors.find(e => e.code === 'LINK_TARGETS_DIRECTORY');
		expect(dirError).toBeDefined();
		expect(dirError?.message).toContain('concepts');
	});

	it('should report directFileCount <= fileCount when links are excluded by depth', async () => {
		const tempDir = getTempDir();
		const files = {
			'ref1.md': '# Ref 1\n\nContent.',
			'ref2.md': '# Ref 2\n\nContent.',
			'ref3.md': '# Ref 3\n\nContent.',
		};
		const skillContent = createSkillContent(
			{ name: TEST_SKILL_NAME, description: VALID_DESCRIPTION },
			'\n# Test\n\nSee [ref1](./ref1.md), [ref2](./ref2.md), [ref3](./ref3.md).',
		);
		const { skillPath } = createTransitiveSkillStructure(tempDir, files, skillContent);

		// depth=0 means no links followed
		const metadata = { packagingOptions: { linkFollowDepth: 0 } };
		const result = await validateSkillForPackaging(skillPath, metadata as never);

		// fileCount=1 (SKILL.md only), directFileCount should NOT exceed fileCount
		expect(result.metadata.fileCount).toBe(1);
		expect(result.metadata.directFileCount).toBeLessThanOrEqual(result.metadata.fileCount);
	});

	it('should bundle all files with linkFollowDepth: 0 (skill only)', async () => {
		const tempDir = getTempDir();
		const files = {
			'reference.md': '# Reference\n\nContent.',
		};
		const skillContent = createSkillContent(
			{ name: TEST_SKILL_NAME, description: VALID_DESCRIPTION },
			'\n# Test Skill\n\nSee [reference](./reference.md).',
		);
		const { skillPath } = createTransitiveSkillStructure(tempDir, files, skillContent);

		const metadata = { packagingOptions: { linkFollowDepth: 0 } };
		const result = await validateSkillForPackaging(skillPath, metadata as never);

		// Only SKILL.md should be bundled, reference.md excluded
		expect(result.metadata.fileCount).toBe(1); // SKILL.md only
		expect(result.metadata.excludedReferenceCount).toBe(1);
	});
});
