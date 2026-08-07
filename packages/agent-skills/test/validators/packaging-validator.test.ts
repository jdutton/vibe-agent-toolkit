/**
 * Unit tests for packaging validation
 */

/* eslint-disable security/detect-non-literal-fs-filename -- Test code with temp directories */
import * as fs from 'node:fs';

import type { ValidationIssue } from '@vibe-agent-toolkit/agent-schema';
import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';
import * as yaml from 'yaml';

import type { PackagingValidationResult } from '../../src/validators/packaging-validator.js';
import {
	activeErrorsOf,
	activeWarningsOf,
	detectNameMismatchIssue,
	validateSkillForPackaging,
} from '../../src/validators/packaging-validator.js';
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

type AllowMap = NonNullable<
	NonNullable<Parameters<typeof validateSkillForPackaging>[1]>['validation']
>['allow'];

/**
 * Shared setup for long-skill allow tests: a long SKILL.md in a temp dir
 * with no transitive links. Returns the packaging validation result with the
 * given allow map applied.
 */
async function setupLongSkillAllowTest(
	allow: AllowMap,
): Promise<PackagingValidationResult> {
	const tempDir = getTempDir();
	const content = createSkillContent(
		{ name: TEST_SKILL_NAME, description: VALID_DESCRIPTION },
		LONG_SKILL_BODY,
	);
	const { skillPath } = createTransitiveSkillStructure(tempDir, {}, content);
	return validateSkillForPackaging(skillPath, { validation: { allow } });
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
		expect(activeErrorsOf(result)).toHaveLength(0);
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
		expect(activeErrorsOf(result)).toHaveLength(0);
		// SKILL_LENGTH + NO_PROGRESSIVE_DISCLOSURE are warnings
		expect(activeWarningsOf(result)).toHaveLength(2);
		const lengthWarn = activeWarningsOf(result).find(e => e.code === 'SKILL_LENGTH_EXCEEDS_RECOMMENDED');
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
		expect(activeWarningsOf(result).filter((e) => e.code === 'SKILL_TOTAL_SIZE_LARGE')).toHaveLength(0);
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
		const totalSizeWarn = activeWarningsOf(result).find((e) => e.code === 'SKILL_TOTAL_SIZE_LARGE');
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
		expect(activeWarningsOf(result).filter((e) => e.code === 'SKILL_TOO_MANY_FILES')).toHaveLength(0);
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
		const fileCountWarn = activeWarningsOf(result).find((e) => e.code === 'SKILL_TOO_MANY_FILES');
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
		expect(activeWarningsOf(result).filter((e) => e.code === 'REFERENCE_TOO_DEEP')).toHaveLength(0);
	});

	it('should warn for depth > 2 when linkFollowDepth is full', async () => {
		const { skillPath } = createThreeLevelChain(getTempDir());

		// With linkFollowDepth: 'full', all links are followed regardless of depth
		const metadata = { linkFollowDepth: 'full' as const };
		const result = await validateSkillForPackaging(skillPath, metadata as never);

		expect(result.status).toBe('success'); // warnings don't make status error
		expect(result.metadata.maxLinkDepth).toBeGreaterThan(2);
		const depthWarn = activeWarningsOf(result).find((e) => e.code === 'REFERENCE_TOO_DEEP');
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
		expect(activeWarningsOf(result).filter((e) => e.code === 'REFERENCE_TOO_DEEP')).toHaveLength(0);
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
		const navWarn = activeWarningsOf(result).find((e) => e.code === 'LINK_TO_NAVIGATION_FILE');
		expect(navWarn).toBeDefined();
		// The issue is anchored at the file CONTAINING the link; the target the
		// link points at is its own field.
		expect(navWarn?.location).toBe('SKILL.md');
		expect(navWarn?.link).toContain('docs/README.md');
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

describe('validateSkillForPackaging - Reserved word in name', () => {
	it('should emit RESERVED_WORD_IN_NAME warning for name containing "claude"', async () => {
		const tempDir = getTempDir();
		const content = createSkillContent(
			{ name: 'claude-helper', description: VALID_DESCRIPTION },
			SKILL_HEADER_NO_TRAILING,
		);
		const { skillPath } = createTransitiveSkillStructure(tempDir, {}, content);

		const result = await validateSkillForPackaging(skillPath);

		const issue = activeWarningsOf(result).find((e) => e.code === 'RESERVED_WORD_IN_NAME');
		expect(issue).toBeDefined();
		expect(issue?.severity).toBe('warning');
		// Warning does not escalate status to error
		expect(activeErrorsOf(result).find((e) => e.code === 'RESERVED_WORD_IN_NAME')).toBeUndefined();
	});

	it('should not emit RESERVED_WORD_IN_NAME for a clean name', async () => {
		const tempDir = getTempDir();
		const content = createSkillContent(
			{ name: 'my-tool', description: VALID_DESCRIPTION },
			SKILL_HEADER_NO_TRAILING,
		);
		const { skillPath } = createTransitiveSkillStructure(tempDir, {}, content);

		const result = await validateSkillForPackaging(skillPath);

		const issue = result.allErrors.find((e) => e.code === 'RESERVED_WORD_IN_NAME');
		expect(issue).toBeUndefined();
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

		const descWarn = activeWarningsOf(result).find((e) => e.code === 'DESCRIPTION_TOO_VAGUE');
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
		const descWarn = activeWarningsOf(result).find((e) => e.code === 'DESCRIPTION_TOO_VAGUE');
		expect(descWarn).toBeDefined();
		expect(descWarn?.message).toContain('characters');
	});

	it('should not warn when description is missing', async () => {
		const tempDir = getTempDir();
		const content = createSkillContent({ name: TEST_SKILL_NAME }, SKILL_HEADER_NO_TRAILING);
		const { skillPath } = createTransitiveSkillStructure(tempDir, {}, content);

		const result = await validateSkillForPackaging(skillPath);

		// Missing description is handled by existing validator, not packaging validator
		const descWarn = activeWarningsOf(result).find((e) => e.code === 'DESCRIPTION_TOO_VAGUE');
		expect(descWarn).toBeUndefined();
	});
});

describe('detectNameMismatchIssue', () => {
	const SKILL_PATH_FIXTURE = '/repo/skills/pdf-extractor/SKILL.md';
	const PDF_EXTRACTOR_DIR = 'pdf-extractor';
	const PDF_PROCESSOR_NAME = 'pdf-processor';

	it('should return issue when frontmatter name does not match parent directory', () => {
		const issue = detectNameMismatchIssue(PDF_PROCESSOR_NAME, PDF_EXTRACTOR_DIR, SKILL_PATH_FIXTURE);

		expect(issue).not.toBeNull();
		expect(issue?.code).toBe('SKILL_NAME_MISMATCHES_DIR');
		expect(issue?.severity).toBe('warning');
		expect(issue?.message).toContain(PDF_PROCESSOR_NAME);
		expect(issue?.message).toContain(PDF_EXTRACTOR_DIR);
	});

	it('should return null when frontmatter name matches parent directory', () => {
		const issue = detectNameMismatchIssue(PDF_EXTRACTOR_DIR, PDF_EXTRACTOR_DIR, SKILL_PATH_FIXTURE);

		expect(issue).toBeNull();
	});

	it('should return null when frontmatter name is missing', () => {
		const issue = detectNameMismatchIssue(undefined, PDF_EXTRACTOR_DIR, SKILL_PATH_FIXTURE);

		expect(issue).toBeNull();
	});

	it('should return null when parent dir is not kebab-case (e.g., repo root)', () => {
		const issue = detectNameMismatchIssue(PDF_PROCESSOR_NAME, 'My Repo', SKILL_PATH_FIXTURE);

		expect(issue).toBeNull();
	});

	it('should be case-insensitive in comparison', () => {
		const issue = detectNameMismatchIssue('PDF-EXTRACTOR', PDF_EXTRACTOR_DIR, SKILL_PATH_FIXTURE);

		expect(issue).toBeNull();
	});

	it('should return null when parent dir is "skills" (flat-layout plugin-root)', () => {
		const issue = detectNameMismatchIssue('vibe-agent-toolkit', 'skills', '/repo/resources/skills/SKILL.md');

		expect(issue).toBeNull();
	});

	it('should return null when parent dir is "resources" (generic container)', () => {
		const issue = detectNameMismatchIssue('my-skill', 'resources', '/repo/resources/SKILL.md');

		expect(issue).toBeNull();
	});

	it('should return null when parent dir is "SKILLS" (case-insensitive container check)', () => {
		const issue = detectNameMismatchIssue('vibe-agent-toolkit', 'SKILLS', '/repo/SKILLS/SKILL.md');

		expect(issue).toBeNull();
	});

	it('should still fire for typical per-dir mismatch (regression check)', () => {
		const issue = detectNameMismatchIssue('processing-pdf', 'processing-pdfs', '/repo/skills/processing-pdfs/SKILL.md');

		expect(issue).not.toBeNull();
		expect(issue?.code).toBe('SKILL_NAME_MISMATCHES_DIR');
	});
});

async function findTimeSensitiveIssue(
	getTempDirFn: () => string,
	bodyText: string,
): Promise<ValidationIssue | undefined> {
	const tempDir = getTempDirFn();
	const skillContent = createSkillContent(
		{ name: TEST_SKILL_NAME, description: VALID_DESCRIPTION },
		bodyText,
	);
	const { skillPath } = createTransitiveSkillStructure(tempDir, {}, skillContent);
	const result = await validateSkillForPackaging(skillPath);
	const allIssues = [...activeErrorsOf(result), ...activeWarningsOf(result), ...result.allErrors];
	return allIssues.find((e) => e.code === 'SKILL_TIME_SENSITIVE_CONTENT');
}

describe('validateSkillForPackaging - Time-sensitive content', () => {
	it('should emit info issue for "as of <month> <year>" phrase', async () => {
		const timeIssue = await findTimeSensitiveIssue(
			getTempDir,
			'\n# Test Skill\n\nAs of November 2025, this tool supports XYZ.',
		);
		expect(timeIssue).toBeDefined();
		expect(timeIssue?.severity).toBe('info');
	});

	it('should NOT emit issue when body has no time-sensitive phrases', async () => {
		const timeIssue = await findTimeSensitiveIssue(
			getTempDir,
			'\n# Test Skill\n\nThis tool supports XYZ without timestamps.',
		);
		expect(timeIssue).toBeUndefined();
	});
});

async function findNonPortableAssetIssue(
	getTempDirFn: () => string,
	bodyText: string,
): Promise<ValidationIssue | undefined> {
	const tempDir = getTempDirFn();
	const skillContent = createSkillContent(
		{ name: TEST_SKILL_NAME, description: VALID_DESCRIPTION },
		bodyText,
	);
	const { skillPath } = createTransitiveSkillStructure(tempDir, {}, skillContent);
	const result = await validateSkillForPackaging(skillPath);
	const allIssues = [...activeErrorsOf(result), ...activeWarningsOf(result), ...result.allErrors];
	return allIssues.find((e) => e.code === 'NON_PORTABLE_ASSET_REFERENCE');
}

describe('validateSkillForPackaging - Non-portable asset references', () => {
	it('should emit a warning for a ${CLAUDE_PLUGIN_ROOT}-anchored script path', async () => {
		const issue = await findNonPortableAssetIssue(
			getTempDir,
			'\n# Test Skill\n\nRun: `node "${CLAUDE_PLUGIN_ROOT}/skills/test-skill/scripts/run.mjs" go`',
		);
		expect(issue).toBeDefined();
		expect(issue?.severity).toBe('warning');
		// The line lives in `line`; `location` stays a bare path.
		expect(issue?.location).not.toMatch(/:\d+$/);
		expect(issue?.line).toBeGreaterThan(0);
	});

	it('should also catch the bare $CLAUDE_PLUGIN_ROOT form (no braces)', async () => {
		const issue = await findNonPortableAssetIssue(
			getTempDir,
			'\n# Test Skill\n\nRun: `node $CLAUDE_PLUGIN_ROOT/scripts/run.mjs go`',
		);
		expect(issue).toBeDefined();
		expect(issue?.severity).toBe('warning');
	});

	it('should NOT emit for a portable skill-relative script path', async () => {
		const issue = await findNonPortableAssetIssue(
			getTempDir,
			'\n# Test Skill\n\nRun: `node scripts/run.mjs go`',
		);
		expect(issue).toBeUndefined();
	});

	it('should NOT emit for a legitimate non-plugin env var (e.g. ${TMPDIR})', async () => {
		const issue = await findNonPortableAssetIssue(
			getTempDir,
			'\n# Test Skill\n\nSet a cache dir: `export CACHE="${TMPDIR:-/tmp}/test-cache"`',
		);
		expect(issue).toBeUndefined();
	});

	it('should flag the CLAUDE_PROJECT_DIR anchor (another Claude-only variable)', async () => {
		const issue = await findNonPortableAssetIssue(
			getTempDir,
			'\n# Test Skill\n\nRun: `node "${CLAUDE_PROJECT_DIR}/skills/x/scripts/run.mjs" go`',
		);
		expect(issue).toBeDefined();
		expect(issue?.severity).toBe('warning');
	});

	it('should flag an absolute script path passed to a runtime', async () => {
		const issue = await findNonPortableAssetIssue(
			getTempDir,
			'\n# Test Skill\n\nRun: `node /Users/me/skill/scripts/run.mjs go`',
		);
		expect(issue).toBeDefined();
		expect(issue?.severity).toBe('warning');
	});

	// Regression: a naive `\$\{?NAME\}?` consumed the closing brace of an
	// ENCLOSING `${VAR:-default}` expansion, reporting `"$CLAUDE_PROJECT_DIR}"`.
	// The trailing brace reads as the typo `$FOO}` and sends reviewers to a file
	// that is in fact valid shell. Reported by an adopter; independently
	// reproduced. See docs/contributing/plugin-distribution-findings.md.
	it('does not capture the closing brace of an enclosing parameter expansion', async () => {
		const issue = await findNonPortableAssetIssue(
			getTempDir,
			'\n# Test Skill\n\n```bash\nDIR="${OTHER_DIR:-$CLAUDE_PROJECT_DIR}"\n```',
		);

		expect(issue).toBeDefined();
		expect(issue?.message).toContain('$CLAUDE_PROJECT_DIR');
		expect(issue?.message).not.toContain('$CLAUDE_PROJECT_DIR}');
	});

	// Regression guard for the OTHER direction of the same fix: narrowing the
	// match to kill the spurious-brace false positive must not lose the operator
	// forms `${NAME:-default}` / `${NAME#…}`, which are idiomatic non-portable
	// references to the very variable the rule targets. A lone `\$\{NAME\}`
	// alternative matched neither.
	it('flags a braced expansion that carries a default operator', async () => {
		const issue = await findNonPortableAssetIssue(
			getTempDir,
			'\n# Test Skill\n\n```bash\nDIR="${CLAUDE_PROJECT_DIR:-$PWD}/data"\n```',
		);

		expect(issue).toBeDefined();
		expect(issue?.message).toContain('CLAUDE_PROJECT_DIR');
	});

	it('still matches the fully-braced form exactly', async () => {
		const issue = await findNonPortableAssetIssue(
			getTempDir,
			'\n# Test Skill\n\nRun: `node "${CLAUDE_PLUGIN_ROOT}/scripts/run.mjs" go`',
		);

		expect(issue?.message).toContain('${CLAUDE_PLUGIN_ROOT}');
	});

	// CLAUDE_PROJECT_DIR denotes the user's repo, not a bundled asset — there is
	// no skill-relative path that expresses it, so the old shared advice was
	// impossible to follow. Guard that the two variants give different fixes.
	it('does not advise a skill-relative path for CLAUDE_PROJECT_DIR', async () => {
		const issue = await findNonPortableAssetIssue(
			getTempDir,
			'\n# Test Skill\n\nRun: `node "$CLAUDE_PROJECT_DIR/tool.mjs" go`',
		);

		expect(issue?.fix).not.toContain('relative to the skill directory');
		expect(issue?.fix).toContain('targets');
	});

	it('names the offending family variant in the message', async () => {
		const issue = await findNonPortableAssetIssue(
			getTempDir,
			'\n# Test Skill\n\nRun: `node "${CLAUDE_PLUGIN_ROOT}/scripts/run.mjs" go`',
		);
		expect(issue?.message).toContain('claude-plugin-root');
	});

	it('should flag CLAUDE_PLUGIN_ROOT in a reachable bundled reference file, not just SKILL.md', async () => {
		const tempDir = getTempDir();
		// SKILL.md body is clean; the anti-pattern lives in a linked reference file.
		const files = {
			'toolbox.md': '# Toolbox\n\nRun `node "${CLAUDE_PLUGIN_ROOT}/skills/x/scripts/csvsum.mjs" go`\n',
		};
		const skillContent = createSkillContent(
			{ name: TEST_SKILL_NAME, description: VALID_DESCRIPTION },
			'\n# Test Skill\n\nSee [toolbox](./toolbox.md).',
		);
		const { skillPath } = createTransitiveSkillStructure(tempDir, files, skillContent);
		const result = await validateSkillForPackaging(skillPath);
		const allIssues = [...activeErrorsOf(result), ...activeWarningsOf(result), ...result.allErrors];
		const issue = allIssues.find((e) => e.code === 'NON_PORTABLE_ASSET_REFERENCE');
		expect(issue).toBeDefined();
		expect(issue?.severity).toBe('warning');
		// Location points at the reference file, not SKILL.md.
		expect(issue?.location).toContain('toolbox.md');
	});
});

async function findNonPortableCommandIssue(
	getTempDirFn: () => string,
	bodyText: string,
): Promise<ValidationIssue | undefined> {
	const tempDir = getTempDirFn();
	const skillContent = createSkillContent(
		{ name: TEST_SKILL_NAME, description: VALID_DESCRIPTION },
		bodyText,
	);
	const { skillPath } = createTransitiveSkillStructure(tempDir, {}, skillContent);
	const result = await validateSkillForPackaging(skillPath);
	const allIssues = [...activeErrorsOf(result), ...activeWarningsOf(result), ...result.allErrors];
	return allIssues.find((e) => e.code === 'NON_PORTABLE_COMMAND');
}

describe('validateSkillForPackaging - Non-portable commands', () => {
	it('should flag `timeout` invoked in command position', async () => {
		const issue = await findNonPortableCommandIssue(
			getTempDir,
			'\n# Test Skill\n\nRun: `timeout 30 node scripts/run.mjs`',
		);
		expect(issue).toBeDefined();
		expect(issue?.severity).toBe('warning');
		expect(issue?.location).not.toMatch(/:\d+$/);
		expect(issue?.line).toBeGreaterThan(0);
		expect(issue?.message).toContain('timeout');
	});

	it('should flag `grep -P` (PCRE unsupported by BSD/macOS grep)', async () => {
		const issue = await findNonPortableCommandIssue(
			getTempDir,
			'\n# Test Skill\n\nFilter: `grep -P "\\d+" file.txt`',
		);
		expect(issue).toBeDefined();
		expect(issue?.message).toContain('grep-pcre');
	});

	it('should flag `sed -i` with no backup suffix', async () => {
		const issue = await findNonPortableCommandIssue(
			getTempDir,
			'\n# Test Skill\n\nEdit: `sed -i s/foo/bar/ file.txt`',
		);
		expect(issue).toBeDefined();
		expect(issue?.message).toContain('sed-i-no-backup');
	});

	it('should flag `readlink -f`', async () => {
		const issue = await findNonPortableCommandIssue(
			getTempDir,
			'\n# Test Skill\n\nResolve: `readlink -f ./path`',
		);
		expect(issue).toBeDefined();
		expect(issue?.message).toContain('readlink-f');
	});

	it('should flag GNU `date -d`', async () => {
		const issue = await findNonPortableCommandIssue(
			getTempDir,
			'\n# Test Skill\n\nParse: `date -d "2026-01-01" +%s`',
		);
		expect(issue).toBeDefined();
		expect(issue?.message).toContain('date-d');
	});

	it('should NOT flag a portable command (`grep -E`)', async () => {
		const issue = await findNonPortableCommandIssue(
			getTempDir,
			'\n# Test Skill\n\nFilter: `grep -E "[0-9]+" file.txt`',
		);
		expect(issue).toBeUndefined();
	});

	it('should NOT flag `sed -i.bak` (portable attached suffix)', async () => {
		const issue = await findNonPortableCommandIssue(
			getTempDir,
			'\n# Test Skill\n\nEdit: `sed -i.bak s/foo/bar/ file.txt`',
		);
		expect(issue).toBeUndefined();
	});

	it('should NOT flag a prose mention of "timeout" (not in command position)', async () => {
		const issue = await findNonPortableCommandIssue(
			getTempDir,
			'\n# Test Skill\n\nThe request will timeout if the server is slow.',
		);
		expect(issue).toBeUndefined();
	});

	it('should NOT flag prose use of the word "grep" without the -P flag', async () => {
		const issue = await findNonPortableCommandIssue(
			getTempDir,
			'\n# Test Skill\n\nYou can grep the logs to find the error.',
		);
		expect(issue).toBeUndefined();
	});

	it('should flag a non-portable command in a reachable bundled reference file, not just SKILL.md', async () => {
		const tempDir = getTempDir();
		const files = {
			'toolbox.md': '# Toolbox\n\nRun `grep -P "\\d+" log.txt`\n',
		};
		const skillContent = createSkillContent(
			{ name: TEST_SKILL_NAME, description: VALID_DESCRIPTION },
			'\n# Test Skill\n\nSee [toolbox](./toolbox.md).',
		);
		const { skillPath } = createTransitiveSkillStructure(tempDir, files, skillContent);
		const result = await validateSkillForPackaging(skillPath);
		const allIssues = [...activeErrorsOf(result), ...activeWarningsOf(result), ...result.allErrors];
		const issue = allIssues.find((e) => e.code === 'NON_PORTABLE_COMMAND');
		expect(issue).toBeDefined();
		expect(issue?.severity).toBe('warning');
		expect(issue?.location).toContain('toolbox.md');
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
		const pdWarn = activeWarningsOf(result).find((e) => e.code === 'NO_PROGRESSIVE_DISCLOSURE');
		expect(pdWarn).toBeUndefined();
	});

	it('should warn for large SKILL.md without reference files', async () => {
		const result = (await setupPackagingValidationTest(
			getTempDir,
			{ name: TEST_SKILL_NAME, description: VALID_DESCRIPTION },
			SKILL_HEADER + LINE_CONTENT.repeat(550)
		)) as PackagingValidationResult;

		expect(result.status).toBe('success'); // warnings don't make status error
		const pdWarn = activeWarningsOf(result).find((e) => e.code === 'NO_PROGRESSIVE_DISCLOSURE');
		expect(pdWarn).toBeDefined();
	});

	it('should pass for small SKILL.md without reference files', async () => {
		const result = (await setupPackagingValidationTest(
			getTempDir,
			{ name: TEST_SKILL_NAME, description: VALID_DESCRIPTION },
			SKILL_HEADER + LINE_CONTENT.repeat(400)
		)) as PackagingValidationResult;

		const pdWarn = activeWarningsOf(result).find((e) => e.code === 'NO_PROGRESSIVE_DISCLOSURE');
		expect(pdWarn).toBeUndefined();
	});
});

describe('validateSkillForPackaging - Severity / allow config (framework)', () => {
	it('should ignore warnings via validation.severity', async () => {
		const result = await testIgnoreWarnings([
			'SKILL_LENGTH_EXCEEDS_RECOMMENDED',
			'NO_PROGRESSIVE_DISCLOSURE',
		]);

		expect(result.status).toBe('success');
		expect(activeWarningsOf(result).filter(
			e => e.code === 'SKILL_LENGTH_EXCEEDS_RECOMMENDED' || e.code === 'NO_PROGRESSIVE_DISCLOSURE'
		)).toHaveLength(0);
	});

	it('should surface only non-ignored warnings when some codes are ignored', async () => {
		// Only ignore SKILL_LENGTH — NO_PROGRESSIVE_DISCLOSURE should remain
		const result = await testIgnoreWarnings(['SKILL_LENGTH_EXCEEDS_RECOMMENDED']);

		expect(result.status).toBe('success');
		expect(activeWarningsOf(result).find(e => e.code === 'SKILL_LENGTH_EXCEEDS_RECOMMENDED')).toBeUndefined();
		const pdWarn = activeWarningsOf(result).find(e => e.code === 'NO_PROGRESSIVE_DISCLOSURE');
		expect(pdWarn).toBeDefined();
	});

	it('should allow specific issues via validation.allow with path wildcard', async () => {
		const result = await setupLongSkillAllowTest({
			SKILL_LENGTH_EXCEEDS_RECOMMENDED: [{ paths: ['**'], reason: 'Legacy skill, refactoring planned for Q2' }],
			NO_PROGRESSIVE_DISCLOSURE: [{ paths: ['**'], reason: REASON_REFACTOR_Q2 }],
		});

		expect(result.status).toBe('success');
		// Both codes are allowed (suppressed), not in warnings
		expect(activeWarningsOf(result).filter(
			e => e.code === 'SKILL_LENGTH_EXCEEDS_RECOMMENDED' || e.code === 'NO_PROGRESSIVE_DISCLOSURE'
		)).toHaveLength(0);
		// ignoredErrors (allowed) contains the allow records
		expect(result.ignoredErrors.some(r => r.code === 'SKILL_LENGTH_EXCEEDS_RECOMMENDED')).toBe(true);
		expect(result.ignoredErrors.some(r => r.code === 'NO_PROGRESSIVE_DISCLOSURE')).toBe(true);
	});

	it('should emit ALLOW_EXPIRED warning for expired allow entries', async () => {
		const result = await setupLongSkillAllowTest({
			SKILL_LENGTH_EXCEEDS_RECOMMENDED: [{ paths: ['**'], reason: 'Temporary exception', expires: '2020-01-01' }],
			NO_PROGRESSIVE_DISCLOSURE: [{ paths: ['**'], reason: REASON_REFACTOR_Q2 }],
		});

		// Expired allow still suppresses the issue itself, but emits ALLOW_EXPIRED
		const expiredWarn = activeWarningsOf(result).find(e => e.code === 'ALLOW_EXPIRED');
		expect(expiredWarn).toBeDefined();
		expect(expiredWarn?.message).toContain('SKILL_LENGTH_EXCEEDS_RECOMMENDED');
		expect(expiredWarn?.message).toContain('2020-01-01');
	});

	it('should keep allow active if not expired', async () => {
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
				allow: {
					SKILL_LENGTH_EXCEEDS_RECOMMENDED: [{ paths: ['**'], reason: 'Time-limited exception', expires: futureDateStr }],
					NO_PROGRESSIVE_DISCLOSURE: [{ paths: ['**'], reason: REASON_REFACTOR_Q2 }],
				},
			},
		});

		expect(result.status).toBe('success');
		expect(activeWarningsOf(result).filter(
			e => e.code === 'SKILL_LENGTH_EXCEEDS_RECOMMENDED' || e.code === 'NO_PROGRESSIVE_DISCLOSURE'
		)).toHaveLength(0);
		expect(activeWarningsOf(result).find(e => e.code === 'ALLOW_EXPIRED')).toBeUndefined();
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

		expect(activeErrorsOf(result).map(e => e.code)).toContain('LINK_OUTSIDE_PROJECT');
		expect(activeErrorsOf(result).map(e => e.code)).not.toContain('OUTSIDE_PROJECT_BOUNDARY');
	});

	it('navigational directory link produces no error and needs no allow entry', async () => {
		const tempDir = getTempDir();
		const conceptsDir = safePath.join(tempDir, 'docs/sub');
		fs.mkdirSync(conceptsDir, { recursive: true });
		fs.writeFileSync(safePath.join(conceptsDir, 'README.md'), '# Sub');

		const skillContent = createSkillContent(
			{ name: TEST_SKILL_NAME, description: VALID_DESCRIPTION },
			'\n# Test\n\nSee [Sub](./docs/sub/) for details.',
		);
		const { skillPath } = createTransitiveSkillStructure(tempDir, {}, skillContent);

		// A navigational link to an existing directory is valid — no error, no allow needed.
		const result = await validateSkillForPackaging(skillPath);

		expect(activeErrorsOf(result).map(e => e.code)).not.toContain('LINK_TARGETS_DIRECTORY');
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

/**
 * Run files-config packaging validation, assert it errored, and return the first
 * active error matching `code`. Collapses the validate + status + find + defined
 * scaffold shared by the files-config tests.
 */
async function expectFilesConfigError(
	skillPath: string,
	files: Array<{ source: string; dest: string }>,
	code: string,
): Promise<ValidationIssue | undefined> {
	const result = await validateSkillForPackaging(skillPath, { files });
	expect(result.status).toBe('error');
	const issue = activeErrorsOf(result).find(e => e.code === code);
	expect(issue).toBeDefined();
	return issue;
}

describe('validateSkillForPackaging - Files config validation', () => {
	it('should detect duplicate dest in files config', async () => {
		const skillPath = createMinimalSkill(getTempDir());

		const dupError = await expectFilesConfigError(
			skillPath,
			[
				{ source: 'a.md', dest: FILES_DEST_A },
				{ source: 'b.md', dest: FILES_DEST_A },
			],
			DUPLICATE_FILES_DEST_CODE,
		);

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

		const dupError = activeErrorsOf(result).find(e => e.code === DUPLICATE_FILES_DEST_CODE);
		expect(dupError).toBeUndefined();
	});

	it('should pass validation when files config is empty', async () => {
		const skillPath = createMinimalSkill(getTempDir());

		const result = await validateSkillForPackaging(skillPath, { files: [] });

		const dupError = activeErrorsOf(result).find(e => e.code === DUPLICATE_FILES_DEST_CODE);
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
		const dupErrors = activeErrorsOf(result).filter(e => e.code === DUPLICATE_FILES_DEST_CODE);
		expect(dupErrors).toHaveLength(2);
	});

	it('should error when files: source resolves to an existing directory', async () => {
		const FILES_DIR_SOURCE = 'dist/assets';
		const tempDir = getTempDir();
		// Create a real directory at the source path
		const srcDir = safePath.join(tempDir, FILES_DIR_SOURCE);
		fs.mkdirSync(srcDir, { recursive: true });

		const skillPath = createMinimalSkill(tempDir);

		const dirError = await expectFilesConfigError(
			skillPath,
			[{ source: FILES_DIR_SOURCE, dest: 'assets' }],
			'LINK_TARGETS_DIRECTORY',
		);

		expect(dirError?.location).toBe(FILES_DIR_SOURCE);
		expect(dirError?.message).toContain(FILES_DIR_SOURCE);
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

	it('navigational directory link does not produce LINK_TARGETS_DIRECTORY error', async () => {
		const tempDir = getTempDir();
		const conceptsDir = safePath.join(tempDir, 'concepts');
		fs.mkdirSync(conceptsDir, { recursive: true });
		fs.writeFileSync(safePath.join(conceptsDir, 'README.md'), '# Concepts');

		const skillContent = createSkillContent(
			{ name: TEST_SKILL_NAME, description: VALID_DESCRIPTION },
			'\n# Test\n\nSee [Concepts](./concepts/) for details.',
		);
		const { skillPath } = createTransitiveSkillStructure(tempDir, {}, skillContent);

		// A navigational link to an existing directory is valid — directory is
		// excluded from the bundle silently, but no LINK_TARGETS_DIRECTORY error
		// is emitted. Status must not be 'error' from this cause.
		const result = await validateSkillForPackaging(skillPath);

		expect(activeErrorsOf(result).map(e => e.code)).not.toContain('LINK_TARGETS_DIRECTORY');
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

// ============================================================================
// validateSkillForPackaging — gitignored files: source (validate path)
// The gitignored-source warning was retired in issue #129: a files: source
// already declares full publish intent, so no warning fires.
// ============================================================================

describe('validateSkillForPackaging - gitignored files: source (validate path)', () => {
	it('does NOT emit any warning for an existing gitignored files: source (full publish intent declared)', async () => {
		const tempDir = getTempDir();
		const gitIgnoredSrc = 'secret.env';
		fs.writeFileSync(safePath.join(tempDir, gitIgnoredSrc), 'SECRET=hunter2');

		const skillPath = createMinimalSkill(tempDir);
		const tracker = { isIgnoredByActiveSet: (p: string) => p.endsWith(gitIgnoredSrc) };

		const result = await validateSkillForPackaging(
			skillPath,
			{ files: [{ source: gitIgnoredSrc, dest: 'config/secret.env' }] },
			'source',
			{ gitTracker: tracker as Parameters<typeof validateSkillForPackaging>[3] extends { gitTracker?: infer T } ? T : never },
		);

		// No warning for a gitignored source — the files: entry is the declaration of intent.
		const warnings = activeWarningsOf(result).filter(i => i.location === gitIgnoredSrc);
		expect(warnings).toHaveLength(0);
	});
});

describe('validateSkillForPackaging - deferred dest links (files: config)', () => {
	it('should succeed and emit LINK_DEFERRED_ARTIFACT info — not LINK_MISSING_TARGET — for a linked dest that does not exist on disk', async () => {
		const tempDir = getTempDir();
		// Skill links to 'scripts/cli.mjs' which is a files: dest (build artifact — absent from disk)
		const DEFERRED_DEST = 'scripts/cli.mjs';
		const skillContent = createSkillContent(
			{ name: TEST_SKILL_NAME, description: VALID_DESCRIPTION },
			`\n# Test Skill\n\nRun the CLI: [cli.mjs](./${DEFERRED_DEST}).`,
		);
		const { skillPath } = createTransitiveSkillStructure(tempDir, {}, skillContent);

		const result = await validateSkillForPackaging(skillPath, {
			files: [{ source: 'dist/cli.mjs', dest: DEFERRED_DEST }],
		});

		// Should not error — deferred dest is not a missing target
		expect(result.status).toBe('success');

		// No LINK_MISSING_TARGET — it was classified as deferred
		const missingIssue = result.allErrors.find(i => i.code === 'LINK_MISSING_TARGET');
		expect(missingIssue).toBeUndefined();

		// LINK_DEFERRED_ARTIFACT info issue should be present
		const deferredIssue = result.allErrors.find(i => i.code === 'LINK_DEFERRED_ARTIFACT');
		expect(deferredIssue).toBeDefined();
		expect(deferredIssue?.severity).toBe('info');
		expect(deferredIssue?.location).toBe(DEFERRED_DEST);
	});
});

/** Count non-overlapping occurrences of `needle` in `haystack` (literal, not regex). */
function countOccurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

/**
 * A fixture that emits at least one issue of EVERY severity, so a test can tell
 * the difference between "the partition is gone" and "there was nothing to
 * partition". Long body → SKILL_LENGTH_EXCEEDS_RECOMMENDED (warning), broken
 * link → LINK_MISSING_TARGET (error), DESCRIPTION_TOO_VAGUE demoted to info.
 */
async function setupMixedSeverityResult(tempDir: string): Promise<PackagingValidationResult> {
	const content = createSkillContent(
		{ name: TEST_SKILL_NAME, description: 'Short desc' },
		`${SKILL_HEADER}See [gone](./gone.md).\n\n${LINE_CONTENT.repeat(550)}`,
	);
	const { skillPath } = createTransitiveSkillStructure(tempDir, {}, content);
	return validateSkillForPackaging(skillPath, {
		validation: { severity: { DESCRIPTION_TOO_VAGUE: 'info' } },
	});
}

describe('PackagingValidationResult - allErrors is the sole container of issue records', () => {
	it('serializes every issue record exactly once (no active* partition re-serialized in full)', async () => {
		const result = await setupMixedSeverityResult(getTempDir());

		// Guard: without all three severities present the assertions below cannot
		// distinguish "deduplicated" from "empty".
		const bySeverity = (s: string): ValidationIssue[] => result.allErrors.filter(i => i.severity === s);
		expect(bySeverity('error').length).toBeGreaterThan(0);
		expect(bySeverity('warning').length).toBeGreaterThan(0);
		expect(bySeverity('info').length).toBeGreaterThan(0);

		// Same serializer options the `vat validate` YAML lane uses.
		const serialized = yaml.stringify(result, { indent: 2, lineWidth: 0, aliasDuplicateObjects: false });

		// The paragraph-length `fix:` prose is the bulk of an issue record. Each
		// distinct fix must appear exactly as many times as issues carry it.
		const fixes = new Map<string, number>();
		for (const issue of result.allErrors) {
			if (issue.fix) fixes.set(issue.fix, (fixes.get(issue.fix) ?? 0) + 1);
		}
		expect(fixes.size).toBeGreaterThan(0);
		for (const [fix, expected] of fixes) {
			expect(countOccurrences(serialized, fix), `fix prose re-serialized: ${fix}`).toBe(expected);
		}

		// Severity lines are a cheap structural proxy: 2x means a full second copy.
		for (const severity of ['error', 'warning', 'info']) {
			expect(
				countOccurrences(serialized, `severity: ${severity}\n`),
				`severity: ${severity} lines`,
			).toBe(bySeverity(severity).length);
		}
	});
});

// ---------------------------------------------------------------------------
// E-glob: the pre-build gates surface FILES_GLOB_DROPPED_NEVER_PACKAGED.
//
// It used to fire only during a build that got far enough to package. `vat
// skills validate` and `vat audit` expand the same globs against the same tree
// and can say the same thing without writing anything — which matters because a
// glob whose base is documentation-bearing loses content silently the day
// someone adds a README.md to it.
// ---------------------------------------------------------------------------

const GLOB_DROP_CODE = 'FILES_GLOB_DROPPED_NEVER_PACKAGED';
const GLOB_UNMATCHED_CODE = 'FILES_GLOB_MATCHED_NOTHING';
const GLOB_ALL_REFUSED_CODE = 'FILES_GLOB_MATCHED_ONLY_NEVER_PACKAGED';
// The glob's SOURCE dir differs from its DEST on purpose: where the two spell
// the same path, this fixture could not tell a finding anchored at the source
// file from one anchored at the would-be dest.
const EXTRAS_SRC_DIR = 'gen/extras';
const EXTRAS_GLOB_SOURCE = `${EXTRAS_SRC_DIR}/**/*`;
const EXTRAS_DEST = 'extras';
const EXTRAS_README_SOURCE = `${EXTRAS_SRC_DIR}/README.md`;
const EXTRAS_README_DEST = 'extras/README.md';
const UNBUILT_GLOB_SOURCE = 'dist/not-built/**/*';

/** Validate a skill whose tree has `gen/extras/{keep.json,README.md}`. */
async function validateWithExtras(
	files: Array<{ source: string; dest: string }>,
): Promise<PackagingValidationResult> {
	const tempDir = getTempDir();
	const skillContent = createSkillContent(
		{ name: TEST_SKILL_NAME, description: VALID_DESCRIPTION },
		SKILL_HEADER,
	);
	const { skillPath } = createTransitiveSkillStructure(
		tempDir,
		{ [`${EXTRAS_SRC_DIR}/keep.json`]: '{}\n', [EXTRAS_README_SOURCE]: '# extras\n' },
		skillContent,
	);
	return validateSkillForPackaging(skillPath, { files });
}

describe('glob files: drops are reported before any build', () => {
	it('reports the never-packaged file a glob would catch, anchored at that file', async () => {
		const result = await validateWithExtras([{ source: EXTRAS_GLOB_SOURCE, dest: EXTRAS_DEST }]);

		const drops = result.allErrors.filter((i: ValidationIssue) => i.code === GLOB_DROP_CODE);
		expect(drops).toHaveLength(1);
		expect(drops[0]?.severity).toBe('warning');
		// The source file, which exists and can be opened — not the dest, which by
		// definition was never written.
		expect(drops[0]?.location).toBe(EXTRAS_README_SOURCE);
		expect(drops[0]?.message).toContain(EXTRAS_README_SOURCE);
		expect(drops[0]?.message).toContain(EXTRAS_GLOB_SOURCE);
	});

	it('stays silent when an explicit entry re-ships the dropped file', async () => {
		const result = await validateWithExtras([
			{ source: EXTRAS_GLOB_SOURCE, dest: EXTRAS_DEST },
			{ source: EXTRAS_README_SOURCE, dest: EXTRAS_README_DEST },
		]);

		expect(result.allErrors.filter((i: ValidationIssue) => i.code === GLOB_DROP_CODE)).toEqual([]);
	});

	it('stays silent for a config with no glob entries at all', async () => {
		const result = await validateWithExtras([
			{ source: `${EXTRAS_SRC_DIR}/keep.json`, dest: 'keep.json' },
		]);

		expect(result.allErrors.filter((i: ValidationIssue) => i.code === GLOB_DROP_CODE)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// The pre-build gate must also predict the glob failure that KILLS the build.
//
// `vat skills build` dies on a glob that matches nothing ("has your build
// run?"). This gate — the one adopters run in CI *before* the build — used to
// report `success` with zero findings on exactly that input, while reporting the
// drop that is harmless by design. Severity stays `info` because matching
// nothing before the artifact exists is the expected state; silence was the bug.
// ---------------------------------------------------------------------------
describe('glob files: entries that currently match nothing are reported before any build', () => {
	it('reports the unmatched glob, naming the pattern and the build consequence', async () => {
		const result = await validateWithExtras([{ source: UNBUILT_GLOB_SOURCE, dest: 'packs' }]);

		const unmatched = result.allErrors.filter(
			(i: ValidationIssue) => i.code === GLOB_UNMATCHED_CODE,
		);
		expect(unmatched).toHaveLength(1);
		expect(unmatched[0]?.severity).toBe('info');
		expect(unmatched[0]?.location).toBe('dist/not-built');
		expect(unmatched[0]?.message).toContain(UNBUILT_GLOB_SOURCE);
		expect(unmatched[0]?.message).toMatch(/build/i);
	});

	it('stays silent for a glob that matches at least one file', async () => {
		const result = await validateWithExtras([{ source: EXTRAS_GLOB_SOURCE, dest: EXTRAS_DEST }]);

		expect(
			result.allErrors.filter((i: ValidationIssue) => i.code === GLOB_UNMATCHED_CODE),
		).toEqual([]);
	});

	it('stays silent for a non-glob entry whose source does not exist', async () => {
		// A missing single-file source is the BUILD's error to raise; this code is
		// about a pattern that expanded to nothing, and a non-glob entry has no
		// expansion at all.
		const result = await validateWithExtras([{ source: 'dist/cli.mjs', dest: 'cli.mjs' }]);

		expect(
			result.allErrors.filter((i: ValidationIssue) => i.code === GLOB_UNMATCHED_CODE),
		).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// The third population: the glob matched, and NOTHING it matched can ship.
//
// `vat skills build` has a second, distinct hard error for this ("matched N
// file(s) … but all of them are never packaged") — deliberately not "has your
// build run?", because the build HAS run. The gate emitted only the per-file
// drops here: the harmless half of the same silence R4 closed for the
// zero-match case. `warning`, not `error`, for the same reason the zero-match is
// `info`: a pre-build tree can be a PARTIAL artifact as easily as an absent one.
// ---------------------------------------------------------------------------
describe('glob files: entries that can ship nothing are reported before any build', () => {
	// Matches README.md only — keep.json is excluded by the extension, so every
	// match is refused. Distinct from the partial fixture (`gen/extras/**/*`,
	// which also nets keep.json) and from the unbuilt one (which matches nothing).
	const ALL_REFUSED_GLOB_SOURCE = `${EXTRAS_SRC_DIR}/*.md`;

	it('reports the entry once, naming the refused file and the pattern', async () => {
		const result = await validateWithExtras([
			{ source: ALL_REFUSED_GLOB_SOURCE, dest: EXTRAS_DEST },
		]);

		const inert = result.allErrors.filter(
			(i: ValidationIssue) => i.code === GLOB_ALL_REFUSED_CODE,
		);
		expect(inert).toHaveLength(1);
		expect(inert[0]?.severity).toBe('warning');
		expect(inert[0]?.location).toBe(EXTRAS_SRC_DIR);
		expect(inert[0]?.message).toContain(ALL_REFUSED_GLOB_SOURCE);
		expect(inert[0]?.message).toContain(EXTRAS_README_SOURCE);
	});

	// The three verdicts must be mutually exclusive at the gate too, or a reader
	// gets two causes for one entry.
	it('reports neither a per-file drop nor an unmatched glob for the same entry', async () => {
		const result = await validateWithExtras([
			{ source: ALL_REFUSED_GLOB_SOURCE, dest: EXTRAS_DEST },
		]);

		expect(result.allErrors.filter((i: ValidationIssue) => i.code === GLOB_DROP_CODE)).toEqual([]);
		expect(
			result.allErrors.filter((i: ValidationIssue) => i.code === GLOB_UNMATCHED_CODE),
		).toEqual([]);
	});

	it('stays silent for a glob that still ships something', async () => {
		const result = await validateWithExtras([{ source: EXTRAS_GLOB_SOURCE, dest: EXTRAS_DEST }]);

		expect(
			result.allErrors.filter((i: ValidationIssue) => i.code === GLOB_ALL_REFUSED_CODE),
		).toEqual([]);
	});
});
