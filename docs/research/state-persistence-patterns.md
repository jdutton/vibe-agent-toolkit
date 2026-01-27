# State Persistence and Session Management in AI Agent Runtimes

Research findings on how major AI agent frameworks handle state persistence and session management (January 2025).

## Executive Summary

AI agent frameworks implement state persistence across a spectrum:

1. **Orchestration frameworks** (LangGraph, Temporal, CrewAI) provide built-in, production-ready persistence with database backends
2. **LLM integration frameworks** (LangChain, Vercel AI SDK, OpenAI) offer memory abstractions and state management utilities
3. **Runtime SDKs** (Claude Agent SDK, OpenAI Assistants API) handle state internally with session-based APIs

Common patterns:
- **Checkpointing**: Save full state snapshots at execution steps (LangGraph, Temporal)
- **Thread/Session IDs**: Track conversations across invocations (all frameworks)
- **External storage**: Delegate persistence to databases (Postgres, Redis, SQLite)
- **Memory abstractions**: Buffer recent history, summarize old context (LangChain, AutoGen, CrewAI)

## 1. LangChain.js & LangGraph

### State Management Approach

LangGraph implements state persistence through **checkpointers** that save graph state snapshots at every execution step ("super-step"). State lives in external storage (PostgreSQL, Redis, SQLite, or in-memory).

### Key Abstractions

**Checkpointers**: Core persistence interface
- `MemorySaver`: In-memory (development only)
- `PostgresSaver`: Production-ready Postgres backend
- `SqliteSaver`: Lightweight file-based persistence
- `RedisSaver`: High-performance distributed state

**Threads**: Unique conversation identifiers
- Each checkpoint has a `thread_id`
- Enables conversation history, human-in-the-loop, time travel

**Stores**: Long-term memory beyond conversation history
- `PostgresStore`: Store user preferences, facts across sessions
- Separate from checkpoints (state snapshots vs. persistent knowledge)

### Code Example: Short-Term Memory (Checkpointing)

```typescript
import { ChatAnthropic } from "@langchain/anthropic";
import { StateGraph, StateSchema, MessagesValue, START } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";

// Define state schema
const State = new StateSchema({
  messages: MessagesValue,
});

// Initialize model
const model = new ChatAnthropic({ model: "claude-haiku-4-5-20251001" });

// Production checkpointer
const DB_URI = "postgresql://postgres:postgres@localhost:5442/postgres?sslmode=disable";
const checkpointer = PostgresSaver.fromConnString(DB_URI);
await checkpointer.setup(); // Create tables

// Build graph
const callModel = async (state) => {
  const response = await model.invoke(state.messages);
  return { messages: [response] };
};

const graph = new StateGraph(State)
  .addNode("call_model", callModel)
  .addEdge(START, "call_model")
  .compile({ checkpointer });

// Use with thread ID
const config = {
  configurable: {
    thread_id: "conversation-123"
  }
};

// First turn - state automatically saved
for await (const chunk of await graph.stream(
  { messages: [{ role: "user", content: "hi! I'm bob" }] },
  { ...config, streamMode: "values" }
)) {
  console.log(chunk.messages.at(-1)?.content);
}

// Second turn - state automatically loaded
for await (const chunk of await graph.stream(
  { messages: [{ role: "user", content: "what's my name?" }] },
  { ...config, streamMode: "values" }
)) {
  console.log(chunk.messages.at(-1)?.content); // "Your name is Bob"
}
```

### Code Example: Long-Term Memory (Store)

```typescript
import { PostgresStore } from "@langchain/langgraph-checkpoint-postgres/store";
import { v4 as uuidv4 } from "uuid";

const store = PostgresStore.fromConnString(DB_URI);
await store.setup(); // Create tables

const callModel = async (state, config) => {
  const userId = config.configurable?.userId;
  const namespace = ["memories", userId];

  // Retrieve relevant memories (RAG over long-term storage)
  const memories = await config.store?.search(namespace, {
    query: state.messages.at(-1)?.content
  });
  const info = memories?.map(d => d.value.data).join("\n") || "";

  // Store new memory if requested
  const lastMessage = state.messages.at(-1);
  if (lastMessage?.content?.toLowerCase().includes("remember")) {
    const memory = "User name is Bob";
    await config.store?.put(namespace, uuidv4(), { data: memory });
  }

  const systemMsg = `You are a helpful assistant. User info: ${info}`;
  const response = await model.invoke([
    { role: "system", content: systemMsg },
    ...state.messages
  ]);
  return { messages: [response] };
};

const graph = new StateGraph(State)
  .addNode("call_model", callModel)
  .addEdge(START, "call_model")
  .compile({ checkpointer, store });

// Different threads, same user
const config1 = { configurable: { thread_id: "1", userId: "alice" } };
const config2 = { configurable: { thread_id: "2", userId: "alice" } };

// Memory persists across threads for same user
await graph.stream(
  { messages: [{ role: "user", content: "Remember: my name is Bob" }] },
  config1
);

await graph.stream(
  { messages: [{ role: "user", content: "what is my name?" }] },
  config2 // Different thread, retrieves memory via userId
);
```

### Key Features

- **Automatic checkpointing**: State saved at every step without manual intervention
- **Time travel**: Retrieve any historical checkpoint
- **Human-in-the-loop**: Pause execution, resume with modified state
- **Fault tolerance**: Resume from last checkpoint after failures
- **Multi-backend**: Swap storage without code changes (Postgres, Redis, SQLite)

### Production Considerations

- Use `PostgresSaver` or `RedisSaver` for production (never `MemorySaver`)
- Separate checkpoints (per-thread state) from stores (cross-thread memory)
- Implement cleanup policies for old checkpoints (storage grows unbounded)
- Use namespaces in stores to organize memories by user/session/type

