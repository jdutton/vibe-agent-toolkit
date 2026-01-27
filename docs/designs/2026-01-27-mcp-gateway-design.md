# MCP Gateway Design

**Date:** 2026-01-27
**Status:** Design Phase
**Authors:** Jeff Dutton, Claude

## Overview

Design for exposing VAT agents through the Model Context Protocol (MCP), enabling orchestration by LLM systems like Claude Desktop. MCP serves as an interface layer that allows external systems to discover and invoke agents while maintaining VAT's runtime-agnostic architecture.

## Motivation

Agents are probabilistic microservices - they need interfaces for external systems to connect and use them. MCP provides a standardized protocol for LLM-driven orchestration, enabling:

- **Claude Desktop integration** - Users can invoke VAT agents through conversational interfaces
- **Agent composition** - LLMs can orchestrate multiple agents to solve complex tasks
- **HITL workflows** - Human-in-the-loop approval patterns aligned with emerging standards
- **Multi-turn conversations** - Stateful conversational agents accessible via MCP

## Core Principles

1. **MCP is an interface, not a runtime** - It exposes agents but doesn't execute them
2. **Gateway discovers running agents** - System startup configures agent registry, gateway provides access
3. **Respect runtime patterns** - Each runtime manages state its own way (LangGraph checkpointers, OpenAI threads, etc.)
4. **Archetype-aware** - Different agent types need different interface patterns (stateless vs stateful)
5. **Separation of concerns** - MCP handles protocol translation and routing, runtimes handle execution and state

## Architecture

### Layers

```
┌─────────────────────────────────────────────────┐
│  External Systems (Claude Desktop, etc.)        │
└─────────────────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────┐
│  Interface Layer (Gateway)                      │
│  ├─ MCP Server (stdio/HTTP)                     │
│  ├─ HTTP API (future)                           │
│  ├─ WebSocket Server (future)                   │
│  └─ CLI Transport (existing)                    │
└─────────────────────────────────────────────────┘
                      ↓
         ┌────────────┴────────────┐
         ↓                         ↓
┌─────────────────┐    ┌──────────────────────┐
│ Session Manager │    │  Agent Registry      │
│ (for stateful)  │    │  (configured)        │
└─────────────────┘    └──────────────────────┘
                      ↓
┌─────────────────────────────────────────────────┐
│  Runtime Adapters (execution layer)             │
│  ├─ Vercel AI SDK                               │
│  ├─ OpenAI                                      │
│  ├─ LangChain                                   │
│  └─ Claude Agent SDK                            │
└─────────────────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────┐
│  VAT Agents (business logic)                    │
│  ├─ Pure Function Tools                         │
│  ├─ One-Shot LLM Analyzers                      │
│  ├─ Conversational Assistants                   │
│  ├─ Orchestrations                              │
│  └─ Event Integrators                           │
└─────────────────────────────────────────────────┘
```

### System Startup Flow

```
1. Initialize Runtime(s) with state backends
   ├─ LangGraph + PostgresSaver
   ├─ OpenAI + thread management
   └─ Vercel AI SDK + state hooks

2. Instantiate Agents with Runtimes
   ├─ breed-advisor → Vercel AI SDK runtime
   ├─ haiku-validator → Pure function (no runtime)
   └─ photo-analyzer → OpenAI runtime

3. Start Gateway(s) - discover and expose agents
   ├─ MCP Server (stdio or HTTP)
   ├─ HTTP API (future)
   └─ CLI interface
```

**Key insight:** Gateway is passive - agents are already running, gateway makes them accessible via MCP protocol.

## Package Structure

### New Package: `@vibe-agent-toolkit/gateway-mcp`

```
packages/gateway-mcp/
├── src/
│   ├── server/
│   │   ├── mcp-gateway.ts             # Main gateway class
│   │   ├── stdio-transport.ts         # Stdio implementation
│   │   └── http-transport.ts          # HTTP/SSE implementation
│   │
│   ├── adapters/                       # Archetype-specific
│   │   ├── stateless-adapter.ts       # Pure Function, One-Shot LLM
│   │   ├── conversational-adapter.ts  # Multi-turn with session state
│   │   ├── orchestration-adapter.ts   # Workflow coordination
│   │   └── event-integrator-adapter.ts # HITL, async operations
│   │
│   ├── session/
│   │   ├── session-manager.ts         # In-memory sessions
│   │   ├── conversation-state.ts      # State types
│   │   └── session-context.ts         # Session context types
│   │
│   ├── observability/
│   │   └── interfaces.ts              # OTel-aligned hooks (future)
│   │
│   └── index.ts                        # Public API
│
├── cli/
│   └── serve.ts                        # `vat serve-mcp` command (future)
│
└── examples/
    ├── stdio-server.ts                 # Claude Desktop example
    └── http-server.ts                  # Remote server example
```

