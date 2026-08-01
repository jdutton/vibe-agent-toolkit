import { CODE_REGISTRY } from '@vibe-agent-toolkit/agent-schema';
import { afterEach, describe, expect, it } from 'vitest';


import {
	detectKnownMarketplacesRegistryDrift,
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

const MARKETPLACE_NAME = 'test-marketplace';

/** Wrap one marketplace entry in a registry keyed by {@link MARKETPLACE_NAME}. */
function registryWithEntry(entry: Record<string, unknown>): unknown {
	return { [MARKETPLACE_NAME]: entry };
}

/**
 * Shapes Claude Code actually writes into `~/.claude/plugins/known_marketplaces.json`
 * today: a git `ref` alongside `repo`, and a `directory` source kind. Neither
 * appeared in VAT's model, so both used to be hard errors.
 */
const REAL_WORLD_REGISTRY = {
	'pinned-github-marketplace': {
		source: {
			source: 'github',
			repo: 'owner/repo',
			ref: 'claude-marketplace',
		},
		installLocation: '/home/someone/.claude/plugins/marketplaces/pinned',
		lastUpdated: TEST_TIMESTAMP,
	},
	'local-directory-marketplace': {
		source: {
			source: 'directory',
			path: '/home/someone/.claude/plugins/marketplaces/local',
		},
		installLocation: '/home/someone/.claude/plugins/marketplaces/local',
		lastUpdated: TEST_TIMESTAMP,
	},
};

// known_marketplaces.json is written and owned by Claude Code — VAT only reads it.
// Postel's Law (CLAUDE.md): "Reading outside world → liberal". Every case below is
// a shape the real file carries or could carry, and every one used to be an error.
describe('KnownMarketplacesRegistrySchema — liberal reading of external data', () => {
	it('accepts the shapes current Claude Code writes (github ref, directory source)', () => {
		const result = KnownMarketplacesRegistrySchema.safeParse(REAL_WORLD_REGISTRY);

		expect(result.success).toBe(true);
	});

	it('absorbs an unknown entry-level field instead of erroring', () => {
		const result = KnownMarketplacesRegistrySchema.safeParse(
			registryWithEntry({
				source: TEST_GITHUB_SOURCE,
				installLocation: TEST_INSTALL_LOCATION,
				lastUpdated: TEST_TIMESTAMP,
				autoUpdate: true,
			})
		);

		expect(result.success).toBe(true);
	});

	it('absorbs an unknown field inside the source instead of erroring', () => {
		const result = KnownMarketplacesRegistrySchema.safeParse(
			registryWithEntry({
				source: { ...TEST_GITHUB_SOURCE, subdirectory: 'plugins' },
				installLocation: TEST_INSTALL_LOCATION,
				lastUpdated: TEST_TIMESTAMP,
			})
		);

		expect(result.success).toBe(true);
	});

	it('absorbs an unrecognized source kind instead of erroring', () => {
		const result = KnownMarketplacesRegistrySchema.safeParse(
			registryWithEntry({
				source: { source: 'npm', package: '@scope/marketplace' },
				installLocation: TEST_INSTALL_LOCATION,
				lastUpdated: TEST_TIMESTAMP,
			})
		);

		expect(result.success).toBe(true);
	});

	it('accepts a timestamp carrying a UTC offset rather than a Z suffix', () => {
		const result = KnownMarketplacesRegistrySchema.safeParse(
			registryWithEntry({
				source: TEST_GITHUB_SOURCE,
				installLocation: TEST_INSTALL_LOCATION,
				lastUpdated: '2026-01-04T12:00:00.000+02:00',
			})
		);

		expect(result.success).toBe(true);
	});
});

// Passthrough alone would trade false errors for total blindness to real schema
// evolution. Drift detection is what keeps the liberality visible — at `info`,
// under the SAME REGISTRY_SHAPE_DRIFT code the installed-plugins registry uses.
describe('detectKnownMarketplacesRegistryDrift', () => {
	it('reports drift under the existing info-severity REGISTRY_SHAPE_DRIFT code', () => {
		expect(CODE_REGISTRY.REGISTRY_SHAPE_DRIFT.defaultSeverity).toBe('info');
	});

	it('reports nothing for a registry made only of recognized shapes', () => {
		expect(
			detectKnownMarketplacesRegistryDrift(
				loadRegistryFixture('known_marketplaces.json')
			)
		).toEqual([]);
	});

	it('reports nothing for the shapes current Claude Code writes (ref, directory)', () => {
		expect(detectKnownMarketplacesRegistryDrift(REAL_WORLD_REGISTRY)).toEqual([]);
	});

	it('reports an unknown entry-level field, pointing at the entry that carries it', () => {
		const drift = detectKnownMarketplacesRegistryDrift(
			registryWithEntry({
				source: TEST_GITHUB_SOURCE,
				installLocation: TEST_INSTALL_LOCATION,
				lastUpdated: TEST_TIMESTAMP,
				autoUpdate: true,
			})
		);

		expect(drift).toHaveLength(1);
		expect(drift[0]?.field).toBe(`${MARKETPLACE_NAME}.autoUpdate`);
		expect(drift[0]?.message).toContain('autoUpdate');
	});

	it('reports an unknown field inside the source', () => {
		const drift = detectKnownMarketplacesRegistryDrift(
			registryWithEntry({
				source: { ...TEST_GITHUB_SOURCE, subdirectory: 'plugins' },
				installLocation: TEST_INSTALL_LOCATION,
				lastUpdated: TEST_TIMESTAMP,
			})
		);

		expect(drift).toHaveLength(1);
		expect(drift[0]?.field).toBe(`${MARKETPLACE_NAME}.source.subdirectory`);
		expect(drift[0]?.message).toContain('subdirectory');
	});

	it('reports an unrecognized source kind', () => {
		const drift = detectKnownMarketplacesRegistryDrift(
			registryWithEntry({
				source: { source: 'npm' },
				installLocation: TEST_INSTALL_LOCATION,
				lastUpdated: TEST_TIMESTAMP,
			})
		);

		expect(drift).toHaveLength(1);
		expect(drift[0]?.field).toBe(`${MARKETPLACE_NAME}.source.source`);
		expect(drift[0]?.message).toContain('npm');
	});

	it('reports one observation per distinct unknown, not one per marketplace', () => {
		const entry = {
			source: TEST_GITHUB_SOURCE,
			installLocation: TEST_INSTALL_LOCATION,
			lastUpdated: TEST_TIMESTAMP,
			autoUpdate: true,
		};

		const drift = detectKnownMarketplacesRegistryDrift({
			a: entry,
			b: entry,
			c: entry,
		});

		expect(drift).toHaveLength(1);
	});

	it('reports nothing for a non-object input', () => {
		expect(detectKnownMarketplacesRegistryDrift('not a registry')).toEqual([]);
	});
});

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

	// Positive control for the liberality above: reading external data liberally
	// must not degrade into reading it blindly. The structural spine — an entry is
	// an object, with a source object, an installLocation string and a datetime —
	// is still enforced, because those are the fields VAT actually models.
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

		it('should reject a source that is a bare string rather than an object', () => {
			const invalid = registryWithEntry({
				source: 'github',
				installLocation: TEST_INSTALL_LOCATION,
				lastUpdated: TEST_TIMESTAMP,
			});

			assertValidationError(
				KnownMarketplacesRegistrySchema,
				invalid,
				'source',
				'Expected object'
			);
		});

		it('should reject a source whose kind is not a string', () => {
			const invalid = registryWithEntry({
				source: { source: 42 },
				installLocation: TEST_INSTALL_LOCATION,
				lastUpdated: TEST_TIMESTAMP,
			});

			assertValidationError(
				KnownMarketplacesRegistrySchema,
				invalid,
				'source.source',
				'Expected string'
			);
		});

		it('should reject a non-string installLocation', () => {
			const invalid = registryWithEntry({
				source: TEST_GITHUB_SOURCE,
				installLocation: 42,
				lastUpdated: TEST_TIMESTAMP,
			});

			assertValidationError(
				KnownMarketplacesRegistrySchema,
				invalid,
				'installLocation',
				'Expected string'
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
