# Structured Outputs in VAT

Guide to choosing and implementing structured output patterns for conversational agents.

## The Problem

**Conversational agents have conflicting requirements:**
- **Natural conversation**: Users expect friendly, natural language
- **Structured extraction**: Systems need predictable, validated data
- **Every-turn extraction**: Trying to extract JSON on every turn fights the LLM's conversational nature

**Common failure mode**: LLM responds conversationally ("Sure, I can help!") instead of returning JSON.

## Three Patterns for Structured Outputs

### Pattern 1: Two-Phase Conversational (Recommended for Chatbots)

**When to use:**
- Multi-turn conversations to gather information
- Chatbots, advisors, assistants
- User needs natural interaction
- Structured data needed only at end

**How it works:**
```
Phase 1: Gathering (turns 1-N)
├─ Conversational text only
├─ No JSON schema constraints
├─ Natural questions/answers
└─ Accumulate state in memory

Phase 2: Extraction (final turn)
├─ User confirms ready
├─ LLM returns structured JSON
└─ Use JSON mode or function calling
```

**Example:**
```typescript
// Phase 1: Conversational
User: "I need a cat"
Agent: "Great! What kind of music do you listen to?"
User: "I like rap"
Agent: "Interesting! Would that be closer to 'rock' (bold energy)
       or 'pop' (social vibe) for our matching system?"
User: "Rock, I guess"
Agent: "Perfect! Tell me about your living space..."

// Phase 2: Extraction (after 4+ factors gathered)
Agent: "I have enough info! Ready for recommendations?"
User: "Yes"
Agent: { // JSON with structured output
  recommendations: [...]
}
```

**Implementation:**
```typescript
// Phase 1: No schema, just conversational
async function gatheringPhase(message: string, state: ConversationState) {
  const response = await llm.generate({
    messages: [...history, { role: 'user', content: message }],
    // NO response_format - pure text
  });

  // Extract mentioned factors informally
  updateStateFromText(response, state);

  return { reply: response, isReady: hasEnoughFactors(state) };
}

// Phase 2: Structured extraction
async function extractionPhase(state: ConversationState) {
  const response = await llm.generate({
    messages: [
      { role: 'system', content: 'Extract and format the gathered data' },
      { role: 'user', content: JSON.stringify(state) }
    ],
    response_format: {
      type: "json_schema",
      json_schema: ProfileSchema  // 100% adherence
    }
  });

  return JSON.parse(response);
}
```

**Benefits:**
- ✅ Natural conversation flow
- ✅ No JSON parsing errors during chat
- ✅ Clear transition point
- ✅ Works with any LLM

**Tradeoffs:**
- Informal extraction during gathering (less strict)
- Requires phase management logic
- Two different prompting strategies

---

### Pattern 2: JSON Mode with Schema Validation

**When to use:**
- Every response needs structured data
- Known, fixed schema
- Using OpenAI gpt-4o-2024-08-06 or later
- Not highly conversational (more form-filling)