### Dependencies

- `@vibe-agent-toolkit/agent-schema` - Agent manifest types, archetype constants
- `@vibe-agent-toolkit/discovery` - Agent scanning and loading
- `@modelcontextprotocol/sdk` - Official MCP implementation
- Existing runtime packages (not imported, provided at configuration)

## Gateway Configuration

### Agent Registration

```typescript
import { MCPGateway } from '@vibe-agent-toolkit/gateway-mcp';
import { breedAdvisor, haikuValidator, photoAnalyzer } from './agents';
import { vercelRuntime, pureFunctionRuntime, openaiRuntime } from './runtimes';

// System startup: create configured gateway
const gateway = new MCPGateway({
  agents: [
    {
      name: 'breed-advisor',
      agent: breedAdvisor,      // archetype discovered from agent.manifest
      runtime: vercelRuntime,
    },
    {
      name: 'haiku-validator',
      agent: haikuValidator,
      runtime: pureFunctionRuntime,
    },
    {
      name: 'photo-analyzer',
      agent: photoAnalyzer,
      runtime: openaiRuntime,
    },
  ],
  transport: 'stdio', // or 'http'

  // Observability (future OTel integration)
  observability: myObservabilityProvider,
});

// Start gateway (begins listening on transport)
await gateway.start();
```

### Internal Registration Process

```typescript
class MCPGateway {
  private tools = new Map<string, ToolRegistration>();

  registerAgent(config: AgentConfig) {
    // Discover archetype from agent manifest
    const archetype = config.agent.manifest.archetype;
    const adapter = this.getAdapter(archetype);

    // Create MCP tool definition
    const toolDef = this.createToolDefinition(config);

    this.tools.set(config.name, {
      agent: config.agent,
      runtime: config.runtime,
      adapter,
      definition: toolDef,
    });
  }

  private getAdapter(archetype: AgentArchetype): ArchetypeAdapter {
    switch (archetype) {
      case AgentArchetype.PureFunction:
      case AgentArchetype.OneShotLLM:
        return new StatelessAdapter();

      case AgentArchetype.Conversational:
        return new ConversationalAdapter();

      case AgentArchetype.Orchestration:
        return new OrchestrationAdapter();

      case AgentArchetype.EventIntegrator:
        return new EventIntegratorAdapter();

      default:
        throw new Error(`Unsupported archetype: ${archetype}`);
    }
  }
}
```

## Archetype Mappings to MCP

### Stateless Archetypes (Direct Tool Mapping)

**Archetype 1: Pure Function Tool**
**Archetype 2: One-Shot LLM Analyzer**

```typescript
// MCP Tool Definition
{
  name: "haiku-validator",
  description: "Validates 5-7-5 syllable structure + kigo/kireji",
  inputSchema: HaikuSchema,  // From agent manifest
}

// Execution (stateless adapter)
class StatelessAdapter {
  async execute(agent, args, connectionId, runtime) {
    // Direct pass-through, no session needed
    const result = await agent.execute(args);
    return this.formatResult(result);
  }
}
```

**Characteristics:**
- One MCP tool = One VAT agent
- No session state
- Direct pass-through
- Result envelope returned as-is

### Stateful Archetypes (Session-Aware Tools)

**Archetype 3: Conversational Assistant**

```typescript
// MCP Tool Definition
{
  name: "breed-advisor",
  description: "Multi-turn breed selection advisor",
  inputSchema: {
    type: "object",
    properties: {
      message: { type: "string" }
    },
    required: ["message"]
  }
}

// Execution (session-aware adapter)
class ConversationalAdapter {
  private sessions = new Map<ConnectionId, SessionState>();

  async execute(agent, args, connectionId, runtime) {
    // Get or create session for this connection
    let session = this.sessions.get(connectionId);
    if (!session) {
      session = this.createSession(connectionId, runtime);
      this.sessions.set(connectionId, session);
    }

    // Agent execution with session state
    const result = await agent.execute(
      {
        message: args.message,
        sessionState: session.state
      },
      session.runtimeContext
    );

    // Update session state
    session.state = result.updatedProfile || result.sessionState;

    return this.formatResult(result);
  }

  private createSession(connectionId: ConnectionId, runtime: Runtime) {
    return {
      connectionId,
      conversationId: this.generateConversationId(connectionId),
      state: { conversationPhase: 'gathering' },
      runtimeContext: runtime.createContext(),
    };
  }
}
```

