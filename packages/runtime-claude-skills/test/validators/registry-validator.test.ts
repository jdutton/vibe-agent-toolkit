/* eslint-disable sonarjs/no-duplicate-string -- Test descriptions naturally repeat */
/* eslint-disable security/detect-non-literal-fs-filename -- Test files use controlled temp directories */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
	validateInstalledPluginsRegistry,
	validateKnownMarketplacesRegistry,
} from '../../src/validators/registry-validator.js';
import {
	assertSingleError,
	assertValidationSuccess,
	setupTempDir,
} from '../test-helpers.js';

/**
 * Helper to create and validate a registry file
 */
async function createAndValidateRegistry(
	tempDir: string,
	fileName: string,
	data: unknown,
	validatorFn: (path: string) => Promise<unknown>,
): Promise<unknown> {
	const registryPath = path.join(tempDir, fileName);
	fs.writeFileSync(registryPath, JSON.stringify(data, null, 2));
	return validatorFn(registryPath);
}

/**
 * Helper to assert schema validation errors
 */
function assertSchemaError(result: unknown): void {
	const validationResult = result as { status: string; issues: Array<{ code: string }> };
	expect(validationResult.status).toBe('error');
	expect(
		validationResult.issues.some((i) => i.code === 'REGISTRY_INVALID_SCHEMA'),
	).toBe(true);
}

describe('validateInstalledPluginsRegistry', () => {
	const { getTempDir } = setupTempDir('registry-validator-installed-');

	it('should validate a valid installed plugins registry', async () => {
		const validRegistry = {
			version: 2,
			plugins: {
				'test-plugin@test-marketplace': [
					{
						scope: 'user',
						installPath: '/path/to/plugin',
						version: '1.0.0',
						installedAt: '2025-01-01T00:00:00.000Z',
						lastUpdated: '2025-01-01T00:00:00.000Z',
						gitCommitSha: 'abc123',
						isLocal: false,
					},
				],
			},
		};

		const registryPath = path.join(getTempDir(), 'installed_plugins.json');
		fs.writeFileSync(registryPath, JSON.stringify(validRegistry, null, 2));

		const result = await validateInstalledPluginsRegistry(registryPath);

		assertValidationSuccess(result);
		expect(result.type).toBe('registry');
		expect(result.summary).toBe('Valid installed plugins registry');
		expect(result.metadata).toBeUndefined();
	});

	it('should fail when registry file does not exist', async () => {
		const nonExistentPath = path.join(getTempDir(), 'nonexistent.json');

		const result = await validateInstalledPluginsRegistry(nonExistentPath);

		assertSingleError(result, 'REGISTRY_MISSING_FILE');
		expect(result.summary).toBe('Registry file not found');
		expect(result.issues[0]?.location).toBe(nonExistentPath);
		expect(result.issues[0]?.fix).toContain('Create the registry file');
	});

	it('should fail when registry file has invalid JSON', async () => {
		const registryPath = path.join(getTempDir(), 'invalid.json');
		fs.writeFileSync(registryPath, '{ invalid json }');

		const result = await validateInstalledPluginsRegistry(registryPath);

		assertSingleError(result, 'REGISTRY_INVALID_JSON');
		expect(result.summary).toBe('Registry file is invalid JSON');
		expect(result.issues[0]?.location).toBe(registryPath);
		expect(result.issues[0]?.message).toContain('Failed to parse');
	});

	it('should fail when registry is missing version field', async () => {
		const result = await createAndValidateRegistry(
			getTempDir(),
			'no-version.json',
			{ plugins: {} },
			validateInstalledPluginsRegistry,
		);

		assertSchemaError(result);
		expect((result as { issues: unknown[] }).issues.length).toBeGreaterThan(0);
	});

	it('should fail when registry has invalid version number', async () => {
		const result = await createAndValidateRegistry(
			getTempDir(),
			'wrong-version.json',
			{ version: 1, plugins: {} },
			validateInstalledPluginsRegistry,
		);

		assertSchemaError(result);
	});

	it('should fail when plugin key format is invalid', async () => {
		const result = await createAndValidateRegistry(
			getTempDir(),
			'invalid-key.json',
			{
				version: 2,
				plugins: {
					'invalid-key-no-at-sign': [
						{
							scope: 'user',
							installPath: '/path',
							version: '1.0.0',
							installedAt: '2025-01-01T00:00:00.000Z',
							lastUpdated: '2025-01-01T00:00:00.000Z',
							gitCommitSha: 'abc',
							isLocal: false,
						},
					],
				},
			},
			validateInstalledPluginsRegistry,
		);

		assertSchemaError(result);
	});

	it('should fail when plugin installation is missing required fields', async () => {
		const result = await createAndValidateRegistry(
			getTempDir(),
			'missing-fields.json',
			{
				version: 2,
				plugins: {
					'test@marketplace': [
						{
							scope: 'user',
							installPath: '/path',
						},
					],
				},
			},
			validateInstalledPluginsRegistry,
		);

		assertSchemaError(result);
		expect((result as { issues: unknown[] }).issues.length).toBeGreaterThan(1);
	});
});

