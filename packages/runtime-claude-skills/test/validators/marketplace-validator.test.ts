/* eslint-disable sonarjs/no-duplicate-string -- Test literals are descriptive, duplication acceptable */
/* eslint-disable security/detect-non-literal-fs-filename -- test helpers use controlled temp directories */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { validateMarketplace } from '../../src/validators/marketplace-validator.js';
import {
	assertSingleError,
	assertValidationSuccess,
	setupTempDir,
} from '../test-helpers.js';

const { getTempDir } = setupTempDir('marketplace-validator-');

const TEST_OWNER = { name: 'Test Owner', email: 'test@example.com' };
const TEST_METADATA = { description: 'Test marketplace', version: '1.0.0' };

describe('validateMarketplace', () => {
	describe('valid marketplace', () => {
		it('should validate a simple marketplace successfully', async () => {
			const tempDir = getTempDir();
			const marketplaceDir = createTestMarketplace(tempDir, {
				name: 'test-marketplace',
				owner: TEST_OWNER,
				metadata: TEST_METADATA,
				plugins: [],
			});

			const result = await validateMarketplace(marketplaceDir);

			assertValidationSuccess(result);
			expect(result.type).toBe('marketplace');
			expect(result.metadata).toEqual({
				name: 'test-marketplace',
				version: '1.0.0',
			});
		});

		it('should validate marketplace with plugins', async () => {
			const tempDir = getTempDir();
			const marketplaceDir = createTestMarketplace(tempDir, {
				name: 'skills-marketplace',
				owner: {
					name: 'Skills Owner',
				},
				metadata: {
					description: 'Collection of skills',
					version: '2.0.0',
				},
				plugins: [
					{
						name: 'document-skills',
						description: 'Document processing suite',
						source: './',
						skills: ['./skills/pdf', './skills/xlsx'],
					},
				],
			});

			const result = await validateMarketplace(marketplaceDir);

			assertValidationSuccess(result);
			expect(result.metadata?.name).toBe('skills-marketplace');
			expect(result.metadata?.version).toBe('2.0.0');
		});
	});

	describe('missing manifest', () => {
		it('should fail when marketplace.json is missing', async () => {
			const tempDir = getTempDir();
			// Create directory without .claude-plugin/marketplace.json
			const marketplaceDir = `${tempDir}/empty-marketplace`;

			const result = await validateMarketplace(marketplaceDir);

			assertSingleError(result, 'MARKETPLACE_MISSING_MANIFEST');
			expect(result.issues[0]?.message).toContain('manifest not found');
			expect(result.issues[0]?.fix).toContain('marketplace.json');
		});
	});

	describe('invalid JSON', () => {
		it('should fail when marketplace.json has syntax errors', async () => {
			const tempDir = getTempDir();
			const marketplaceDir = createTestMarketplaceWithInvalidJson(
				tempDir,
				'{ "name": "test", invalid json }',
			);

			const result = await validateMarketplace(marketplaceDir);

			assertSingleError(result, 'MARKETPLACE_INVALID_JSON');
			expect(result.issues[0]?.message).toContain('parse');
			expect(result.issues[0]?.fix).toContain('JSON syntax');
		});
	});

	describe('invalid schema', () => {
		it('should fail when name is missing', async () => {
			const tempDir = getTempDir();
			const marketplaceDir = createTestMarketplace(tempDir, {
				owner: { name: 'Owner' },
				plugins: [],
			});

			const result = await validateMarketplace(marketplaceDir);

			expect(result.status).toBe('error');
			const nameError = result.issues.find((i) => i.code === 'MARKETPLACE_INVALID_SCHEMA');
			expect(nameError).toBeDefined();
			expect(nameError?.message).toContain('Required');
		});

		it('should fail when owner is missing', async () => {
			const tempDir = getTempDir();
			const marketplaceDir = createTestMarketplace(tempDir, {
				name: 'test-marketplace',
				plugins: [],
			});

			const result = await validateMarketplace(marketplaceDir);

			expect(result.status).toBe('error');
			const ownerError = result.issues.find((i) => i.code === 'MARKETPLACE_INVALID_SCHEMA');
			expect(ownerError).toBeDefined();
			expect(ownerError?.message).toContain('Required');
		});

		it('should fail when plugins is not an array', async () => {
			const tempDir = getTempDir();
			const marketplaceDir = createTestMarketplace(tempDir, {
				name: 'test-marketplace',
				owner: { name: 'Owner' },
				plugins: 'not-an-array' as never,
			});

			const result = await validateMarketplace(marketplaceDir);

			expect(result.status).toBe('error');
			const pluginsError = result.issues.find((i) => i.code === 'MARKETPLACE_INVALID_SCHEMA');
			expect(pluginsError).toBeDefined();
			expect(pluginsError?.fix).toBeDefined();
		});

		it('should fail when plugin is missing required fields', async () => {
			const tempDir = getTempDir();
			const marketplaceDir = createTestMarketplace(tempDir, {
				name: 'test-marketplace',
				owner: { name: 'Owner' },
				metadata: {
					description: 'Test',
					version: '1.0.0',
				},
				plugins: [
					{
						name: 'incomplete-plugin',
						// Missing description and source
					} as never,
				],
			});

			const result = await validateMarketplace(marketplaceDir);

			expect(result.status).toBe('error');
			expect(result.issues.some((i) => i.code === 'MARKETPLACE_INVALID_SCHEMA')).toBe(true);
		});

		it('should provide fix suggestions for schema errors', async () => {
			const tempDir = getTempDir();
			const marketplaceDir = createTestMarketplace(tempDir, {
				name: 'test-marketplace',
				owner: { name: 'Owner' },
				plugins: 123 as never, // Wrong type
			});

			const result = await validateMarketplace(marketplaceDir);

			expect(result.status).toBe('error');
			const schemaError = result.issues.find((i) => i.code === 'MARKETPLACE_INVALID_SCHEMA');
			expect(schemaError?.fix).toBeDefined();
			expect(schemaError?.fix).not.toBe('');
		});
	});
});

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Create a test marketplace directory with marketplace.json
 */
function createTestMarketplace(
	baseDir: string,
	marketplaceData: Record<string, unknown>,
	marketplaceName = 'test-marketplace',
): string {
	const marketplaceDir = `${baseDir}/${marketplaceName}`;
	const claudePluginDir = `${marketplaceDir}/.claude-plugin`;

	fs.mkdirSync(claudePluginDir, { recursive: true });

	const marketplaceJsonPath = path.join(claudePluginDir, 'marketplace.json');
	fs.writeFileSync(marketplaceJsonPath, JSON.stringify(marketplaceData, null, 2));

	return marketplaceDir;
}

/**
 * Create a test marketplace directory with invalid JSON content
 */
function createTestMarketplaceWithInvalidJson(
	baseDir: string,
	invalidJsonContent: string,
): string {
	const marketplaceDir = `${baseDir}/invalid-json-marketplace`;
	const claudePluginDir = `${marketplaceDir}/.claude-plugin`;

	fs.mkdirSync(claudePluginDir, { recursive: true });

	const marketplaceJsonPath = path.join(claudePluginDir, 'marketplace.json');
	fs.writeFileSync(marketplaceJsonPath, invalidJsonContent);

	return marketplaceDir;
}