**Characteristics:**
- Session persists for connection lifetime (stdio) or managed explicitly (HTTP)
- State flows: sessionState → agent → updatedState → session storage
- MCP client doesn't see internal state structure
- Runtime context created by runtime adapter (LangGraph checkpointer, OpenAI client, etc.)

**Archetype 5: Orchestration**

Externally looks like Pure Function or One-Shot LLM, but may:
- Coordinate multiple sub-agents internally
- Need persistent state for checkpointing/retries
- Expose observability metadata if configured

**Archetype 9: Event Integrator (HITL)**

Two tools per agent (poll-based pattern for MCP compatibility):

```typescript
// Tool 1: Submit async operation
{
  name: "human-approval-submit",
  inputSchema: { decision: string, context: object }
}
// Returns: { requestId: "xyz", status: "pending" }

// Tool 2: Check operation status
{
  name: "human-approval-check",
  inputSchema: { requestId: string }
}
// Returns: { requestId: "xyz", status: "approved" | "pending" | "rejected", data: {...} }
```

## Session Context and Type System

### Strong Typing for Session IDs

```typescript
// Brand types for session identity
type ConnectionId = string & { readonly __brand: 'ConnectionId' };
type ConversationId = string & { readonly __brand: 'ConversationId' };
type RuntimeSessionId = string & { readonly __brand: 'RuntimeSessionId' };
type TraceId = string & { readonly __brand: 'TraceId' };

interface SessionContext {
  connectionId: ConnectionId;       // MCP connection
  conversationId: ConversationId;   // Logical conversation
  runtimeSessionId?: RuntimeSessionId; // Framework-specific
  traceId?: TraceId;                // Observability
}
```

**Mapping strategy:** Separate but enable mapping. In stdio mode they can be the same, in HTTP mode they're separate but mapped.

### Session State Structure

```typescript
interface SessionState {
  connectionId: ConnectionId;
  conversationId: ConversationId;
  state: Record<string, unknown>;  // Agent-specific state
  runtimeContext: RuntimeContext;
  createdAt: number;
  lastAccessedAt?: number;
}

interface RuntimeContext {
  // For conversational agents
  history?: Message[];
  addToHistory?: (role: string, content: string) => void;
  callLLM?: (messages: Message[]) => Promise<string>;

  // For stateful runtimes
  checkpoint?: unknown;       // LangGraph checkpointer
  threadId?: string;          // OpenAI thread ID
  sessionId?: string;         // Claude SDK session

  // Cleanup hook
  cleanup?: () => Promise<void>;
}
```

## Session Lifecycle Management

### Stdio Transport (Claude Desktop typical case)

```typescript
class StdioSessionManager {
  private sessions = new Map<ConnectionId, SessionState>();

  // Session created on first tool call
  async getOrCreateSession(connectionId: ConnectionId, runtime: Runtime) {
    if (!this.sessions.has(connectionId)) {
      const session = {
        connectionId,
        conversationId: this.generateConversationId(connectionId),
        state: {},
        runtimeContext: runtime.createContext(),
        createdAt: Date.now(),
      };
      this.sessions.set(connectionId, session);
    }
    return this.sessions.get(connectionId)!;
  }

  // Cleanup when MCP connection closes
  async onConnectionClosed(connectionId: ConnectionId) {
    const session = this.sessions.get(connectionId);
    if (session) {
      // Let runtime cleanup (flush checkpoints, close threads, etc.)
      await session.runtimeContext.cleanup?.();
      this.sessions.delete(connectionId);
    }
  }
}
```

**Characteristics:**
- Process lifetime = connection lifetime
- In-memory state (stdio mode)
- Cleanup on connection close

### HTTP Transport (Remote MCP servers)

