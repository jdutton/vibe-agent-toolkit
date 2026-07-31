import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

import {
	isRecord,
	recordDrift,
	recordUnknownKeys,
	type RegistryDriftRecord,
	type RegistryShapeDrift,
} from './registry-drift.js';

/**
 * `known_marketplaces.json` is written and owned by Claude Code — VAT only reads it.
 * Per VAT's Postel's Law rule (CLAUDE.md: "Reading outside world → liberal"), these
 * schemas `.passthrough()` and keep the source `kind` open: an unrecognized field or
 * marketplace source kind is drift in someone else's file, not an error in the user's
 * setup.
 *
 * Modelling it strictly turned every shape Claude Code added — the git `ref` on a
 * github source, the `directory` source kind — into a hard error against a registry
 * the user cannot edit.
 *
 * Liberality alone would be blindness, so it is paired with
 * {@link detectKnownMarketplacesRegistryDrift}: what passthrough absorbs still gets
 * reported, at `info`, under the same `REGISTRY_SHAPE_DRIFT` code the installed-plugins
 * registry uses.
 */

/**
 * Marketplace source kinds VAT's model knows about. Not enforced by the schema — a
 * kind outside this list parses fine and is reported as drift instead.
 */
export const KNOWN_MARKETPLACE_SOURCE_KINDS = [
	'github',
	'file',
	'directory',
] as const;

const KNOWN_SOURCE_KIND_SET: ReadonlySet<string> = new Set(
	KNOWN_MARKETPLACE_SOURCE_KINDS
);

/**
 * Marketplace source location.
 *
 * Kind-specific fields are optional rather than required-per-kind: a github source
 * carries `repo` (and optionally a `ref`), a file/directory source carries `path`.
 * Requiring them per kind would re-create the false errors this schema exists to
 * avoid the moment Claude Code renames one.
 */
const MarketplaceSourceSchema = z
	.object({
		source: z
			.string()
			.describe(
				`Source kind (recognized: ${KNOWN_MARKETPLACE_SOURCE_KINDS.join(', ')}; others pass through as drift)`
			),

		repo: z
			.string()
			.regex(/^[^/]+\/[^/]+$/, 'Must be in format "owner/repo"')
			.optional()
			.describe('GitHub repository in "owner/repo" form'),

		ref: z
			.string()
			.optional()
			.describe('Git ref (branch, tag or commit) a github marketplace is pinned to'),

		path: z
			.string()
			.optional()
			.describe('Filesystem path for a file or directory marketplace'),
	})
	.passthrough()
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
			.datetime({ offset: true })
			.describe('ISO 8601 last update timestamp'),
	})
	.passthrough()
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

const KNOWN_ENTRY_KEYS: ReadonlySet<string> = new Set([
	'source',
	'installLocation',
	'lastUpdated',
]);

const KNOWN_SOURCE_KEYS: ReadonlySet<string> = new Set([
	'source',
	'repo',
	'ref',
	'path',
]);

/**
 * Collect drift observations for one marketplace entry.
 *
 * @param entry - Candidate marketplace entry (may be any shape)
 * @param pointer - Dotted pointer to the entry, i.e. the marketplace name
 * @param record - Accumulator, keyed by message so N marketplaces sharing one
 *   unknown field produce one observation rather than N identical ones
 */
function collectEntryDrift(
	entry: unknown,
	pointer: string,
	record: RegistryDriftRecord
): void {
	if (!isRecord(entry)) {
		return;
	}

	recordUnknownKeys(
		entry,
		KNOWN_ENTRY_KEYS,
		pointer,
		(key) => `Marketplace entries carry unrecognized field '${key}'`,
		record
	);

	const source = entry['source'];
	if (!isRecord(source)) {
		return;
	}

	recordUnknownKeys(
		source,
		KNOWN_SOURCE_KEYS,
		`${pointer}.source`,
		(key) => `Marketplace sources carry unrecognized field '${key}'`,
		record
	);

	const kind = source['source'];
	if (typeof kind === 'string' && !KNOWN_SOURCE_KIND_SET.has(kind)) {
		recordDrift(
			record,
			`${pointer}.source.source`,
			`Marketplace source kind '${kind}' is not one of the recognized kinds (${KNOWN_MARKETPLACE_SOURCE_KINDS.join(', ')})`
		);
	}
}

/**
 * Report what `.passthrough()` absorbed: fields and source kinds in a
 * known-marketplaces registry that VAT's model does not recognize.
 *
 * Deduplicated by message — the point is "Claude Code writes something new",
 * not "it wrote it eight times".
 *
 * @param data - Parsed registry JSON (any shape; non-objects yield no drift)
 * @returns One observation per distinct unrecognized field or source kind
 */
export function detectKnownMarketplacesRegistryDrift(
	data: unknown
): RegistryShapeDrift[] {
	const found: RegistryDriftRecord = new Map();

	if (!isRecord(data)) {
		return [];
	}

	for (const [marketplaceName, entry] of Object.entries(data)) {
		collectEntryDrift(entry, marketplaceName, found);
	}

	return [...found.values()];
}
