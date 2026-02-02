import { afterEach, describe, expect, it } from 'vitest';


import {
	KnownMarketplacesRegistrySchema,
	type KnownMarketplacesRegistry,
} from '../../src/schemas/known-marketplaces-registry.js';
import {
	assertValidationError,
	cleanupTestFiles,
	loadRegistryFixture,
} from '../test-helpers.js';

const TEST_GITHUB_SOURCE = {
	source: 'github' as const,
	repo: 'owner/repo',
};

const TEST_INSTALL_LOCATION = '/path/to/marketplace';
const TEST_TIMESTAMP = '2026-01-04T12:00:00.000Z';

describe('KnownMarketplacesRegistrySchema', () => {
	afterEach(() => {
		cleanupTestFiles();
	});

	describe('valid registries', () => {
		it('should validate known-good known_marketplaces.json', () => {
			const knownGood = loadRegistryFixture('known_marketplaces.json');
			const result = KnownMarketplacesRegistrySchema.safeParse(knownGood);

			expect(result.success).toBe(true);
			if (result.success) {
				expect(typeof result.data).toBe('object');

				// Check that all entries have required fields
				for (const entry of Object.values(result.data)) {
					expect(entry.source).toBeDefined();
					expect(entry.installLocation).toBeDefined();
					expect(entry.lastUpdated).toBeDefined();
				}
			}
		});

		it('should validate registry with GitHub source', () => {
			const registry: KnownMarketplacesRegistry = {
				'test-marketplace': {
					source: TEST_GITHUB_SOURCE,
					installLocation: TEST_INSTALL_LOCATION,
					lastUpdated: TEST_TIMESTAMP,
				},
			};

			const result = KnownMarketplacesRegistrySchema.safeParse(registry);
			expect(result.success).toBe(true);
		});

		it('should validate registry with file source', () => {
			const registry: KnownMarketplacesRegistry = {
				'local-marketplace': {
					source: {
						source: 'file',
						path: '/local/path',
					},
					installLocation: TEST_INSTALL_LOCATION,
					lastUpdated: TEST_TIMESTAMP,
				},
			};

			const result = KnownMarketplacesRegistrySchema.safeParse(registry);
			expect(result.success).toBe(true);
		});
	});

	describe('validation errors', () => {
		it('should reject entry missing source field', () => {
			const invalid = {
				'test-marketplace': {
					installLocation: TEST_INSTALL_LOCATION,
					lastUpdated: TEST_TIMESTAMP,
				},
			};

			assertValidationError(
				KnownMarketplacesRegistrySchema,
				invalid,
				'source',
				'Required'
			);
		});

		it('should reject entry missing installLocation field', () => {
			const invalid = {
				'test-marketplace': {
					source: TEST_GITHUB_SOURCE,
					lastUpdated: TEST_TIMESTAMP,
				},
			};

			assertValidationError(
				KnownMarketplacesRegistrySchema,
				invalid,
				'installLocation',
				'Required'
			);
		});

		it('should reject entry missing lastUpdated field', () => {
			const invalid = {
				'test-marketplace': {
					source: TEST_GITHUB_SOURCE,
					installLocation: TEST_INSTALL_LOCATION,
				},
			};

			assertValidationError(
				KnownMarketplacesRegistrySchema,
				invalid,
				'lastUpdated',
				'Required'
			);
		});

		it('should reject invalid source type', () => {
			const invalid = {
				'test-marketplace': {
					source: {
						source: 'invalid-source',
					},
					installLocation: TEST_INSTALL_LOCATION,
					lastUpdated: TEST_TIMESTAMP,
				},
			};

			assertValidationError(
				KnownMarketplacesRegistrySchema,
				invalid,
				'source',
				'Invalid discriminator value'
			);
		});

		it('should reject GitHub source with invalid repo format', () => {
			const invalid = {
				'test-marketplace': {
					source: {
						source: 'github',
						repo: 'invalid-no-slash',
					},
					installLocation: TEST_INSTALL_LOCATION,
					lastUpdated: TEST_TIMESTAMP,
				},
			};

			assertValidationError(
				KnownMarketplacesRegistrySchema,
				invalid,
				'repo',
				'Must be in format "owner/repo"'
			);
		});

		it('should reject file source missing path', () => {
			const invalid = {
				'test-marketplace': {
					source: {
						source: 'file',
					},
					installLocation: TEST_INSTALL_LOCATION,
					lastUpdated: TEST_TIMESTAMP,
				},
			};

			assertValidationError(
				KnownMarketplacesRegistrySchema,
				invalid,
				'path',
				'Required'
			);
		});

		it('should reject invalid datetime format', () => {
			const invalid = {
				'test-marketplace': {
					source: TEST_GITHUB_SOURCE,
					installLocation: TEST_INSTALL_LOCATION,
					lastUpdated: 'not-a-date',
				},
			};

			assertValidationError(
				KnownMarketplacesRegistrySchema,
				invalid,
				'lastUpdated',
				'Invalid datetime'
			);
		});

		it('should reject entry with extra fields', () => {
			const invalid = {
				'test-marketplace': {
					source: TEST_GITHUB_SOURCE,
					installLocation: TEST_INSTALL_LOCATION,
					lastUpdated: TEST_TIMESTAMP,
					extraField: 'not-allowed',
				},
			};

			assertValidationError(
				KnownMarketplacesRegistrySchema,
				invalid,
				'test-marketplace',
				'Unrecognized key'
			);
		});

		it('should reject empty marketplace name', () => {
			const invalid = {
				'': {
					source: TEST_GITHUB_SOURCE,
					installLocation: TEST_INSTALL_LOCATION,
					lastUpdated: TEST_TIMESTAMP,
				},
			};

			assertValidationError(
				KnownMarketplacesRegistrySchema,
				invalid,
				'',
				'String must contain at least 1 character'
			);
		});
	});
});
