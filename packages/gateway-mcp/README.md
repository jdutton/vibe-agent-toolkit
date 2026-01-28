# @vibe-agent-toolkit/gateway-mcp

MCP Gateway for exposing VAT agents through the Model Context Protocol, enabling orchestration by LLM systems like Claude Desktop.

## Features

- **Stdio Transport** - Native integration with Claude Desktop and other MCP clients
- **Stateless Agent Support** - Pure Function Tools and One-Shot LLM Analyzers
- **Multi-Agent Servers** - Expose multiple agents through a single MCP server
- **Runtime Agnostic** - Works with any VAT runtime adapter (Vercel AI SDK, OpenAI, LangChain, Claude Agent SDK)
- **Type-Safe** - Full TypeScript support with branded session IDs
- **Error Classification** - Distinguishes retryable vs non-retryable errors for intelligent retry logic
- **Observability Ready** - Hooks for OpenTelemetry integration (console logger included)

## Installation

```bash
# Using bun
bun add @vibe-agent-toolkit/gateway-mcp

# Using npm
npm install @vibe-agent-toolkit/gateway-mcp

# Using pnpm
pnpm add @vibe-agent-toolkit/gateway-mcp
```

## Quick Start

### Single Agent Server

Expose a single VAT agent via MCP stdio transport:

```typescript
import { StdioMCPGateway, NoOpObservabilityProvider } from '@vibe-agent-toolkit/gateway-mcp';
import { haikuValidator } from '@vibe-agent-toolkit/vat-example-cat-agents';

const gateway = new StdioMCPGateway({
  name: 'haiku-validator-server',
  version: '1.0.0',
  agents: [
    {
      name: 'haiku-validator',
      agent: haikuValidator,
      runtime: null, // Pure function, no runtime needed
    },
  ],
  observability: new NoOpObservabilityProvider(),
});

await gateway.start();
```

Run with:
```bash
bun run my-server.ts
```

### Multi-Agent Server

Expose multiple agents through one MCP server:

```typescript
import { StdioMCPGateway, NoOpObservabilityProvider } from '@vibe-agent-toolkit/gateway-mcp';
import { haikuValidator, photoAnalyzer } from '@vibe-agent-toolkit/vat-example-cat-agents';

const gateway = new StdioMCPGateway({
  name: 'vat-agents',
  version: '1.0.0',
  agents: [
    {
      name: 'haiku-validator',
      agent: haikuValidator,
      runtime: null, // Pure function
    },
    {
      name: 'photo-analyzer',
      agent: photoAnalyzer,
      runtime: null, // Mock mode
    },
  ],
  observability: new NoOpObservabilityProvider(),
});

await gateway.start();
```

## Claude Desktop Configuration

Add to `~/.claude/config.json`:

```json
{
  "mcpServers": {
    "vat-agents": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/your/server.ts"]
    }
  }
}
```

