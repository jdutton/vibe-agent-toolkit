import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

/**
 * Marketplace source - GitHub or local file
 */
const MarketplaceSourceSchema = z
	.discriminatedUnion('source', [
		z
			.object({
				source: z.literal('github'),
				repo: z
					.string()
					.regex(/^[^/]+\/[^/]+$/, 'Must be in format "owner/repo"'),
			})
			.strict()
			.describe('GitHub repository'),

		z
			.object({
				source: z.literal('file'),
				path: z.string(),
			})
			.strict()
			.describe('Local file path'),
	])
	.describe('Marketplace source location');

/**
 * Single marketplace registry entry
 */
const MarketplaceEntrySchema = z
	.object({
		source: MarketplaceSourceSchema.describe('Marketplace source location'),

		installLocation: z
			.string()
			.describe('Absolute path to marketplace installation'),

		lastUpdated: z
			.string()
			.datetime()
			.describe('ISO 8601 last update timestamp'),
	})
	.strict()
	.describe('Single marketplace registry entry');

/**
 * Schema for known_marketplaces.json registry
 * Tracks all known marketplace sources
 *
 * Format: { "marketplace-name": { source, installLocation, lastUpdated } }
 */
export const KnownMarketplacesRegistrySchema = z
	.record(z.string().min(1), MarketplaceEntrySchema)
	.describe('Known marketplaces registry structure');

export type KnownMarketplacesRegistry = z.infer<
	typeof KnownMarketplacesRegistrySchema
>;
export type MarketplaceEntry = z.infer<typeof MarketplaceEntrySchema>;
export type MarketplaceSource = z.infer<typeof MarketplaceSourceSchema>;

export const KnownMarketplacesRegistryJsonSchema = zodToJsonSchema(
	KnownMarketplacesRegistrySchema,
	{ name: 'KnownMarketplacesRegistry', $refStrategy: 'none' }
);
