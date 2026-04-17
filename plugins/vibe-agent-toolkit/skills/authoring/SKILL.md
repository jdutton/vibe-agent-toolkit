---
name: authoring
description: Use when authoring SKILL.md files, designing agent architectures, or configuring packaging options. Covers SKILL.md structure, agent archetypes, orchestration patterns, and validation override patterns.
---

# VAT Agent Authoring: SKILL.md, Archetypes & Patterns

## SKILL.md Structure

A SKILL.md file is the definition file for a VAT agent skill. It tells Claude what the skill
does and how to use it. All SKILL.md files must have YAML frontmatter:

```markdown
---
name: my-skill
description: One sentence: what this skill does and when to use it (max 200 chars)
---

# My Skill

Rest of the skill documentation...
```

Required frontmatter fields:
- `name` — unique identifier, kebab-case, matches the skill's directory name
- `description` — trigger description used for skill routing; be specific about activation conditions

Best practices for `description`:
- Start with "Use when..." to make activation conditions explicit
- Include the key commands or concepts the skill covers
- Keep under 200 characters

## Agent Archetypes

VAT supports four agent archetypes for different use cases.

### Archetype 1: Pure Function Tool

**When to use:** Stateless validation, transformation, computation — no LLM needed.

**Characteristics:** Deterministic output, fast execution, easy to test.

**Example use cases:** Input validation, data transformation, format conversion, rules-based logic.

```typescript
export async function validateInput(input: MyInput): Promise<ValidationResult> {
  if (input.text.length < 5) {
    return { status: 'error', error: 'too-short' };
  }
  return { status: 'success', data: { valid: true } };
}
```

### Archetype 2: One-Shot LLM Analyzer

**When to use:** Single LLM call for analysis, classification, or generation.

**Characteristics:** One LLM call per execution, stateless, handles LLM errors.

**Example use cases:** Sentiment analysis, text classification, entity extraction, creative generation.

```typescript
export async function analyzeSentiment(text: string, context: AgentContext) {
  const response = await context.callLLM([
    { role: 'user', content: `Analyze sentiment: "${text}"` }
  ]);

  const parsed = JSON.parse(response);
  return { status: 'success', data: parsed };
}
```

### Archetype 3: Conversational Assistant

**When to use:** Multi-turn dialogue, progressive data collection across sessions.

**Characteristics:** Multiple LLM calls, maintains session state, phases (gathering → ready → complete).

**Example use cases:** Customer support chatbots, product advisors, interview agents, multi-step forms.

```typescript
export async function conversationalAgent(
  message: string,
  sessionState: SessionState
) {
  if (sessionState.phase === 'gathering') {
    return {
      reply: "Can you tell me more about X?",
      sessionState: { ...sessionState },
      result: { status: 'in-progress' }
    };
  }

  return {
    reply: "Here's your result!",
    sessionState: { ...sessionState, phase: 'complete' },
    result: { status: 'success', data: finalResult }
  };
}
```

### Archetype 4: External Event Integrator

**When to use:** Waiting for external events (approvals, webhooks, third-party APIs).

**Characteristics:** Emits event, blocks waiting for response, timeout handling, mockable for testing.

**Example use cases:** Human-in-the-loop approval, webhook integrations, external API polling.

```typescript
export async function humanApproval(
  request: ApprovalRequest,
  options = { mockable: true, timeout: 30000 }
) {
  if (options.mockable) {
    return { status: 'success', data: { approved: true } };
  }

  const response = await emitEvent(request, options.timeout);
  return { status: 'success', data: response };
}
```

## Result Envelopes

Always return result envelopes — never throw exceptions for expected errors.

```typescript
// AgentResult<TData, TError> — for single-execution agents
type AgentResult<TData, TError> =
  | { status: 'success'; data: TData }
  | { status: 'error'; error: TError };

// StatefulAgentResult — for conversational agents
type StatefulAgentResult<TData, TError, TMetadata> =
  | { status: 'in-progress'; metadata?: TMetadata }
  | { status: 'success'; data: TData }
  | { status: 'error'; error: TError };
```

