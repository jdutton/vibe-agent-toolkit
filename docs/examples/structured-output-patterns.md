# Structured Output Patterns - Side-by-Side Comparison

Three implementations of the same use case: **Cat Adoption Profile Assistant**

## Use Case

Help user create a cat adoption profile by gathering:
- Name preference (string)
- Age preference (kitten, adult, senior)
- Activity level (low, medium, high)

**Goal**: Show three different patterns for structured extraction.

---

## Pattern 1: Two-Phase Conversational

**Best for**: Chatbots, natural conversations, gathering info over multiple turns

### Implementation

```typescript
import { z } from 'zod';

// Schemas
const AdoptionProfileSchema = z.object({
  namePreference: z.string().optional(),
  agePreference: z.enum(['kitten', 'adult', 'senior']).optional(),
  activityLevel: z.enum(['low', 'medium', 'high']).optional(),
});

type AdoptionProfile = z.infer<typeof AdoptionProfileSchema>;

// Phase 1: Conversational gathering (returns text)
async function gatheringPhase(
  userMessage: string,
  currentProfile: AdoptionProfile,
  history: Message[]
): Promise<{ reply: string; updatedProfile: AdoptionProfile; isReady: boolean }> {

  // Build conversational prompt (NO JSON schema)
  const prompt = `You are a friendly cat adoption assistant. Have a natural conversation to gather:
- Name preference
- Age preference (kitten, adult, or senior)
- Activity level (low, medium, or high)

Current profile: ${JSON.stringify(currentProfile)}

Respond naturally. When you have all 3 pieces of info, say "I have everything I need!"

User: ${userMessage}
Assistant:`;

  const response = await llm.generate({
    messages: [...history, { role: 'user', content: prompt }],
    // NO response_format - pure conversational text
  });

  // Informally extract any mentioned factors (forgiving)
  const updatedProfile = extractFactorsFromText(response, currentProfile);

  // Check if ready
  const isReady =
    updatedProfile.namePreference !== undefined &&
    updatedProfile.agePreference !== undefined &&
    updatedProfile.activityLevel !== undefined;

  return {
    reply: response,
    updatedProfile,
    isReady
  };
}

// Phase 2: Structured extraction (returns validated data)
async function extractionPhase(
  profile: AdoptionProfile
): Promise<{ profile: AdoptionProfile; recommendations: string[] }> {

  const response = await llm.generate({
    messages: [{
      role: 'system',
      content: 'Extract the adoption profile into structured format'
    }, {
      role: 'user',
      content: JSON.stringify(profile)
    }],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "adoption_profile",
        schema: zodToJsonSchema(AdoptionProfileSchema)
      }
    }
  });

  const validated = AdoptionProfileSchema.parse(JSON.parse(response));
  const recommendations = generateRecommendations(validated);

  return { profile: validated, recommendations };
}

// Main conversation loop
async function runConversation() {
  let profile: AdoptionProfile = {};
  const history: Message[] = [];

  while (true) {
    const userInput = await getUserInput();

    // Phase 1: Gather
    const gathering = await gatheringPhase(userInput, profile, history);
    console.log('Agent:', gathering.reply);

    profile = gathering.updatedProfile;
    history.push(
      { role: 'user', content: userInput },
      { role: 'assistant', content: gathering.reply }
    );

    // Transition to Phase 2 when ready
    if (gathering.isReady) {
      const userConfirms = await getUserInput('Ready to see matches? (yes/no)');

      if (userConfirms.toLowerCase() === 'yes') {
        // Phase 2: Extract
        const result = await extractionPhase(profile);
        console.log('Final Profile:', result.profile);
        console.log('Recommendations:', result.recommendations);
        break;
      }
    }
  }
}
```

### Example Conversation

```
User: I want to adopt a cat
Agent: Wonderful! What kind of name are you thinking? Something playful,
       regal, or do you prefer a specific style?

User: Something playful
Agent: Great! How about the cat's age - are you looking for a kitten,
       adult, or senior cat?

User: Adult
Agent: Perfect! And energy-wise, are you hoping for low energy (calm),
       medium (playful), or high energy (very active)?

User: Medium energy
Agent: I have everything I need!

Ready to see matches? yes

Final Profile: {
  namePreference: "playful",
  agePreference: "adult",
  activityLevel: "medium"
}
Recommendations: ["Tabby Mix", "Domestic Shorthair", ...]
```

### Pros/Cons

