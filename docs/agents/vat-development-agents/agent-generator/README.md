# agent-generator

**Version:** 0.1.0
**Status:** Design Phase (Phase 1.5) - Validated ✅
**Type:** Meta-agent (generates other agents)

An agentic tool that helps users create new VAT agents through adaptive conversation following industry best practices.

---

## Purpose

agent-generator guides users through a structured 4-phase workflow to design high-quality AI agents:

1. **GATHER** - Understand user's intent and goals
2. **ANALYZE** - Identify agent pattern and extract requirements
3. **DESIGN** - Make informed architecture decisions (LLM, tools, prompts)
4. **GENERATE** - Create validated agent package

### Why This Agent Exists

- **Forcing function**: Validates VAT agent-schema through real-world usage
- **Best practices**: Incorporates research from Anthropic, Databricks, Microsoft Azure
- **Consistency**: Ensures all VAT agents follow proven design patterns
- **Accessibility**: Makes agent design approachable for non-experts

---

## Usage

### Input

Provide agent requirements (see `schemas/input.schema.json`):

```json
{
  "agentPurpose": "What problem does this agent solve?",
  "successCriteria": "How will you know it succeeded?",
  "typicalInputs": "What data does it receive? (optional)",
  "expectedOutputs": "What should it produce? (optional)",
  "domainContext": "Domain knowledge needed? (optional)",
  "performanceRequirements": {
    "latency": "Speed requirements? (optional)",
    "accuracy": "Quality threshold? (optional)",
    "cost": "Budget constraints? (optional)"
  },
  "additionalContext": "Anything else? (optional)"
}
```

**Minimum viable input:**
```json
{
  "agentPurpose": "Review PRs for security issues",
  "successCriteria": "Catches 100% of critical vulnerabilities"
}
```

### Output

Complete agent package (see `schemas/output.schema.json`):

```json
{
  "agentYaml": { /* validated agent.yaml content */ },
  "files": [
    { "path": "agent.yaml", "content": "...", "type": "readme" },
    { "path": "prompts/system.md", "content": "...", "type": "prompt" },
    { "path": "prompts/user.md", "content": "...", "type": "prompt" },
    { "path": "schemas/input.schema.json", "content": "...", "type": "schema" },
    { "path": "schemas/output.schema.json", "content": "...", "type": "schema" },
    { "path": "README.md", "content": "...", "type": "readme" }
  ],
  "validationResults": {
    "valid": true,
    "errors": [],
    "warnings": []
  },
  "summary": "Your agent is ready! Next: customize prompts, test, deploy.",
  "architecture": {
    "llm": "Claude Sonnet 4.5: Balanced quality/cost",
    "tools": ["file-reader", "github-api"],
    "promptStrategy": "System: expert reviewer, User: structured diff",
    "resourcesPlan": "Security checklist, coding standards as references"
  }
}
```

### Example

See `examples/example-input.md` for complete PR review agent scenario.

---

## Architecture

### Four-Phase Workflow

**Phase 1: GATHER**
- Agent asks: "What problem are you solving? How will you know you succeeded?"
- Extracts: Purpose and success criteria

**Phase 2: ANALYZE**
- Agent identifies agent type (code analysis, data processing, RAG, workflow)
- Asks pattern-specific questions
- Extracts: Detailed requirements (I/O formats, tools, domain knowledge)

**Phase 3: DESIGN**
- Agent makes architecture decisions:
  - LLM selection (based on accuracy/speed/cost requirements)
  - Tool selection (minimize count, justify each)
  - Prompt strategy (context-efficient)
  - Resource planning (high-signal only)
- Explains reasoning for each decision

**Phase 4: GENERATE**
- Agent creates all file contents
- Validates agent.yaml against `@vibe-agent-toolkit/agent-schema`
- Returns structured output (wrapper writes files)

### LLM Configuration

**Primary:** Claude Sonnet 4.5
- Strong software architecture understanding
- Adaptive conversation capability
- High-quality code/prompt generation
- Context efficiency (understands "smallest high-signal tokens")

