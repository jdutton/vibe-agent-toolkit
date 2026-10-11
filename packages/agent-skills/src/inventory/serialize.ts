import { z } from 'zod';

import type { AnyInventory, InstallInventory, MarketplaceInventory, ParseError, PluginInventory, SkillInventory } from './types.js';

/*
 * A list the projection did not walk is `null`, never `[]`.
 *
 * `null` is already this repo's vocabulary for "no answer here" — see
 * `DeclaredList`, where `null` means the manifest omitted the field and `[]`
 * means it declared an explicitly empty one. A shallow projection is the same
 * distinction on the discovered side: `null` = "not walked", `[]` = "walked and
 * found nothing". Writing `[]` for a list nobody looked at made a `--shallow`
 * document byte-identical to a real scan of an empty plugin.
 */

type ShallowPluginInventory = Omit<PluginInventory, 'discovered'> & {
	discovered: Omit<PluginInventory['discovered'], 'skills'> & { skills: null };
};

type ShallowMarketplaceInventory = Omit<MarketplaceInventory, 'discovered'> & {
	discovered: { plugins: null };
};

type ShallowInstallInventory = Omit<InstallInventory, 'marketplaces' | 'plugins'> & {
	marketplaces: ShallowMarketplaceInventory[];
	plugins: ShallowPluginInventory[];
};

type ShallowProjection =
	| ShallowMarketplaceInventory
	| ShallowPluginInventory
	| ShallowInstallInventory
	| SkillInventory;

/** Which projection of an inventory is published: everything, or the top-level structure only. */
export type InventoryProjection = 'full' | 'shallow';

/**
 * An inventory as published: the inventory itself, or its shallow projection
 * under a top-level `projection: shallow` marker. No version label — a consumer
 * reads `kind`, the model's own discriminator, and under pre-1.0 pins the VAT
 * version it ran.
 */
export type InventorySerialized = AnyInventory | ({ projection: 'shallow' } & ShallowProjection);

/**
 * The object an inventory is published as.
 *
 * - `full` → the inventory, unchanged.
 * - `shallow` → top-level structure without transitive nesting, every list the
 *   projection skips `null` (not `[]`) and a `projection: shallow` marker, so a
 *   consumer tells an unwalked list from an empty one per field and per document:
 *   a plugin's `discovered.skills` (its declared skills stay, as refs), a
 *   marketplace's `discovered.plugins`, and each child of an install projected
 *   the same way, path, manifest and declarations kept.
 *
 * @param inv - The extracted inventory
 * @param projection - Which projection to publish
 * @returns The object to publish; rendering it is the caller's writer's job
 */
export function serializedInventory(inv: AnyInventory, projection: InventoryProjection): InventorySerialized {
	return projection === 'full' ? inv : { projection: 'shallow', ...shallowProject(inv) };
}

function shallowProject(inv: AnyInventory): ShallowProjection {
	if (inv.kind === 'plugin') {
		return { ...inv, discovered: { ...inv.discovered, skills: null } };
	}
	if (inv.kind === 'marketplace') {
		return { ...inv, discovered: { plugins: null } };
	}
	if (inv.kind === 'install') {
		return {
			...inv,
			marketplaces: inv.marketplaces.map((m) => shallowProject(m) as ShallowMarketplaceInventory),
			plugins: inv.plugins.map((p) => shallowProject(p) as ShallowPluginInventory),
		};
	}
	return inv;
}

/** Every inventory in the tree, the subject first: each nested marketplace, plugin and skill. */
function inventoriesIn(inv: AnyInventory): AnyInventory[] {
	if (inv.kind === 'plugin') return [inv, ...inv.discovered.skills];
	if (inv.kind === 'marketplace') return [inv, ...inv.discovered.plugins.flatMap(inventoriesIn)];
	if (inv.kind === 'install') return [inv, ...[...inv.marketplaces, ...inv.plugins].flatMap(inventoriesIn)];
	return [inv];
}

/**
 * How many inventories the extraction produced: the subject and every
 * marketplace, plugin and skill nested under it.
 *
 * @param inv - The extracted inventory (the FULL one — a projection is a rendering choice, not less work)
 */
export function countInventories(inv: AnyInventory): number {
	return inventoriesIn(inv).length;
}

/**
 * Every `parseErrors[]` row across the tree that says the OS refused a path —
 * a path that was not examined, a statement about the RUN — once per path, in
 * the order met. A content defect (malformed JSON, a missing manifest) is the
 * subject's own and stays in the inventory's data only.
 *
 * @param inv - The extracted inventory
 */
export function unreadableParseErrors(inv: AnyInventory): ParseError[] {
	const byPath = new Map<string, ParseError>();
	for (const node of inventoriesIn(inv)) {
		for (const row of node.parseErrors) {
			if (row.unreadable === true && !byPath.has(row.path)) byPath.set(row.path, row);
		}
	}
	return [...byPath.values()];
}

// ── The published schema ─────────────────────────────────────────────────────

