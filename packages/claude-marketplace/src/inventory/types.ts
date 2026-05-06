import type {
	InstallInventory,
	InventoryParseError,
	MarketplaceInventory,
	PluginInventory,
	PluginRef,
	ResolvedReference,
	SkillInventory,
} from '@vibe-agent-toolkit/agent-skills';

const VENDOR = 'claude-code' as const;

export class ClaudePluginInventory implements PluginInventory {
	public readonly kind = 'plugin' as const;
	public readonly vendor = VENDOR;
	public readonly path: string;
	public readonly shape: 'claude-plugin' | 'skill-claude-plugin';
	public readonly manifest: { name?: string; version?: string; description?: string };
	public readonly declared: PluginInventory['declared'];
	public readonly discovered: PluginInventory['discovered'];
	public readonly references: ResolvedReference[];
	public readonly unexpected: { skillManifests: string[]; pluginManifests: string[] };
	public readonly parseErrors: InventoryParseError[];

	constructor(data: Omit<PluginInventory, 'kind' | 'vendor'>) {
		this.path = data.path;
		this.shape = data.shape;
		this.manifest = data.manifest;
		this.declared = data.declared;
		this.discovered = data.discovered;
		this.references = data.references;
		this.unexpected = data.unexpected;
		this.parseErrors = data.parseErrors;
	}
}

export class ClaudeSkillInventory implements SkillInventory {
	public readonly kind = 'skill' as const;
	public readonly vendor = VENDOR;
	public readonly path: string;
	public readonly manifest: { name: string; description?: string };
	public readonly files: { skillMd: string; linked: string[]; packaged: string[] };
	public readonly parseErrors: InventoryParseError[];

	constructor(data: Omit<SkillInventory, 'kind' | 'vendor'>) {
		this.path = data.path;
		this.manifest = data.manifest;
		this.files = data.files;
		this.parseErrors = data.parseErrors;
	}
}

export class ClaudeMarketplaceInventory implements MarketplaceInventory {
	public readonly kind = 'marketplace' as const;
	public readonly vendor = VENDOR;
	public readonly path: string;
	public readonly manifest: { name?: string; description?: string };
	public readonly declared: { plugins: PluginRef[] };
	public readonly discovered: { plugins: PluginInventory[] };
	public readonly parseErrors: InventoryParseError[];

	constructor(data: Omit<MarketplaceInventory, 'kind' | 'vendor'>) {
		this.path = data.path;
		this.manifest = data.manifest;
		this.declared = data.declared;
		this.discovered = data.discovered;
		this.parseErrors = data.parseErrors;
	}
}

export class ClaudeInstallInventory implements InstallInventory {
	public readonly kind = 'install' as const;
	public readonly vendor = VENDOR;
	public readonly path: string;
	public readonly installRoot: string;
	public readonly marketplaces: MarketplaceInventory[];
	public readonly plugins: PluginInventory[];
	public readonly parseErrors: InventoryParseError[];

	constructor(data: Omit<InstallInventory, 'kind' | 'vendor'>) {
		this.path = data.path;
		this.installRoot = data.installRoot;
		this.marketplaces = data.marketplaces;
		this.plugins = data.plugins;
		this.parseErrors = data.parseErrors;
	}
}
