/**
 * Unit tests for packaging validation
 */

/* eslint-disable security/detect-non-literal-fs-filename -- Test code with temp directories */
import * as fs from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import type { PackagingValidationResult } from '../../src/validators/packaging-validator.js';
import { validateSkillForPackaging } from '../../src/validators/packaging-validator.js';
import {
	createSkillContent,
	createTransitiveSkillStructure,
	setupNavigationValidationTest,
	setupPackagingValidationTest,
	setupTempDir,
	setupTransitiveValidationTest,
} from '../test-helpers.js';

const { getTempDir } = setupTempDir('packaging-validator-');

// Use a description that's >= 50 characters to avoid DESCRIPTION_TOO_VAGUE warnings
const VALID_DESCRIPTION = 'A comprehensive test skill with a detailed description for validation purposes';

// Constants to avoid duplication warnings
const TEST_SKILL_NAME = 'test-skill';
const LINE_CONTENT = 'Line content\n';
const REASON_REFACTOR_Q2 = 'Will be refactored in Q2';
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
 * Helper to test ignoring warnings via validation.severity config.
 * Returns result with all warnings ignored for the given codes.
 */
async function testIgnoreWarnings(
	codes: string[],
): Promise<PackagingValidationResult> {
	const tempDir = getTempDir();
	const content = createSkillContent(
		{ name: TEST_SKILL_NAME, description: VALID_DESCRIPTION },
		LONG_SKILL_BODY,
	);
	const { skillPath } = createTransitiveSkillStructure(tempDir, {}, content);

	const severity = Object.fromEntries(codes.map(c => [c, 'ignore' as const]));
	return validateSkillForPackaging(skillPath, {
		validation: { severity },
	});
}

type AcceptMap = NonNullable<
	NonNullable<Parameters<typeof validateSkillForPackaging>[1]>['validation']
>['accept'];

/**
 * Shared setup for long-skill acceptance tests: a long SKILL.md in a temp dir
 * with no transitive links. Returns the packaging validation result with the
 * given accept map applied.
 */
