# @vibe-agent-toolkit/agent-schema

JSON Schema definitions and TypeScript types for VAT agent manifest format.

## Installation

```bash
bun add @vibe-agent-toolkit/agent-schema
```

## Usage

```typescript
import { AgentManifestSchema } from '@vibe-agent-toolkit/agent-schema';

// Validate agent.yaml structure
const result = AgentManifestSchema.safeParse(data);
```

## Package Exports

- TypeScript types and Zod schemas: `@vibe-agent-toolkit/agent-schema`
- JSON Schemas: `@vibe-agent-toolkit/agent-schema/schemas/*`
