---
name: vibe-agent-toolkit
description: User adoption guide for building portable AI agents with VAT - agent creation, CLI workflows, and best practices
---

# Vibe Agent Toolkit Skill

Comprehensive guide for creating portable AI agents using the Vibe Agent Toolkit (VAT). This skill covers agent creation, CLI workflows, and practical usage patterns.

## Purpose: For Users, Not Contributors

**Key distinction:**
- **This skill** = How to USE VAT to build agents
- **Root CLAUDE.md** = How to DEVELOP VAT itself

This skill focuses on agent authoring, not VAT codebase development.

## What is VAT?

**Vibe Agent Toolkit (VAT)** is a modular toolkit for building portable AI agents that work across multiple LLM frameworks and deployment targets.

### What VAT IS

- **Agent authoring framework** - Define agents once, run anywhere
- **Multi-runtime support** - Vercel AI SDK, LangChain, OpenAI, Claude Agent SDK
- **Standardized patterns** - Consistent result envelopes, error handling, orchestration
- **Type-safe** - Full TypeScript support with Zod schemas
- **Framework agnostic** - Agents are plain functions, no vendor lock-in

### What VAT IS NOT

- **NOT a chat UI** - VAT provides the agent logic, not the interface
- **NOT an LLM provider** - Bring your own API keys (OpenAI, Anthropic, etc.)
- **NOT a deployment platform** - Deploy agents where you want (cloud, edge, local)
- **NOT opinionated about domains** - Use for any domain (code analysis, data processing, customer service, etc.)

### Core Value Proposition

**Write Once, Run Anywhere**

```typescript
// 1. Define agent once (plain TypeScript)
export async function analyzeSentiment(text: string) {
  // Your logic here
  return { sentiment: 'positive', confidence: 0.9 };
}

// 2. Adapt to ANY runtime
// Vercel AI SDK
const vercelTool = createVercelAISDKAdapter(analyzeSentiment);

// LangChain
const langchainTool = createLangChainAdapter(analyzeSentiment);

// OpenAI
const openaiTool = createOpenAIAdapter(analyzeSentiment);

// Claude Agent SDK
const claudeTool = createClaudeAgentSDKAdapter(analyzeSentiment);
```

No framework-specific code in your agent. Runtime adapters handle the translation.

## When to Use VAT

### VAT is Great For

**✅ Multi-framework projects**
- Team uses different LLM frameworks
- Want flexibility to switch frameworks later
- Building a platform that supports multiple frameworks

**✅ Reusable agent libraries**
- Creating internal agent packages
- Open-source agent collections
- Marketplace/plugin systems

**✅ Testing and experimentation**
- Compare LLM performance across providers
- A/B test different frameworks
- Validate agent logic without framework lock-in

**✅ Complex orchestration**
- Multi-agent workflows
- Validation loops (generate → validate → retry)
- Human-in-the-loop approval gates
- Conversational multi-turn agents

### VAT May NOT Be Needed For

**❌ Simple one-off scripts**
- Single-use agent, not reused
- Framework is already decided
- No portability required

**❌ Framework-specific features**
- Need deep integration with one framework
- Using advanced framework-specific capabilities
- Framework provides everything you need

**❌ No TypeScript/JavaScript projects**
- VAT is TypeScript-first
- Other languages not currently supported

## Creating Agents with agent-generator

The **agent-generator** is a meta-agent that helps you design high-quality agents through guided conversation.

### What agent-generator Does

Agent-generator guides you through a **4-phase workflow**:

1. **GATHER** - Understand your intent and goals
2. **ANALYZE** - Identify agent pattern and requirements
3. **DESIGN** - Make architecture decisions (LLM, tools, prompts)
4. **GENERATE** - Create validated agent package

### How to Use agent-generator

**Step 1: Provide Requirements**

Minimum viable input:
```json
{
  "agentPurpose": "Review PRs for security issues",
  "successCriteria": "Catches 100% of critical vulnerabilities"
}
```

