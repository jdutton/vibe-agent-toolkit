# Agent Commands

Manage and execute AI agents defined in agent.yaml manifests.

## Overview

VAT agents are defined using Kubernetes-style YAML manifests that specify:
- Agent metadata (name, version, description)
- LLM configuration (provider, model, parameters)
- Tools (RAG, functions, APIs)
- Prompts (system, user templates)
- Resources (documentation, templates, examples)

## Commands

### `vat agent validate <path>`

Validate agent manifest and check prerequisites.

**Usage**:
```bash
vat agent validate ./my-agent
vat agent validate ./my-agent/agent.yaml
vat agent validate packages/vat-development-agents/agents/agent-generator
```

**Validation checks**:
- Manifest schema validation (apiVersion, kind, metadata, spec)
- LLM provider and model configuration
- Tool configurations (RAG databases, function files)
- Resource file existence (prompts, docs, templates)
- Prompt references ($ref paths)

**Output**: YAML to stdout with validation results
**Exit codes**: 0 = valid, 1 = validation errors, 2 = system error

---

## Manifest Format

VAT uses Kubernetes-style manifests for agent configuration:

```yaml
apiVersion: vat.dev/v1
kind: Agent

metadata:
  name: "agent-name"
  version: "0.1.0"
  description: "Agent description"

spec:
  llm:
    provider: anthropic
    model: claude-sonnet-4.5
    temperature: 0.7

  prompts:
    system:
      $ref: ./prompts/system.md

  tools:
    - name: tool_name
      type: library
      description: Tool description

  resources:
    resource_id:
      path: ./path/to/file
      type: template
```

See `@vibe-agent-toolkit/agent-schema` for complete schema reference.

## Examples

### Example 1: Validate agent-generator

```bash
cd packages/vat-development-agents
vat agent validate agents/agent-generator
```

### Example 2: Validate with custom path

```bash
vat agent validate ./my-custom-agent/agent.yaml
```

## Environment Variables

- `ANTHROPIC_API_KEY` - API key for Anthropic (Claude)
- `OPENAI_API_KEY` - API key for OpenAI
- `GOOGLE_API_KEY` - API key for Google (Gemini)

## See Also

- [@vibe-agent-toolkit/agent-schema](../../agent-schema/README.md) - Schema reference
- [agent-generator](../../vat-development-agents/agents/agent-generator/README.md) - Example agent
- [RAG Commands](./rag.md) - Indexing documentation for RAG tools