**Sources:**
- [LangGraph Persistence Documentation](https://docs.langchain.com/oss/javascript/langgraph/add-memory)
- [Mastering LangGraph Checkpointing: Best Practices for 2025](https://sparkco.ai/blog/mastering-langgraph-checkpointing-best-practices-for-2025)
- [Tutorial - Persist LangGraph State with Couchbase Checkpointer](https://developer.couchbase.com/tutorial-langgraph-persistence-checkpoint/)

---

## 2. Vercel AI SDK

### State Management Approach

Vercel AI SDK RSC (React Server Components) manages **two distinct types of state**:

1. **UI State**: Client-side React state (like `useState`) containing rendered components
2. **AI State**: Server-side conversation history passed to LLMs on each request

**Important**: AI SDK RSC is **currently experimental and paused**. Vercel recommends using AI SDK UI for production. Migration guides are available.

### Key Abstractions

**Hooks (Client Components)**:
- `useUIState()`: Access/update UI state (rendered components)
- `useAIState()`: Read AI state (conversation history)
- `useActions()`: Trigger server actions

**Server Functions**:
- `getAIState()`: Read AI state in server actions
- `getMutableAIState()`: Update AI state in server actions
- `onSetAIState()`: Lifecycle hook to persist state when done
- `onGetUIState()`: Reconstruct UI from stored AI state

### Code Example: State Persistence

```typescript
// actions.ts - Server-side conversation handler
'use server';

import { getAIState, getMutableAIState, streamUI } from '@ai-sdk/rsc';
import { openai } from '@ai-sdk/openai';
import { generateId } from 'ai';

export interface ServerMessage {
  role: 'user' | 'assistant' | 'function';
  content: string;
}

export interface ClientMessage {
  id: string;
  role: 'user' | 'assistant' | 'function';
  display: ReactNode;
}

export async function continueConversation(
  input: string,
): Promise<ClientMessage> {
  'use server';

  // Get mutable AI state (conversation history)
  const history = getMutableAIState();

  // Stream response with tools
  const result = await streamUI({
    model: openai('gpt-3.5-turbo'),
    messages: [...history.get(), { role: 'user', content: input }],
    text: ({ content, done }) => {
      if (done) {
        // Save to AI state when complete
        history.done([
          ...history.get(),
          { role: 'user', content: input },
          { role: 'assistant', content },
        ]);
      }
      return <div>{content}</div>;
    },
    tools: {
      showStockInformation: {
        description: 'Get stock information',
        inputSchema: z.object({
          symbol: z.string(),
          numOfMonths: z.number(),
        }),
        generate: async ({ symbol, numOfMonths }) => {
          // Save tool call to AI state
          history.done([
            ...history.get(),
            {
              role: 'function',
              name: 'showStockInformation',
              content: JSON.stringify({ symbol, numOfMonths }),
            },
          ]);
          return <Stock symbol={symbol} numOfMonths={numOfMonths} />;
        },
      },
    },
  });

  return {
    id: generateId(),
    role: 'assistant',
    display: result.value, // ReactNode
  };
}
```

```typescript
// ai-context.ts - AI provider with persistence
import { createAI } from '@ai-sdk/rsc';
import { ServerMessage, ClientMessage, continueConversation } from './actions';

// saveChat and loadChat are your database functions
async function saveChat(messages: ServerMessage[]) {
  // Save to database (Postgres, MongoDB, etc.)
}

async function loadChat(): Promise<ServerMessage[]> {
  // Load from database
  return [];
}

export const AI = createAI<ServerMessage[], ClientMessage[]>({
  actions: {
    continueConversation,
  },

  // Save AI state to database when done
  onSetAIState: async ({ state, done }) => {
    'use server';
    if (done) {
      await saveChat(state);
    }
  },

  // Reconstruct UI state from stored AI state
  onGetUIState: async () => {
    'use server';
    const history = await loadChat();

    return history.map(({ role, content }) => ({
      id: generateId(),
      role,
      display:
        role === 'function'
          ? <Stock {...JSON.parse(content)} />
          : content,
    }));
  },
});
```

```tsx
// page.tsx - Client component
'use client';

import { useState } from 'react';
import { useActions, useUIState } from '@ai-sdk/rsc';
import { generateId } from 'ai';

export default function ChatPage() {
  const [input, setInput] = useState('');
  const [conversation, setConversation] = useUIState();
  const { continueConversation } = useActions();

  return (
    <div>
      <div>
        {conversation.map((message) => (
          <div key={message.id}>
            {message.role}: {message.display}
          </div>
        ))}
      </div>

      <input
        value={input}
        onChange={e => setInput(e.target.value)}
      />
      <button
        onClick={async () => {
          // Add user message to UI
          setConversation(current => [
            ...current,
            { id: generateId(), role: 'user', display: input },
          ]);

          // Get AI response
          const message = await continueConversation(input);

          // Add AI response to UI
          setConversation(current => [
            ...current,
            message,
          ]);

          setInput('');
        }}
      >
        Send
      </button>
    </div>
  );
}
```

### Key Features

- **Dual state model**: UI state (client) and AI state (server) stay synchronized
- **Generative UI**: Stream React components as LLM generates responses
- **Automatic persistence**: `onSetAIState` hook saves state when conversation completes
- **Session restoration**: `onGetUIState` reconstructs UI from stored AI state
- **Type-safe**: Full TypeScript support for state shape

### Production Considerations

- **Status**: RSC is experimental and development is paused - use AI SDK UI instead
- **Database choice**: You implement `saveChat`/`loadChat` (Postgres, MongoDB, Redis)
- **Session management**: Store session ID in cookies/auth to load correct history
- **UI reconstruction**: `onGetUIState` must handle all possible message types (text, tools, components)
- **Streaming timeout**: Set `maxDuration` for long-running operations

**Sources:**
- [AI SDK RSC: Managing Generative UI State](https://ai-sdk.dev/docs/ai-sdk-rsc/generative-ui-state)
- [AI SDK RSC: Overview](https://ai-sdk.dev/docs/ai-sdk-rsc/overview)
- [AI SDK: Save Messages to Database](https://ai-sdk.dev/cookbook/rsc/save-messages-to-database)

---

## 3. OpenAI SDK

### State Management Approach

OpenAI SDK provides **two state management models**:

1. **Assistants API**: Server-side threads managed by OpenAI (state stored by OpenAI)
2. **Chat Completions API**: Client-side message arrays (you manage state)

### Assistants API: Server-Side State

OpenAI stores conversation state in **threads**. You create threads, add messages, and run assistants against them. State persists on OpenAI servers.

#### Key Abstractions

**Threads**: Persistent conversation containers
- Created via `POST /threads`
- Store unlimited messages
- Persist indefinitely (until deleted)
- Can attach metadata (user ID, session info)

**Messages**: Individual turns in conversation
- Added via `POST /threads/{thread_id}/messages`
- Immutable once created
- Supports text, images, files

**Runs**: Execution of assistant against thread
- Created via `POST /threads/{thread_id}/runs`
- Generates assistant response
- Status tracking: `queued`, `in_progress`, `completed`, `failed`

#### Code Example: Assistants API

```typescript
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Create assistant (one-time setup)
const assistant = await openai.beta.assistants.create({
  name: "Customer Support Bot",
  instructions: "You are a helpful customer support agent.",
  model: "gpt-4-turbo",
});

// Start new conversation - create thread
const thread = await openai.beta.threads.create({
  metadata: {
    userId: "user-123",
    sessionId: "session-456",
  },
});

console.log("Thread ID:", thread.id); // Save this to resume later

// Add user message
await openai.beta.threads.messages.create(thread.id, {
  role: "user",
  content: "Hello, I need help with my order",
});

// Run assistant
const run = await openai.beta.threads.runs.create(thread.id, {
  assistant_id: assistant.id,
});

// Wait for completion (poll status)
let runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
while (runStatus.status !== 'completed') {
  await new Promise(resolve => setTimeout(resolve, 1000));
  runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
}

// Retrieve messages (includes assistant response)
const messages = await openai.beta.threads.messages.list(thread.id);
for (const message of messages.data.reverse()) {
  console.log(`${message.role}: ${message.content[0].text.value}`);
}

// Resume conversation later (same thread ID)
await openai.beta.threads.messages.create(thread.id, {
  role: "user",
  content: "Can you check the status of order #12345?",
});

const run2 = await openai.beta.threads.runs.create(thread.id, {
  assistant_id: assistant.id,
});
// ... poll and retrieve messages
```

#### Key Features

- **OpenAI-managed state**: No database needed, state stored on OpenAI servers
- **Unlimited history**: Threads can grow indefinitely (OpenAI handles context windowing)
- **Resumable**: Retrieve thread by ID weeks later, full history intact
- **Metadata**: Attach custom key-value pairs (user ID, session info)
- **Built-in tools**: Code interpreter, file search, function calling

#### Production Considerations

- **Vendor lock-in**: State lives on OpenAI servers (can't export easily)
- **Cost**: Stored messages count toward usage (long threads = higher costs)
- **Deletion**: Implement cleanup policy for old threads
- **Rate limits**: API calls subject to rate limits (polling runs can hit limits)
- **No streaming**: Must poll run status (use streaming with Chat Completions instead)

### Chat Completions API: Client-Side State

For more control, use the Chat Completions API and manage messages yourself. State lives wherever you store it (database, session storage, etc.).

#### Code Example: Chat Completions with Manual State

```typescript
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// You manage the message array
let conversationHistory = [
  { role: "system", content: "You are a helpful assistant." },
];

async function chat(userMessage: string) {
  // Add user message to history
  conversationHistory.push({
    role: "user",
    content: userMessage,
  });

  // Send full history to API
  const response = await openai.chat.completions.create({
    model: "gpt-4-turbo",
    messages: conversationHistory,
  });

  const assistantMessage = response.choices[0].message;

  // Add assistant response to history
  conversationHistory.push(assistantMessage);

  return assistantMessage.content;
}

// Use it
await chat("Hello, what's the weather like?");
await chat("What about tomorrow?"); // Has context from previous message

// Save to database (your implementation)
await saveConversation(userId, sessionId, conversationHistory);

// Load from database later
conversationHistory = await loadConversation(userId, sessionId);
await chat("Remind me what we were talking about?");
```

#### Key Features

- **Full control**: You decide where and how to store state
- **Streaming**: Real-time response streaming available
- **Portable**: Not locked to OpenAI (same message format works with other providers)
- **Context windowing**: You implement logic to truncate old messages (token limits)

#### Production Considerations

- **Token management**: Must implement context windowing (truncate old messages)
- **Storage**: You need database (Postgres, Redis, etc.)
- **Cost optimization**: Remove old messages to reduce token usage
- **Concurrent requests**: Handle race conditions if multiple users share state

**Sources:**
- [OpenAI API Reference - Threads](https://github.com/openai/openai-node/blob/master/api.md)
- [OpenAI Node SDK - Message Events](https://github.com/openai/openai-node/blob/master/helpers.md)

---

## 4. Claude Agent SDK

### State Management Approach

Claude Agent SDK uses **session-based persistence** with automatic state management. Sessions maintain complete development environment state including conversation history, file contexts, background processes, and permissions.

### Key Abstractions

**Sessions**: Persistent conversation and environment state
- Automatically created on first query
- Resume by providing `session_id`
- Fork sessions to create branches from a point in history
- State includes: messages, file contexts, working directory, background processes

**Automatic Context Management**:
- SDK manages context internally (no manual history tracking)
- Intelligent context compaction (removes redundant information)
- File system as context source (grep/tail for large files)

**Subagents**: Isolated context for specialized tasks
- Separate context from main agent
- Prevents information overload
- Focused interactions without polluting main conversation

### Code Example: Session Management

```typescript
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Start new session
const response1 = await client.messages.create({
  model: "claude-3-5-sonnet-20250129",
  max_tokens: 1024,
  messages: [
    { role: "user", content: "Hello, I'm working on a TypeScript project" }
  ],
});

// Extract session ID from response
const sessionId = response1.system?.[0]?.session_id;
console.log("Session ID:", sessionId);

// Continue conversation - SDK automatically loads history
const response2 = await client.messages.create({
  model: "claude-3-5-sonnet-20250129",
  max_tokens: 1024,
  messages: [
    { role: "user", content: "Can you help me debug the auth module?" }
  ],
  session_id: sessionId, // Resume session
});

// Fork session to create new branch
const response3 = await client.messages.create({
  model: "claude-3-5-sonnet-20250129",
  max_tokens: 1024,
  messages: [
    { role: "user", content: "Actually, let's try a different approach" }
  ],
  session_id: sessionId,
  fork_session: true, // Creates new session_id from this point
});

const newSessionId = response3.system?.[0]?.session_id;
// Now you have two separate branches
```

### Key Features

- **Automatic persistence**: No manual history management required
- **Complete environment state**: Beyond conversation (files, processes, permissions)
- **Session forking**: Branch conversations at any point
- **Context management**: SDK handles compaction and optimization
- **Subagents**: Isolated contexts for specialized tasks

### Future Development

**Context Slots** (Feature Request - November 2025):
- Designated context that updates without accumulating in history
- Use case: Game state, session data, configuration
- Avoids token waste from historical versions of ephemeral state
- Would allow agents to maintain current state without context pollution

### Production Considerations

- **Session storage**: Store session IDs in your database (map user/session → session_id)
- **Cleanup**: Implement policies to delete old sessions (no automatic expiration)
- **Forking**: Use for A/B testing or exploring alternatives without losing main thread
- **Stateful environment**: SDK expects file system access and process control

**Sources:**
- [Claude Agent SDK - Session Management](https://platform.claude.com/docs/en/agent-sdk/sessions)
- [Feature Request: Context Slots for Ephemeral State Management](https://github.com/anthropics/claude-agent-sdk-python/issues/311)
- [Building Agents with the Claude Agent SDK](https://www.anthropic.com/engineering/building-agents-with-the-claude-agent-sdk)

---

## 5. Temporal

### State Management Approach

Temporal provides **durable execution** with automatic state persistence. Every workflow execution creates an **append-only event log** stored in the persistence layer (Cassandra, MySQL, PostgreSQL). State is captured at every execution step without manual intervention.

### Key Abstractions

**Event History**: Append-only log of everything that happened
- Every state change persisted
- Every action replayable
- Complete audit trail
- Stored in database backend

**Workflow State**: Local variables, loop counters, conditional branches
- Automatically captured at await points (activities, timers, signals)
- Persists across server crashes and deployments
- Workflow can pause for days/weeks and resume perfectly

**Persistence Service**: Database backends
- Cassandra (recommended for scale)
- MySQL
- PostgreSQL
- Pluggable interface for custom stores

### Code Example: Durable Workflow State

```typescript
import { proxyActivities, sleep } from '@temporalio/workflow';
import type * as activities from './activities';

const { processPayment, sendEmail } = proxyActivities<typeof activities>({
  startToCloseTimeout: '1 minute',
});

export async function orderWorkflow(orderId: string, amount: number): Promise<string> {
  // All local variables are automatically persisted
  let retryCount = 0;
  let paymentSuccessful = false;
  let confirmationNumber: string | null = null;

  // State persists across await points
  while (retryCount < 3 && !paymentSuccessful) {
    try {
      // Activity call - state snapshot saved before/after
      const result = await processPayment(orderId, amount);
      paymentSuccessful = true;
      confirmationNumber = result.confirmationNumber;
    } catch (error) {
      retryCount++;
      // Wait 5 minutes - workflow can pause here for days
      await sleep('5 minutes');
      // After resume, retryCount and all variables are restored
    }
  }

  if (!paymentSuccessful) {
    throw new Error('Payment failed after 3 retries');
  }

  // Send confirmation email
  await sendEmail(orderId, confirmationNumber!);

  // Return value persisted in event history
  return confirmationNumber!;
}
```

**What Temporal Automatically Persists:**
- All local variables (`retryCount`, `paymentSuccessful`, `confirmationNumber`)
- Execution position (which line of code we're on)
- Activity results
- Timer state (sleep calls)
- Exception handling state

**Recovery Scenario:**
1. Workflow starts, `retryCount = 0`
2. `processPayment` fails, `retryCount = 1`
3. Sleep for 5 minutes starts
4. **Server crashes during sleep**
5. New server picks up workflow
6. **All variables restored**: `retryCount = 1`, `paymentSuccessful = false`
7. Sleep completes (timer tracked by Temporal)
8. Retry attempt #2 continues

### Workflow Lifecycle

```typescript
// Temporal workflow showing complete lifecycle with persistence

import { defineSignal, defineQuery, setHandler } from '@temporalio/workflow';

// Signals update workflow state
export const approvalSignal = defineSignal<[boolean]>('approval');
export const cancelSignal = defineSignal('cancel');

// Queries read current state
export const statusQuery = defineQuery<string>('status');

export async function approvalWorkflow(documentId: string): Promise<string> {
  let approved: boolean | null = null;
  let cancelled = false;
  let status = 'waiting_for_approval';

  // Register signal handlers (state updates)
  setHandler(approvalSignal, (approvalDecision: boolean) => {
    approved = approvalDecision;
    status = approved ? 'approved' : 'rejected';
  });

  setHandler(cancelSignal, () => {
    cancelled = true;
    status = 'cancelled';
  });

  // Register query handler (read state)
  setHandler(statusQuery, () => status);

  // Wait for approval (can wait days/weeks)
  while (approved === null && !cancelled) {
    await sleep('1 minute');
    // State persists: approved, cancelled, status all saved
  }

  if (cancelled) {
    return 'Workflow cancelled';
  }

  if (approved) {
    await proxyActivities.processDocument(documentId);
    return 'Document processed';
  } else {
    return 'Document rejected';
  }
}
```

**External State Queries (Read Current State):**
```typescript
// From outside the workflow, check current status
const handle = client.workflow.getHandle('workflow-id');
const currentStatus = await handle.query(statusQuery);
console.log(currentStatus); // "waiting_for_approval", "approved", etc.
```

**External State Updates (Send Signals):**
```typescript
// From outside, send approval decision
await handle.signal(approvalSignal, true); // Approve
// State update persisted, workflow continues with approved = true
```

### Key Features

- **Invisible checkpointing**: No manual state save/load
- **Fault tolerance**: Resume from any failure point
- **Long-running workflows**: Pause for days/weeks, resume perfectly
- **Replay-based recovery**: Re-execute workflow code deterministically using event history
- **Time travel debugging**: Replay workflow from any point in history
- **Complete audit trail**: Every state change recorded

### Production Considerations

- **Event history size**: Large event histories (100k+ events) can slow replays
- **Determinism requirement**: Workflow code must be deterministic (no random(), Date.now(), external API calls)
- **Activities for side effects**: Non-deterministic operations (API calls, DB writes) must be in activities
- **Database choice**: Cassandra for scale, Postgres for simplicity
- **Retention policies**: Archive/delete old workflow histories (grows unbounded)

**Sources:**
- [Temporal: Beyond State Machines for Reliable Distributed Applications](https://temporal.io/blog/temporal-replaces-state-machines-for-distributed-applications)
- [Temporal Workflow Execution Overview](https://docs.temporal.io/workflow-execution)
- [Agentic AI Workflows: Why Orchestration with Temporal is Key](https://intuitionlabs.ai/articles/agentic-ai-temporal-orchestration)

---

## 6. AutoGen

### State Management Approach

AutoGen agents are **stateful by default** and maintain conversation history internally. The framework provides APIs to save, load, and manage agent state, with support for context limiting to handle token constraints.

### Key Abstractions

**Agent State**: Internal conversation history
- `save_state()`: Serialize agent state
- `load_state()`: Restore agent from saved state
- State includes: messages, context, configuration

**Chat Completion Context**: Controls how much history is sent to model
- `UnboundedChatCompletionContext`: Send full history (default)
- `BufferedChatCompletionContext`: Limit to last N messages
- `TokenLimitedChatCompletionContext`: Limit by token count

**Memory Extensions**: External memory modules
- Chat history buffer
- Summarization (compress old history)
- External knowledge retrieval

### Code Example: Stateful Assistant

```typescript
import { AssistantAgent, UserProxyAgent } from 'autogen';

// Create assistant agent (stateful by default)
const assistant = new AssistantAgent({
  name: "helpful_assistant",
  llm_config: {
    model: "gpt-4",
    api_key: process.env.OPENAI_API_KEY,
  },
});

// User proxy for human interaction
const user_proxy = new UserProxyAgent({
  name: "user",
  human_input_mode: "NEVER",
});

// Conversation 1
await user_proxy.initiate_chat(assistant, {
  message: "Hello, my name is Alice"
});

// Conversation 2 - assistant remembers context
await user_proxy.initiate_chat(assistant, {
  message: "What's my name?"
});
// Assistant responds: "Your name is Alice"

// Save state for later
const state = assistant.save_state();
await saveToDatabase(userId, sessionId, state);

// Load state in new session
const loadedState = await loadFromDatabase(userId, sessionId);
const restoredAssistant = AssistantAgent.load_state(loadedState);

// Continue from where we left off
await user_proxy.initiate_chat(restoredAssistant, {
  message: "What were we talking about?"
});
```

### Code Example: Context Limiting

```typescript
import { AssistantAgent, BufferedChatCompletionContext } from 'autogen';

// Limit to last 10 messages (reduce token usage)
const assistant = new AssistantAgent({
  name: "helpful_assistant",
  llm_config: {
    model: "gpt-4",
    api_key: process.env.OPENAI_API_KEY,
  },
  chat_completion_context: new BufferedChatCompletionContext({
    max_messages: 10, // Only send last 10 messages to model
  }),
});

// Or limit by token count
import { TokenLimitedChatCompletionContext } from 'autogen';

const assistant2 = new AssistantAgent({
  name: "token_limited_assistant",
  llm_config: {
    model: "gpt-4",
    api_key: process.env.OPENAI_API_KEY,
  },
  chat_completion_context: new TokenLimitedChatCompletionContext({
    max_tokens: 4000, // Only send up to 4000 tokens of history
  }),
});
```

### Microsoft Agent Framework Migration

**Important**: AutoGen is transitioning to the **Microsoft Agent Framework**. Key differences:

**AutoGen (Current)**:
- `AssistantAgent`: Stateful, maintains conversation history
- State persists between calls automatically

**Microsoft Agent Framework (New)**:
- `ChatAgent`: Stateless, does not maintain history
- Use `AgentThread` to manage conversation history externally

```typescript
// Microsoft Agent Framework pattern
import { ChatAgent, AgentThread } from '@microsoft/agent-framework';

// Create stateless agent
const agent = new ChatAgent({
  name: "my_agent",
  model: "gpt-4",
});

// Manage state with AgentThread
const thread = new AgentThread();

// First message
const response1 = await agent.chat({
  message: "Hello, I'm Alice",
  thread: thread, // Thread stores history
});

// Second message - thread provides context
const response2 = await agent.chat({
  message: "What's my name?",
  thread: thread, // Agent receives history from thread
});

// Save thread state
const threadState = thread.save();
await saveToDatabase(userId, sessionId, threadState);

// Resume later
const loadedThread = AgentThread.load(await loadFromDatabase(userId, sessionId));
const response3 = await agent.chat({
  message: "Continue our conversation",
  thread: loadedThread,
});
```

### Key Features

- **Stateful agents**: Maintain conversation history automatically
- **Save/Load**: Serialize and restore agent state
- **Context limiting**: Control token usage with buffering/truncation
- **Memory modules**: Summarization, external knowledge retrieval
- **Migration path**: Moving to explicit thread-based state management

### Production Considerations

- **AutoGen → Microsoft Framework**: Plan migration to new framework
- **State size**: Monitor state size, implement cleanup policies
- **Context strategies**: Choose appropriate context limiting for your use case
- **Storage**: Implement database persistence for `save_state()`/`load_state()`
- **Token costs**: Context limiting reduces costs for long conversations

**Sources:**
- [AutoGen to Microsoft Agent Framework Migration Guide](https://learn.microsoft.com/en-us/agent-framework/migration-guide/from-autogen/)
- [Managing State in AutoGen](https://microsoft.github.io/autogen/stable//user-guide/agentchat-user-guide/tutorial/state.html)
- [AutoGen Agents Documentation](https://microsoft.github.io/autogen/stable//user-guide/agentchat-user-guide/tutorial/agents.html)

---

## 7. CrewAI

### State Management Approach

CrewAI implements **multi-layered memory architecture** with support for workflow state persistence through Flows. State can be unstructured (dictionary-style) or structured (Pydantic models).

### Key Abstractions

**Memory Layers**:
1. **Short-term Memory**: Recent interactions, task outputs, tool results (vector DB - ChromaDB)
2. **Long-term Memory**: Historical task inputs/outputs, feedback (SQLite database)
3. **Entity Memory**: Named entities and attributes for semantic consistency

**Flow State**: Workflow-level state management
- Unstructured: Python dictionaries
- Structured: Pydantic models (type-safe, validated)
- Persistent: Save/resume workflows

**Flow Persistence**:
- `@persist` decorator
- `FlowPersistence` interface
- Pause, resume, and recovery capabilities

### Code Example: Multi-Layer Memory

```python
from crewai import Agent, Task, Crew
from crewai.memory import ShortTermMemory, LongTermMemory, EntityMemory

# Define agents with memory
researcher = Agent(
    role='Senior Researcher',
    goal='Research and analyze market trends',
    backstory='Expert in market analysis',
    memory=True,  # Enable all memory layers
)

writer = Agent(
    role='Content Writer',
    goal='Write engaging articles',
    backstory='Skilled technical writer',
    memory=True,
)

# Create crew with memory configuration
crew = Crew(
    agents=[researcher, writer],
    tasks=[
        Task(
            description='Research AI trends in 2025',
            agent=researcher,
        ),
        Task(
            description='Write article about AI trends',
            agent=writer,
        ),
    ],
    memory=True,  # Enable memory
    memory_config={
        'short_term': {
            'provider': 'chromadb',  # Vector DB for recent context
            'storage_path': './crew_memory/short_term',
        },
        'long_term': {
            'provider': 'sqlite',  # SQL DB for historical data
            'storage_path': './crew_memory/long_term.db',
        },
        'entity': {
            'provider': 'chromadb',  # Track entities
            'storage_path': './crew_memory/entities',
        },
    },
)

# Execute - memory automatically persists
result = crew.kickoff()

# Memory persists across sessions
# Next execution can access previous context
result2 = crew.kickoff(inputs={'topic': 'quantum computing'})
# Agents have access to previous research and entities
```

### Code Example: Flow State Management

```python
from crewai import Flow, Agent, Task
from crewai.flows import FlowState, persist
from pydantic import BaseModel

# Structured state (type-safe)
class ResearchState(BaseModel):
    topic: str
    research_complete: bool = False
    findings: list[str] = []
    article_draft: str = ""

# Unstructured state (dictionary)
class UnstructuredFlow(Flow):
    state_type = dict  # or FlowState for dictionary-based

    def __init__(self):
        super().__init__()
        self.state = {
            'topic': '',
            'status': 'pending',
            'results': [],
        }

    @persist  # Save state after this step
    def research_step(self):
        self.state['status'] = 'researching'
        # Perform research
        self.state['results'] = ['finding1', 'finding2']
        return self.state

    @persist
    def write_step(self):
        self.state['status'] = 'writing'
        # Write article
        return self.state

# Structured state flow (recommended)
class StructuredFlow(Flow):
    state_type = ResearchState

    def __init__(self):
        super().__init__()
        self.state = ResearchState(topic='AI trends')

    @persist
    def research_step(self):
        # Type-safe access
        self.state.research_complete = True
        self.state.findings = ['AI adoption up 40%', 'LLMs dominate']
        return self.state

    @persist
    def write_step(self):
        # Access with autocompletion
        self.state.article_draft = f"Article about {self.state.topic}"
        return self.state

# Run flow with persistence
flow = StructuredFlow()

# Execute step 1 - state saved
flow.research_step()

# Simulate interruption (server restart, etc.)
# Load flow from persistent storage
loaded_flow = StructuredFlow.load(flow.id)

# Continue from where we left off
loaded_flow.write_step()  # Has access to research findings
```

### Code Example: Long-Running Workflow with Recovery

```python
from crewai import Flow, Agent, Crew, Task
from crewai.flows import persist, FlowPersistence
import time

class DataPipelineFlow(Flow):
    state_type = dict

    def __init__(self):
        super().__init__()
        self.state = {
            'stage': 'init',
            'data_collected': False,
            'data_processed': False,
            'report_generated': False,
        }

    @persist
    def collect_data(self):
        self.state['stage'] = 'collecting'
        # Long-running data collection
        time.sleep(60)  # Simulate 1 min collection
        self.state['data_collected'] = True
        return self.state

    @persist
    def process_data(self):
        if not self.state['data_collected']:
            raise ValueError("Data not collected yet")

        self.state['stage'] = 'processing'
        # Long-running processing
        time.sleep(120)  # Simulate 2 min processing
        self.state['data_processed'] = True
        return self.state

    @persist
    def generate_report(self):
        if not self.state['data_processed']:
            raise ValueError("Data not processed yet")

        self.state['stage'] = 'reporting'
        # Generate report
        self.state['report_generated'] = True
        return self.state

# Start pipeline
pipeline = DataPipelineFlow()

try:
    pipeline.collect_data()
    pipeline.process_data()
    pipeline.generate_report()
except Exception as e:
    # Failure during processing
    print(f"Pipeline failed: {e}")
    # State is saved, can resume

# Resume from failure point
resumed_pipeline = DataPipelineFlow.load(pipeline.id)

# Check what's complete
if resumed_pipeline.state['data_collected'] and not resumed_pipeline.state['data_processed']:
    # Skip collection, resume at processing
    resumed_pipeline.process_data()
    resumed_pipeline.generate_report()
```

### Key Features

- **Three memory layers**: Short-term (recent), Long-term (historical), Entity (semantic)
- **Structured state**: Pydantic models for type safety and validation
- **Flow persistence**: `@persist` decorator for automatic checkpointing
- **Pause/resume**: Workflows can pause and resume across sessions
- **Recovery**: Automatic state recovery after failures
- **Default storage**: ChromaDB (vectors), SQLite (structured data)

### Production Considerations

- **Memory storage**: Default `~/.local/share/CrewAI/` - configure for production
- **State size**: Monitor state growth, implement cleanup policies
- **Structured state**: Use Pydantic models for production (catches errors early)
- **Database backend**: Replace SQLite with Postgres for scale
- **Vector DB**: Replace ChromaDB with Pinecone/Weaviate for production
- **Serialization**: Ensure state is serializable (no file handles, network connections)

**Sources:**
- [CrewAI Changelog - January 2025](https://docs.crewai.com/en/changelog)
- [Deep Dive into CrewAI Memory Systems](https://sparkco.ai/blog/deep-dive-into-crewai-memory-systems)
- [CrewAI Flows Explained: The Next Evolution in AI Orchestration](https://medium.com/codex/crewai-flows-explained-the-next-evolution-in-ai-orchestration-part-2-a7ff0fbe47d8)

---

## 8. LangChain Memory Abstractions (Classic)

### State Management Approach

LangChain provides **memory classes** that abstract conversation history management. These classes handle storing and retrieving messages, with various strategies for managing token limits.

**Important**: As of version 0.3.1 (2025), many memory classes are **deprecated**. Modern LangChain uses message trimming utilities and LangGraph checkpointing instead.

### Key Abstractions (Deprecated but Illustrative)

**ConversationBufferMemory**: Store full conversation history
- Simple in-memory buffer
- No truncation or summarization
- Grows unbounded (token limit issues)

**ConversationBufferWindowMemory**: Store last N messages
- Sliding window approach
- Reduces token usage
- Loses older context

**ConversationSummaryMemory**: Summarize old messages
- Compresses history using LLM
- Maintains context while reducing tokens
- Additional LLM calls for summarization

**ConversationTokenBufferMemory**: Limit by token count
- Tracks token usage
- Truncates when exceeds limit
- More precise than message count

### Code Example: Buffer Window Memory (Deprecated)

```typescript
import { ConversationChain } from "langchain/chains";
import { ChatOpenAI } from "@langchain/openai";
import { BufferWindowMemory } from "langchain/memory";

// Keep only last 5 messages
const memory = new BufferWindowMemory({
  k: 5, // Window size
  returnMessages: true,
});

const model = new ChatOpenAI({
  modelName: "gpt-3.5-turbo",
});

const chain = new ConversationChain({
  llm: model,
  memory: memory,
});

// Conversation
await chain.call({ input: "Hi, I'm Alice" });
await chain.call({ input: "What's the weather?" });
await chain.call({ input: "What's my name?" }); // Still remembers (within window)

// After 6+ messages, "Hi, I'm Alice" is dropped
for (let i = 0; i < 10; i++) {
  await chain.call({ input: `Message ${i}` });
}

await chain.call({ input: "What's my name?" }); // Forgets Alice (outside window)
```

### Modern Approach: Message Trimming (2025)

```typescript
import { ChatOpenAI } from "@langchain/openai";
import { MessagesPlaceholder } from "@langchain/core/prompts";
import { trimMessages } from "@langchain/core/messages";

const model = new ChatOpenAI({
  modelName: "gpt-3.5-turbo",
});

// Manual message management (you store messages)
let conversationHistory = [];

async function chat(userMessage: string) {
  conversationHistory.push({
    role: "user",
    content: userMessage,
  });

  // Trim to last 10 messages before sending to LLM
  const trimmedHistory = trimMessages(conversationHistory, {
    maxMessages: 10,
    strategy: "last", // or "first", "token_limit"
  });

  const response = await model.invoke(trimmedHistory);

  conversationHistory.push({
    role: "assistant",
    content: response.content,
  });

  return response.content;
}

// Store to database
await saveConversation(userId, conversationHistory);
```

### Modern Approach: LangGraph Checkpointing (Recommended)

See **LangChain.js & LangGraph** section above for production-ready state management with checkpointers and stores.

### Key Features (Classic Memory)

- **Abstraction**: Hides storage details from chain logic
- **Multiple strategies**: Buffer, window, summary, token-based
- **Trade-offs**: Simplicity vs. token usage vs. context retention

### Why Deprecated?

1. **Tight coupling**: Memory tied to chain abstractions
2. **Limited flexibility**: Hard to implement custom strategies
3. **Better alternatives**: LangGraph checkpointing, manual message arrays
4. **Token management**: Better handled with explicit trimming utilities

### Production Considerations (Modern)

- **Don't use deprecated memory classes**: Migrate to LangGraph or manual management
- **Token awareness**: Always track token usage, implement trimming
- **Database storage**: Store full conversation, trim before LLM calls
- **Context strategies**: Choose based on use case (window, summary, vector search)

**Sources:**
- [LangChain ConversationBufferMemory: Complete Implementation Guide + Code Examples 2025](https://latenode.com/blog/ai-frameworks-technical-infrastructure/langchain-setup-tools-agents-memory/langchain-conversationbuffer-memory-complete-implementation-guide-code-examples-2025)
- [Conversational Memory for LLMs with Langchain](https://www.pinecone.io/learn/series/langchain/langchain-conversational-memory/)
- [LangChain Memory Documentation](https://python.langchain.com/api_reference/langchain/memory/)

---

## Summary: State Persistence Patterns Across Frameworks

### Pattern 1: Built-In Persistence with External Storage
**Frameworks**: LangGraph, Temporal, CrewAI

**Characteristics**:
- Framework manages persistence automatically
- State stored in external databases (Postgres, SQLite, Redis)
- Checkpointing at execution steps
- Production-ready out of the box

**When to Use**:
- Long-running workflows
- Need fault tolerance
- Multi-step orchestration
- Complex state requirements

### Pattern 2: Session/Thread-Based State
**Frameworks**: OpenAI Assistants API, Claude Agent SDK

**Characteristics**:
- Server-side state management
- Session IDs for resumption
- State stored by vendor (OpenAI) or SDK (Claude)
- Minimal client-side state management

**When to Use**:
- Simple conversational agents
- Don't want to manage database
- Vendor lock-in acceptable
- Prototype/MVP development

### Pattern 3: Client-Side State Management
**Frameworks**: OpenAI Chat Completions, Vercel AI SDK, LangChain Memory

**Characteristics**:
- You manage message arrays
- Choose your storage (Postgres, Redis, etc.)
- Full control over state shape
- Manual context windowing

**When to Use**:
- Need full control
- Multi-provider support
- Custom state requirements
- Cost optimization (token management)

### Pattern 4: Agent-Level Statefulness
**Frameworks**: AutoGen, CrewAI (Agents)

**Characteristics**:
- Agents maintain internal state
- Save/load APIs for persistence
- Context limiting options
- Memory abstractions (short-term, long-term)

**When to Use**:
- Multi-agent systems
- Agent-to-agent communication
- Need memory layers
- Learning from past executions

---

## Common Implementation Patterns

### 1. Message History Buffer

**Problem**: Store and retrieve conversation history

**Solution**:
```typescript
interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: Date;
}

class ConversationStore {
  async saveMessage(sessionId: string, message: Message): Promise<void> {
    // Save to database
  }

  async getHistory(sessionId: string, limit?: number): Promise<Message[]> {
    // Retrieve from database
  }

  async clearHistory(sessionId: string): Promise<void> {
    // Delete history
  }
}
```

**Used by**: All frameworks (implement yourself or use built-in)

### 2. Token-Aware Context Windowing

**Problem**: Stay within model token limits

**Solution**:
```typescript
function trimHistory(
  messages: Message[],
  maxTokens: number
): Message[] {
  let tokenCount = 0;
  const trimmed: Message[] = [];

  // Keep system message
  if (messages[0]?.role === 'system') {
    trimmed.push(messages[0]);
    tokenCount += estimateTokens(messages[0].content);
  }

  // Add messages from end until token limit
  for (let i = messages.length - 1; i >= 1; i--) {
    const msgTokens = estimateTokens(messages[i].content);
    if (tokenCount + msgTokens > maxTokens) break;
    trimmed.unshift(messages[i]);
    tokenCount += msgTokens;
  }

  return trimmed;
}
```

**Used by**: LangChain, AutoGen, custom implementations

### 3. Checkpoint-Based State Snapshots

**Problem**: Resume workflows after failures

**Solution**:
```typescript
interface Checkpoint {
  id: string;
  timestamp: Date;
  state: Record<string, any>;
  metadata?: Record<string, any>;
}

class CheckpointStore {
  async saveCheckpoint(
    workflowId: string,
    state: Record<string, any>
  ): Promise<Checkpoint> {
    const checkpoint = {
      id: generateId(),
      timestamp: new Date(),
      state: structuredClone(state),
    };
    // Save to database
    return checkpoint;
  }

  async getLatestCheckpoint(workflowId: string): Promise<Checkpoint | null> {
    // Retrieve from database
  }

  async listCheckpoints(workflowId: string): Promise<Checkpoint[]> {
    // Retrieve all checkpoints
  }
}
```

**Used by**: LangGraph, Temporal, CrewAI Flows

### 4. Hierarchical Memory (Short-Term + Long-Term)

**Problem**: Balance recent context with historical knowledge

**Solution**:
```typescript
class HierarchicalMemory {
  // Short-term: Recent conversation (in-memory or Redis)
  private shortTerm: Message[] = [];

  // Long-term: Facts, preferences (database + vector DB)
  private longTermStore: VectorDatabase;

  async addMessage(message: Message): Promise<void> {
    // Add to short-term buffer
    this.shortTerm.push(message);

    // Keep only last N messages
    if (this.shortTerm.length > 20) {
      this.shortTerm.shift();
    }

    // Extract and store facts in long-term
    const facts = await extractFacts(message);
    for (const fact of facts) {
      await this.longTermStore.store(fact);
    }
  }

  async getContext(query: string): Promise<string> {
    // Recent conversation
    const recent = this.shortTerm.map(m => m.content).join('\n');

    // Relevant historical facts (semantic search)
    const relevant = await this.longTermStore.search(query, { limit: 5 });
    const facts = relevant.map(r => r.content).join('\n');

    return `Recent conversation:\n${recent}\n\nRelevant facts:\n${facts}`;
  }
}
```

**Used by**: CrewAI, custom implementations

---

## Decision Matrix: Choosing a State Management Approach

| Requirement | Recommended Framework | Pattern |
|-------------|----------------------|---------|
| Simple chatbot | OpenAI Assistants API, Claude Agent SDK | Session-based |
| Long-running workflows | Temporal, LangGraph | Checkpointing |
| Multi-agent orchestration | CrewAI, AutoGen | Agent-level state |
| Cost optimization | OpenAI Chat Completions, manual management | Client-side buffer |
| Fault tolerance | Temporal, LangGraph | Event sourcing |
| Real-time streaming | Vercel AI SDK, OpenAI Chat Completions | Client-side buffer |
| React integration | Vercel AI SDK (experimental) | RSC state hooks |
| Multi-provider support | LangChain, manual management | Client-side buffer |
| Memory layers | CrewAI, custom implementation | Hierarchical memory |
| Time travel debugging | Temporal, LangGraph | Event sourcing |

---

## Recommendations for VAT (Vibe Agent Toolkit)

### 1. Provide Abstractions, Not Implementations

VAT should define **interfaces** for state management, letting users plug in their storage:

```typescript
// @vibe-agent-toolkit/runtime-state (new package)

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

### 2. Runtime-Specific Adapters

Each runtime adapter should handle state appropriately:

```typescript
// Vercel AI SDK adapter - use RSC state hooks
class VercelAISDKAdapter implements RuntimeAdapter {
  convertToFunction(agent, stateStore) {
    // Use useAIState/useUIState internally
    return async (input) => {
      const history = stateStore.load(sessionId);
      // Use streamUI with state management
    };
  }
}

// LangChain adapter - use LangGraph checkpointing
class LangChainAdapter implements RuntimeAdapter {
  convertToFunction(agent, stateStore) {
    // Use PostgresSaver or MemorySaver
    const checkpointer = new PostgresSaver(dbUri);
    // Compile graph with checkpointer
  }
}

// OpenAI adapter - use Assistants API threads
class OpenAIAdapter implements RuntimeAdapter {
  convertToFunction(agent, stateStore) {
    // Map VAT session IDs to OpenAI thread IDs
    const threadId = await stateStore.load(sessionId);
    // Use thread-based API
  }
}
```

### 3. Reference Implementations

Provide example implementations for common stores:

```typescript
// @vibe-agent-toolkit/runtime-state-postgres
export class PostgresStateStore implements StateStore {
  // Full implementation for Postgres
}

// @vibe-agent-toolkit/runtime-state-redis
export class RedisStateStore implements StateStore {
  // Full implementation for Redis
}

// @vibe-agent-toolkit/runtime-state-memory
export class InMemoryStateStore implements StateStore {
  // For testing only
}
```

### 4. State Management Utilities

```typescript
// @vibe-agent-toolkit/runtime-state/utils

export function trimMessages(
  messages: Message[],
  maxTokens: number
): Message[] {
  // Token-aware trimming
}

export function extractFacts(message: Message): Promise<string[]> {
  // Extract facts for long-term memory
}

export function estimateTokens(text: string): number {
  // Token estimation (rough)
}
```

### 5. Documentation and Examples

- **Guide**: "State Management in VAT Agents"
- **Examples**: Reference implementations for each runtime
- **Decision tree**: Help users choose state strategy
- **Migration guides**: Move between runtimes without losing state

---

## Conclusion

State persistence and session management vary significantly across AI frameworks:

1. **Orchestration frameworks** (LangGraph, Temporal, CrewAI) provide production-ready persistence with external databases
2. **LLM frameworks** (LangChain, Vercel AI SDK) offer utilities and abstractions for client-managed state
3. **Runtime SDKs** (OpenAI, Claude) handle state internally with session/thread APIs

**Key Takeaway**: There is no universal state management pattern. VAT should:
- Define abstract interfaces for state storage
- Provide runtime-specific adapters that leverage native state management
- Offer reference implementations for common backends (Postgres, Redis)
- Let users choose their storage and strategy

This approach maintains VAT's "write once, run anywhere" philosophy while respecting each runtime's native state management patterns.