Optional context (improves recommendations):
```json
{
  "agentPurpose": "Review PRs for security issues",
  "successCriteria": "Catches 100% of critical vulnerabilities",
  "typicalInputs": "GitHub PR diff",
  "expectedOutputs": "List of security issues with severity",
  "performanceRequirements": {
    "latency": "Under 30 seconds per PR",
    "accuracy": "Zero false negatives on critical issues",
    "cost": "Under $0.10 per PR"
  }
}
```

**Step 2: Conversational Refinement**

Agent-generator asks follow-up questions:
- What tools does the agent need? (file readers, APIs, etc.)
- What domain knowledge is required?
- What are edge cases to handle?
- What's the input/output format?

**Step 3: Architecture Recommendations**

Agent-generator makes informed decisions:
- **LLM selection** - Based on accuracy/speed/cost requirements
- **Tool selection** - Minimizes count, justifies each
- **Prompt strategy** - Context-efficient, high-signal
- **Resource planning** - References, examples, schemas

**Step 4: Generated Agent Package**

Output includes:
- `agent.yaml` - Validated agent manifest
- `prompts/system.md` - System prompt
- `prompts/user.md` - User prompt template
- `schemas/input.schema.json` - Input validation
- `schemas/output.schema.json` - Output validation
- `README.md` - Usage documentation

**Step 5: Customize and Deploy**

- Review generated prompts, adjust as needed
- Test agent with sample inputs
- Deploy using runtime adapters

### agent-generator Best Practices

**Be specific about success criteria:**
```
❌ "Make it work well"
✅ "Catches 100% of SQL injection vulnerabilities"
```

**Provide performance requirements:**
```
❌ "Fast enough"
✅ "Under 5 seconds per request, under $0.01 per call"
```

**Describe domain context:**
```
❌ "Security stuff"
✅ "OWASP Top 10, CWE database, company coding standards"
```

**Identify tools early:**
```
❌ "Whatever it needs"
✅ "File reader, GitHub API, static analysis tool"
```

### agent-generator Resources