✅ **Pros:**
- Natural conversation flow
- No JSON parsing errors during chat
- Forgiving factor extraction
- Works with any LLM

❌ **Cons:**
- Need phase management logic
- Informal extraction less precise
- Two different prompting strategies

---

## Pattern 2: JSON Mode (Every Turn)

**Best for**: Form-filling, structured data on every response, OpenAI gpt-4o

### Implementation

```typescript
import { generateObject } from 'ai';
import { openai } from '@ai-sdk/openai';

// Schema (same as Pattern 1)
const AdoptionProfileSchema = z.object({
  namePreference: z.string().optional(),
  agePreference: z.enum(['kitten', 'adult', 'senior']).optional(),
  activityLevel: z.enum(['low', 'medium', 'high']).optional(),
});

// Response includes both conversational reply AND structured data
const ResponseSchema = z.object({
  reply: z.string().describe('Conversational response to user'),
  updatedProfile: AdoptionProfileSchema.describe('Updated adoption profile'),
  isComplete: z.boolean().describe('True if all fields are filled'),
});

async function conversationalTurn(
  userMessage: string,
  currentProfile: z.infer<typeof AdoptionProfileSchema>,
  history: Message[]
): Promise<z.infer<typeof ResponseSchema>> {

  const { object } = await generateObject({
    model: openai('gpt-4o-2024-08-06'),  // Required for Structured Outputs
    schema: ResponseSchema,
    messages: [
      {
        role: 'system',
        content: `You are a cat adoption assistant. Gather name preference,
age preference (kitten/adult/senior), and activity level (low/medium/high).

Current profile: ${JSON.stringify(currentProfile)}

Return JSON with:
- reply: Your conversational response
- updatedProfile: Updated profile with any new info from user
- isComplete: true if all 3 fields are filled`
      },
      ...history,
      { role: 'user', content: userMessage }
    ]
  });

  // object is fully typed and guaranteed to match schema!
  return object;
}

// Main conversation loop
async function runConversation() {
  let profile: z.infer<typeof AdoptionProfileSchema> = {};
  const history: Message[] = [];

  while (true) {
    const userInput = await getUserInput();

    const response = await conversationalTurn(userInput, profile, history);

    console.log('Agent:', response.reply);
    profile = response.updatedProfile;

    history.push(
      { role: 'user', content: userInput },
      { role: 'assistant', content: response.reply }
    );

    if (response.isComplete) {
      console.log('Final Profile:', profile);
      break;
    }
  }
}
```

### Example Conversation

```
User: I want to adopt a cat
Response: {
  reply: "Wonderful! Let's find you the perfect match. What kind of name
          style do you prefer - playful, regal, or something specific?",
  updatedProfile: {},
  isComplete: false
}

User: Playful names
Response: {
  reply: "Great! How about age - kitten, adult, or senior?",
  updatedProfile: { namePreference: "playful" },
  isComplete: false
}

User: Adult
Response: {
  reply: "Perfect! Last question - low, medium, or high energy?",
  updatedProfile: { namePreference: "playful", agePreference: "adult" },
  isComplete: false
}

User: Medium
Response: {
  reply: "I have everything I need! Here are your matches...",
  updatedProfile: {
    namePreference: "playful",
    agePreference: "adult",
    activityLevel: "medium"
  },
  isComplete: true
}
```

### Pros/Cons

✅ **Pros:**
- 100% schema adherence (gpt-4o-2024-08-06)
- No parsing errors
- Fully typed responses
- Structured data on every turn

❌ **Cons:**
- Requires OpenAI gpt-4o-2024-08-06+
- Not portable to other LLMs
- Reply must be in JSON structure
- Can feel less natural

---

## Pattern 3: Tool Calling

**Best for**: Mixed conversation + actions, agent decides when to extract

### Implementation

```typescript
import OpenAI from 'openai';
import { zodToJsonSchema } from 'zod-to-json-schema';

const openai = new OpenAI();

// Schemas (same)
const AdoptionProfileSchema = z.object({
  namePreference: z.string().optional(),
  agePreference: z.enum(['kitten', 'adult', 'senior']).optional(),
  activityLevel: z.enum(['low', 'medium', 'high']).optional(),
});

// Define tools the LLM can call
const tools: OpenAI.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'update_adoption_profile',
      description: 'Update the adoption profile with confirmed information from user',
      parameters: zodToJsonSchema(AdoptionProfileSchema)
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_cat_recommendations',
      description: 'Get cat recommendations when profile is complete',
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  }
];

async function conversationalTurn(
  userMessage: string,
  profile: z.infer<typeof AdoptionProfileSchema>,
  history: OpenAI.ChatCompletionMessageParam[]
): Promise<{
  reply?: string;
  toolCalls?: Array<{ name: string; args: any }>;
}> {

  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      {
        role: 'system',
        content: `You are a cat adoption assistant. Have a natural conversation.