```typescript
class HTTPSessionManager {
  private sessions = new Map<ConnectionId, SessionState>();
  private sessionTimeouts = new Map<ConnectionId, NodeJS.Timeout>();

  async getOrCreateSession(connectionId: ConnectionId, runtime: Runtime) {
    const session = await this.getOrCreate(connectionId, runtime);

    // Reset timeout on access
    this.resetTimeout(connectionId);

    return session;
  }

  private resetTimeout(connectionId: ConnectionId) {
    // Clear existing timeout
    const existing = this.sessionTimeouts.get(connectionId);
    if (existing) clearTimeout(existing);

    // Set new timeout (30 minutes default)
    const timeout = setTimeout(() => {
      this.expireSession(connectionId);
    }, 30 * 60 * 1000);

    this.sessionTimeouts.set(connectionId, timeout);
  }

  private async expireSession(connectionId: ConnectionId) {
    const session = this.sessions.get(connectionId);
    if (session) {
      await session.runtimeContext.cleanup?.();
      this.sessions.delete(connectionId);
      this.sessionTimeouts.delete(connectionId);
    }
  }
}
```

**Characteristics:**
- Multiple concurrent connections
- Session ID in headers (or generated)
- Timeout-based expiration (30min default, configurable)
- May need external storage for horizontal scaling

### Connection ID Generation

**Stdio mode** (process = connection):
```typescript
const connectionId = `stdio-${process.pid}` as ConnectionId;
```

**HTTP mode** (from MCP-Session-Id header or generate):
```typescript
const connectionId = (
  req.headers['mcp-session-id'] ||
  `http-${generateId()}`
) as ConnectionId;
```

## Error Handling and Result Translation

### VAT Result Envelopes → MCP Responses

```typescript
// VAT Result Envelope
{
  status: 'success' | 'error',
  data?: TOutput,
  error?: { type: string, message: string },
  confidence?: number,
  warnings?: string[],
  execution?: ExecutionMetadata
}

// MCP Tool Result
{
  content: [{ type: 'text', text: string }],
  isError?: boolean
}
```

### Translation Implementation

```typescript
class ResultTranslator {
  toMCPResult(vatResult: AgentResult): MCPToolResult {
    if (vatResult.status === 'success') {
      return {
        content: [{
          type: 'text',
          text: this.formatSuccess(vatResult)
        }],
        isError: false
      };
    }

    return {
      content: [{
        type: 'text',
        text: this.formatError(vatResult.error)
      }],
      isError: true
    };
  }

  private formatSuccess(result: AgentResult): string {
    // For conversational: return reply
    if ('reply' in result.data) {
      return result.data.reply;
    }

    // For structured output: return JSON
    return JSON.stringify(result.data, null, 2);
  }

  private formatError(error: LLMError): string {
    return `Error (${error.type}): ${error.message}`;
  }
}
```

### Error Classification

Gateway preserves error type for intelligent retry logic:

**Retryable errors (transient):**
- `llm-rate-limit` → Exponential backoff
- `llm-timeout` → Quick retry
- `llm-unavailable` → Longer wait

**Non-retryable errors (permanent):**
- `llm-refusal` → Don't retry
- `llm-invalid-output` → Don't retry
- `invalid-input` → Don't retry

MCP client (Claude Desktop) sees error type and can decide retry policy.

## Transport Implementations

### Stdio Transport (Claude Desktop)

```typescript
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

class StdioMCPGateway extends MCPGateway {
  async start() {
    const server = new Server(
      {
        name: 'vat-agents',
        version: '1.0.0'
      },
      {
        capabilities: {
          tools: {},
          logging: {}  // stderr logging support
        }
      }
    );

    // Register all tools
    const tools = Array.from(this.tools.values()).map(t => t.definition);
    server.setRequestHandler('tools/list', async () => ({ tools }));

    // Handle tool calls
    server.setRequestHandler('tools/call', async (request) => {
      const { name, arguments: args } = request.params;
      const connectionId = `stdio-${process.pid}` as ConnectionId;

      const tracer = this.observability.getTracer();

      return tracer.startActiveSpan('tool.call', async (span) => {
        span.setAttribute('tool', name);
        span.setAttribute('connection', connectionId);

        try {
          const result = await this.handleToolCall(name, args, connectionId);
          span.setAttribute('status', 'success');
          return result;
        } catch (error) {
          span.recordException(error as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally {
          span.end();
        }
      });
    });

    // Connect stdio transport
    const transport = new StdioServerTransport();
    await server.connect(transport);

    this.observability.getLogger().info('Stdio MCP gateway started', {
      tools: tools.length
    });
  }
}
```