**Alternatives:**
- Claude Opus 4.5: Maximum quality for complex multi-agent systems
- GPT-4o: OpenAI ecosystem preference

### Tools

**validate_agent_schema** (required)
- Package: `@vibe-agent-toolkit/agent-schema`
- Function: `AgentManifestSchema.safeParse()`
- Used in GENERATE phase to ensure correctness

### Resources

**Documentation** (4 files):
- `agent-design-best-practices.md` - Research from Anthropic, Databricks, Microsoft
- `llm-selection-guide.md` - Model capabilities/cost/latency
- `tool-recommendations.md` - Common tools and MCP servers
- `vat-schema-reference.md` - agent.yaml format specification

**Templates** (4 files):
- `agent-template.yaml` - Base structure
- `prompt-system-template.md` - System prompt boilerplate
- `prompt-user-template.md` - User prompt with variables
- `README-template.md` - Documentation structure

**Examples** (3 files):
- `code-analysis-agent.yaml` - Code review agent
- `data-processing-agent.yaml` - Data transformation agent
- `rag-agent.yaml` - Document Q&A agent

---

## Design Validation

This agent design has been validated against `@vibe-agent-toolkit/agent-schema`:

- ✅ `agent.yaml` passes `AgentManifestSchema.safeParse()`
- ✅ Input/output schemas are valid JSON Schema Draft 07
- ✅ All references ($ref) are correct relative paths
- ✅ LLM configuration includes reasoning and alternatives
- ✅ Resources are properly categorized

See `validate-agent.ts` for validation script.

---

## Testing Strategy

### Unit Testing (Future - Phase 2)

**Test each phase independently:**

1. **GATHER phase:**
   - Input: Minimal user description
   - Expected: Focused follow-up questions
   - Verify: Extracts purpose + success criteria

2. **ANALYZE phase:**
   - Input: Purpose + success criteria
   - Expected: Pattern identification + targeted questions
   - Verify: Correct agent type, detailed requirements

3. **DESIGN phase:**
   - Input: Requirements from ANALYZE
   - Expected: Justified architecture decisions
   - Verify: LLM choice, tool selection, prompt strategy

4. **GENERATE phase:**
   - Input: Architecture from DESIGN
   - Expected: Valid agent package
   - Verify: Schema validation passes, all files present

### Integration Testing (Future - Phase 2)

**Test complete workflow:**

```typescript
const input = {
  agentPurpose: "Validate agent.yaml files",
  successCriteria: "Catches all schema errors"
};

const output = await agentGenerator.run(input);

assert(output.validationResults.valid === true);
assert(output.files.length >= 5); // agent.yaml, prompts, schemas, README
assert(output.architecture.llm.includes("Claude"));
```

### Example-Based Testing (Future - Phase 2)

Test with representative agent types:
- Code analysis agent
- Data processing agent
- RAG agent
- Workflow agent

---

## Design Status

- [x] Input schema defined
- [x] Output schema defined
- [x] System prompt written
- [x] User prompt template written
- [x] agent.yaml validated
- [x] Design notes documented
- [x] Complete README with architecture and testing strategy

---

## Next Steps

### Phase 2: Implementation

1. Implement agent runtime (conversation manager)
2. Implement file writer wrapper
3. Create resource content (docs, templates, examples)
4. Build CLI interface
5. Add web search tool for current LLM pricing

### Phase 3: Refinement

1. Test with real users designing agents
2. Collect feedback on conversation flow
3. Refine prompts based on actual usage
4. Optimize resource content for context efficiency
5. Add more agent pattern examples

---

## Research Sources

This agent incorporates best practices from:

- [Building Effective Agents - Anthropic](https://www.anthropic.com/research/building-effective-agents)
- [Effective Context Engineering - Anthropic](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [Agent System Design Patterns - Databricks](https://docs.databricks.com/aws/en/generative-ai/guide/agent-system-design-patterns)
- [AI Agent Orchestration - Microsoft Azure](https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/ai-agent-design-patterns)

---

## License

MIT

---

## Authors

VAT Team <team@vat.dev>