When user provides information, call update_adoption_profile to record it.
When you have all 3 pieces of info (name, age, activity), call get_cat_recommendations.

Current profile: ${JSON.stringify(profile)}`
      },
      ...history,
      { role: 'user', content: userMessage }
    ],
    tools,
    tool_choice: 'auto'  // LLM decides when to call tools
  });

  const message = response.choices[0].message;

  return {
    reply: message.content ?? undefined,
    toolCalls: message.tool_calls?.map(tc => ({
      name: tc.function.name,
      args: JSON.parse(tc.function.arguments)
    }))
  };
}

// Main conversation loop
async function runConversation() {
  let profile: z.infer<typeof AdoptionProfileSchema> = {};
  const history: OpenAI.ChatCompletionMessageParam[] = [];

  while (true) {
    const userInput = await getUserInput();

    const response = await conversationalTurn(userInput, profile, history);

    // Handle text response
    if (response.reply) {
      console.log('Agent:', response.reply);
    }

    // Handle tool calls
    if (response.toolCalls) {
      for (const toolCall of response.toolCalls) {
        if (toolCall.name === 'update_adoption_profile') {
          profile = { ...profile, ...toolCall.args };
          console.log('Profile updated:', profile);
        } else if (toolCall.name === 'get_cat_recommendations') {
          const recommendations = generateRecommendations(profile);
          console.log('Recommendations:', recommendations);
          return;  // Done!
        }
      }
    }

    history.push(
      { role: 'user', content: userInput },
      { role: 'assistant', content: response.reply ?? '', tool_calls: response.toolCalls as any }
    );
  }
}
```

### Example Conversation

```
User: I want to adopt a cat
Agent: "Wonderful! What kind of name are you thinking?"
[No tool calls - just chatting]

User: Something playful
Agent: "Great choice!"
[Tool call: update_adoption_profile({ namePreference: "playful" })]
Agent: "How about age - kitten, adult, or senior?"

User: Adult, and I want medium energy
[Tool call: update_adoption_profile({ agePreference: "adult", activityLevel: "medium" })]
Agent: "Perfect! I have everything I need."
[Tool call: get_cat_recommendations()]
Recommendations: [...]
```

### Pros/Cons

✅ **Pros:**
- Natural conversation flow
- LLM decides when to extract (not forced every turn)
- Clear intent tracking (tool calls = structured actions)
- Can extract multiple fields at once
- Industry standard pattern

❌ **Cons:**
- More complex implementation
- Need to handle tool execution
- Conversation history includes tool results
- Requires function calling support

---

## When to Use Each Pattern

| Scenario | Recommended Pattern | Why |
|----------|-------------------|-----|
| Chatbot gathering info naturally | **Two-Phase** | Most natural, no JSON errors during chat |
| Form with known fields | **JSON Mode** | Guaranteed structure on every turn |
| Agent taking multiple actions | **Tool Calling** | Clear intent, mixed text + operations |
| Need cross-LLM portability | **Two-Phase** | Doesn't require specific API features |
| Using OpenAI gpt-4o | **JSON Mode** or **Tool Calling** | 100% reliable, built-in support |
| Complex multi-step workflow | **Tool Calling** | Agent orchestrates operations |

---

## Key Takeaways

1. **Don't fight the LLM**: Asking for JSON on every conversational turn is unnatural
2. **Separate concerns**: Conversation (text) vs extraction (structure)
3. **Use native features**: OpenAI Structured Outputs = 100% adherence
4. **Match pattern to use case**: Chatbot ≠ form ≠ agent
5. **Test failure modes**: What happens when LLM doesn't follow instructions?

## Further Reading

- [Full documentation](../structured-outputs.md)
- [OpenAI Structured Outputs](https://openai.com/index/introducing-structured-outputs-in-the-api/)
- [When to use function calling vs JSON mode](https://www.vellum.ai/blog/when-should-i-use-function-calling-structured-outputs-or-json-mode)