**Key characteristics:**
- Process lifetime = connection lifetime
- Single connection (Claude Desktop to this process)
- Stderr for logging (never stdout - breaks protocol)
- In-memory session state

### HTTP Transport (Remote Servers)

```typescript
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/http.js';

class HTTPMCPGateway extends MCPGateway {
  async start(port: number = 3000) {
    const app = express();

    // Session tracking
    const sessions = new Map<string, StreamableHTTPServerTransport>();

    app.post('/mcp', async (req, res) => {
      const sessionId = req.headers['mcp-session-id'] as string;
      const connectionId = (sessionId || `http-${generateId()}`) as ConnectionId;

      let transport: StreamableHTTPServerTransport;

      if (sessionId && sessions.has(sessionId)) {
        // Reuse existing session
        transport = sessions.get(sessionId)!;
      } else {
        // Create new session
        transport = new StreamableHTTPServerTransport('/mcp', res);
        sessions.set(connectionId, transport);

        // Cleanup on disconnect
        transport.onClose(() => {
          this.sessionManager.onConnectionClosed(connectionId);
          sessions.delete(connectionId);
        });
      }

      // Handle request via transport
      await this.mcpServer.connect(transport);
    });

    app.listen(port, () => {
      this.observability.getLogger().info('HTTP MCP gateway started', { port });
    });
  }
}
```

**Key characteristics:**
- Multiple concurrent connections
- Session ID in headers (or generated)
- Timeout-based session expiration
- State may need external storage for horizontal scaling

## Observability (Future OTel Integration)

### Interface Design

**Aligned with OpenTelemetry patterns:**

```typescript
// Single provider object with separate signal getters
// Matches OTel's actual API: trace.getTracer(name, version)
export interface ObservabilityProvider {
  getTracer(name: string, version: string): Tracer;
  getMeter(name: string, version: string): Meter;
  getLogger(name: string, version: string): Logger;
}

// Use actual OTel interfaces (no translation layer)
import type { Tracer, Meter, Logger } from '@opentelemetry/api';

// Components call once at construction and cache instances
class MCPGateway {
  private readonly tracer: Tracer;

  constructor(config: GatewayConfig) {
    this.tracer = config.observability.getTracer(
      '@vibe-agent-toolkit/gateway-mcp',
      PACKAGE_VERSION
    );
  }

  // Internal API uses cached tracer
  async handleToolCall() {
    return this.tracer.startActiveSpan('tool.call', async (span) => {
      // Ambient context propagates automatically
    });
  }
}
```

**No-op implementation for when observability not configured:**

```typescript
class NoOpObservabilityProvider implements ObservabilityProvider {
  getTracer() { return new NoOpTracer(); }
  getMeter() { return new NoOpMeter(); }
  getLogger() { return new NoOpLogger(); }
}
```

### Design Decisions

**Name/Version Injection:**
- Components call `getTracer(name, version)` once at construction and cache the instance
- Aligns with OTel's standard API: `trace.getTracer(name, version)`
- Avoids passing name/version on every call (cached tracer pattern)

**Context Propagation:**
- Use OTel's ambient context via `startActiveSpan()`
- Context automatically propagates through: gateway → adapter → agent → runtime
- No explicit context parameters needed in internal APIs

**Standard Span Attributes:**
- Tool-level: `tool` (name), `connection` (connectionId), `status` (success/error)
- Agent-level: TBD in future observability design
- Runtime-level: TBD based on runtime-specific patterns

### Open Questions for Future Observability Design

**To be resolved in separate design session:**

1. Standard span attributes and metric names for consistency across agents?
2. Integration with runtime-specific observability (LangGraph tracing, OpenAI logging, etc.)?
3. Should Logger interface be simplified beyond OTel's low-level `emit()` API?
4. Metric collection patterns (counters, histograms, gauges)?
5. Sampling strategies for high-throughput deployments?

**Direction:** Follow OpenTelemetry standards for structured logging, metrics collection, and distributed tracing. Full design in future brainstorming session.

## State Management Strategy

### Research Findings

Investigation of major AI agent runtimes revealed **three distinct state management paradigms:**

1. **Built-in Persistence** (LangGraph, Temporal, CrewAI)
   - Automatic checkpointing with external storage (Postgres, Redis)
   - Production-ready fault tolerance
   - Best for long-running workflows

