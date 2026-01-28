# @vibe-agent-toolkit/gateway-mcp

MCP Gateway for exposing VAT agents through the Model Context Protocol, enabling orchestration by LLM systems like Claude Desktop.

## Features

- **Stdio Transport** - Native integration with Claude Desktop and other MCP clients
- **Stateless Agent Support** - Pure Function Tools and One-Shot LLM Analyzers (Phase 1)
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

### Layers

```
┌─────────────────────────────────────────────────┐
│  External Systems (Claude Desktop, etc.)        │
└─────────────────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────┐
│  Interface Layer (Gateway)                      │
│  ├─ MCP Server (stdio/HTTP)                     │
│  └─ Stateless Adapter (Phase 1)                 │
└─────────────────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────┐
│  VAT Agents (business logic)                    │
│  ├─ Pure Function Tools                         │
│  └─ One-Shot LLM Analyzers                      │
└─────────────────────────────────────────────────┘
```

### Key Concepts

**Gateway is Passive** - Agents are already instantiated with their runtimes. The gateway discovers them and exposes them via MCP protocol.

**Archetype-Aware** - Different agent archetypes map to different MCP patterns (stateless tools, conversational agents, orchestrations, etc.)

**Runtime Separation** - MCP handles protocol translation and routing. Runtimes handle execution and state management.

## Supported Archetypes (Phase 1)

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

## Coming in Phase 2+

- **Conversational Assistants** - Multi-turn conversations with session state
- **HTTP Transport** - Remote MCP servers with multiple concurrent connections
- **Orchestrations** - Workflow coordination with sub-agents
- **Event Integrators (HITL)** - Human-in-the-loop approval patterns
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

## Design Documentation

For complete architecture, session management, and future phases, see:
- [State Persistence Patterns](../../docs/research/state-persistence-patterns.md)
- [VAT Architecture](../../docs/architecture/README.md)

## License

MIT
