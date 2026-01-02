# @vibe-agent-toolkit/agent-config

Agent manifest loading and validation for vibe-agent-toolkit.

## Features

- Load and validate agent manifests (using `@vibe-agent-toolkit/agent-schema`)
- Validate tool prerequisites (RAG databases exist, etc.)
- Validate resource file existence (prompts, docs, templates)
- Foundation for future agent execution (no LLM integration in this phase)

## Installation

```bash
bun add @vibe-agent-toolkit/agent-config
```

## Usage

### Loading an Agent

```typescript
import { loadAgentManifest } from '@vibe-agent-toolkit/agent-config';

const manifest = await loadAgentManifest('./agent.yaml');
console.log(`Loaded: ${manifest.metadata.name} v${manifest.metadata.version}`);
```

### Validating an Agent

```typescript
import { validateAgent } from '@vibe-agent-toolkit/agent-config';

const result = await validateAgent('./agent.yaml');

if (result.valid) {
  console.log('✅ Agent is valid');
} else {
  console.error('❌ Validation errors:', result.errors);
}
```

## API

### `loadAgentManifest(path: string): Promise<LoadedAgentManifest>`

Load and parse agent manifest from file.

**Parameters**:
- `path` - Path to agent.yaml or agent directory

**Returns**: Validated agent manifest with `__manifestPath` property

**Throws**: Error if file not found or invalid

---

### `validateAgent(path: string): Promise<ValidationResult>`

Validate agent manifest and check prerequisites.

**Parameters**:
- `path` - Path to agent.yaml or agent directory

**Returns**: Validation result with errors/warnings

---

## License

MIT