const ParseErrorSchema = z.object({
	path: z.string(),
	message: z.string(),
	line: z.number().int().optional(),
	unreadable: z.literal(true).optional(),
}).strict();

const ComponentRefSchema = z.object({
	manifestPath: z.string(),
	resolvedPath: z.string(),
	exists: z.boolean(),
}).strict();

/**
 * A declared ref. `inline` is allowed on EVERY declared list, not only hooks,
 * MCP and LSP: the extractor records any manifest field given as an object as
 * one ref carrying that config, whatever the field.
 */
const DeclaredRefSchema = ComponentRefSchema.extend({ inline: z.record(z.string(), z.unknown()).optional() });
const DeclaredListSchema = DeclaredRefSchema.array().nullable();

const PluginRefSchema = ComponentRefSchema.extend({ source: z.enum(['path', 'git', 'npm', 'unknown']) });

const ResolvedReferenceSchema = z.object({ from: z.string(), to: z.string(), exists: z.boolean() }).strict();

const BASE = { vendor: z.string(), path: z.string(), parseErrors: z.array(ParseErrorSchema) };

const SkillSchema = z.object({
	kind: z.literal('skill'),
	...BASE,
	manifest: z.object({ name: z.string(), description: z.string().optional() }).strict(),
	files: z.object({ skillMd: z.string(), linked: z.array(z.string()), packaged: z.array(z.string()) }).strict(),
}).strict();

const PluginSchema = z.object({
	kind: z.literal('plugin'),
	...BASE,
	manifest: z.object({ name: z.string().optional(), version: z.string().optional(), description: z.string().optional() }).strict(),
	shape: z.enum(['claude-plugin', 'skill-claude-plugin']),
	declared: z.object({
		skills: DeclaredListSchema,
		commands: DeclaredListSchema,
		agents: DeclaredListSchema,
		hooks: DeclaredListSchema,
		mcpServers: DeclaredListSchema,
		outputStyles: DeclaredListSchema,
		lspServers: DeclaredListSchema,
	}).strict(),
	discovered: z.object({
		skills: z.array(SkillSchema),
		commands: z.array(ComponentRefSchema),
		agents: z.array(ComponentRefSchema),
	}).strict(),
	references: z.array(ResolvedReferenceSchema),
	unexpected: z.object({ skillManifests: z.array(z.string()), pluginManifests: z.array(z.string()) }).strict(),
}).strict();

const MarketplaceSchema = z.object({
	kind: z.literal('marketplace'),
	...BASE,
	manifest: z.object({ name: z.string().optional(), description: z.string().optional() }).strict(),
	declared: z.object({ plugins: z.array(PluginRefSchema) }).strict(),
	discovered: z.object({ plugins: z.array(PluginSchema) }).strict(),
}).strict();

const InstallSchema = z.object({
	kind: z.literal('install'),
	...BASE,
	installRoot: z.string(),
	marketplaces: z.array(MarketplaceSchema),
	plugins: z.array(PluginSchema),
}).strict();

// The shallow kinds: each unwalked list `null`; an install's children shallow too.
const ShallowPluginSchema = PluginSchema.extend({ discovered: PluginSchema.shape.discovered.extend({ skills: z.null() }) });
const ShallowMarketplaceSchema = MarketplaceSchema.extend({ discovered: z.object({ plugins: z.null() }).strict() });
const ShallowInstallSchema = InstallSchema.extend({
	marketplaces: z.array(ShallowMarketplaceSchema),
	plugins: z.array(ShallowPluginSchema),
});
const SHALLOW_MARKER = { projection: z.literal('shallow') };

/** `T` as Zod 3 infers it: every optional property also admits `undefined`, deeply. */
type AsZodInfers<T> = T extends readonly (infer U)[]
	? AsZodInfers<U>[]
	: T extends object
		? { [K in keyof T]: {} extends Pick<T, K> ? AsZodInfers<Exclude<T[K], undefined>> | undefined : AsZodInfers<T[K]> }
		: T;

type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * The compile-time link to `types.ts` (tests are not typechecked, so it lives
 * here): a schema whose inferred type and the model are not mutually
 * assignable is `never` as an argument, and the build fails.
 */
function linkedToModel<S extends z.ZodTypeAny>(
	schema: S & (Mutual<z.infer<S>, AsZodInfers<InventorySerialized>> extends true ? unknown : never),
): S {
	return schema;
}

/**
 * The schema of {@link InventorySerialized}: a full inventory, or a shallow
 * projection carrying its marker. Strict throughout — a key the inventory model
 * does not declare is refused.
 */
export const InventorySerializedSchema = linkedToModel(z.union([
	z.discriminatedUnion('kind', [PluginSchema, MarketplaceSchema, InstallSchema, SkillSchema]),
	z.discriminatedUnion('kind', [
		ShallowPluginSchema.extend(SHALLOW_MARKER),
		ShallowMarketplaceSchema.extend(SHALLOW_MARKER),
		ShallowInstallSchema.extend(SHALLOW_MARKER),
		SkillSchema.extend(SHALLOW_MARKER),
	]),
]));