The generator incorporates best practices from:
- [Building Effective Agents - Anthropic](https://www.anthropic.com/research/building-effective-agents)
- [Effective Context Engineering - Anthropic](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [Agent System Design Patterns - Databricks](https://docs.databricks.com/aws/en/generative-ai/guide/agent-system-design-patterns)
- [AI Agent Orchestration - Microsoft Azure](https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/ai-agent-design-patterns)

**Documentation:**
- [agent-generator README](../../agents/agent-generator/README.md) - Full documentation
- [agent-authoring.md](../../../../docs/agent-authoring.md) - Agent patterns and examples
- [orchestration.md](../../../../docs/orchestration.md) - Multi-agent workflows

## Understanding Agent Patterns

VAT supports multiple agent patterns (archetypes) for different use cases.

### Pattern 1: Pure Function Tool

**When to use:** Stateless validation, transformation, computation

**Characteristics:**
- No LLM calls
- Deterministic output
- Fast execution
- Easy to test

**Example use cases:**
- Input validation
- Data transformation
- Format conversion
- Rules-based logic

**Code pattern:**
```typescript
export async function validateInput(input: MyInput): Promise<ValidationResult> {
  if (input.text.length < 5) {
    return { status: 'error', error: 'too-short' };
  }
  return { status: 'success', data: { valid: true } };
}
```

### Pattern 2: One-Shot LLM Analyzer

**When to use:** Single LLM call for analysis, classification, generation

**Characteristics:**
- One LLM call per execution
- Stateless
- Handles LLM errors
- Parses and validates output

**Example use cases:**
- Sentiment analysis
- Text classification
- Entity extraction
- Creative generation

**Code pattern:**
```typescript
export async function analyzeSentiment(text: string, context: AgentContext) {
  const response = await context.callLLM([
    { role: 'user', content: `Analyze sentiment: "${text}"` }
  ]);

  const parsed = JSON.parse(response);
  return { status: 'success', data: parsed };
}
```

### Pattern 3: Conversational Assistant

**When to use:** Multi-turn dialogue, progressive data collection

**Characteristics:**
- Multiple LLM calls across turns
- Maintains session state
- Phases (gathering → ready → complete)
- Natural language replies + machine-readable results

**Example use cases:**
- Customer support chatbots
- Product advisors
- Interview/survey agents
- Multi-step form filling

**Code pattern:**
```typescript
export async function conversationalAgent(
  message: string,
  sessionState: SessionState
) {
  if (sessionState.phase === 'gathering') {
    // Collect more info
    return {
      reply: "Can you tell me more about X?",
      sessionState: { ...sessionState },
      result: { status: 'in-progress' }
    };
  }

  // Ready to complete
  return {
    reply: "Here's your result!",
    sessionState: { ...sessionState, phase: 'complete' },
    result: { status: 'success', data: finalResult }
  };
}
```

### Pattern 4: External Event Integrator

**When to use:** Waiting for external events (approvals, webhooks)

**Characteristics:**
- Emits event, blocks waiting for response
- Timeout handling
- External system unavailability
- Can be mocked for testing

**Example use cases:**
- Human-in-the-loop approval
- Webhook integrations
- External API polling
- Third-party service calls

**Code pattern:**
```typescript
export async function humanApproval(
  request: ApprovalRequest,
  options = { mockable: true, timeout: 30000 }
) {
  if (options.mockable) {
    // Mock mode for testing
    return { status: 'success', data: { approved: true } };
  }

  // Real mode - emit event and wait
  const response = await emitEvent(request, options.timeout);
  return { status: 'success', data: response };
}
```

**See also:**
- [agent-authoring.md](../../../../docs/agent-authoring.md) - Complete patterns guide
- [orchestration.md](../../../../docs/orchestration.md) - Chaining and workflows

## VAT CLI Workflows

The VAT CLI (`vat`) provides commands for working with agents, skills, and resources.

### Installation

```bash
# Global installation (recommended)
npm install -g vibe-agent-toolkit

# Or install just the CLI
npm install -g @vibe-agent-toolkit/cli

# Verify installation
vat --version
```

### Skills Commands

**List available skills:**
```bash
# Scan for SKILL.md files in current directory
vat skills list

# Show user-installed skills (~/.claude/plugins)
vat skills list --user
```

**Install skills:**
```bash
# From npm package
vat skills install npm:@vibe-agent-toolkit/vat-cat-agents

# From local directory
vat skills install ./my-skills

# From zip file
vat skills install ./skills.zip
```

**Validate skill quality:**
```bash
# Validate all skills declared in package.json vat.skills
vat skills validate

# Validate a specific skill by name
vat skills validate --skill my-skill

# Show verbose output (excluded reference details)
vat skills validate --verbose
```

**Build skills for distribution:**
```bash
# Build all skills in package
vat skills build

# Build specific skill
vat skills build --skill my-skill

# Dry-run (preview)
vat skills build --dry-run
```

### Packaging Options

Configure `packagingOptions` in your skill's `vat.skills[]` entry in package.json:

```json
{
  "vat": {
    "skills": [{
      "name": "my-skill",
      "source": "./SKILL.md",
      "path": "./dist/skills/my-skill",
      "packagingOptions": {
        "linkFollowDepth": 1,
        "resourceNaming": "resource-id",
        "stripPrefix": "knowledge-base",
        "excludeReferencesFromBundle": {
          "rules": [
            { "patterns": ["**/concepts/**"], "template": "Use search to find: {{link.text}}" }
          ],
          "defaultTemplate": "{{link.text}} (search knowledge base)"
        }
      }
    }]
  }
}
```

**`linkFollowDepth`** — Controls how deep links are followed from SKILL.md:

| Value | Behavior |
|-------|----------|
| `0` | Skill file only (no links followed) |
| `1` | Direct links only |
| `2` | Direct + one transitive level **(default)** |
| `N` | N levels of transitive links |
| `"full"` | Complete transitive closure |

**`resourceNaming`** — How bundled files are named in output:

| Strategy | Example Output | Use When |
|----------|---------------|----------|
| `basename` | `overview.md` | Few files, unique names **(default)** |
| `resource-id` | `topics-quickstart-overview.md` | Many files, flat output needed |
| `preserve-path` | `topics/quickstart/overview.md` | Preserve original structure |

Use `stripPrefix` to remove a common directory prefix (e.g., `"knowledge-base"`).

**`excludeReferencesFromBundle`** — Rules for excluding files and rewriting their links:

- `rules[]` — Ordered glob patterns (first match wins), each with optional Handlebars template
- `defaultTemplate` — Applied to depth-exceeded links not matching any rule

**Template variables:**

| Variable | Description | Example |
|----------|-------------|---------|
| `{{link.text}}` | Link display text | `"Setup Guide"` |
| `{{link.uri}}` | Original href | `"./docs/setup.md"` |
| `{{link.fileName}}` | Target filename | `"setup.md"` |
| `{{link.filePath}}` | Path relative to skill root | `"docs/setup.md"` |
| `{{skill.name}}` | Skill name from frontmatter | `"my-skill"` |

**`ignoreValidationErrors`** — Override validation rules:

```json
"ignoreValidationErrors": {
  "SKILL_LENGTH_EXCEEDS_RECOMMENDED": "Large domain requires detailed examples",
  "NO_PROGRESSIVE_DISCLOSURE": {
    "reason": "Temporary — refactoring planned",
    "expires": "2026-06-30"
  }
}
```

### Agent Commands

**Import Claude Skills to VAT format:**
```bash
# Import skill to agent.yaml
vat agent import my-skill/SKILL.md

# Custom output path
vat agent import my-skill/SKILL.md --output my-agent/agent.yaml

# Force overwrite
vat agent import my-skill/SKILL.md --force
```

**Audit agent/skill quality:**
```bash
# Audit single file
vat agent audit my-agent/agent.yaml

# Audit directory recursively
vat agent audit agents/ --recursive

# Detailed validation errors
vat agent audit my-agent/agent.yaml --debug
```

The audit checks for:
- Required frontmatter fields
- Naming conventions
- Description length limits
- Link integrity
- Console tool availability

### Resources Commands

**Validate markdown resources:**
```bash
# Validate directory
vat resources validate docs/

# With frontmatter schema validation
vat resources validate docs/ --frontmatter-schema schema.json

# Strict mode (warnings become errors)
vat resources validate docs/ --strict
```

**Parse and extract resource metadata:**
```bash
# Parse directory and output JSON
vat resources parse docs/ --output resources.json

# Parse with link resolution
vat resources parse docs/ --resolve-links
```

### Common Workflows

**Workflow 1: Create New Agent**
```bash
# 1. Use agent-generator (interactive)
# Follow prompts to define your agent

# 2. Review generated files
cat my-agent/agent.yaml
cat my-agent/prompts/system.md

# 3. Test agent
cd my-agent
vat test

# 4. Package for distribution
vat package
```

**Workflow 2: Install and Use Skills**
```bash
# 1. Install skill from npm
vat skills install npm:@vibe-agent-toolkit/vat-cat-agents

# 2. List installed skills
vat skills list --user

# 3. Use in Claude Code
# Skills appear in ~/.claude/plugins/
# Claude Code auto-loads them
```

**Workflow 3: Validate and Audit**
```bash
# 1. Create/edit skill
vim my-skill/SKILL.md

# 2. Validate before import
vat skills validate my-skill/SKILL.md

# 3. Audit for quality issues
vat agent audit my-skill/SKILL.md

# 4. Import to VAT format
vat agent import my-skill/SKILL.md
```

**Workflow 4: Build and Distribute**
```bash
# 1. Add vat.skills to package.json
# (See distribution standard docs)

# 2. Build skills
bun run build  # Includes vat skills build

# 3. Test locally
vat skills install ./packages/my-skills

# 4. Publish to npm
npm publish

# 5. Install from npm
vat skills install npm:@my-org/my-skills
```

### CLI Tips

**Use --help for any command:**
```bash
vat --help
vat skills --help
vat skills install --help
```

**Use --dry-run for preview:**
```bash
vat skills build --dry-run
vat skills install my-skill --dry-run
```

**Use --debug for troubleshooting:**
```bash
vat skills validate my-skill --debug
vat agent audit my-agent --debug
```

**Check skill installation location:**
```bash
# User skills
ls ~/.claude/plugins/

# Project skills
ls .claude/skills/
```

## Result Envelopes and Error Handling

VAT uses standardized result envelopes for type-safe composition and error handling.

### Core Result Types

**AgentResult<TData, TError>** - For single-execution agents:
```typescript
type AgentResult<TData, TError> =
  | { status: 'success'; data: TData }
  | { status: 'error'; error: TError };
```

**StatefulAgentResult<TData, TError, TMetadata>** - For conversational agents:
```typescript
type StatefulAgentResult<TData, TError, TMetadata> =
  | { status: 'in-progress'; metadata?: TMetadata }
  | { status: 'success'; data: TData }
  | { status: 'error'; error: TError };
```

### Standard Error Types

**LLM errors:**
```typescript
type LLMError =
  | 'llm-refusal'          // LLM refused to generate
  | 'llm-invalid-output'   // Output format incorrect
  | 'llm-timeout'          // Request timed out
  | 'llm-rate-limit'       // Hit rate limit
  | 'llm-token-limit'      // Exceeded token limit
  | 'llm-unavailable';     // Service unavailable
```

**Event integration errors:**
```typescript
type ExternalEventError =
  | 'event-timeout'           // External event timed out
  | 'event-unavailable'       // System unavailable
  | 'event-rejected'          // Request rejected
  | 'event-invalid-response'; // Invalid response
```

### Error Handling Pattern

Always check status before accessing data:

```typescript
const output = await myAgent.execute(input);

if (output.result.status === 'success') {
  // Type-safe access to data
  console.log(output.result.data);
} else if (output.result.status === 'error') {
  // Type-safe access to error
  console.error('Failed:', output.result.error);
} else {
  // In-progress (conversational agents)
  console.log('Still working:', output.result.metadata);
}
```

### Result Helpers

VAT provides helpers for working with results:

**mapResult()** - Transform success data:
```typescript
import { mapResult } from '@vibe-agent-toolkit/agent-runtime';

const result = { status: 'success', data: 10 };
const doubled = mapResult(result, (n) => n * 2);
// doubled = { status: 'success', data: 20 }
```

**andThen()** - Chain operations:
```typescript
import { andThen } from '@vibe-agent-toolkit/agent-runtime';

const output1 = await agent1.execute(input);
const output2 = await andThen(output1.result, async (data) => {
  const out = await agent2.execute(data);
  return out.result;
});
```

**match()** - Pattern match on status:
```typescript
import { match } from '@vibe-agent-toolkit/agent-runtime';

const message = match(result, {
  success: (data) => `Success: ${data}`,
  error: (err) => `Error: ${err}`,
  inProgress: (meta) => `Working: ${meta.step}`,
});
```

**See also:** [orchestration.md](../../../../docs/orchestration.md) for composition patterns

## Orchestration Patterns

Combine agents into workflows using standardized result envelopes.

### Sequential Pipeline

Execute agents in order, passing results forward:

```typescript
// Step 1: Analyze
const analysisOutput = await analyzer.execute(input);

// Step 2: Process (only if step 1 succeeded)
const processedOutput = await andThen(
  analysisOutput.result,
  async (data) => {
    const out = await processor.execute(data);
    return out.result;
  }
);

// Step 3: Validate (only if step 2 succeeded)
const finalOutput = await andThen(
  processedOutput,
  async (data) => {
    const out = await validator.execute(data);
    return out.result;
  }
);
```

### Parallel Execution

Run multiple agents concurrently:

```typescript
// Execute in parallel
const [output1, output2, output3] = await Promise.all([
  agent1.execute(input),
  agent2.execute(input),
  agent3.execute(input),
]);

// Combine results
if (output1.result.status === 'success' &&
    output2.result.status === 'success' &&
    output3.result.status === 'success') {
  // All succeeded
  const combined = combineResults(
    output1.result.data,
    output2.result.data,
    output3.result.data
  );
}
```

### Validation Loop

Generator + Validator with retry:

```typescript
async function generateValidOutput(
  input: MyInput,
  maxAttempts: number = 5
) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Generate
    const generatorOutput = await generator.execute(input);
    if (generatorOutput.result.status === 'error') continue;

    // Validate
    const validatorOutput = await validator.execute(
      generatorOutput.result.data
    );

    if (validatorOutput.result.status === 'success' &&
        validatorOutput.result.data.valid) {
      // Found valid output!
      return generatorOutput.result.data;
    }

    // Invalid, retry with feedback
    console.log('Attempt', attempt + 1, 'invalid:',
      validatorOutput.result.data.reason);
  }

  throw new Error('Max attempts exceeded');
}
```

### Human-in-the-Loop

Integrate human approval:

```typescript
// Generate content
const generatorOutput = await generator.execute(input);

if (generatorOutput.result.status === 'success') {
  // Request approval
  const approvalOutput = await humanApproval.execute({
    content: generatorOutput.result.data,
    context: input,
  });

  if (approvalOutput.result.status === 'success' &&
      approvalOutput.result.data.approved) {
    // Approved - continue
    return generatorOutput.result.data;
  } else {
    // Rejected - handle feedback
    console.log('Rejected:', approvalOutput.result.data.feedback);
  }
}
```

### Conversational Multi-Turn

Handle stateful conversations:

```typescript
let session = {
  state: { phase: 'gathering' },
  history: [],
};

while (true) {
  const userMessage = await getUserInput();

  const output = await conversationalAgent.execute({
    message: userMessage,
    sessionState: session.state,
  });

  console.log('Agent:', output.reply);

  // Update session
  session = {
    state: output.sessionState,
    history: [
      ...session.history,
      { role: 'user', content: userMessage },
      { role: 'assistant', content: output.reply },
    ],
  };

  // Check completion
  if (output.result.status === 'success') {
    console.log('Final result:', output.result.data);
    break;
  } else if (output.result.status === 'error') {
    console.error('Failed:', output.result.error);
    break;
  }
  // Otherwise status === 'in-progress', continue
}
```

**See also:** [orchestration.md](../../../../docs/orchestration.md) for complete guide

## Testing Agents

VAT provides test helpers and patterns for agent testing.

### Unit Testing Pure Functions

```typescript
import { describe, expect, it } from 'vitest';
import { resultMatchers } from '@vibe-agent-toolkit/agent-runtime';

describe('myValidator', () => {
  it('should validate correct input', async () => {
    const output = await myValidator.execute({ text: 'valid' });

    resultMatchers.expectSuccess(output.result);
    expect(output.result.data.valid).toBe(true);
  });

  it('should reject invalid input', async () => {
    const output = await myValidator.execute({ text: 'x' });

    resultMatchers.expectError(output.result);
    expect(output.result.error).toBe('too-short');
  });
});
```

### Integration Testing with Mock LLM

```typescript
import { createMockContext } from '@vibe-agent-toolkit/agent-runtime';

describe('myAnalyzer with mock LLM', () => {
  it('should parse LLM response', async () => {
    const mockContext = createMockContext(
      JSON.stringify({ sentiment: 'positive', confidence: 0.9 })
    );

    const output = await myAnalyzer.execute(
      { text: 'Great!' },
      mockContext
    );

    resultMatchers.expectSuccess(output.result);
    expect(output.result.data.sentiment).toBe('positive');
  });
});
```

### Testing Conversational Flows

```typescript
describe('conversational agent flow', () => {
  it('should gather info progressively', async () => {
    // Turn 1
    const output1 = await agent.execute({
      message: 'Hello',
    });
    expect(output1.reply).toContain('name?');
    resultMatchers.expectInProgress(output1.result);

    // Turn 2
    const output2 = await agent.execute({
      message: 'My name is Alice',
      sessionState: output1.sessionState,
    });
    expect(output2.reply).toContain('age?');
    resultMatchers.expectInProgress(output2.result);

    // Turn 3 (complete)
    const output3 = await agent.execute({
      message: 'I am 30',
      sessionState: output2.sessionState,
    });
    resultMatchers.expectSuccess(output3.result);
    expect(output3.result.data).toBeDefined();
  });
});
```

## Best Practices

### 1. Use Result Envelopes Consistently

Always return result envelopes, never throw exceptions for expected errors:

```typescript
// ✅ GOOD
return { result: { status: 'error', error: 'invalid-input' } };

// ❌ BAD
throw new Error('Invalid input');
```

### 2. Define Clear Error Types

Use enums or literal unions:

```typescript
// ✅ GOOD
type MyError = 'invalid-format' | 'processing-failed' | 'timeout';

// ❌ BAD
type MyError = string;
```

### 3. Validate Input and Output

Use Zod schemas for type safety:

```typescript
import { z } from 'zod';

const InputSchema = z.object({
  text: z.string().min(1).max(1000),
});

const OutputSchema = z.object({
  result: z.boolean(),
  reason: z.string().optional(),
});

// Validate at runtime
const input = InputSchema.parse(userInput);
const output = OutputSchema.parse(agentOutput);
```

### 4. Test All Paths

Cover success, errors, and edge cases:

```typescript
describe('myAgent', () => {
  it('should handle success case');
  it('should handle validation error');
  it('should handle LLM timeout');
  it('should handle malformed input');
});
```

### 5. Use Mock Mode for External Dependencies

Enable testing without API calls:

```typescript
async execute(input, options = { mockable: true }) {
  if (options.mockable) {
    // Fast, deterministic mock
    return getMockResponse(input);
  }
  // Real API call
  return await callExternalAPI(input);
}
```

### 6. Document Agent Behavior

Clear documentation helps users:

```typescript
/**
 * Analyzes sentiment of text input.
 *
 * @param text - Text to analyze (max 1000 chars)
 * @returns Sentiment (positive/negative/neutral) with confidence score
 *
 * @example
 * const result = await analyzeSentiment("Great product!");
 * // { sentiment: 'positive', confidence: 0.9 }
 *
 * @throws Never throws - returns error result envelope on failure
 */
export async function analyzeSentiment(text: string) {
  // ...
}
```

## Next Steps

Now that you understand VAT basics:

1. **Create your first agent** using agent-generator
2. **Review examples** in `@vibe-agent-toolkit/vat-example-cat-agents`
3. **Read detailed docs**:
   - [agent-authoring.md](../../../../docs/agent-authoring.md)
   - [orchestration.md](../../../../docs/orchestration.md)
   - [getting-started.md](../../../../docs/getting-started.md)
4. **Explore runtime adapters** for your preferred framework
5. **Join the community** and share your agents

## Documentation Index

**Getting Started:**
- [Getting Started Guide](../../../../docs/getting-started.md) - Setup and first steps
- [Main README](../../../../README.md) - Project overview

**Agent Development:**
- [agent-generator README](../../agents/agent-generator/README.md) - Meta-agent for creating agents
- [Agent Authoring Guide](../../../../docs/agent-authoring.md) - Patterns and code examples
- [Orchestration Guide](../../../../docs/orchestration.md) - Multi-agent workflows

**Architecture:**
- [Architecture Overview](../../../../docs/architecture/README.md) - Package structure
- [Runtime Adapters](../../../../docs/adding-runtime-adapters.md) - Multi-framework support

**Examples:**
- `@vibe-agent-toolkit/vat-example-cat-agents` - Reference implementations
- Run demos: `bun run demo:photos`, `bun run demo:conversation`

## Success Criteria

You've successfully adopted VAT when:

**For Single Agents:**
- Agent has clear input/output schemas
- Errors are handled as data (result envelopes)
- Tests cover success and error paths
- Agent works across multiple runtimes

**For Workflows:**
- Multi-agent pipelines compose cleanly
- Retry logic handles transient failures
- State management is explicit
- Observability shows performance/cost

**For Teams:**
- Agents are reusable across projects
- Framework choice is flexible
- Testing doesn't require real APIs
- Documentation enables self-service

## Getting Help

- **Documentation:** [docs/README.md](../../../../docs/README.md)
- **Examples:** `packages/vat-example-cat-agents/`
- **GitHub Issues:** Report bugs or ask questions
- **CLI Help:** `vat --help`, `vat skills --help`, etc.

Happy agent building!