async function setupLongSkillAcceptanceTest(
	accept: AcceptMap,
): Promise<PackagingValidationResult> {
	const tempDir = getTempDir();
	const content = createSkillContent(
		{ name: TEST_SKILL_NAME, description: VALID_DESCRIPTION },
		LONG_SKILL_BODY,
	);
	const { skillPath } = createTransitiveSkillStructure(tempDir, {}, content);
	return validateSkillForPackaging(skillPath, { validation: { accept } });
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

	it('should warn for SKILL.md over 500 lines', async () => {
		const tempDir = getTempDir();
		const content = createSkillContent(
			{ name: TEST_SKILL_NAME, description: VALID_DESCRIPTION },
			SKILL_HEADER + LINE_CONTENT.repeat(550), // ~550 lines
		);
		const { skillPath } = createTransitiveSkillStructure(tempDir, {}, content);

		const result = await validateSkillForPackaging(skillPath);

		// Size checks are warnings not errors — status is success
		expect(result.status).toBe('success');
		expect(result.activeErrors).toHaveLength(0);
		// SKILL_LENGTH + NO_PROGRESSIVE_DISCLOSURE are warnings
		expect(result.activeWarnings).toHaveLength(2);
		const lengthWarn = result.activeWarnings.find(e => e.code === 'SKILL_LENGTH_EXCEEDS_RECOMMENDED');
		expect(lengthWarn).toBeDefined();
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
		expect(result.activeWarnings.filter((e) => e.code === 'SKILL_TOTAL_SIZE_LARGE')).toHaveLength(0);
	});

	it('should warn for total lines over 2000', async () => {
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

		expect(result.status).toBe('success'); // warnings don't make status error
		expect(result.metadata.totalLines).toBeGreaterThan(2000);
		const totalSizeWarn = result.activeWarnings.find((e) => e.code === 'SKILL_TOTAL_SIZE_LARGE');
		expect(totalSizeWarn).toBeDefined();
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
		expect(result.activeWarnings.filter((e) => e.code === 'SKILL_TOO_MANY_FILES')).toHaveLength(0);
	});

	it('should warn for more than 6 files', async () => {
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

		expect(result.status).toBe('success'); // warnings don't make status error
		expect(result.metadata.fileCount).toBe(8); // 7 refs + SKILL.md
		const fileCountWarn = result.activeWarnings.find((e) => e.code === 'SKILL_TOO_MANY_FILES');
		expect(fileCountWarn).toBeDefined();
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
		expect(result.activeWarnings.filter((e) => e.code === 'REFERENCE_TOO_DEEP')).toHaveLength(0);
	});

	it('should warn for depth > 2 when linkFollowDepth is full', async () => {
		const { skillPath } = createThreeLevelChain(getTempDir());

		// With linkFollowDepth: 'full', all links are followed regardless of depth
		const metadata = { linkFollowDepth: 'full' as const };
		const result = await validateSkillForPackaging(skillPath, metadata as never);

		expect(result.status).toBe('success'); // warnings don't make status error
		expect(result.metadata.maxLinkDepth).toBeGreaterThan(2);
		const depthWarn = result.activeWarnings.find((e) => e.code === 'REFERENCE_TOO_DEEP');
		expect(depthWarn).toBeDefined();
	});

	it('should truncate at default depth 2 and exclude deeper files', async () => {
		const { skillPath } = createThreeLevelChain(getTempDir());

		// Default behavior: linkFollowDepth = 2, so level3.md is excluded
		const result = await validateSkillForPackaging(skillPath);

		expect(result.status).toBe('success');
		expect(result.metadata.maxLinkDepth).toBeLessThanOrEqual(2);
		expect(result.metadata.fileCount).toBe(3); // SKILL.md + level1.md + level2.md
		expect(result.metadata.excludedReferenceCount).toBe(1); // level3.md excluded
		expect(result.activeWarnings.filter((e) => e.code === 'REFERENCE_TOO_DEEP')).toHaveLength(0);
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
	it('should detect links to README.md', async () => {
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

		// Navigation file links are warnings, not errors
		expect(result.status).toBe('success');
		const navWarn = result.activeWarnings.find((e) => e.code === 'LINK_TO_NAVIGATION_FILE');
		expect(navWarn).toBeDefined();
		// location is relative to project root
		expect(navWarn?.location).toContain('docs/README.md');
	});

	it('should detect links to index.md', async () => {
		const files = {
			'docs/index.md': '# Documentation Index',
		};
		const skillBody = '\n# Test Skill\n\nSee [docs](./docs/index.md).';

		const { findNavWarn } = await setupNavigationValidationTest(
			getTempDir,
			files,
			skillBody,
			{ name: TEST_SKILL_NAME, description: VALID_DESCRIPTION }
		);

		const navWarn = findNavWarn();
		expect(navWarn).toBeDefined();
		expect((navWarn as { message: string }).message).toContain('index.md');
	});

	it('should not warn for specific topic files', async () => {
		const files = {
			'operators.md': '# Operators',
			'calculations.md': '# Calculations',
		};
		const skillBody = '\n# Test Skill\n\nSee [operators](./operators.md) and [calculations](./calculations.md).';

		const { findNavWarn } = await setupNavigationValidationTest(
			getTempDir,
			files,
			skillBody,
			{ name: TEST_SKILL_NAME, description: VALID_DESCRIPTION }
		);

		const navWarn = findNavWarn();
		expect(navWarn).toBeUndefined();
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

		const descWarn = result.activeWarnings.find((e) => e.code === 'DESCRIPTION_TOO_VAGUE');
		expect(descWarn).toBeUndefined();
	});

	it('should warn for description < 50 characters', async () => {
		const tempDir = getTempDir();
		const content = createSkillContent(
			{ name: TEST_SKILL_NAME, description: 'Short description' },
			SKILL_HEADER_NO_TRAILING,
		);
		const { skillPath } = createTransitiveSkillStructure(tempDir, {}, content);

		const result = await validateSkillForPackaging(skillPath);

		// Description warning — status is still success
		expect(result.status).toBe('success');
		const descWarn = result.activeWarnings.find((e) => e.code === 'DESCRIPTION_TOO_VAGUE');
		expect(descWarn).toBeDefined();
		expect(descWarn?.message).toContain('characters');
	});

	it('should not warn when description is missing', async () => {
		const tempDir = getTempDir();
		const content = createSkillContent({ name: TEST_SKILL_NAME }, SKILL_HEADER_NO_TRAILING);
		const { skillPath } = createTransitiveSkillStructure(tempDir, {}, content);

		const result = await validateSkillForPackaging(skillPath);

		// Missing description is handled by existing validator, not packaging validator
		const descWarn = result.activeWarnings.find((e) => e.code === 'DESCRIPTION_TOO_VAGUE');
		expect(descWarn).toBeUndefined();
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
		const pdWarn = result.activeWarnings.find((e) => e.code === 'NO_PROGRESSIVE_DISCLOSURE');
		expect(pdWarn).toBeUndefined();
	});

	it('should warn for large SKILL.md without reference files', async () => {
		const result = (await setupPackagingValidationTest(
			getTempDir,
			{ name: TEST_SKILL_NAME, description: VALID_DESCRIPTION },
			SKILL_HEADER + LINE_CONTENT.repeat(550)
		)) as PackagingValidationResult;

		expect(result.status).toBe('success'); // warnings don't make status error
		const pdWarn = result.activeWarnings.find((e) => e.code === 'NO_PROGRESSIVE_DISCLOSURE');
		expect(pdWarn).toBeDefined();
	});

	it('should pass for small SKILL.md without reference files', async () => {
		const result = (await setupPackagingValidationTest(
			getTempDir,
			{ name: TEST_SKILL_NAME, description: VALID_DESCRIPTION },
			SKILL_HEADER + LINE_CONTENT.repeat(400)
		)) as PackagingValidationResult;

		const pdWarn = result.activeWarnings.find((e) => e.code === 'NO_PROGRESSIVE_DISCLOSURE');
		expect(pdWarn).toBeUndefined();
	});
});

describe('validateSkillForPackaging - Severity / accept config (framework)', () => {
	it('should ignore warnings via validation.severity', async () => {
		const result = await testIgnoreWarnings([
			'SKILL_LENGTH_EXCEEDS_RECOMMENDED',
			'NO_PROGRESSIVE_DISCLOSURE',
		]);

		expect(result.status).toBe('success');
		expect(result.activeWarnings.filter(
			e => e.code === 'SKILL_LENGTH_EXCEEDS_RECOMMENDED' || e.code === 'NO_PROGRESSIVE_DISCLOSURE'
		)).toHaveLength(0);
	});

	it('should surface only non-ignored warnings when some codes are ignored', async () => {
		// Only ignore SKILL_LENGTH — NO_PROGRESSIVE_DISCLOSURE should remain
		const result = await testIgnoreWarnings(['SKILL_LENGTH_EXCEEDS_RECOMMENDED']);

		expect(result.status).toBe('success');
		expect(result.activeWarnings.find(e => e.code === 'SKILL_LENGTH_EXCEEDS_RECOMMENDED')).toBeUndefined();
		const pdWarn = result.activeWarnings.find(e => e.code === 'NO_PROGRESSIVE_DISCLOSURE');
		expect(pdWarn).toBeDefined();
	});

	it('should accept specific issues via validation.accept with path wildcard', async () => {
		const result = await setupLongSkillAcceptanceTest({
			SKILL_LENGTH_EXCEEDS_RECOMMENDED: [{ paths: ['**'], reason: 'Legacy skill, refactoring planned for Q2' }],
			NO_PROGRESSIVE_DISCLOSURE: [{ paths: ['**'], reason: REASON_REFACTOR_Q2 }],
		});

		expect(result.status).toBe('success');
		// Both codes are accepted (suppressed), not in warnings
		expect(result.activeWarnings.filter(
			e => e.code === 'SKILL_LENGTH_EXCEEDS_RECOMMENDED' || e.code === 'NO_PROGRESSIVE_DISCLOSURE'
		)).toHaveLength(0);
		// ignoredErrors (accepted) contains the accept records
		expect(result.ignoredErrors.some(r => r.code === 'SKILL_LENGTH_EXCEEDS_RECOMMENDED')).toBe(true);
		expect(result.ignoredErrors.some(r => r.code === 'NO_PROGRESSIVE_DISCLOSURE')).toBe(true);
	});

	it('should emit ACCEPTANCE_EXPIRED warning for expired accept entries', async () => {
		const result = await setupLongSkillAcceptanceTest({
			SKILL_LENGTH_EXCEEDS_RECOMMENDED: [{ paths: ['**'], reason: 'Temporary exception', expires: '2020-01-01' }],
			NO_PROGRESSIVE_DISCLOSURE: [{ paths: ['**'], reason: REASON_REFACTOR_Q2 }],
		});

		// Expired accept still suppresses the issue itself, but emits ACCEPTANCE_EXPIRED
		const expiredWarn = result.activeWarnings.find(e => e.code === 'ACCEPTANCE_EXPIRED');
		expect(expiredWarn).toBeDefined();
		expect(expiredWarn?.message).toContain('SKILL_LENGTH_EXCEEDS_RECOMMENDED');
		expect(expiredWarn?.message).toContain('2020-01-01');
	});

	it('should keep accept active if not expired', async () => {
		const tempDir = getTempDir();
		const content = createSkillContent(
			{ name: TEST_SKILL_NAME, description: VALID_DESCRIPTION },
			LONG_SKILL_BODY,
		);
		const { skillPath } = createTransitiveSkillStructure(tempDir, {}, content);

		const futureDate = new Date();
		futureDate.setFullYear(futureDate.getFullYear() + 1);
		const futureDateStr = futureDate.toISOString().split('T')[0];

		const result = await validateSkillForPackaging(skillPath, {
			validation: {
				accept: {
					SKILL_LENGTH_EXCEEDS_RECOMMENDED: [{ paths: ['**'], reason: 'Time-limited exception', expires: futureDateStr }],
					NO_PROGRESSIVE_DISCLOSURE: [{ paths: ['**'], reason: REASON_REFACTOR_Q2 }],
				},
			},
		});

		expect(result.status).toBe('success');
		expect(result.activeWarnings.filter(
			e => e.code === 'SKILL_LENGTH_EXCEEDS_RECOMMENDED' || e.code === 'NO_PROGRESSIVE_DISCLOSURE'
		)).toHaveLength(0);
		expect(result.activeWarnings.find(e => e.code === 'ACCEPTANCE_EXPIRED')).toBeUndefined();
	});

	it('emits LINK_OUTSIDE_PROJECT through the framework instead of OUTSIDE_PROJECT_BOUNDARY', async () => {
		// Create a skill that links outside the project boundary
		// We use a path that goes above the temp dir (which is the project root here)
		const tempDir = getTempDir();
		const skillContent = createSkillContent(
			{ name: TEST_SKILL_NAME, description: VALID_DESCRIPTION },
			'\n# Test Skill\n\nSee [outside](../outside.md).',
		);
		const { skillPath } = createTransitiveSkillStructure(tempDir, {}, skillContent);

		const result = await validateSkillForPackaging(skillPath, {
			validation: { severity: { LINK_OUTSIDE_PROJECT: 'error' } },
		});

		expect(result.activeErrors.map(e => e.code)).toContain('LINK_OUTSIDE_PROJECT');
		expect(result.activeErrors.map(e => e.code)).not.toContain('OUTSIDE_PROJECT_BOUNDARY');
	});

	it('allows accepting LINK_TARGETS_DIRECTORY per-path', async () => {
		const tempDir = getTempDir();
		const conceptsDir = safePath.join(tempDir, 'docs/sub');
		fs.mkdirSync(conceptsDir, { recursive: true });
		fs.writeFileSync(safePath.join(conceptsDir, 'README.md'), '# Sub');

		const skillContent = createSkillContent(
			{ name: TEST_SKILL_NAME, description: VALID_DESCRIPTION },
			'\n# Test\n\nSee [Sub](./docs/sub/) for details.',
		);
		const { skillPath } = createTransitiveSkillStructure(tempDir, {}, skillContent);

		// location is 'docs/sub' (relative to project root, no trailing slash)
		const result = await validateSkillForPackaging(skillPath, {
			validation: {
				accept: {
					LINK_TARGETS_DIRECTORY: [{ paths: ['docs/sub'], reason: 'ToC target' }],
				},
			},
		});

		expect(result.activeErrors).toHaveLength(0);
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

// Files config validation constants
const DUPLICATE_FILES_DEST_CODE = 'DUPLICATE_FILES_DEST';
const FILES_DEST_A = 'output/a.md';
const FILES_DEST_B = 'output/b.md';

/**
 * Create a minimal valid skill in the given temp dir.
 */
function createMinimalSkill(tempDir: string): string {
	const content = createSkillContent(
		{ name: TEST_SKILL_NAME, description: VALID_DESCRIPTION },
		SKILL_HEADER_NO_TRAILING,
	);
	const { skillPath } = createTransitiveSkillStructure(tempDir, {}, content);
	return skillPath;
}

describe('validateSkillForPackaging - Files config validation', () => {
	it('should detect duplicate dest in files config', async () => {
		const skillPath = createMinimalSkill(getTempDir());

		const result = await validateSkillForPackaging(skillPath, {
			files: [
				{ source: 'a.md', dest: FILES_DEST_A },
				{ source: 'b.md', dest: FILES_DEST_A },
			],
		});

		expect(result.status).toBe('error');
		const dupError = result.activeErrors.find(e => e.code === DUPLICATE_FILES_DEST_CODE);
		expect(dupError).toBeDefined();
		expect(dupError?.message).toContain(FILES_DEST_A);
	});

	it('should pass validation when files config dests are unique', async () => {
		const skillPath = createMinimalSkill(getTempDir());

		const result = await validateSkillForPackaging(skillPath, {
			files: [
				{ source: 'a.md', dest: FILES_DEST_A },
				{ source: 'b.md', dest: FILES_DEST_B },
			],
		});

		const dupError = result.activeErrors.find(e => e.code === DUPLICATE_FILES_DEST_CODE);
		expect(dupError).toBeUndefined();
	});

	it('should pass validation when files config is empty', async () => {
		const skillPath = createMinimalSkill(getTempDir());

		const result = await validateSkillForPackaging(skillPath, { files: [] });

		const dupError = result.activeErrors.find(e => e.code === DUPLICATE_FILES_DEST_CODE);
		expect(dupError).toBeUndefined();
	});

	it('should detect multiple duplicate dests', async () => {
		const skillPath = createMinimalSkill(getTempDir());

		const result = await validateSkillForPackaging(skillPath, {
			files: [
				{ source: 'a.md', dest: FILES_DEST_A },
				{ source: 'b.md', dest: FILES_DEST_A },
				{ source: 'c.md', dest: FILES_DEST_B },
				{ source: 'd.md', dest: FILES_DEST_B },
			],
		});

		expect(result.status).toBe('error');
		const dupErrors = result.activeErrors.filter(e => e.code === DUPLICATE_FILES_DEST_CODE);
		expect(dupErrors).toHaveLength(2);
	});
});

describe('validateSkillForPackaging - Link collection integration', () => {
	it('should limit bundled files to depth 1 when linkFollowDepth is 1', async () => {
		const { skillPath } = createThreeLevelChain(getTempDir());

		const metadata = { linkFollowDepth: 1 };
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
			excludeReferencesFromBundle: {
				rules: [
					{ patterns: ['internal/**'] },
				],
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
		const conceptsDir = safePath.join(tempDir, 'concepts');
		fs.mkdirSync(conceptsDir, { recursive: true });
		fs.writeFileSync(safePath.join(conceptsDir, 'README.md'), '# Concepts');

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
		const metadata = { linkFollowDepth: 0 };
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

		const metadata = { linkFollowDepth: 0 };
		const result = await validateSkillForPackaging(skillPath, metadata as never);

		// Only SKILL.md should be bundled, reference.md excluded
		expect(result.metadata.fileCount).toBe(1); // SKILL.md only
		expect(result.metadata.excludedReferenceCount).toBe(1);
	});
});