Standard LLM error literals: `'llm-refusal'`, `'llm-invalid-output'`, `'llm-timeout'`,
`'llm-rate-limit'`, `'llm-token-limit'`, `'llm-unavailable'`.

Always check status before accessing data:
```typescript
const output = await myAgent.execute(input);
if (output.result.status === 'success') {
  console.log(output.result.data);
} else if (output.result.status === 'error') {
  console.error('Failed:', output.result.error);
}
```

## Orchestration Patterns

### Sequential Pipeline

```typescript
const analysisOutput = await analyzer.execute(input);
const processedOutput = await andThen(
  analysisOutput.result,
  async (data) => {
    const out = await processor.execute(data);
    return out.result;
  }
);
```

### Parallel Execution

```typescript
const [output1, output2, output3] = await Promise.all([
  agent1.execute(input),
  agent2.execute(input),
  agent3.execute(input),
]);
```

### Validation Loop (Generate + Validate with Retry)

```typescript
async function generateValidOutput(input: MyInput, maxAttempts = 5) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const generatorOutput = await generator.execute(input);
    if (generatorOutput.result.status === 'error') continue;

    const validatorOutput = await validator.execute(generatorOutput.result.data);
    if (validatorOutput.result.status === 'success' &&
        validatorOutput.result.data.valid) {
      return generatorOutput.result.data;
    }
  }
  throw new Error('Max attempts exceeded');
}
```

### Human-in-the-Loop

```typescript
const generatorOutput = await generator.execute(input);
if (generatorOutput.result.status === 'success') {
  const approvalOutput = await humanApproval.execute({
    content: generatorOutput.result.data,
    context: input,
  });
  if (approvalOutput.result.data.approved) {
    return generatorOutput.result.data;
  }
}
```

### Conversational Multi-Turn

```typescript
let session = { state: { phase: 'gathering' }, history: [] };

while (true) {
  const userMessage = await getUserInput();
  const output = await conversationalAgent.execute({
    message: userMessage,
    sessionState: session.state,
  });

  console.log('Agent:', output.reply);
  session = {
    state: output.sessionState,
    history: [...session.history,
      { role: 'user', content: userMessage },
      { role: 'assistant', content: output.reply }
    ],
  };

  if (output.result.status === 'success') break;
  if (output.result.status === 'error') break;
  // status === 'in-progress': continue
}
```

## packagingOptions Reference

Configure in your skill's `vat.skills[]` entry in `package.json`:

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

**`linkFollowDepth`** — How deep to follow links from SKILL.md:

| Value | Behavior |
|-------|----------|
| `0` | Skill file only (no links followed) |
| `1` | Direct links only |
| `2` | Direct + one transitive level **(default)** |
| `"full"` | Complete transitive closure |

**`resourceNaming`** — How bundled files are named:

| Strategy | Example | Use When |
|----------|---------|----------|
| `basename` | `overview.md` | Few files, unique names **(default)** |
| `resource-id` | `topics-quickstart-overview.md` | Many files, flat output |
| `preserve-path` | `topics/quickstart/overview.md` | Preserve structure |

Use `stripPrefix` to remove a common directory prefix (e.g., `"knowledge-base"`).

**`excludeReferencesFromBundle`** — Rules for excluding files and rewriting their links:
- `rules[]` — Ordered glob patterns (first match wins), each with optional Handlebars template
- `defaultTemplate` — Applied to depth-exceeded links not matching any rule

**Template variables:**

| Variable | Description |
|----------|-------------|
| `{{link.text}}` | Link display text |
| `{{link.href}}` | Original href (without fragment) |
| `{{link.fragment}}` | Fragment including `#` prefix, or empty |
| `{{link.type}}` | Link type (`"local_file"`, etc.) |
| `{{link.resource.id}}` | Target resource ID (if resolved) |
| `{{link.resource.fileName}}` | Target filename (if resolved) |
| `{{skill.name}}` | Skill name from frontmatter |