2. **Session/Thread-Based** (OpenAI Assistants API, Claude Agent SDK)
   - Server-side state management by vendor
   - Session IDs for resumption
   - Minimal client-side work but vendor lock-in

3. **Client-Side Management** (OpenAI Chat Completions, Vercel AI SDK, LangChain)
   - Application manages message arrays
   - Full control but more implementation work
   - Best for cost optimization and multi-provider support

### VAT Approach

**Provide abstractions, not implementations:**

```typescript
// Future package: @vibe-agent-toolkit/runtime-state

export interface StateStore {
  save(sessionId: string, state: Record<string, any>): Promise<void>;
  load(sessionId: string): Promise<Record<string, any> | null>;
  delete(sessionId: string): Promise<void>;
  list(filter?: Record<string, any>): Promise<string[]>;
}

export interface ConversationStore {
  addMessage(sessionId: string, message: Message): Promise<void>;
  getHistory(sessionId: string, options?: HistoryOptions): Promise<Message[]>;
  clearHistory(sessionId: string): Promise<void>;
}
```

**Each runtime adapter uses its native state management:**
- LangGraph adapter → PostgresSaver checkpointing
- OpenAI adapter → Thread IDs
- Vercel AI SDK adapter → RSC state hooks
- Claude Agent SDK adapter → Session-based state

**Reference implementations provided:**
- `PostgresStateStore` (production)
- `RedisStateStore` (production)
- `InMemoryStateStore` (development/testing only)

**Key insight:** MCP gateway is pass-through for state - it maps connectionIds and routes calls, but runtimes handle their state their own way.

Full state management design documented in: `docs/research/state-persistence-patterns.md`

## HITL (Human-in-the-Loop) Standards Alignment

### Industry Convergence (2024-2025)

Research shows three complementary standards emerging:

1. **MCP (Anthropic)** - Tool/context integration with consent model
2. **A2A (Google)** - Agent-to-agent communication with async HITL
3. **CIBA (OpenID Foundation)** - Decoupled authentication for agents

### Recommended Patterns for VAT

**Interrupt/Resume with Checkpointing:**
- Pattern: Agent pauses at approval point, saves state, waits for decision
- State persisted via checkpointer (database-backed, not in-memory)
- Aligns with: LangGraph `interrupt()`, Temporal signals, AWS Bedrock HITL

**Asynchronous with Backchannel:**
- Pattern: Agent submits request, continues work, gets notified on approval
- Supports: Poll mode (client checks) or ping mode (server notifies)
- Aligns with: CIBA flow, A2A async operations

**MCP Implementation:**
- Event Integrator agents (Archetype 9) use poll-based pattern
- Two tools: `{agent}-submit` (initiate) and `{agent}-check` (poll)
- Enables proper async orchestration within MCP timeout constraints

Full HITL research documented in: Research task output from brainstorming session

## Multi-Turn Conversational Agents over MCP

### Industry Best Practices

Research of production MCP servers revealed:

**Pattern: Single tool called repeatedly**
- All travel agent examples use this pattern
- Claude Desktop maintains conversation history
- MCP server maintains domain-specific state (preferences, recommendations)
- Example: Azure AI Travel Agents, Travel Assistant MCP Ecosystem

**Key Finding:** "Less is More"
- 3-7 workflow-based tools outperform many granular tools
- Single conversational tool optimal for multi-turn agents
- LLM performance degrades with more tools

