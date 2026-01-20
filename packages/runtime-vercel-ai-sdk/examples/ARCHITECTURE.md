# Vercel AI SDK Runtime Adapter Architecture

## Two Types of VAT Agents

### 1. Pure Function Agents → Vercel AI SDK Tools

**What they are:**
- Deterministic, synchronous functions
- No LLM calls needed
- Examples: validators, parsers, formatters

**How they're used with Vercel AI SDK:**
```typescript
// Convert agent to tool
const haikuTool = convertPureFunctionToTool(
  haikuValidatorAgent,
  HaikuSchema,
  HaikuValidationResultSchema
);

// Use with generateText() for LLM tool calling
const result = await generateText({
  model: openai('gpt-4'),
  tools: {
    validateHaiku: haikuTool.tool
  },
  prompt: 'Generate a haiku and validate it'
});
```

**Flow:**
```
User Prompt
  ↓
LLM (GPT-4)
  ↓ decides to call tool
Haiku Validator Agent (pure function)
  ↓ validates syllables
Structured Result
  ↓
LLM incorporates result into response
  ↓
User gets final answer
```

**Key Point:** The LLM *calls* the pure function agent as a tool during generation.

---

### 2. LLM Analyzer Agents → Vercel AI SDK Functions

**What they are:**
- Agents that internally call an LLM
- Single-shot analysis with structured output
- Examples: name generator, sentiment analyzer, content classifier

**How they're used with Vercel AI SDK:**
```typescript
// Convert agent to function
const generateName = convertLLMAnalyzerToFunction(
  nameGeneratorAgent,
  NameGeneratorInputSchema,
  NameSuggestionSchema,
  {
    model: openai('gpt-4o-mini'),
    temperature: 0.9
  }
);

// Use directly - makes real LLM call
const result = await generateName({
  characteristics: { /* cat details */ }
});
```

**Flow:**
```
User Input
  ↓
Name Generator Agent
  ↓ builds prompt
Vercel AI SDK generateText()
  ↓ makes API call
LLM (GPT-4o-mini)
  ↓ generates response
Agent parses response
  ↓ validates with Zod
Structured Output
  ↓
User gets result
```

**Key Point:** The agent itself *makes* the LLM call internally and returns structured output.

---

## Comparison Table

| Aspect | Pure Function Agent | LLM Analyzer Agent |
|--------|---------------------|-------------------|
| **Makes LLM calls?** | No | Yes |
| **Adapter converts to** | Vercel AI SDK `tool()` | Async function with `generateText()` |
| **Used by** | LLM during generation | Direct invocation |
| **Execution** | Synchronous | Asynchronous |
| **Cost** | Free (just computation) | API call costs |
| **Use case** | Validation, parsing, transformation | Generation, analysis, classification |
| **Example** | Haiku validator | Name generator |

---

## The Runtime Adapter's Job

The runtime adapter's role is different for each type:

### For Pure Function Agents:
```typescript
// Agent defines logic
const agent = {
  execute: (input) => {
    // Pure computation
    return validateHaiku(input);
  }
};

// Adapter wraps it as a Vercel AI SDK tool
const tool = tool({
  description: agent.manifest.description,
  parameters: inputSchema,
  execute: async (input) => agent.execute(input)
});
```

### For LLM Analyzer Agents:
```typescript
// Agent defines prompt logic
const agent = {
  execute: async (input, context) => {
    const prompt = buildPrompt(input);
    const response = await context.callLLM(prompt);
    return parseResponse(response);
  }
};

// Adapter provides context.callLLM()
const func = async (input) => {
  const context = {
    callLLM: async (prompt) => {
      const result = await generateText({
        model: openai('gpt-4o-mini'),
        prompt
      });
      return result.text;
    }
  };
  return agent.execute(input, context);
};
```

---

## When to Use Which

**Use Pure Function Agents when:**
- Logic is deterministic
- No creativity/generation needed
- Want LLM to call your function
- Examples: validation, parsing, data transformation

**Use LLM Analyzer Agents when:**
- Need LLM capabilities (generation, analysis, reasoning)
- Want structured output from LLM
- Single-shot analysis (not multi-turn conversation)
- Examples: content generation, classification, sentiment analysis

---

## Provider Portability

Both types work with any Vercel AI SDK provider:

```typescript
// OpenAI
const config = { model: openai('gpt-4o-mini') };

// Anthropic
const config = { model: anthropic('claude-3-5-sonnet-20241022') };

// Google
const config = { model: google('gemini-2.0-flash-001') };

// Same agent, same adapter code, different provider!
const generateName = convertLLMAnalyzerToFunction(
  nameGeneratorAgent,
  inputSchema,
  outputSchema,
  config
);
```

---

## Demo Scripts

Run these to see each type in action:

```bash
# Pure function agents as tools
source ~/.secrets.env && bun run demo

# LLM analyzer agents as functions (focused demo)
source ~/.secrets.env && bun run llm-demo
```
