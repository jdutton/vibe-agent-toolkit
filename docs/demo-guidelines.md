# Demo Guidelines

## Critical Rule

**CRITICAL: All demos MUST use runtime adapters, never direct agent execution.**

## Requirements for New Demos

### 1. Multi-Runtime Support

Demos must support ALL runtimes that can execute the archetype:
- Pure Function Tool → All 4 runtimes (Vercel AI SDK, LangChain, OpenAI, Claude Agent SDK)
- LLM Analyzer → All 4 runtimes
- Conversational Assistant → All 4 runtimes
- Future archetypes → Check runtime adapter packages

### 2. Runtime Adapter Pattern

Use the adapter interface pattern:

```typescript
// Define adapter interface
export interface MyArchetypeRuntimeAdapter<TInput, TOutput, TState> {
  name: string;
  convertToFunction: (...) => (input: TInput, ...) => Promise<TOutput>;
}

// Create implementations for each runtime
function createVercelAISDKAdapter(): MyArchetypeRuntimeAdapter { ... }
function createOpenAIAdapter(): MyArchetypeRuntimeAdapter { ... }
function createLangChainAdapter(): MyArchetypeRuntimeAdapter { ... }
function createClaudeAgentSDKAdapter(): MyArchetypeRuntimeAdapter { ... }

// Main demo accepts runtime as CLI argument
const adapter = getRuntimeAdapter(process.argv[2] ?? 'vercel');
```

### 3. Runtime Selection

Support command-line runtime selection:

```bash
bun run demo:my-archetype           # Default runtime (usually Vercel)
bun run demo:my-archetype vercel    # Explicit Vercel AI SDK
bun run demo:my-archetype openai    # OpenAI SDK
bun run demo:my-archetype langchain # LangChain
bun run demo:my-archetype claude    # Claude Agent SDK
```

### 4. File Organization

```
examples/
├── my-archetype-demo.ts                    # Main demo (runtime selection)
├── my-archetype-runtime-adapter.ts         # Adapter interface
└── my-archetype-adapters/
    ├── vercel-ai-sdk-adapter.ts            # Vercel implementation
    ├── openai-adapter.ts                   # OpenAI implementation
    ├── langchain-adapter.ts                # LangChain implementation
    └── claude-agent-sdk-adapter.ts         # Claude implementation
```

### 5. Why This Matters

- ✅ **Validates portability** - Ensures agents truly work across all runtimes
- ✅ **Demonstrates value prop** - Shows VAT's key benefit (write once, run anywhere)
- ✅ **Catches integration issues** - Runtime-specific bugs surface during demo creation
- ✅ **Better user experience** - Users can try the runtime they prefer
- ❌ **Never bypass adapters** - Direct agent execution skips the core value proposition

### 6. Anti-Patterns to Avoid

```typescript
// ❌ WRONG - Direct agent execution
const result = await myAgent.execute(input, context);

// ✅ CORRECT - Via runtime adapter
const adapter = getRuntimeAdapter();
const result = await adapter.convertToFunction(input);
```

## Example: Conversational Demo

See `packages/vat-example-cat-agents/examples/conversational-demo.ts` for reference implementation.

**Structure**:
- Interface: `conversational-runtime-adapter.ts`
- Adapters: `conversational-adapters/*.ts` (4 files, one per runtime)
- Main: `conversational-demo.ts` (runtime selection + CLI transport)

**Usage**:
```bash
# Test all runtimes
source ~/.secrets.env && bun run demo:conversation vercel
source ~/.secrets.env && bun run demo:conversation openai
source ~/.secrets.env && bun run demo:conversation langchain
source ~/.secrets.env && bun run demo:conversation claude
```

**For AI assistants**: When creating new demos, ALWAYS use this multi-runtime pattern. Never create demos that call `agent.execute()` directly.
