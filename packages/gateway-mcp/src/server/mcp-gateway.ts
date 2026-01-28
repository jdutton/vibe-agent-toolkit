import type { Agent, OneShotAgentOutput } from '@vibe-agent-toolkit/agent-schema';

import { StatelessAdapter } from '../adapters/stateless-adapter.js';
import { NoOpObservabilityProvider } from '../observability/no-op-provider.js';
import type {
  AgentRegistration,
  ArchetypeAdapter,
  GatewayConfig,
  Logger,
  MCPToolDefinition,
  ObservabilityProvider,
} from '../types.js';

/**
 * Internal registration with resolved adapter
 */
interface ResolvedToolRegistration {
  name: string;
  agent: Agent<unknown, OneShotAgentOutput<unknown, string>>;
  adapter: ArchetypeAdapter;
  definition: MCPToolDefinition;
}

/**
 * MCP Gateway - exposes VAT agents through Model Context Protocol
 *
 * Phase 1: Stdio transport, stateless agents only
 */
export class MCPGateway {
  protected readonly tools = new Map<string, ResolvedToolRegistration>();
  protected readonly observability: ObservabilityProvider;
  protected readonly logger: Logger;
  protected readonly transport: 'stdio' | 'http';

  constructor(config: GatewayConfig) {
    this.transport = config.transport;
    this.observability = config.observability ?? new NoOpObservabilityProvider();
    this.logger = this.observability.getLogger();

    // Register all agents
    for (const registration of config.agents) {
      this.registerAgent(registration);
    }

    this.logger.info('MCPGateway initialized', {
      transport: this.transport,
      agentCount: this.tools.size,
    });
  }

  /**
   * Register an agent with the gateway
   */
  protected registerAgent(registration: AgentRegistration): void {
    const { agent } = registration;
    const { manifest } = agent;

    // Auto-detect adapter from archetype (or use provided adapter)
    const adapter = registration.adapter ?? this.getAdapter(manifest.archetype);

    // Create MCP tool definition
    const definition = adapter.createToolDefinition(agent);

    // Store registration
    this.tools.set(registration.name, {
      name: registration.name,
      agent,
      adapter,
      definition,
    });

    this.logger.debug('Agent registered', {
      name: registration.name,
      archetype: manifest.archetype,
      adapter: adapter.name,
    });
  }

  /**
   * Get adapter for archetype (Phase 1: stateless only)
   */
  protected getAdapter(archetype: string): ArchetypeAdapter {
    switch (archetype) {
      case 'pure-function':
      case 'one-shot-llm-analyzer':
        return new StatelessAdapter();

      // Phase 2+: Add more archetypes
      case 'conversational':
      case 'orchestration':
      case 'external-event-integrator':
        throw new Error(`Unsupported archetype: ${archetype} (coming in Phase 2+)`);

      default:
        throw new Error(`Unknown archetype: ${archetype}`);
    }
  }

  /**
   * Get all registered tool definitions (for MCP tools/list)
   */
  getToolDefinitions(): MCPToolDefinition[] {
    return [...this.tools.values()].map((reg) => reg.definition);
  }

  /**
   * Get tool registration by name
   */
  protected getToolRegistration(name: string): ResolvedToolRegistration {
    const registration = this.tools.get(name);
    if (!registration) {
      throw new Error(`Tool not found: ${name}`);
    }
    return registration;
  }

  /**
   * Start the gateway (to be implemented by transport-specific subclasses)
   */
  async start(): Promise<void> {
    throw new Error('start() must be implemented by transport-specific subclass');
  }
}
