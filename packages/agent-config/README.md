# @vibe-agent-toolkit/agent-config

Agent manifest loading and validation for vibe-agent-toolkit.

## Features

- Load and validate agent manifests (using `@vibe-agent-toolkit/schema`)
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

const result = await validateAgent('./my-agent', { locationRoot: process.cwd() });

if (result.summary.errors === 0) {
  console.log(`✅ ${result.manifest.name} passes (${result.status})`);
} else {
  for (const issue of result.issues) console.error(`${issue.location}: [${issue.code}] ${issue.message}`);
}
```

## API

Every error the loader throws is a `VatError` carrying a `code`; dispatch on the
code, never the message:

| Code | When |
|---|---|
| `AGENT_MANIFEST_NOT_FOUND` (`AGENT_MANIFEST_NOT_FOUND_CODE`) | The path names no manifest: no file at a `.yaml`/`.yml` path, or a directory with neither `agent.yaml` nor `agent.yml` |
| `AGENT_MANIFEST_UNREADABLE` (`AGENT_MANIFEST_UNREADABLE_CODE`) | A manifest's content is not YAML |
| `FS_FAULT` (`FsFaultError` from `@vibe-agent-toolkit/utils`) | A manifest is there but the OS refuses it (`EACCES`, `ELOOP`): a `source` fault on the path argument, refused as the utils/schema refusal table says |
| `AGENT_MANIFEST_INVALID` | `loadAgentManifest` only: the YAML parsed but the manifest schema rejects it |

### `loadAgentManifest(path: string): Promise<LoadedAgentManifest>`

Load and parse agent manifest from file.

**Parameters**:
- `path` - Path to agent.yaml or agent directory

**Returns**: Validated agent manifest with `__manifestPath` property

**Throws**: `VatError` coded `AGENT_MANIFEST_NOT_FOUND`, `AGENT_MANIFEST_UNREADABLE`, `AGENT_MANIFEST_INVALID` or `FS_FAULT` (table above)

---

### `validateAgent(path: string, options: ValidateAgentOptions): Promise<ValidationResult>`

Validate agent manifest and check prerequisites: the schema, the RAG database a
`spec.rag` block needs, and every resource and prompt file the manifest references.

**Parameters**:
- `path` - Path to agent.yaml or agent directory
- `options.locationRoot` - Required. The directory every issue `location` is relative to

**Returns**: `ValidationResult`:
- `status` - `'ok'` when there is no issue, `'findings'` when there is at least one
- `summary` - the issues by severity: `{ errors, warnings, info }`
- `issues` - every finding, each located at the manifest. Codes: `AGENT_MANIFEST_INVALID` (one per schema violation, `field` is the key path), `AGENT_REFERENCE_MISSING`, `AGENT_REFERENCE_UNREADABLE`, `AGENT_RAG_NO_SOURCES` (warning)
- `manifest` - `{ name, version, path }`: `name`/`version` are `null` when the manifest does not validate (or declares no version); `path` is absolute

**Throws**: `VatError` coded `AGENT_MANIFEST_NOT_FOUND`, `AGENT_MANIFEST_UNREADABLE` or `FS_FAULT` — no manifest was read, so there is nothing to report findings about. A schema violation is a finding, never a throw.

---

## License

MIT