**State Management:**
- **Stdio mode:** In-memory state, process lifetime = session lifetime
- **HTTP mode:** Timeout-based expiration, may need external storage
- **Host manages:** Conversation history (Claude Desktop's responsibility)
- **Server manages:** Domain state (user preferences, accumulated factors)

**Breed Advisor Example:**
```typescript
// MCP tool: breed-advisor
{
  name: "breed-advisor",
  inputSchema: { message: { type: "string" } }
}

// Server maintains state in-memory (stdio) or with timeouts (HTTP)
class BreedAdvisorServer {
  private profile: SelectionProfile = { conversationPhase: 'gathering' };

  async handleToolCall(message: string) {
    // Update profile, return response
    // State persists across calls for this connection
  }
}
```

Full MCP conversational research documented in: Research task output from brainstorming session

## Implementation Phases

### Phase 1: Foundation (MVP)

**Goal:** Stdio transport with stateless agents working in Claude Desktop

**Deliverables:**
- `@vibe-agent-toolkit/gateway-mcp` package structure
- `MCPGateway` class with agent registration
- Stdio transport implementation
- Stateless adapter (Pure Function, One-Shot LLM)
- Result envelope translation
- Basic observability hooks (console logger, no-op tracer/meter)
- Example: Haiku validator and photo analyzer via MCP

**Success criteria:**
- Claude Desktop can discover and call VAT agents
- Agents execute and return results correctly
- Error handling works (retryable vs non-retryable)

### Phase 2: Stateful Agents

**Goal:** Add conversational agent support

**Deliverables:**
- Conversational adapter with session management
- Stdio session manager (in-memory)
- Session lifecycle (create, access, cleanup)
- Example: Breed advisor conversational agent via MCP

**Success criteria:**
- Multi-turn conversations work
- State persists across tool calls
- Sessions cleanup on connection close

### Phase 3: HTTP Transport

**Goal:** Remote MCP servers

**Deliverables:**
- HTTP transport implementation
- HTTP session manager (timeout-based)
- Session ID handling (headers)
- External state store interfaces

**Success criteria:**
- Multiple concurrent clients
- Session expiration works
- State survives process restart (with external store)

### Phase 4: Advanced Archetypes

**Goal:** Orchestrations and HITL agents

**Deliverables:**
- Orchestration adapter (observable/controllable)
- Event integrator adapter (poll-based HITL)
- Observability metadata exposure

**Success criteria:**
- Orchestrations work (simple and complex)
- HITL approval workflows function
- Observability data available for debugging

### Phase 5: Production Hardening

**Goal:** Production-ready deployment

**Deliverables:**
- Full OTel integration (`@vibe-agent-toolkit/observability`)
- External state stores (Postgres, Redis)
- Horizontal scaling support
- CLI command (`vat serve-mcp`)
- Monitoring and alerting patterns

**Success criteria:**
- Scales to 100+ concurrent connections
- Full observability (traces, metrics, logs)
- Production deployment examples

## Open Questions

### Observability
- How to auto-inject component name/version into OTel calls?
- Context propagation patterns through agent execution chain?
- Standard span attributes and metric names for consistency?

### State Management
- Should MCP gateway provide reference state store implementations?
- How to handle state migration between runtime versions?
- Horizontal scaling strategy for HTTP transport with external state?

### Orchestrations
- Should orchestrations expose internal state via MCP resources?
- How to handle long-running orchestrations (hours/days)?
- Relationship between orchestration checkpointing and session state?

### HITL Integration
- Poll-based vs webhook-based approval delivery?
- Timeout handling for approval requests?
- Integration with external approval systems (Slack, email, etc.)?

### Agent Discovery
- Should gateway support dynamic agent registration (hot reload)?
- How to handle agent versioning (multiple versions of same agent)?
- Discovery from multiple sources (filesystem, registry, database)?

## Success Criteria

1. **Claude Desktop Integration** - Users can install and use VAT agents in Claude Desktop via stdio transport
2. **Stateless Agents** - Pure function and one-shot LLM agents work flawlessly
3. **Conversational Agents** - Multi-turn conversations maintain state correctly across calls
4. **Runtime Agnostic** - Same agent code works with any runtime (Vercel, OpenAI, LangChain, Claude)
5. **Error Handling** - Errors are classified correctly, enabling intelligent retry logic
6. **Observability** - Full visibility into agent execution (logs, traces, metrics)
7. **Production Ready** - Scales to 100+ concurrent connections with horizontal scaling

## Next Steps

1. **Approve Design** - Review and sign off on architecture
2. **Create Implementation Plan** - Break Phase 1 into tasks
3. **Setup Package** - Create `gateway-mcp` package structure
4. **Implement MVP** - Stdio transport + stateless adapter
5. **Test with Examples** - Validate with haiku validator and photo analyzer
6. **Iterate** - Expand to conversational agents and HTTP transport

## References

- [Model Context Protocol Specification](https://modelcontextprotocol.io/specification/2025-11-25)
- [MCP Architecture Documentation](https://modelcontextprotocol.io/docs/learn/architecture)
- [State Persistence Patterns Research](../research/state-persistence-patterns.md)
- [VAT Architecture Overview](../architecture/README.md)
- [Conversational Agents Architecture](../architecture/conversational-agents.md)