**How it works:**
- Every LLM call includes `response_format` with JSON schema
- OpenAI achieves 100% schema adherence ([source](https://openai.com/index/introducing-structured-outputs-in-the-api/))
- No retry needed - guaranteed valid JSON

**Implementation (OpenAI):**
```typescript
import { zodToJsonSchema } from 'zod-to-json-schema';

const completion = await openai.chat.completions.create({
  model: "gpt-4o-2024-08-06",
  messages: [...conversationHistory],
  response_format: {
    type: "json_schema",
    json_schema: {
      name: "breed_profile_response",
      strict: true,
      schema: zodToJsonSchema(BreedAdvisorOutputSchema)
    }
  }
});

// Response is GUARANTEED to match schema
const data = JSON.parse(completion.choices[0].message.content);
```

**Implementation (Vercel AI SDK):**
```typescript
import { openai } from '@ai-sdk/openai';
import { generateObject } from 'ai';

const { object } = await generateObject({
  model: openai('gpt-4o-2024-08-06'),
  schema: BreedAdvisorOutputSchema,  // Zod schema
  prompt: 'Your conversational prompt here',
});

// object is fully typed and validated
```

**Benefits:**
- ✅ 100% schema adherence (OpenAI)
- ✅ No retry logic needed
- ✅ Fully typed responses
- ✅ Built-in, not prompt hacking

**Tradeoffs:**
- ❌ Requires OpenAI gpt-4o-2024-08-06+ (not portable)
- ❌ Still fighting conversational nature
- ❌ Reply must be JSON (can't be purely conversational)
- ❌ Every turn has parsing overhead

**When NOT to use:**
- Early conversation turns (gathering info)
- Highly conversational interactions
- Need to work across multiple LLM providers

---

### Pattern 3: Function/Tool Calling

**When to use:**
- Agent needs to TAKE ACTIONS (not just return data)
- Mixed conversation + structured operations
- Want LLM to decide WHEN to extract
- Using OpenAI, Anthropic, or compatible APIs

**How it works:**
- Define functions/tools the LLM can call
- LLM generates text AND/OR calls functions
- Framework executes functions and returns results
- Clear separation: conversation vs actions

**Example conversation:**
```
User: "I need a cat for my apartment"
Agent: "Great! Tell me more..."  // Just text

User: "I like rock music and have two kids"
Agent: <calls update_profile({
  livingSpace: "apartment",
  musicPreference: "rock",
  familyComposition: "young-kids"
})>
Agent: "Thanks! What about grooming?"  // More text

User: "I don't want to brush daily"
Agent: <calls update_profile({ groomingTolerance: "weekly" })>
Agent: <calls get_recommendations()>
Agent: "Based on your profile, I recommend..."  // Present results
```

**Implementation (OpenAI):**
```typescript
const tools = [{
  type: "function",
  function: {
    name: "update_breed_profile",
    description: "Update user's breed selection profile with new information",
    parameters: zodToJsonSchema(SelectionProfileSchema)
  }
}, {
  type: "function",
  function: {
    name: "get_recommendations",
    description: "Get breed recommendations when profile is complete",
    parameters: { type: "object", properties: {} }
  }
}];

const completion = await openai.chat.completions.create({
  model: "gpt-4o",
  messages: conversationHistory,
  tools: tools,
  tool_choice: "auto"  // LLM decides when to call
});

if (completion.choices[0].message.tool_calls) {
  for (const toolCall of completion.choices[0].message.tool_calls) {
    if (toolCall.function.name === "update_breed_profile") {
      const args = JSON.parse(toolCall.function.arguments);
      updateProfile(args);
    } else if (toolCall.function.name === "get_recommendations") {
      const recs = generateRecommendations(currentProfile);
      // Add to conversation history
    }
  }
}
```

**Implementation (Anthropic Claude):**
```typescript
import Anthropic from '@anthropic-ai/sdk';

const tools = [{
  name: "update_breed_profile",
  description: "Update user's breed profile with confirmed information",
  input_schema: zodToJsonSchema(SelectionProfileSchema)
}];

const message = await anthropic.messages.create({
  model: "claude-3-5-sonnet-20241022",
  max_tokens: 1024,
  tools: tools,
  messages: conversationHistory
});

// Check for tool use
if (message.content.some(block => block.type === 'tool_use')) {
  const toolUse = message.content.find(block => block.type === 'tool_use');
  // Execute tool and continue conversation
}
```

**Benefits:**
- ✅ Natural separation: text vs actions
- ✅ LLM decides when to extract (not every turn)
- ✅ Can call multiple functions in one turn
- ✅ Clear intent tracking
- ✅ Industry standard pattern

**Tradeoffs:**
- More complex implementation
- Requires function/tool calling support
- Need to handle function execution
- Conversation + tool results in history

---

## Decision Matrix

| Use Case | Pattern | Why |
|----------|---------|-----|
| Chatbot gathering info over multiple turns | **Two-Phase** | Natural conversation, structured output only when ready |
| Form-filling with fixed fields | **JSON Mode** | Every response needs structure, no ambiguity |
| Agent taking actions (API calls, DB updates) | **Tool Calling** | Clear intent, mixed text + operations |
| Extracting data from single message | **JSON Mode** | One-shot extraction, no conversation needed |
| Complex multi-step workflow | **Tool Calling** | Agent orchestrates multiple operations |
| Need to work across LLM providers | **Two-Phase** | Most portable, doesn't require specific features |

## Implementation in VAT

### Current: JSON Every Turn (Problematic)

The breed advisor currently tries to return JSON on every turn:

**Problems:**
- ❌ LLM slips into conversational mode ("Sure, I can help!")
- ❌ JSON parse errors break the flow
- ❌ Fighting natural conversation
- ❌ Requires complex retry logic

### Recommended: Two-Phase Pattern

**For the breed advisor demo**, use two-phase:

```typescript
// Phase 1: Gather (conversational)
type GatheringResponse = {
  reply: string;  // Pure text
  extractedFactors: Partial<SelectionProfile>;  // Informal extraction
  isReadyForRecommendations: boolean;
};

// Phase 2: Extract (structured)
type ExtractionResponse = {
  profile: SelectionProfile;  // Validated schema
  recommendations: BreedRecommendation[];
};
```

**Conversation flow:**
1. User starts conversation
2. Agent asks questions (text responses)
3. Track factors informally (forgiving)
4. When 4+ factors: "Ready for recommendations?"
5. User confirms → Phase 2 (structured extraction)
6. Return validated profile + recommendations

### Alternative: Tool Calling Pattern

For more complex use cases:

```typescript
// Define tools
const tools = {
  update_profile: { schema: SelectionProfileSchema },
  get_recommendations: { schema: RecommendationsSchema },
  ask_clarification: { schema: ClarificationSchema }
};

// LLM decides when to call each tool
// Conversation history includes both text and tool calls
```

## Best Practices

### 1. Match Pattern to Use Case
- Chatbot → Two-phase
- Data extraction → JSON mode
- Actions → Tool calling

### 2. Use Native Features When Available
- OpenAI gpt-4o-2024-08-06: Use Structured Outputs (100% adherence)
- Anthropic Claude: Use tool use (not JSON mode)
- Other providers: Use two-phase pattern

### 3. Don't Fight the LLM
- Asking for JSON on every conversational turn = fighting
- Let LLM be conversational when gathering info
- Extract structure when ready

### 4. Test Failure Modes
- What if LLM returns text instead of JSON?
- What if LLM creates invalid enum values?
- What if user input is ambiguous?

### 5. Provide Clear Feedback
- If invalid music genre → ask user to clarify (don't map silently)
- If missing required fields → ask explicitly
- If schema validation fails → show user what's needed

## Further Reading

- [OpenAI Structured Outputs](https://openai.com/index/introducing-structured-outputs-in-the-api/) - 100% schema adherence
- [When to use function calling vs JSON mode](https://www.vellum.ai/blog/when-should-i-use-function-calling-structured-outputs-or-json-mode) - Decision guide
- [Guide to structured outputs](https://agenta.ai/blog/the-guide-to-structured-outputs-and-function-calling-with-llms) - Comprehensive overview
- [Multi-turn conversation patterns](https://pmc.ncbi.nlm.nih.gov/articles/PMC7266438/) - State machine approaches
- [OpenAI Function Calling docs](https://platform.openai.com/docs/guides/function-calling) - Official guide
- [Anthropic Tool Use](https://docs.anthropic.com/en/docs/build-with-claude/tool-use) - Claude-specific implementation

## Examples in VAT

- **Breed Advisor** (current): JSON every turn (to be refactored)
- **Two-Phase Example** (coming): Conversational → structured
- **Tool Calling Example** (coming): Mixed text + actions
- **JSON Mode Example** (coming): One-shot extraction
