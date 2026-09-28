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

**Output**: the report envelope (YAML) on stdout; the findings, human-readable, on stderr.
One manifest per run, so `examined` is 1. Every finding is located at the manifest,
relative to `data.root` (the working directory):

- `AGENT_MANIFEST_INVALID` (error) — one per schema violation; `field` is the dotted key path
- `AGENT_REFERENCE_MISSING` (error) — a prompt `$ref`, a resource path or the RAG database does not exist
- `AGENT_REFERENCE_UNREADABLE` (error) — a referenced path exists but the OS refused access
- `AGENT_RAG_NO_SOURCES` (warning) — `spec.rag` names no sources

```yaml
status: findings          # ok | findings | error
examined: 1
findings:
  - code: AGENT_REFERENCE_MISSING
    severity: error
    message: "System prompt not found: ./prompts/system.md"
    location: my-agent/agent.yaml
summary: { errors: 1, warnings: 0, info: 0 }
gate: { strict: false }
durationMs: 12
data:
  root: /abs/path/to/project
  manifest: { name: my-agent, version: 0.1.0, path: my-agent/agent.yaml }   # name/version null when the manifest does not validate
```

**Exit codes** (derived from the document):

| Exit | `status` | When |
|---|---|---|
| `0` | `ok` / `findings` | No error-severity finding (a warning never fails the run) |
| `1` | `findings` | An error-severity finding — a schema violation or an unreachable reference |
| `2` | `error` | No manifest to judge; `error.code` says why: `USAGE_INVALID` (the path or name names no manifest, or no `projectRoot`), `INPUT_UNREADABLE` (the OS refuses the manifest, or it is not YAML) |

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
    model: claude-sonnet-5
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

See `@vibe-agent-toolkit/schema` for complete schema reference.

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

## Requirements

Each `vat agent` subcommand declares its own `projectRoot` and config policy:

| Subcommand | `projectRoot` | Config |
|---|---|---|
| `vat agent list` | optional (tolerates absence) | not used |
| `vat agent installed` | N/A | not used |
| `vat agent build <pathOrName>` | required (errors without `vibe-agent-toolkit.config.yaml` or `.git/` ancestor) | required file with `agents.*` fields populated |
| `vat agent run <pathOrName> <input>` | optional (path-explicit; tolerates absence) | optional (uses defaults if absent) |
| `vat agent validate <pathOrName>` | required | optional (uses defaults if absent) |
| `vat agent import <skillPath>` | N/A | not used |
| `vat agent install <agentName>` | N/A | not used |
| `vat agent uninstall <agentName>` | N/A | not used |

**Why `build` and `validate` require `projectRoot`:** both are explicit-adoption
operations. Building or source-validating an agent without an authoring
boundary would silently accept arbitrary trees as "the project" and would not
participate in the unified validation framework. `vat agent run` is
path-explicit and runs from anywhere; `vat agent list` discovers without
needing a project context.

See [Roots and Config — Canonical Concepts](../../../docs/concepts/roots-and-config.md)
for terminology.

## See Also

- [@vibe-agent-toolkit/schema](../../schema/README.md) - Schema reference
- [agent-generator](../../vat-development-agents/agents/agent-generator/README.md) - Example agent
- [RAG Commands](./rag.md) - Indexing documentation for RAG tools