**`validation`** — Unified framework for overriding default severity and allowing specific issue instances:

```yaml
# In vibe-agent-toolkit.config.yaml under skills.defaults or skills.config.<name>
validation:
  severity:
    LINK_DROPPED_BY_DEPTH: error           # upgrade: block on depth-dropped links
    LINK_TO_NAVIGATION_FILE: ignore        # silence: this skill intentionally links to READMEs
  allow:
    PACKAGED_UNREFERENCED_FILE:
      - paths: ["templates/runtime.json"]
        reason: "consumed programmatically at runtime"
        expires: "2026-09-30"
    SKILL_LENGTH_EXCEEDS_RECOMMENDED:
      - reason: "whole-skill concern; paths defaults to ['**/*']"
```

Two sub-keys, each covering a different override granularity:

- **`severity`** — Class-level. Raise any code to `error` (blocks build), lower to `warning` (emits, non-blocking), or `ignore` (fully suppressed). Applies to every instance of that code.
- **`allow`** — Per-instance. Suppress specific `(code, path)` matches with a required `reason` and optional `expires` date. `paths` is optional (defaults to `["**/*"]` — the whole skill). Use for legitimate exceptions that don't warrant code-wide silencing.

Things adopters typically adjust:

- Downgrade `LINK_DROPPED_BY_DEPTH` to `ignore` when intentionally linking out to external docs.
- Allow specific files under `PACKAGED_UNREFERENCED_FILE` when they're consumed programmatically by CLI scripts at runtime.
- Raise `ALLOW_EXPIRED` to `error` for zero-tolerance expiry policies.

Expired `allow` entries still apply — VAT emits `ALLOW_EXPIRED` as a reminder rather than silently re-surfacing the underlying issue (no surprise build breaks when a date passes). Unused `allow` entries surface as `ALLOW_UNUSED` (analogous to ESLint's unused-disable).

Full code reference at `docs/validation-codes.md`. `vat audit` is advisory: it applies `severity` for display grouping only, ignores `allow`, and always exits 0. Use `vat skills validate` or `vat skills build` for gated checks.

## Testing Agents

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
});
```

### Integration Testing with Mock LLM

```typescript
import { createMockContext } from '@vibe-agent-toolkit/agent-runtime';

const mockContext = createMockContext(
  JSON.stringify({ sentiment: 'positive', confidence: 0.9 })
);
const output = await myAnalyzer.execute({ text: 'Great!' }, mockContext);
resultMatchers.expectSuccess(output.result);
```

### Testing Conversational Flows

```typescript
// Turn 1
const output1 = await agent.execute({ message: 'Hello' });
expect(output1.reply).toContain('name?');
resultMatchers.expectInProgress(output1.result);

// Turn 2 — pass session state forward
const output2 = await agent.execute({
  message: 'My name is Alice',
  sessionState: output1.sessionState,
});
```

## Best Practices

1. **Return result envelopes, never throw** for expected errors
2. **Define error types as literal unions** (`'invalid-format' | 'timeout'`) not `string`
3. **Use Zod schemas** for all input/output validation
4. **Test all paths** — success, each error type, edge cases
5. **Use mock mode** for external dependencies to enable offline testing
6. **Document with JSDoc** — purpose, params, return type, example, `@throws Never throws`
7. **Keep SKILL.md focused** — if it exceeds ~300 lines, split into action skills

## References

- Skill Quality and Compatibility — VAT's Stance — what VAT believes makes a skill good and compatible, and how those beliefs turn into validation codes. Read this before overriding severity defaults or adding allow entries.
- Validation Codes Reference — full list of codes VAT emits, their default severity, and override recipes.
- [Skill Quality Checklist](resources/skill-quality-checklist.md) — Pre-publication checklist for all skills (general + CLI-backed)
- agent-authoring.md — Complete patterns guide
- orchestration.md — Multi-agent workflows
- [Building Effective Agents - Anthropic](https://www.anthropic.com/research/building-effective-agents)
