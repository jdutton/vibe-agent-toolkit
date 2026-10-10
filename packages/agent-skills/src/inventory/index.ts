export type {
	AnyInventory,
	BaseInventory,
	ComponentRef,
	DeclaredList,
	HookRef,
	InstallInventory,
	LspRef,
	MarketplaceInventory,
	McpRef,
	ParseError,
	PluginInventory,
	PluginRef,
	ResolvedReference,
	SkillInventory,
} from './types.js';

export {
	isInstallInventory,
	isMarketplaceInventory,
	isPluginInventory,
	isSkillInventory,
} from './types.js';

export {
	countInventories,
	InventorySerializedSchema,
	serializedInventory,
	unreadableParseErrors,
} from './serialize.js';
export type { InventoryProjection, InventorySerialized } from './serialize.js';

export {
	detectDeclaredButMissing,
	detectMarketplacePluginSourceMissing,
	detectPresentButUndeclared,
	detectReferenceTargetMissing,
} from './detectors/index.js';
