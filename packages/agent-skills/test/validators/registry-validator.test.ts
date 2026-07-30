
/* eslint-disable sonarjs/no-duplicate-string -- Test descriptions naturally repeat */
/* eslint-disable security/detect-non-literal-fs-filename -- Test files use controlled temp directories */
import * as fs from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
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
	const registryPath = safePath.join(tempDir, fileName);
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

		const registryPath = safePath.join(getTempDir(), 'installed_plugins.json');
		fs.writeFileSync(registryPath, JSON.stringify(validRegistry, null, 2));

		const result = await validateInstalledPluginsRegistry(registryPath);

		assertValidationSuccess(result);
		expect(result.type).toBe('registry');
		expect(result.summary).toBe('Valid installed plugins registry');
		expect(result.metadata).toBeUndefined();
	});

	it('should fail when registry file does not exist', async () => {
		const nonExistentPath = safePath.join(getTempDir(), 'nonexistent.json');

		const result = await validateInstalledPluginsRegistry(nonExistentPath);

		assertSingleError(result, 'REGISTRY_MISSING_FILE');
		expect(result.summary).toBe('Registry file not found');
		// `location` is project-relative (anchor contract) — the temp dir has no
		// enclosing config or git root, so the file's own directory is the root.
		expect(result.issues[0]?.location).toBe('nonexistent.json');
		expect(result.issues[0]?.fix).toContain('Create the registry file');
	});

	it('should fail when registry file has invalid JSON', async () => {
		const registryPath = safePath.join(getTempDir(), 'invalid.json');
		fs.writeFileSync(registryPath, '{ invalid json }');

		const result = await validateInstalledPluginsRegistry(registryPath);

		assertSingleError(result, 'REGISTRY_INVALID_JSON');
		expect(result.summary).toBe('Registry file is invalid JSON');
		expect(result.issues[0]?.location).toBe('invalid.json');
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

	// Regression: the registry is Claude Code's own file. Modelling it strictly
	// turned every shape Claude Code added into a wall of false errors.
	describe('liberal reading of a registry VAT does not own', () => {
		const CURRENT_CLAUDE_CODE_ENTRY = {
			scope: 'project',
			projectPath: '/Users/someone/Workspaces/some-project',
			installPath: '/path/to/plugin',
			version: '1.0.0',
			installedAt: '2025-01-01T00:00:00.000Z',
			lastUpdated: '2025-01-01T00:00:00.000Z',
			gitCommitSha: 'abc123',
		};

		it("accepts scope 'project' with projectPath and no isLocal", async () => {
			const result = await createAndValidateRegistry(
				getTempDir(),
				'project-scope.json',
				{ version: 2, plugins: { 'test@marketplace': [CURRENT_CLAUDE_CODE_ENTRY] } },
				validateInstalledPluginsRegistry,
			);

			assertValidationSuccess(result as Parameters<typeof assertValidationSuccess>[0]);
		});

		it('absorbs an unknown field and reports it as REGISTRY_SHAPE_DRIFT instead of an error', async () => {
			const result = (await createAndValidateRegistry(
				getTempDir(),
				'drifted.json',
				{
					version: 2,
					plugins: {
						'test@marketplace': [{ ...CURRENT_CLAUDE_CODE_ENTRY, futureField: 'unknown' }],
					},
				},
				validateInstalledPluginsRegistry,
			)) as { status: string; issues: Array<{ code: string; severity: string; field?: string }> };

			expect(result.issues.some((i) => i.code === 'REGISTRY_INVALID_SCHEMA')).toBe(false);

			const drift = result.issues.filter((i) => i.code === 'REGISTRY_SHAPE_DRIFT');
			expect(drift).toHaveLength(1);
			expect(drift[0]?.severity).toBe('info');
			expect(drift[0]?.field).toBe('plugins.test@marketplace.0.futureField');
			// info-only findings must not fail the run
			expect(result.status).not.toBe('error');
		});

		it('emits no drift issue when the registry uses only recognized shapes', async () => {
			const result = (await createAndValidateRegistry(
				getTempDir(),
				'no-drift.json',
				{ version: 2, plugins: { 'test@marketplace': [CURRENT_CLAUDE_CODE_ENTRY] } },
				validateInstalledPluginsRegistry,
			)) as { issues: Array<{ code: string }> };

			expect(result.issues.some((i) => i.code === 'REGISTRY_SHAPE_DRIFT')).toBe(false);
		});

		it('still errors on a genuinely malformed registry, and does not add drift noise', async () => {
			const result = (await createAndValidateRegistry(
				getTempDir(),
				'malformed.json',
				{ version: 7, plugins: { 'no-at-sign': 'not-an-array' } },
				validateInstalledPluginsRegistry,
			)) as { status: string; issues: Array<{ code: string }> };

			assertSchemaError(result);
			expect(result.issues.some((i) => i.code === 'REGISTRY_SHAPE_DRIFT')).toBe(false);
		});
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

		const registryPath = safePath.join(getTempDir(), 'known_marketplaces.json');
		fs.writeFileSync(registryPath, JSON.stringify(validRegistry, null, 2));

		const result = await validateKnownMarketplacesRegistry(registryPath);

		assertValidationSuccess(result);
		expect(result.type).toBe('registry');
		expect(result.summary).toBe('Valid known marketplaces registry');
		expect(result.metadata).toBeUndefined();
	});

	it('should fail when registry file does not exist', async () => {
		const nonExistentPath = safePath.join(getTempDir(), 'nonexistent.json');

		const result = await validateKnownMarketplacesRegistry(nonExistentPath);

		assertSingleError(result, 'REGISTRY_MISSING_FILE');
		expect(result.summary).toBe('Registry file not found');
		// `location` is project-relative (anchor contract) — the temp dir has no
		// enclosing config or git root, so the file's own directory is the root.
		expect(result.issues[0]?.location).toBe('nonexistent.json');
	});

	it('should fail when registry file has invalid JSON', async () => {
		const registryPath = safePath.join(getTempDir(), 'invalid.json');
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

	// known_marketplaces.json is Claude Code's file, not VAT's. Both shapes below used
	// to be hard errors and both occur in the wild: a `file` source with no `path`, and
	// a `directory` source kind. Per Postel's Law (CLAUDE.md) they are absorbed.
	//
	// The unrecognized *kind* additionally carries an info-severity REGISTRY_SHAPE_DRIFT
	// issue, now that detectKnownMarketplacesRegistryDrift is wired into
	// validateKnownMarketplacesRegistry. That is why these assert on status and on the
	// absence of REGISTRY_INVALID_SCHEMA, rather than on an issue count — an absorbed
	// shape is allowed to be *observed*, it is just not allowed to be an error.
	it.each([
		{
			label: 'a source with no path',
			file: 'missing-path.json',
			source: { source: 'file' },
		},
		{
			label: 'an unrecognized source kind',
			file: 'invalid-source.json',
			source: { source: 'directory', path: '/path' },
		},
	])('should absorb $label rather than erroring', async ({ file, source }) => {
		const result = (await createAndValidateRegistry(
			getTempDir(),
			file,
			{
				'test-marketplace': {
					source,
					installLocation: '/path',
					lastUpdated: '2025-01-01T00:00:00.000Z',
				},
			},
			validateKnownMarketplacesRegistry,
		)) as { status: string; issues: Array<{ code: string }> };

		expect(result.issues.some((i) => i.code === 'REGISTRY_INVALID_SCHEMA')).toBe(false);
		expect(result.status).not.toBe('error');
	});

	// Positive control: liberal must not mean blind. The structural spine is still enforced.
	it('should still fail when an entry is not an object at all', async () => {
		const result = await createAndValidateRegistry(
			getTempDir(),
			'not-an-object.json',
			{ 'test-marketplace': 'https://example.com/marketplace' },
			validateKnownMarketplacesRegistry,
		);

		assertSchemaError(result);
	});
});
