# @vibe-agent-toolkit/transports

Transport adapters for VAT conversational agents.

## Overview

Transports connect conversational functions to different interaction channels (CLI, WebSocket, HTTP, etc.) without coupling to specific runtime implementations. This package provides the core transport abstraction and two reference implementations.

## Installation

```bash
npm install @vibe-agent-toolkit/transports
```

## Core Concepts

### Conversational Function

A conversational function is any async function that:
- Takes input and session state
- Returns output and updated session state

```typescript
type ConversationalFunction<TInput, TOutput, TState> = (
  input: TInput,
  session: Session<TState>
) => Promise<{
  output: TOutput;
  session: Session<TState>;
}>;
```

### Session

A session contains conversation history and application-specific state:

```typescript
type Session<TState> = {
  history: Message[];
  state: TState;
};
```

### Transport

A transport provides lifecycle management for running conversational functions:

```typescript
interface Transport {
  start(): Promise<void>;
  stop(): Promise<void>;
}
```

## CLI Transport

Interactive command-line interface with built-in commands and conversation history.

### Features

- Local session management (single user)
- Built-in commands: `/quit`, `/state`, `/restart`, `/help`
- Optional colored output
- Configurable prompts

### Usage

```typescript
import { CLITransport } from '@vibe-agent-toolkit/transports';

// Create a simple echo agent
const echoFn = async (input: string, session: Session<any>) => {
  const newHistory = [
    ...session.history,
    { role: 'user', content: input },
    { role: 'assistant', content: `Echo: ${input}` },
  ];
  return {
    output: `Echo: ${input}`,
    session: { ...session, history: newHistory },
  };
};

// Run with CLI transport
const transport = new CLITransport({
  fn: echoFn,
  showState: true,
  colors: true,
});

await transport.start();
```

### Options

```typescript
interface CLITransportOptions<TState> {
  fn: ConversationalFunction<string, string, TState>;
  initialSession?: Session<TState>;
  colors?: boolean; // Default: true
  showState?: boolean; // Default: false
  prompt?: string; // Default: "You: "
  assistantPrefix?: string; // Default: "Assistant: "
}
```

### Built-in Commands

- `/help` - Show available commands
- `/state` - Display current session state
- `/restart` - Clear history and reset state
- `/quit` - Exit the CLI

## WebSocket Transport

Real-time bidirectional communication with per-connection session isolation.

### Features

- Per-connection session management
- JSON message format
- Automatic session cleanup on disconnect
- Configurable host and port

### Usage

```typescript
import { WebSocketTransport } from '@vibe-agent-toolkit/transports';

// Create a stateful counter agent
const counterFn = async (input: string, session: Session<{ count: number }>) => {
  const count = (session.state?.count ?? 0) + 1;
  const newHistory = [
    ...session.history,
    { role: 'user', content: input },
    { role: 'assistant', content: `Message #${count}` },
  ];
  return {
    output: `Message #${count}`,
    session: { history: newHistory, state: { count } },
  };
};

// Run with WebSocket transport
const transport = new WebSocketTransport({
  fn: counterFn,
  port: 8080,
  createInitialSession: () => ({ history: [], state: { count: 0 } }),
});

await transport.start();
// Server listening on ws://localhost:8080
```

### Options

```typescript
interface WebSocketTransportOptions<TState> {
  fn: ConversationalFunction<string, string, TState>;
  port?: number; // Default: 8080
  host?: string; // Default: 'localhost'
  createInitialSession?: () => Session<TState>;
}
```

### Message Format

**Client → Server:**
```json
{
  "type": "message",
  "content": "Hello"
}
```

**Server → Client (success):**
```json
{
  "type": "message",
  "reply": "Response text",
  "state": { "count": 1 }
}
```

**Server → Client (error):**
```json
{
  "type": "error",
  "error": "Error message"
}
```

### Client Example

```typescript
import { WebSocket } from 'ws';

const ws = new WebSocket('ws://localhost:8080');

ws.on('open', () => {
  ws.send(JSON.stringify({
    type: 'message',
    content: 'Hello, agent!'
  }));
});

ws.on('message', (data) => {
  const response = JSON.parse(data.toString());
  console.log('Reply:', response.reply);
  console.log('State:', response.state);
});
```

## Using with Runtime Adapters

Transports work with any runtime adapter that implements the conversational function signature:

```typescript
import { CLITransport } from '@vibe-agent-toolkit/transports';
import { createClaudeSkillAdapter } from '@vibe-agent-toolkit/agent-skills';

// Create adapter from Claude skill
const adapter = createClaudeSkillAdapter({
  skillDir: './my-skill',
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Run with CLI transport
const transport = new CLITransport({
  fn: adapter.conversationalFn,
});

await transport.start();
```

## Architecture

### No Session IDs in Core Types

The transport abstraction intentionally excludes session IDs from core types. Session management is transport-specific:

- **CLI Transport**: Single local session (no ID needed)
- **WebSocket Transport**: Per-connection sessions (WeakMap keyed by socket)
- **HTTP Transport** (future): Session IDs in cookies/headers

This design keeps the core types simple while allowing each transport to implement session management appropriately.

### Transport Independence

Transports are independent of runtime implementations. The same conversational function can run on any transport:

```typescript
// Same function, different transports
const myFn = createMyAgent();

// CLI
const cliTransport = new CLITransport({ fn: myFn });

// WebSocket
const wsTransport = new WebSocketTransport({ fn: myFn });

// HTTP (future)
const httpTransport = new HTTPTransport({ fn: myFn });
```

## TypeScript

This package is written in TypeScript and provides full type definitions.

```typescript
import type {
  Transport,
  ConversationalFunction,
  Session,
  Message,
} from '@vibe-agent-toolkit/transports';
```

## License

MIT
