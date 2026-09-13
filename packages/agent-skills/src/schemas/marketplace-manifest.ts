import { hasParentTraversalSegment, isAbsoluteAnyPlatform } from '@vibe-agent-toolkit/utils';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

/**
 * Schema for .claude-plugin/marketplace.json manifest
 * Based on official Claude Code marketplace format
 * @see https://code.claude.com/docs/en/plugin-marketplaces
 *
 * Uses .passthrough() per Postel's Law — we're reading external files
 * and must tolerate unknown fields from the evolving official spec.
 *
 * Official source types for plugin entries:
 *   - string: relative path (e.g. "./plugins/my-plugin")
 *   - { source: "github", repo, ref?, sha? }
 *   - { source: "url", url, ref?, sha? }
 *   - { source: "npm", package, version?, registry? }
 *   - { source: "pip", package, version?, registry? }
 */

const OwnerSchema = z
	.object({
		name: z.string().min(1, 'Owner name is required'),
		email: z.string().email().optional(),
	})
	.passthrough();

/**
 * Plugin source — relative path string or source object.
 * We validate the discriminant (`source` field on objects) but use
 * .passthrough() for provider-specific fields (repo, url, package, etc.).
 *
 * A string `source` is a path the consumer resolves against the marketplace
 * root and WALKS, so this refine is the first containment gate. It refuses
 * every spelling that leaves the root on some platform: an absolute path
 * (POSIX root, drive letter, UNC) and a `..` segment behind EITHER separator.
 * Claude Code's installer rejects a source that resolves outside the
 * marketplace directory, so such an entry cannot ship either way.
 *
 * 🪤 The check used to split on `/` alone — `plugins\..\..\x` passed it and
 * `path.resolve` walked it out of the root on every platform; `/etc` passed it
 * outright — and the consumer entered whatever it named.
 */
const PluginSourceSchema = z.union([
	z
		.string()
		.min(1)
		.refine((s) => !isAbsoluteAnyPlatform(s) && !hasParentTraversalSegment(s), (s) => ({
			// Names the value: the reader's next move is to fix THIS entry.
			message:
				`source path "${s}" must be relative to the marketplace directory and stay inside it`
				+ ' (no absolute path, no `..` segment) — Claude Code rejects a plugin source that'
				+ ' resolves outside the marketplace, so this entry cannot be installed',
		})),
	z.object({ source: z.string() }).passthrough(),
]);

const MarketplacePluginEntrySchema = z
	.object({
		name: z.string().min(1, 'Plugin name is required'),
		source: PluginSourceSchema.describe('Plugin source — relative path or source object'),
		description: z.string().optional(),
		version: z.string().optional(),
		author: z
			.object({
				name: z.string().min(1),
				email: z.string().email().optional(),
			})
			.passthrough()
			.optional(),
	})
	.passthrough();

export const MarketplaceManifestSchema = z
	.object({
		$schema: z.string().optional().describe('JSON Schema reference'),

		name: z
			.string()
			.min(1, 'Marketplace name is required')
			.describe('Marketplace identifier'),

		description: z
			.string()
			.optional()
			.describe('Human-readable description of the marketplace'),

		version: z
			.string()
			.optional()
			.describe('Marketplace manifest version'),

		owner: OwnerSchema.describe('Marketplace owner information'),

		plugins: z
			.array(MarketplacePluginEntrySchema)
			.describe('List of plugins available in this marketplace'),
	})
	.passthrough()
	.describe('Claude Code marketplace manifest (.claude-plugin/marketplace.json)');

export type MarketplaceManifest = z.infer<typeof MarketplaceManifestSchema>;

/**
 * JSON Schema representation of MarketplaceManifestSchema
 * For external tools and documentation
 */
export const MarketplaceManifestJsonSchema = zodToJsonSchema(
	MarketplaceManifestSchema,
	{
		name: 'MarketplaceManifest',
		$refStrategy: 'none',
	}
);
