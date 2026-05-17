# @vibe-agent-toolkit/vat-development-agents

**VAT Development Agents** - Dogfooding the vibe-agent-toolkit

This package contains agents used for developing the Vibe Agent Toolkit itself. These agents validate schemas, generate new agents, optimize resources, and more.

## Agents

### agent-generator

**Status:** Design Complete (Phase 1.5)
**Purpose:** Helps users create new VAT agents through adaptive 4-phase conversation

Guides users through:
1. **GATHER** - Understand problem and success criteria
2. **ANALYZE** - Identify agent pattern, extract requirements
3. **DESIGN** - Choose LLM, tools, prompts, resources
4. **GENERATE** - Create validated agent package

[Read full design →](./agents/agent-generator/README.md)

### resource-optimizer

**Status:** Scoped (Phase 1.5)
**Purpose:** Analyzes agent resources for context efficiency

Identifies opportunities to improve agent resources following Anthropic's "smallest high-signal tokens" principle.

[Read scope document →](./agents/resource-optimizer/SCOPE.md)

## Package Structure

```
@vibe-agent-toolkit/vat-development-agents/
├── agents/
│   ├── agent-generator/          # Design complete
│   │   ├── agent.yaml            # Validated manifest
│   │   ├── schemas/              # I/O schemas
│   │   ├── prompts/              # System/user prompts
│   │   ├── examples/             # Example usage
│   │   └── README.md             # Full documentation
│   └── resource-optimizer/       # Scoped only
│       └── SCOPE.md              # Design scope
└── package.json                  # NPM package manifest
```

## Installation

### As NPM Package

```bash
npm install @vibe-agent-toolkit/vat-development-agents
```

### Installing the Skill

This package includes a distributable Claude Code skill called `vibe-agent-toolkit` that provides guidance on using VAT for agent creation and development.

**Install from npm:**
```bash
vat skills install npm:@vibe-agent-toolkit/vat-development-agents
```

**Install from local directory (development):**
```bash
vat skills install ./packages/vat-development-agents
```

**Verify installation:**
```bash
vat skills list --installed
```

The `vibe-agent-toolkit` skill will be installed to `~/.claude/plugins/vibe-agent-toolkit/` and will appear in Claude Code after restarting or running `/reload-plugins`.

**What the skill includes:**
- VAT overview and use cases
- Agent creation guide (using agent-generator)
- CLI workflow documentation
- Links to agent authoring and orchestration guides
- Best practices for portable agents

## Usage

### As NPM Package

```javascript
import agentGenerator from '@vibe-agent-toolkit/vat-development-agents/agents/agent-generator';
```

### Direct Agent Access

```bash
# Validate agent-generator's own manifest
cd packages/vat-development-agents
bun run validate
```

## Development Status

| Agent | Phase | Status |
|-------|-------|--------|
| agent-generator | 1.5 - Design | ✅ Complete |
| resource-optimizer | 1.5 - Scope | ✅ Complete |
| schema-validator | Planned | 📋 Phase 2 |
| test-generator | Planned | 📋 Phase 2+ |

## Keywords

- `vat-agent` - Discoverable via `npm search vat-agent`
- `vibe-agent` - Alternative namespace
- `agent-bundle` - Contains multiple agents
- `development-tools` - Developer tooling

## License

MIT © VAT Team
