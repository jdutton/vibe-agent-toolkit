# @vibe-agent-toolkit/agent-schema

JSON Schema definitions and TypeScript types for VAT agent manifest format.

## Installation

```bash
bun add @vibe-agent-toolkit/agent-schema
```

## Usage

### TypeScript (Zod Schemas)

```typescript
import { AgentManifestSchema, type AgentManifest } from '@vibe-agent-toolkit/agent-schema';

// Validate agent.yaml data
const result = AgentManifestSchema.safeParse(data);

if (result.success) {
  const agent: AgentManifest = result.data;
  console.log('Valid agent:', agent.metadata.name);
} else {
  console.error('Validation errors:', result.error.issues);
}
```

### JSON Schema (External Tools)

JSON Schema files are available in the `schemas/` directory:

```typescript
import agentManifestSchema from '@vibe-agent-toolkit/agent-schema/schemas/agent-manifest.json';
```

Available schemas:
- `agent-manifest.json` - Complete agent manifest
- `agent-metadata.json` - Agent metadata
- `llm-config.json` - LLM configuration
- `agent-interface.json` - Input/output interface
- `tool.json` - Tool definitions
- `resource-registry.json` - Resource registry

## Exported Schemas

### Core Schemas

- `AgentManifestSchema` - Complete agent.yaml structure
- `AgentMetadataSchema` - Agent metadata (name, version, etc.)
- `AgentSpecSchema` - Agent specification (LLM, tools, resources)

### Component Schemas

- `LLMConfigSchema` - LLM configuration with alternatives
- `ToolSchema` - Tool definitions
- `AgentInterfaceSchema` - Input/output schemas
- `ResourceRegistrySchema` - Resource registry
- `PromptsConfigSchema` - Prompt configuration
- `CredentialsConfigSchema` - Credentials requirements

### Utility Schemas

- `SchemaRefSchema` - JSON Schema $ref format
- `ToolAlternativeSchema` - Tool alternatives
- `BuildMetadataSchema` - Build metadata

## TypeScript Types

All schemas export corresponding TypeScript types:

```typescript
import type {
  AgentManifest,
  AgentMetadata,
  AgentSpec,
  LLMConfig,
  Tool,
  AgentInterface,
} from '@vibe-agent-toolkit/agent-schema';
```

## Validation Example

```typescript
import { AgentManifestSchema } from '@vibe-agent-toolkit/agent-schema';
import { readFileSync } from 'node:fs';
import YAML from 'yaml';

// Load agent.yaml
const content = readFileSync('agent.yaml', 'utf-8');
const data = YAML.parse(content);

// Validate
const result = AgentManifestSchema.safeParse(data);

if (!result.success) {
  console.error('Validation failed:');
  result.error.issues.forEach(issue => {
    console.error(`- ${issue.path.join('.')}: ${issue.message}`);
  });
  process.exit(1);
}

console.log('✅ Valid agent manifest');
```

## Schema Generation

JSON Schemas are automatically generated from Zod schemas during build:

```bash
bun run generate:schemas
```

This ensures TypeScript types and JSON Schemas stay in sync.

## API Version

Current API version: `vat.dev/v1`

Future versions will be released as:
- Breaking changes: `vat.dev/v2`
- Non-breaking additions: Compatible within `v1`

## License

MIT