describe('validateKnownMarketplacesRegistry', () => {
	const { getTempDir } = setupTempDir('registry-validator-marketplaces-');

	it('should validate a valid known marketplaces registry', async () => {
		const validRegistry = {
			'test-marketplace': {
				source: {
					source: 'github',
					repo: 'owner/repo',
				},
				installLocation: '/path/to/marketplace',
				lastUpdated: '2025-01-01T00:00:00.000Z',
			},
			'local-marketplace': {
				source: {
					source: 'file',
					path: '/path/to/local',
				},
				installLocation: '/path/to/local',
				lastUpdated: '2025-01-01T00:00:00.000Z',
			},
		};

		const registryPath = path.join(getTempDir(), 'known_marketplaces.json');
		fs.writeFileSync(registryPath, JSON.stringify(validRegistry, null, 2));

		const result = await validateKnownMarketplacesRegistry(registryPath);

		assertValidationSuccess(result);
		expect(result.type).toBe('registry');
		expect(result.summary).toBe('Valid known marketplaces registry');
		expect(result.metadata).toBeUndefined();
	});

	it('should fail when registry file does not exist', async () => {
		const nonExistentPath = path.join(getTempDir(), 'nonexistent.json');

		const result = await validateKnownMarketplacesRegistry(nonExistentPath);

		assertSingleError(result, 'REGISTRY_MISSING_FILE');
		expect(result.summary).toBe('Registry file not found');
		expect(result.issues[0]?.location).toBe(nonExistentPath);
	});

	it('should fail when registry file has invalid JSON', async () => {
		const registryPath = path.join(getTempDir(), 'invalid.json');
		fs.writeFileSync(registryPath, '{ bad: json }');

		const result = await validateKnownMarketplacesRegistry(registryPath);

		assertSingleError(result, 'REGISTRY_INVALID_JSON');
		expect(result.summary).toBe('Registry file is invalid JSON');
	});

	it('should fail when marketplace entry is missing required fields', async () => {
		const result = await createAndValidateRegistry(
			getTempDir(),
			'missing-fields.json',
			{
				'test-marketplace': {
					source: { source: 'github', repo: 'owner/repo' },
				},
			},
			validateKnownMarketplacesRegistry,
		);

		assertSchemaError(result);
	});

	it('should fail when GitHub source has invalid repo format', async () => {
		const result = await createAndValidateRegistry(
			getTempDir(),
			'invalid-repo.json',
			{
				'test-marketplace': {
					source: { source: 'github', repo: 'invalid-no-slash' },
					installLocation: '/path',
					lastUpdated: '2025-01-01T00:00:00.000Z',
				},
			},
			validateKnownMarketplacesRegistry,
		);

		assertSchemaError(result);
	});

	it('should fail when file source is missing path', async () => {
		const result = await createAndValidateRegistry(
			getTempDir(),
			'missing-path.json',
			{
				'test-marketplace': {
					source: { source: 'file' },
					installLocation: '/path',
					lastUpdated: '2025-01-01T00:00:00.000Z',
				},
			},
			validateKnownMarketplacesRegistry,
		);

		assertSchemaError(result);
	});

	it('should fail when source type is invalid', async () => {
		const result = await createAndValidateRegistry(
			getTempDir(),
			'invalid-source.json',
			{
				'test-marketplace': {
					source: { source: 'invalid', repo: 'owner/repo' },
					installLocation: '/path',
					lastUpdated: '2025-01-01T00:00:00.000Z',
				},
			},
			validateKnownMarketplacesRegistry,
		);

		assertSchemaError(result);
	});
});