**Notes:**
- Use absolute paths (Claude Desktop doesn't expand `~` or relative paths)
- Restart Claude Desktop after updating config
- Check logs in Claude Desktop developer console if server doesn't connect

## Architecture Overview

### Design Principles

1. **MCP is an interface, not a runtime** - Gateway exposes agents but doesn't execute them
2. **Gateway discovers configured agents** - System startup registers agents, gateway provides access
3. **Respect runtime patterns** - Each runtime manages state its own way (LangGraph checkpointers, OpenAI threads, etc.)
4. **Archetype-aware** - Different agent types need different interface patterns (stateless vs stateful)
5. **Separation of concerns** - MCP handles protocol translation and routing, runtimes handle execution and state

### Layers

```
┌─────────────────────────────────────────────────┐
│  External Systems (Claude Desktop, etc.)        │
└─────────────────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────┐
│  Interface Layer (Gateway)                      │
│  ├─ MCP Server (stdio/HTTP)                     │
│  └─ Stateless Adapter                           │
└─────────────────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────┐
│  VAT Agents (business logic)                    │
│  ├─ Pure Function Tools                         │
│  └─ One-Shot LLM Analyzers                      │
└─────────────────────────────────────────────────┘
```

### Stdio Protocol Compliance

**Critical constraint for Claude Desktop integration:**

- **stdout** - JSON-RPC protocol messages ONLY (MCP spec requirement)
- **stderr** - All logs, debug output, errors
- **Process lifetime** - Server runs until stdin closes (natural stdio connection lifetime)

Violating stdout purity breaks MCP clients with JSON parse errors. All logging infrastructure must write to stderr.

### Package-Scoped Collections

Agents are discovered via npm package exports:

```typescript
// Package: @my-scope/my-agents
// Export: /mcp-collections

export const myAgents: MCPCollection = {
  name: 'my-agents',
  description: 'My agent collection',
  agents: [
    { name: 'agent-1', agent: agent1, description: '...' },
    { name: 'agent-2', agent: agent2, description: '...' },
  ],
};

export const collections: Record<string, MCPCollection> = {
  'my-agents': myAgents,
};

export const defaultCollection = myAgents;
```

CLI command: `vat mcp serve @my-scope/my-agents`

**Future Enhancement**: Global discovery registry with versioning.

### Key Concepts

**Gateway is Passive** - Agents are already instantiated with their runtimes. The gateway discovers them and exposes them via MCP protocol.

**Archetype-Aware** - Different agent archetypes map to different MCP patterns (stateless tools, conversational agents, orchestrations, etc.)

**Runtime Separation** - MCP handles protocol translation and routing. Runtimes handle execution and state management.

## Supported Archetypes

### Pure Function Tool
**Archetype:** `pure-function-tool`

Direct synchronous functions with no LLM calls or external state.

**MCP Mapping:**
- One MCP tool = One VAT agent
- No session state
- Direct pass-through execution

**Example:** Haiku validator

### One-Shot LLM Analyzer
**Archetype:** `one-shot-llm-analyzer`

Single LLM call to analyze input and return structured output.

**MCP Mapping:**
- One MCP tool = One VAT agent
- No session state (stateless LLM call)
- Input → LLM → Structured output

**Example:** Photo analyzer

## Current Features

**Implemented:**
- ✅ Stdio transport for Claude Desktop
- ✅ Stateless agent support (Pure Function Tools, One-Shot LLM Analyzers)
- ✅ Multi-agent servers (multiple tools per server)
- ✅ Package-scoped collections
- ✅ CLI integration (`vat mcp serve <package>`)
- ✅ Observability hooks (console logger included)
- ✅ System tests for protocol compliance

**Current Limitations:**
- Process-per-server model (no multi-tenancy)
- Single stdio connection (Claude Desktop spawns dedicated process)
- No session state management (stateless agents only)

## Planned Features

**Stateful Agents:**
- **Conversational Assistants** - Multi-turn conversations with session state
- **Orchestrations** - Workflow coordination with sub-agents
- **Event Integrators (HITL)** - Human-in-the-loop approval patterns

**Transport & Discovery:**
- **HTTP Transport** - Remote MCP servers with multiple concurrent connections
- **Global Discovery Registry** - Namespace management and versioning

**Observability:**
- **Full OpenTelemetry Integration** - Traces, metrics, and structured logs

## API Reference

### `StdioMCPGateway`

Creates an MCP gateway using stdio transport (for Claude Desktop).

```typescript
interface StdioMCPGatewayConfig {
  name: string;                      // Server name
  version: string;                   // Server version
  agents: AgentRegistration[];       // Agents to expose
  observability: ObservabilityProvider; // Logging and tracing
}

interface AgentRegistration {
  name: string;                      // Tool name in MCP
  agent: VATAgent;                   // VAT agent instance
  runtime: RuntimeAdapter | null;    // Runtime adapter (or null for pure functions)
}
```

**Methods:**
- `start(): Promise<void>` - Start the MCP server on stdio

**Example:**
```typescript
const gateway = new StdioMCPGateway({
  name: 'my-agents',
  version: '1.0.0',
  agents: [{ name: 'my-tool', agent: myAgent, runtime: null }],
  observability: new NoOpObservabilityProvider(),
});

await gateway.start();
```

### `NoOpObservabilityProvider`

No-op implementation for when observability is not needed.

```typescript
const observability = new NoOpObservabilityProvider();
```

### `ConsoleLogger`

Console-based logger for development (logs to stderr for MCP compatibility).

```typescript
import { ConsoleLogger } from '@vibe-agent-toolkit/gateway-mcp';

const logger = new ConsoleLogger('my-server');
logger.info('Server started', { port: 3000 });
logger.error('Error occurred', { error: err });
```

### Error Handling

The gateway translates VAT result envelopes to MCP responses:

**VAT Result Envelope:**
```typescript
{
  status: 'success' | 'error',
  data?: TOutput,
  error?: { type: string, message: string },
  confidence?: number,
  warnings?: string[]
}
```

**MCP Tool Result:**
```typescript
{
  content: [{ type: 'text', text: string }],
  isError?: boolean
}
```

**Error Classification:**
- Retryable: `llm-rate-limit`, `llm-timeout`, `llm-unavailable`
- Non-retryable: `llm-refusal`, `llm-invalid-output`, `invalid-input`

## Examples

See [examples/README.md](./examples/README.md) for:
- Haiku validator server (Pure Function Tool)
- Photo analyzer server (One-Shot LLM Analyzer)
- Combined multi-agent server
- Claude Desktop configuration examples

## Development

```bash
# Install dependencies
bun install

# Build package
bun run build

# Run tests
bun run test

# Run tests in watch mode
bun run test:watch

# Generate coverage report
bun run test:coverage
```

## CLI Integration

See [CLI MCP Commands Documentation](../cli/docs/mcp.md) for:
- `vat mcp list-collections` - List available agent packages
- `vat mcp serve <package>` - Start MCP server for a package
- Claude Desktop configuration generation
- Local development setup with `VAT_ROOT_DIR`

## Design Documentation

For complete architecture and future phases, see:
- [State Persistence Patterns](../../docs/research/state-persistence-patterns.md)
- [VAT Architecture](../../docs/architecture/README.md)

**Note:** Detailed design documents (requirements, implementation plans) are kept in `docs/plans/` (gitignored). Architectural decisions and constraints are documented here in the README.

## License

MIT
